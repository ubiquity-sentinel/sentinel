/**
 * Launcher re-admission of historical review-ceiling parks. The review-round
 * ceiling is retired (owner directive 2026-10-30); this pass remains the
 * trusted way to return an already-parked record to its runtime step while
 * preserving every counter, charge and reservation.
 */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_REVIEWED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_UNREVIEWED,
} from "../src/repair/review-round-cap.ts";
import { intentClosable, type RetryPlanV1 } from "./hosted-autonomy-retries.ts";
import {
  isPassportWorkTrial,
  passportTrialCanReconsider,
} from "../src/repair/passport-work-trial.ts";

/** Ceiling parks a raised review-round ceiling can reopen (exact text). */
const RAISED_CEILING_PARKS: readonly string[] = [
  REVIEW_ROUND_CEILING_UNREVIEWED,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_BASE_MOVED,
];

/** Detail of a grant that reopens a ceiling park once rounds remain. */
export const RAISED_CEILING_DETAIL_SUFFIX = ":review_rounds_raised";

/**
 * A record parked by the retired runtime ceiling gate (no completed review,
 * an unresolved P0, no task acceptance, or a moved base) returns to `work`
 * uncharged: no round count bounds a review any more (`reviewRoundsLeft` is
 * unbounded), so the runtime then gates, refreshes, corrects or reviews it on
 * its ordinary path and never parks it for a spent count. A Passport trial's
 * REVIEWED park goes straight to delivery. No counter, reservation or review
 * moves here, and a published head and pull request are required.
 */
export function planRaisedCeilingReadmission(
  snapshot: RepairStateSnapshotV1,
  record: RepairStateSnapshotV1["work"][number],
  /** The run's legacy cutoff; a round count no longer gates re-admission. */
  _cutoff: number | null,
): RetryPlanV1 | null {
  const blocker = record.blocker;
  const trial = isPassportWorkTrial(record.repository);
  if (
    trial &&
    !passportTrialCanReconsider(record, snapshot.reservations)
  ) return null;
  if (
    blocker === null || blocker.kind !== "other" ||
    (!RAISED_CEILING_PARKS.includes(blocker.message) &&
      !(trial && blocker.message === REVIEW_ROUND_CEILING_REVIEWED)) ||
    record.target.head === null || record.target.pr === null ||
    !intentClosable(record, snapshot.reservations)
  ) return null;
  return {
    id: record.id,
    repository: record.repository,
    grant: 0,
    nextStep: trial && blocker.message === REVIEW_ROUND_CEILING_REVIEWED
      ? "delivery"
      : "work",
    reviewRounds: null,
    advanceBase: false,
    observedBase: null,
    detail: `${blocker.kind}${RAISED_CEILING_DETAIL_SUFFIX}`,
  };
}
