/**
 * Repair loop internals: the retired review-round ceiling gate.
 *
 * Owner directive 2026-10-30: a spent review-round count is accounting, never
 * a permanent park. The runtime keeps iterating (review -> fix -> review)
 * until the current head has a completed review with no P0, or a different
 * blocker applies. `reviewRoundCeilingGate` therefore always admits a review
 * request, and `reviewRoundsSpentOut` no longer reports a spent count: it
 * reports the carried fact instead (the reviewed head needs no new review).
 *
 * `parkAtReviewRoundCeiling` remains for the carried-delivery timeout, stall
 * and refresh-limit parks that share the `review round ceiling reached:`
 * prefix; those are bounded delivery conditions, not a spent round count.
 */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { ceilingParkMessage, spentReviewedHead } from "./review-round-cap.ts";
import { markBlocked } from "./transitions.ts";

/** The legacy review cutoff this run's round counts use (null: none). */
export function legacyCutoff(context: LoopContextV1): number | null {
  return context.legacyReviewCutoff ?? null;
}

/**
 * True when this record's reviewed head is delivered by the carried rule: its
 * historical count is spent (`ordinaryReviewRoundsSpent`, accounting only) and
 * its latest completed review is clean and accepted (`spentReviewedHead`). It
 * selects the carried-delivery path (`executeCarriedDelivery`,
 * `spentOnMovedBase`); it never gates a review and never parks a record.
 */
export function reviewRoundsSpentOut(
  context: LoopContextV1,
  record: WorkRecordV1,
): boolean {
  return spentReviewedHead(context.snapshot, record);
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
 * The retired ceiling check every review request used to pass first. It now
 * always admits the request: the counter is accounting, not an admission
 * gate. Retained with its exact signature for `requestReviewFor`.
 */
export function reviewRoundCeilingGate(
  _deps: RepairCycleDepsV1,
  _context: LoopContextV1,
  _record: WorkRecordV1,
  _concludedKey: string | null = null,
): Promise<StepResultV1> | null {
  return null;
}
