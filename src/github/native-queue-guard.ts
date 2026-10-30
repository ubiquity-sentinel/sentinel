import { hasQueueDeliveryProvenance } from "./queue-delivery-provenance.ts";
import type { QueueLegacyDirectGrant } from "./queue-legacy-direct.ts";
/** Trusted in-memory final effect guard. No queue metadata is added to persisted records. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { Clock, StateReadView } from "../contracts/ports.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { candidateBranch } from "../repair/keys.ts";
import {
  hasQueueIntentNamespace,
  isQueueHeld,
  type QueueMode,
} from "../../ops/hosted-autonomy-queue-policy.ts";
import type { QueueProofPolicy } from "../../ops/hosted-autonomy-queue-proof.ts";
import type { GitHubQueueDeliveryClient } from "./client-queue-delivery.ts";
import type {
  DeliveryProofResult,
  QueuePullIdentity,
} from "./merge-queue-types.ts";
import type { QueueDeliveryReader } from "./queue-delivery-reader.ts";
import { proveNativeQueueDelivery } from "./native-queue-proof.ts";

export type NativeQueueOperation =
  | "publication"
  | "refresh"
  | "conflict"
  | "merge"
  | "resume";
export type QueueGuardReason =
  | "capability_missing"
  | "rule_unavailable"
  | "observation_unavailable"
  | "inactive_observation_unavailable"
  | "authorization_unavailable"
  | "custody"
  | "member"
  | "identity_drift"
  | "merged_head"
  | "queue_required";
export type QueueGuardDecision =
  | { status: "allow"; basis: "self" | "inactive_no_rule" | "native_absent" }
  | {
    status: "hold";
    reason: QueueGuardReason;
    pull: QueuePullIdentity | null;
  };
export interface QueueEffectRequest {
  operation: NativeQueueOperation;
  branch?: string;
  pullRequest?: number;
  expectedHead?: GitSha | null;
  deadline: number;
}
export type NativeDeliveryDecision =
  | DeliveryProofResult
  | QueueLegacyDirectGrant
  | {
    status: "unavailable";
    reason: "rule_unavailable" | "inactive_observation_unavailable";
  };
export interface NativeQueueGuardV1 {
  inspect(
    input: {
      record: WorkRecordV1;
      operation: NativeQueueOperation;
      expectedHead?: GitSha | null;
      deadline: number;
    },
  ): Promise<QueueGuardDecision>;
  inspectEffect(input: QueueEffectRequest): Promise<QueueGuardDecision>;
  proveDelivery(
    input: {
      record: WorkRecordV1;
      receipt: ReviewReceiptV1;
      revision: GitSha;
      deadline: number;
    },
  ): Promise<NativeDeliveryDecision>;
}
export interface NativeQueueGuardOptions {
  repository: RepositoryIdentityV1;
  state: StateReadView;
  clock: Clock;
  client: GitHubQueueDeliveryClient;
  reader: QueueDeliveryReader;
  mode: QueueMode;
  proofActivated: boolean;
  policy: QueueProofPolicy;
}
export function isNativeQueueTarget(repository: RepositoryIdentityV1): boolean {
  return repository.owner === "ubiquity" && repository.name === "ai.ubq.fi";
}
export function queueHold(
  reason: QueueGuardReason,
  pull: QueuePullIdentity | null = null,
): QueueGuardDecision {
  return { status: "hold", reason, pull };
}
const equal = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);

export function createNativeQueueGuard(
  options: NativeQueueGuardOptions,
): NativeQueueGuardV1 {
  async function inspect(
    input: QueueEffectRequest,
    expected?: WorkRecordV1,
  ): Promise<QueueGuardDecision> {
    const hasCustody = (record: WorkRecordV1) =>
      isQueueHeld(record) || hasQueueIntentNamespace(record) ||
      hasQueueDeliveryProvenance(record);
    let strict = options.mode !== "off" || options.proofActivated ||
      (expected !== undefined && hasCustody(expected));
    const unavailable = (
      reason: QueueGuardReason = "observation_unavailable",
    ) => queueHold(strict ? reason : "inactive_observation_unavailable");
    const matches = (row: WorkRecordV1) =>
      equal(row.repository, options.repository) &&
      (expected !== undefined
        ? row.id === expected.id
        : input.pullRequest !== undefined
        ? row.target.pr === input.pullRequest
        : input.branch !== undefined &&
          (row.target.branch === input.branch ||
            candidateBranch(row.id) === input.branch));
    const readState = async () => {
      const read = await options.state.readRepair();
      if (read.ok && read.value.status === "found") {
        strict ||= read.value.snapshot.work.some((row) =>
          matches(row) && hasCustody(row)
        );
      }
      return read;
    };
    try {
      if (!isNativeQueueTarget(options.repository)) {
        return { status: "allow", basis: "self" };
      }
      if (
        !Number.isFinite(input.deadline) ||
        options.clock.now() >= input.deadline
      ) return unavailable();
      const state = await readState();
      if (!state.ok || state.value.status !== "found") {
        return unavailable();
      }
      const rows = state.value.snapshot.work.filter(matches);
      if (
        rows.length > 1 ||
        (expected !== undefined &&
          (rows.length !== 1 || !equal(rows[0], expected)))
      ) return unavailable("identity_drift");
      const record = rows[0];
      if (
        record !== undefined &&
        (isQueueHeld(record) || hasQueueIntentNamespace(record) ||
          hasQueueDeliveryProvenance(record))
      ) return queueHold("custody");
      const rules = await options.client.readBranchRules("development");
      if (!rules.ok) {
        return unavailable();
      }
      const active = rules.value.some((rule) => rule.type === "merge_queue");
      strict ||= active;
      if (options.clock.now() >= input.deadline) {
        return unavailable();
      }
      // An owner cannot enable a queue without its effective rule. This fresh authenticated
      // negative preserves today's live path before queue permission/canary activation.
      if (options.mode === "off" && !options.proofActivated && !active) {
        const fresh = await readState();
        if (
          !fresh.ok || fresh.value.status !== "found" ||
          fresh.value.head !== state.value.head ||
          options.clock.now() >= input.deadline
        ) return unavailable("identity_drift");
        return { status: "allow", basis: "inactive_no_rule" };
      }
      if (input.operation === "merge" && active) {
        return queueHold("queue_required");
      }
      let number = input.pullRequest ?? record?.target.pr ?? undefined;
      const branch = input.branch ?? record?.target.branch ??
        (record === undefined ? undefined : candidateBranch(record.id));
      if (number === undefined) {
        if (branch === undefined) return unavailable("identity_drift");
        const pulls = await options.client.listPullRequestsByHeadRef(branch);
        if (!pulls.ok) return unavailable();
        if (pulls.value.length > 1) return unavailable("identity_drift");
        number = pulls.value[0]?.number;
        if (number === undefined) {
          // Complete empty discovery only authorizes this genuinely PR-less branch.
          const after = await readState();
          if (
            !after.ok || after.value.status !== "found" ||
            after.value.head !== state.value.head ||
            options.clock.now() >= input.deadline
          ) return unavailable("identity_drift");
          return { status: "allow", basis: "native_absent" };
        }
      }
      const read = await options.client.readQueuePull(number, input.deadline);
      if (read.status !== "complete") return unavailable();
      const { pull, entry, mergedRevision } = read.value.membership;
      if (entry !== null) return queueHold("member", pull);
      if (mergedRevision !== null) return queueHold("merged_head", pull);
      const head = input.expectedHead ??
        record?.target.candidateState?.publishedHead ?? record?.target.head;
      if (
        (branch !== undefined && pull.headRef !== branch) ||
        (head !== undefined && head !== null && pull.head !== head) ||
        pull.baseRef !== "development"
      ) return queueHold("identity_drift", pull);
      const after = await readState();
      if (
        !after.ok || after.value.status !== "found" ||
        after.value.head !== state.value.head ||
        options.clock.now() >= input.deadline
      ) return queueHold("identity_drift", pull);
      return { status: "allow", basis: "native_absent" };
    } catch {
      return unavailable();
    }
  }
  return {
    inspect: ({ record, operation, expectedHead, deadline }) =>
      inspect({ operation, expectedHead, deadline }, record),
    inspectEffect: (input) => inspect(input),
    proveDelivery: (input) => proveNativeQueueDelivery(options, input),
  };
}
