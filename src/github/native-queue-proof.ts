import { resolveQueueLegacyDirect } from "./queue-legacy-direct.ts";
/** Native adapter for the one shared queue-first proof constructor. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
import { hasQueueDeliveryProvenance } from "./queue-delivery-provenance.ts";
import {
  hasQueueIntentNamespace,
  isQueueHeld,
} from "../../ops/hosted-autonomy-queue-policy.ts";
import type {
  NativeDeliveryDecision,
  NativeQueueGuardOptions,
} from "./native-queue-guard.ts";

export async function proveNativeQueueDelivery(
  options: NativeQueueGuardOptions,
  input: {
    record: WorkRecordV1;
    receipt: ReviewReceiptV1;
    revision: GitSha;
    deadline: number;
  },
): Promise<NativeDeliveryDecision> {
  const { record } = input;
  const hasCustody = (row: WorkRecordV1) =>
    isQueueHeld(row) || hasQueueIntentNamespace(row) ||
    hasQueueDeliveryProvenance(row);
  let strict = options.mode !== "off" || options.proofActivated ||
    hasCustody(record);
  const unavailable = (): NativeDeliveryDecision => ({
    status: "unavailable",
    reason: strict
      ? "queue_evidence_unavailable"
      : "inactive_observation_unavailable",
  });
  // The shared legacy reader performs multiple fresh state/rule observations.
  // Remember positive custody even if a later read throws or becomes unavailable.
  const stateView = new Proxy(options.state, {
    get(target, key) {
      if (key === "readRepair") {
        return async () => {
          const read = await target.readRepair();
          if (read.ok && read.value.status === "found") {
            strict ||= read.value.snapshot.work.some((row) =>
              row.id === record.id && hasCustody(row)
            );
          }
          return read;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const client = new Proxy(options.client, {
    get(target, key) {
      if (key === "readBranchRules") {
        return async (branch: string) => {
          const read = await target.readBranchRules(branch);
          if (read.ok) {
            strict ||= read.value.some((rule) => rule.type === "merge_queue");
          }
          return read;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  try {
    if (
      !Number.isFinite(input.deadline) ||
      options.clock.now() >= input.deadline || record.target.pr === null ||
      record.target.head === null || record.target.base === null
    ) return unavailable();
    const state = await stateView.readRepair();
    if (
      !state.ok || state.value.status !== "found" ||
      canonicalStringify(
          state.value.snapshot.work.find((row) => row.id === record.id) ?? null,
        ) !== canonicalStringify(record)
    ) return unavailable();
    const legacy = await resolveQueueLegacyDirect({
      ...options,
      state: stateView,
      client,
    }, input);
    if (legacy.status !== "complete") {
      return unavailable();
    }
    if (legacy.value !== null) return legacy.value;
    strict = true;
    const basis = await options.reader.readAuthorizationBasis({
      record,
      snapshot: state.value.snapshot,
      deadline: input.deadline,
    });
    if (basis.status !== "complete") return unavailable();
    const facts = await options.reader.read({
      ...input,
      snapshot: state.value.snapshot,
      currentTask: basis.value.task,
      now: options.clock.now(),
    });
    if (facts.status !== "complete") return unavailable();
    const proof = await resolveQueueAwareDelivery(facts.value, options.policy);
    const after = await options.state.readRepair();
    return after.ok && after.value.status === "found" &&
        after.value.head === state.value.head &&
        options.clock.now() < input.deadline
      ? proof
      : unavailable();
  } catch {
    return unavailable();
  }
}
