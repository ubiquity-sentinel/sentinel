import { isVerifiedDeliveryProof } from "../../ops/hosted-autonomy-queue-proof.ts";
import { CHECK_POLL_MS } from "./loop-bounds.ts";
import { hasQueueDeliveryProvenance } from "../github/queue-delivery-provenance.ts";
import {
  hasQueueIntentNamespace,
  isQueueHeld,
} from "../../ops/hosted-autonomy-queue-policy.ts";
/** Final queue guards preserve original intent, candidate identity and charged accounting. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  NativeDeliveryDecision,
  QueueGuardReason,
} from "../github/native-queue-guard.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  isNativeQueueTarget,
  type NativeQueueOperation,
} from "../github/native-queue-guard.ts";
import {
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import { persistTransition } from "./loop-state.ts";
import { releaseRequestReceipt } from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";

/**
 * A hold is permanent only when the guard positively observed a state that
 * forbids the operation. Observation, authorization and transport failures
 * mean the operation was not observed, so they take the bounded retry wait.
 */
const QUEUE_GUARD_HOLD_TRANSIENT: Readonly<Record<QueueGuardReason, boolean>> =
  {
    capability_missing: true,
    rule_unavailable: true,
    observation_unavailable: true,
    inactive_observation_unavailable: true,
    authorization_unavailable: true,
    custody: false,
    member: false,
    identity_drift: false,
    merged_head: false,
    queue_required: false,
  };

function queueGuardHoldIsTransient(reason: QueueGuardReason): boolean {
  return QUEUE_GUARD_HOLD_TRANSIENT[reason];
}

function isQueueGuardReason(value: string): value is QueueGuardReason {
  return Object.hasOwn(QUEUE_GUARD_HOLD_TRANSIENT, value);
}

/**
 * A pre-m25 hold has no inspect reason. Only the bare scheduling hold is
 * eligible for recovery; queue intent and delivery provenance remain strict
 * custody evidence. The pre-ranking pass inspects the live queue before it
 * changes that wait.
 */
function isLegacyQueueHoldForInspection(record: WorkRecordV1): boolean {
  return (record.nextStep === "work" || record.nextStep === "review" ||
    record.nextStep === "delivery") &&
    isQueueHeld(record) &&
    !hasQueueIntentNamespace(record) &&
    !hasQueueDeliveryProvenance(record);
}

/**
 * Inspect each configured bare legacy hold before touching it. The queue
 * inspection is the real effect observation: `inspect` treats the durable
 * legacy wait itself as custody, so this pass asks the effect surface for the
 * record's exact branch and pull without presenting a held expected record.
 * A null pull request is the existing optional-field sentinel that makes the
 * guard resolve the PR from the branch; it is never a queue identity claim.
 */
export async function releaseLegacyQueueHoldsForInspection(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  attempted: Set<string>,
  githubFor?: (record: WorkRecordV1) => RepairCycleDepsV1["github"],
): Promise<StepResultV1 | null> {
  const records = context.snapshot.work.filter((record) =>
    !attempted.has(record.id) && isLegacyQueueHoldForInspection(record) &&
    deps.configs.some((config) =>
      sameRepositoryIdentity(config.repository, record.repository)
    )
  );
  if (records.length === 0) return null;
  const now = deps.clock.now();
  const waits = new Map<string, WorkRecordV1["wait"]>();
  for (const record of records) {
    attempted.add(record.id);
    const guard = (githubFor === undefined ? deps.github : githubFor(record))
      .nativeQueue;
    if (guard === undefined) continue;
    let decision;
    try {
      decision = await guard.inspectEffect({
        operation: "resume",
        branch: record.target.branch ?? undefined,
        pullRequest: null as unknown as number,
        expectedHead: record.target.head,
        deadline: context.bounds.runDeadline,
      });
    } catch {
      // An unobserved queue leaves the durable hold exactly as it was.
      continue;
    }
    if (decision.status === "allow") {
      waits.set(record.id, null);
    } else if (queueGuardHoldIsTransient(decision.reason)) {
      waits.set(record.id, {
        reason: "unavailable",
        since: record.wait?.reason === "unavailable" ? record.wait.since : now,
        until: now + CHECK_POLL_MS,
      });
    }
  }
  if (waits.size === 0) return null;
  return await persistTransition(deps, context, (draft) => {
    draft.work = draft.work.map((record) => {
      if (!waits.has(record.id) || !isLegacyQueueHoldForInspection(record)) {
        return record;
      }
      return { ...record, wait: waits.get(record.id)!, updatedAt: now };
    });
  });
}

