/**
 * Launcher re-admission of review-ceiling parks after the owner raised the
 * ceiling (decision 2026-10-24: "you can have up to five reviews").
 */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_UNREVIEWED,
  reviewRoundsLeft,
} from "../src/repair/review-round-cap.ts";
import { intentClosable, type RetryPlanV1 } from "./hosted-autonomy-retries.ts";

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
 * Owner decision 2026-10-24 raised `MAX_REVIEW_ROUNDS` from three to five. A
 * record parked by the runtime's ceiling gate under the old ceiling (no
 * completed review, an unresolved P0, no task acceptance, or a moved base)
 * whose durable ledger now leaves a round (`reviewRoundsLeft`) returns to
 * `work` uncharged; the runtime then gates, refreshes, corrects or reviews it
 * on its ordinary path, and its ceiling gate parks it again at five. No
 * counter, reservation or review moves here, and a published head and pull
 * request are required.
 */
export function planRaisedCeilingReadmission(
  snapshot: RepairStateSnapshotV1,
  record: RepairStateSnapshotV1["work"][number],
  cutoff: number | null,
): RetryPlanV1 | null {
  const blocker = record.blocker;
  if (
    blocker === null || blocker.kind !== "other" ||
    !RAISED_CEILING_PARKS.includes(blocker.message) ||
    record.target.head === null || record.target.pr === null ||
    !intentClosable(record, snapshot.reservations) ||
    reviewRoundsLeft(snapshot, record, cutoff) === 0
  ) return null;
  return {
    id: record.id,
    repository: record.repository,
    grant: 0,
    nextStep: "work",
    reviewRounds: null,
    advanceBase: false,
    observedBase: null,
    detail: `${blocker.kind}${RAISED_CEILING_DETAIL_SUFFIX}`,
  };
}
