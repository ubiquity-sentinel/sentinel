import { resolveQueueLegacyDirect } from "./queue-legacy-direct.ts";
/** Native adapter for the one shared queue-first proof constructor. */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
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
  const unavailable = {
    status: "unavailable" as const,
    reason: "queue_evidence_unavailable" as const,
  };
  const { record } = input;
  if (
    options.clock.now() >= input.deadline || record.target.pr === null ||
    record.target.head === null || record.target.base === null
  ) return unavailable;
  const state = await options.state.readRepair();
  if (
    !state.ok || state.value.status !== "found" ||
    canonicalStringify(
        state.value.snapshot.work.find((row) => row.id === record.id) ?? null,
      ) !== canonicalStringify(record)
  ) return unavailable;
  const legacy = await resolveQueueLegacyDirect(options, input);
  if (legacy.status !== "complete") {
    return legacy.reason === "rule_unavailable" ? legacy : unavailable;
  }
  if (legacy.value !== null) return legacy.value;
  const basis = await options.reader.readAuthorizationBasis({
    record,
    snapshot: state.value.snapshot,
    deadline: input.deadline,
  });
  if (basis.status !== "complete") return unavailable;
  const facts = await options.reader.read({
    ...input,
    snapshot: state.value.snapshot,
    currentTask: basis.value.task,
    now: options.clock.now(),
  });
  if (facts.status !== "complete") return unavailable;
  const proof = await resolveQueueAwareDelivery(facts.value, options.policy);
  const after = await options.state.readRepair();
  return after.ok && after.value.status === "found" &&
      after.value.head === state.value.head &&
      options.clock.now() < input.deadline
    ? proof
    : unavailable;
}
