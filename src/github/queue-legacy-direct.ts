import type { TakeoverPublicationProof } from "../contracts/existing-pr-takeover.ts";
import { hasTakeoverCustody } from "./existing-pr-takeover-provenance.ts";
import { takeoverPublicationMatches } from "./existing-pr-publication-proof.ts";
import { hasQueueDeliveryProvenance } from "./queue-delivery-provenance.ts";
/** Shared preactivation direct grant. It is never a VerifiedDelivery proof. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { Clock, StateReadView } from "../contracts/ports.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { reviewedIdentity } from "../repair/carried-review.ts";
import { reviewAuthorizesMerge } from "../repair/review-gate.ts";
import {
  hasQueueIntentNamespace,
  isQueueHeld,
  type QueueMode,
} from "../../ops/hosted-autonomy-queue-policy.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
} from "../../ops/hosted-autonomy-policy.ts";
import {
  sameTreeChanges,
  treeChangesDigest,
} from "../../ops/hosted-autonomy-github-trees.ts";
import type { GitHubQueueDeliveryClient } from "./client-queue-delivery.ts";
import type { QueueBinding, QueueRead } from "./merge-queue-types.ts";
import type { QueueDeliveryReader } from "./queue-delivery-reader.ts";

export interface QueueLegacyDirectGrant {
  status: "legacy_direct";
  binding: QueueBinding;
  revision: GitSha;
  publicationProof?: TakeoverPublicationProof;
  carried?: { reviewedBase: GitSha; reviewedHead: GitSha; patchDigest: string };
}
export type QueueLegacyDirectRead =
  | QueueRead<QueueLegacyDirectGrant | null>
  | { status: "unavailable"; reason: "rule_unavailable" };
export interface QueueLegacyDirectOptions {
  state: StateReadView;
  clock: Clock;
  client: GitHubQueueDeliveryClient;
  reader: QueueDeliveryReader;
  mode: QueueMode;
  proofActivated: boolean;
}
export async function resolveQueueLegacyDirect(
  options: QueueLegacyDirectOptions,
  input: {
    record: WorkRecordV1;
    receipt?: ReviewReceiptV1;
    revision: GitSha;
    deadline: number;
  },
): Promise<QueueLegacyDirectRead> {
  const unavailable = (): QueueRead<never> => ({
    status: "unavailable",
    reason: "incomplete",
  });
  const equal = (a: unknown, b: unknown) =>
    canonicalStringify(a) === canonicalStringify(b);
  const { record } = input;
  if (
    options.proofActivated || options.mode !== "off" || isQueueHeld(record) ||
    hasQueueIntentNamespace(record) || hasQueueDeliveryProvenance(record)
  ) return { status: "complete", value: null };
  if (
    !Number.isFinite(input.deadline) || options.clock.now() >= input.deadline ||
    record.target.pr === null || record.target.head === null ||
    record.target.base === null
  ) return unavailable();
  const state = await options.state.readRepair();
  if (
    !state.ok || state.value.status !== "found" ||
    !equal(
      state.value.snapshot.work.find((row) => row.id === record.id) ?? null,
      record,
    )
  ) return unavailable();
  const rules = await options.client.readBranchRules("development");
  if (!rules.ok) return { status: "unavailable", reason: "rule_unavailable" };
  if (rules.value.some((rule) => rule.type === "merge_queue")) {
    return { status: "complete", value: null };
  }
  const observed = await options.client.readQueueLegacyPull(
    record.target.pr,
    input.deadline,
  );
  if (observed.status !== "complete") return observed;
  const { pull, mergedBy } = observed.value;
  const publication = hasTakeoverCustody(record)
    ? await options.reader.readPublication?.({
      record,
      snapshot: state.value.snapshot,
      deadline: input.deadline,
      revision: input.revision,
    })
    : { status: "complete" as const, value: null };
  if (publication?.status !== "complete") return unavailable();
  if (
    pull.state !== "merged" || pull.head !== record.target.head ||
    pull.mergeSha !== input.revision || pull.baseRef !== "development" ||
    pull.headRef !== record.target.branch || pull.author === null ||
    (hasTakeoverCustody(record)
      ? !takeoverPublicationMatches(
        publication.value ?? undefined,
        record,
        input.revision,
        pull.author,
      )
      : !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)) ||
    mergedBy?.type !== "Bot" ||
    mergedBy.login !== HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR
  ) return unavailable();
  const binding = await options.reader.readBinding({
    record,
    snapshot: state.value.snapshot,
    deadline: input.deadline,
  });
  if (binding.status !== "complete") return binding;
  const { receipt, task, optedOut } = binding.value;
  if (
    optedOut ||
    (input.receipt !== undefined && !equal(receipt, input.receipt)) ||
    !reviewAuthorizesMerge(
      receipt,
      reviewedIdentity(record, receipt),
      HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
      task,
    )
  ) return unavailable();
  let carried: QueueLegacyDirectGrant["carried"];
  if (
    receipt.pullRequest.base !== record.target.base ||
    receipt.pullRequest.head !== record.target.head
  ) {
    const original = await options.client.readQueuePatch(
      receipt.pullRequest.base,
      receipt.pullRequest.head,
      input.deadline,
    );
    if (original.status !== "complete") return original;
    const current = await options.client.readQueuePatch(
      record.target.base,
      record.target.head,
      input.deadline,
    );
    if (current.status !== "complete") return current;
    if (!sameTreeChanges(original.value.changes, current.value.changes)) {
      return unavailable();
    }
    carried = {
      reviewedBase: receipt.pullRequest.base,
      reviewedHead: receipt.pullRequest.head,
      patchDigest: await treeChangesDigest(current.value.changes),
    };
  }
  const finalBinding = await options.reader.readBinding({
    record,
    snapshot: state.value.snapshot,
    deadline: input.deadline,
  });
  if (
    finalBinding.status !== "complete" ||
    !equal(binding.value, finalBinding.value)
  ) return unavailable();
  const finalRules = await options.client.readBranchRules("development");
  if (!finalRules.ok) {
    return { status: "unavailable", reason: "rule_unavailable" };
  }
  if (finalRules.value.some((rule) => rule.type === "merge_queue")) {
    return { status: "complete", value: null };
  }
  const after = await options.state.readRepair();
  if (
    !after.ok || after.value.status !== "found" ||
    after.value.head !== state.value.head ||
    options.clock.now() >= input.deadline
  ) return unavailable();
  return {
    status: "complete",
    value: {
      status: "legacy_direct",
      binding: binding.value.binding,
      revision: input.revision,
      ...(publication.value === null
        ? {}
        : { publicationProof: publication.value }),
      ...(carried === undefined ? {} : { carried }),
    },
  };
}
