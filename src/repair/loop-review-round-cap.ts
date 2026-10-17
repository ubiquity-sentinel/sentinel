/**
 * Repair loop internals: parking a record at the hard review-round ceiling
 * (`review-round-cap.ts`, owner decision 2026-10-16).
 *
 * A park only writes the existing `markBlocked` transition of kind `other`
 * with one of the fixed ceiling messages. It never reserves, settles, refunds
 * or drops a charge, never clears the PR, head, base, candidate state,
 * evidence or receipts, and never merges or pushes: the parked record is idle
 * for the runtime. Only a REVIEWED or BASE_MOVED park is ever merged, by the
 * launcher's spent-round delivery rule (`isDeliverableReviewRoundCeilingPark`);
 * the others stay parked. Generation 79 parses the park and none of its
 * re-arm, recovery or re-admission rules match it.
 */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { ceilingParkMessage, reviewRoundsLeft } from "./review-round-cap.ts";
import { markBlocked } from "./transitions.ts";

/** The legacy review cutoff this run's round counts use (null: none). */
export function legacyCutoff(context: LoopContextV1): number | null {
  return context.legacyReviewCutoff ?? null;
}

/** True once this task may request no further review. */
export function reviewRoundsSpentOut(
  context: LoopContextV1,
  record: WorkRecordV1,
): boolean {
  return reviewRoundsLeft(context.snapshot, record, legacyCutoff(context)) ===
    0;
}

/** Persist one park (one compare-and-swap write); the record is then idle. */
export function parkAtReviewRoundCeiling(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  message: string = ceilingParkMessage(context.snapshot, record),
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    markBlocked(record, "other", message, deps.clock.now()),
  );
}

/**
 * The ceiling check every review request passes first, before the run
 * bounds, the freshness gate (so no refresh intent is written) and the
 * reservation: null while a round is left; otherwise a deferral while an
 * operation is in flight or the run deadline has passed, or the park, with
 * nothing spent and nothing read from GitHub.
 */
export function reviewRoundCeilingGate(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> | null {
  if (!reviewRoundsSpentOut(context, record)) return null;
  if (record.intent !== null) {
    return Promise.resolve({
      kind: "deferred",
      detail: "review round ceiling reached with an operation in flight",
    });
  }
  // The park is deterministic bookkeeping: it may run until the total run
  // deadline (past the model cutoff), never after it.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return Promise.resolve({
      kind: "deferred",
      detail: "review request is past the run bounds",
    });
  }
  return parkAtReviewRoundCeiling(deps, context, record);
}