export async function holdQueueRecord(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  transient = false,
): Promise<StepResultV1> {
  record = context.snapshot.work.find((row) => row.id === record.id) ?? record;
  if (record.wait?.reason === "backoff" && record.wait.until === null) {
    return { kind: "deferred", detail: "native merge queue custody hold" };
  }
  transient &&= !hasQueueIntentNamespace(record) &&
    !hasQueueDeliveryProvenance(record);
  const now = deps.clock.now();
  if (
    transient && record.wait?.reason === "unavailable" &&
    record.wait.until !== null && record.wait.until > now
  ) {
    return {
      kind: "deferred",
      detail: "native merge queue rule observation unavailable",
    };
  }
  // Bypass fairness counters: observing external custody is not a failed execution.
  const held = await persistTransition(deps, context, (draft) => {
    const index = draft.work.findIndex((row) => row.id === record.id);
    if (index < 0) throw new Error("queue hold work identity missing");
    draft.work[index] = {
      ...record,
      wait: transient
        ? {
          reason: "unavailable",
          since: record.wait?.reason === "unavailable"
            ? record.wait.since
            : now,
          until: now + CHECK_POLL_MS,
        }
        : { reason: "backoff", since: now, until: null },
      updatedAt: now,
    };
  });
  // Keep the existing loop progress semantics. This private result marker is
  // attached only after the state write and cannot enter JSON/stdout carriers.
  return held.kind === "progress"
    ? Object.defineProperty(held, "queueHold", { value: true })
    : held;
}
export async function guardQueueOperation(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  operation: NativeQueueOperation,
  expectedHead?: GitSha | null,
): Promise<StepResultV1 | null> {
  record = context.snapshot.work.find((row) => row.id === record.id) ?? record;
  if (!isNativeQueueTarget(record.repository)) return null;
  // Exact base-only review has no pull request and must not become queue custody.
  if (
    record.target.pr === null && record.target.branch === null &&
    operation === "resume"
  ) return null;
  if (
    operation === "resume" &&
    context.snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, record)
    )
  ) return await guardQueueDelivery(deps, context, record);
  const guard = deps.github.nativeQueue;
  if (guard === undefined) return await holdQueueRecord(deps, context, record);
  const result = await guard.inspect({
    record,
    operation,
    expectedHead,
    deadline: context.bounds.runDeadline,
  });
  return result.status === "allow" ? null : await holdQueueRecord(
    deps,
    context,
    record,
    queueGuardHoldIsTransient(result.reason),
  );
}
export async function guardQueueDelivery(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  receipt?: ReviewReceiptV1 | null,
  revision?: GitSha,
  acceptProof?: (
    proof: Extract<
      NativeDeliveryDecision,
      { status: "verified" | "legacy_direct" }
    >,
  ) => boolean,
): Promise<StepResultV1 | null> {
  record = context.snapshot.work.find((row) => row.id === record.id) ?? record;
  if (!isNativeQueueTarget(record.repository) || record.target.pr === null) {
    return null;
  }
  const request = context.snapshot.releaseRequests.find((row) =>
    releaseRequestMatchesDelivery(row, record)
  );
  const exactReceipt = receipt === undefined
    ? request === undefined
      ? null
      : releaseRequestReceipt(context.snapshot.reviews, request)
    : receipt;
  const exactRevision = revision ?? request?.revision;
  if (
    deps.github.nativeQueue === undefined || exactReceipt === null ||
    exactRevision === undefined
  ) return await holdQueueRecord(deps, context, record);
  const proof = await deps.github.nativeQueue.proveDelivery({
    record,
    receipt: exactReceipt,
    revision: exactRevision,
    deadline: context.bounds.runDeadline,
  });
  if (proof.status === "verified" || proof.status === "legacy_direct") {
    const binding = proof.status === "verified"
      ? proof.delivery
      : proof.binding;
    const actualRevision = proof.status === "verified"
      ? proof.delivery.revision
      : proof.revision;
    if (
      (proof.status === "verified" &&
        !isVerifiedDeliveryProof(proof.delivery)) ||
      canonicalStringify(binding.repository) !==
        canonicalStringify(record.repository) ||
      binding.pullRequest !== record.target.pr ||
      binding.base !== record.target.base ||
      binding.head !== record.target.head ||
      binding.reviewRequestId !== exactReceipt.requestId ||
      binding.reviewReceiptId !== exactReceipt.id ||
      actualRevision !== exactRevision ||
      (exactReceipt.taskAcceptance != null &&
        binding.taskDigest !== exactReceipt.taskAcceptance.taskDigest) ||
      (acceptProof !== undefined && !acceptProof(proof))
    ) return await holdQueueRecord(deps, context, record);
    return null;
  }
  return await holdQueueRecord(
    deps,
    context,
    record,
    proof.status === "unavailable" &&
      (proof.reason === "rule_unavailable" ||
        proof.reason === "inactive_observation_unavailable"),
  );
}

/** Fixed native refusal only; unrelated transport errors retain existing retry handling. */
export function queueEffectRefused(error: { detail: string }): boolean {
  return error.detail.startsWith("native queue custody");
}

export function queueRefusalIsTransient(error: { detail: string }): boolean {
  const prefix = "native queue custody hold: ";
  if (!error.detail.startsWith(prefix)) return false;
  const reason = error.detail.slice(prefix.length);
  return isQueueGuardReason(reason) && queueGuardHoldIsTransient(reason);
}
