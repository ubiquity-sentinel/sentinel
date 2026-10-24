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
import {
  clearIntent,
  clearWait,
  countReviewRound,
  markBlocked,
} from "./transitions.ts";

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
 * Bound on a `review_request` intent left in flight at the ceiling with no
 * journal shown to conclude it: 6 hours, like the other ceiling waits. A
 * review attempt is bounded far below it (`REVIEW_BOUND_MS`), so an intent
 * that old no longer stands for a review that can still post.
 */
export const CEILING_REVIEW_INTENT_BOUND_MS = 6 * 60 * 60_000;

/**
 * The in-flight operation at the ceiling is a review attempt that is over:
 * a `review_request` intent whose own journal concluded (`concludedKey`, the
 * operation key a terminal no-verdict observation was read under), or one
 * started at least `CEILING_REVIEW_INTENT_BOUND_MS` ago (issue #155: live
 * 264's shape, counter 0 and three charges, kept its intent through every
 * no-verdict re-request and deferred here on every run). Any other intent
 * finishes first.
 */
function reviewIntentOver(
  record: WorkRecordV1,
  concludedKey: string | null,
  now: number,
): boolean {
  const intent = record.intent;
  return intent !== null && intent.kind === "review_request" &&
    (intent.key === concludedKey ||
      now - intent.startedAt >= CEILING_REVIEW_INTENT_BOUND_MS);
}

/**
 * The ceiling check every review request passes first, before the run
 * bounds, the freshness gate (so no refresh intent is written) and the
 * reservation: null while a round is left; otherwise a deferral while an
 * operation is in flight or the run deadline has passed, or the park, with
 * nothing spent and nothing read from GitHub. A review attempt that is over
 * (`reviewIntentOver`) is recovered as `recoverExpiredReviewAttempt` does:
 * its round is counted once and its intent cleared (its charge kept, never
 * refunded or moved), in the same write as the park.
 */
export function reviewRoundCeilingGate(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  /** The operation key of a review journal just observed concluded. */
  concludedKey: string | null = null,
): Promise<StepResultV1> | null {
  if (!reviewRoundsSpentOut(context, record)) return null;
  const now = deps.clock.now();
  let parked = record;
  if (record.intent !== null) {
    if (!reviewIntentOver(record, concludedKey, now)) {
      return Promise.resolve({
        kind: "deferred",
        detail: "review round ceiling reached with an operation in flight",
      });
    }
    parked = countReviewRound(clearIntent(clearWait(record, now), now), now);
  }
  // The park is deterministic bookkeeping: it may run until the total run
  // deadline (past the model cutoff), never after it.
  if (now >= context.bounds.runDeadline) {
    return Promise.resolve({
      kind: "deferred",
      detail: "review request is past the run bounds",
    });
  }
  return parkAtReviewRoundCeiling(deps, context, parked);
}
