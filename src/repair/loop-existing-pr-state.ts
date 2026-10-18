/** Existing V1 native custody transitions. No producer, review or charge is invented. */
import type {
  NativeTakeoverObservation,
  TakeoverPreserveRequest,
} from "../contracts/existing-pr-takeover.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  nativeTakeoverIntentKey,
  TAKEOVER_EVIDENCE_NAMESPACE,
  TAKEOVER_NATIVE_PRESERVED,
  TAKEOVER_NATIVE_PRESERVING,
  takeoverAnchorRef,
  takeoverBindingDigest,
  takeoverNativeRef,
  takeoverProvenanceRef,
} from "../github/existing-pr-takeover-provenance.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { persistTransition, replaceWorkMutation } from "./loop-state.ts";

export async function nativePreserveRequest(
  context: LoopContextV1,
  candidate: NativeTakeoverObservation,
): Promise<TakeoverPreserveRequest | null> {
  if (context.head === null) return null;
  const bindingDigest = await takeoverBindingDigest(candidate.binding);
  return {
    binding: candidate.binding,
    bindingDigest,
    head: candidate.head,
    base: candidate.base,
    ref: await takeoverNativeRef({
      bindingDigest,
      head: candidate.head,
      base: candidate.base,
    }),
    expectedStateHead: context.head,
    deadline: context.bounds.runDeadline,
  };
}

export function persistNativeIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: TakeoverPreserveRequest,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  return persistTransition(
    deps,
    context,
    replaceWorkMutation({
      ...record,
      nextStep: "blocked",
      blocker: {
        kind: "other",
        message: TAKEOVER_NATIVE_PRESERVING,
        since: now,
      },
      wait: null,
      target: {
        base: request.base,
        branch: request.binding.headRef,
        head: request.head,
        pr: request.binding.pullRequest,
        checkpoint: null,
        candidateState: { preserved: null, publishedHead: request.head },
      },
      evidence: [...record.evidence, takeoverAnchorRef(request.bindingDigest)],
      intent: {
        kind: "push",
        key: nativeTakeoverIntentKey(request),
        startedAt: now,
        branch: request.ref,
        expectedHead: request.head,
        observedBase: request.base,
        pr: null,
        requestId: null,
        resultId: null,
      },
      updatedAt: now,
    }),
    request.expectedStateHead,
  );
}

export function persistNativeAnchor(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: TakeoverPreserveRequest,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  return persistTransition(
    deps,
    context,
    replaceWorkMutation({
      ...record,
      intent: null,
      wait: null,
      nextStep: "blocked",
      blocker: {
        kind: "other",
        message: TAKEOVER_NATIVE_PRESERVED,
        since: now,
      },
      updatedAt: now,
    }),
    request.expectedStateHead,
  );
}

export function persistNativePointer(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  request: TakeoverPreserveRequest,
): Promise<StepResultV1> {
  return persistTransition(
    deps,
    context,
    replaceWorkMutation({
      ...record,
      intent: null,
      wait: null,
      nextStep: "work",
      blocker: null,
      evidence: [
        ...record.evidence.filter((row) =>
          !row.ref.startsWith(TAKEOVER_EVIDENCE_NAMESPACE)
        ),
        takeoverProvenanceRef(request.bindingDigest, request.expectedStateHead),
      ],
      updatedAt: deps.clock.now(),
    }),
    request.expectedStateHead,
  );
}

const QUEUE_PREFLIGHT_HOLD =
  "existing PR preflight: native queue observation unavailable";

/** This marker owns only an initially unbound, idle work transition. */
export function isExistingPrQueuePreflightHold(record: WorkRecordV1): boolean {
  return record.source.kind === "issue" && record.target.pr === null &&
    record.target.head === null && record.intent === null &&
    record.nextStep === "blocked" && record.blocker?.kind === "other" &&
    record.blocker.message === QUEUE_PREFLIGHT_HOLD &&
    record.wait?.reason === "backoff" && record.wait.until === null;
}

export function canHoldExistingPrQueuePreflight(record: WorkRecordV1): boolean {
  return record.source.kind === "issue" && record.target.pr === null &&
    record.target.head === null && record.intent === null &&
    record.nextStep === "work" && record.blocker === null &&
    record.wait === null;
}

export function persistExistingPrQueuePreflightHold(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  if (context.head === null || !canHoldExistingPrQueuePreflight(record)) {
    return Promise.resolve({
      kind: "deferred",
      detail: "existing PR preflight wait is not owned",
    });
  }
  const now = deps.clock.now();
  return persistTransition(
    deps,
    context,
    replaceWorkMutation({
      ...record,
      nextStep: "blocked",
      blocker: { kind: "other", message: QUEUE_PREFLIGHT_HOLD, since: now },
      wait: { reason: "backoff", until: null, since: now },
      updatedAt: now,
    }),
    context.head,
  );
}

/** Called only after this pass's native absence and complete negative PR discovery. */
export function resumeExistingPrQueuePreflight(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  if (context.head === null || !isExistingPrQueuePreflightHold(record)) {
    return Promise.resolve({
      kind: "deferred",
      detail: "existing PR preflight wait is not owned",
    });
  }
  return persistTransition(
    deps,
    context,
    replaceWorkMutation({
      ...record,
      nextStep: "work",
      blocker: null,
      wait: null,
      updatedAt: deps.clock.now(),
    }),
    context.head,
  );
}
