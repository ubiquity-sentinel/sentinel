/** Owner-authorized Passport work trial; this grants no merge or custody authority. */
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type {
  CandidatePreservationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";

export function isPassportWorkTrial(
  repository: Pick<RepositoryIdentityV1, "owner" | "name"> | undefined,
): boolean {
  return repository?.owner.toLowerCase() === "ubiquity" &&
    repository.name.toLowerCase() === "passport.ubq.fi";
}

/** A policy park cannot conceal an unfinished or unbound current admission. */
export function passportTrialCanReconsider(
  record: WorkRecordV1,
  reservations: readonly BudgetReservationV1[],
): boolean {
  if (!isPassportWorkTrial(record.repository)) return false;
  // A retained implementation intent is the attempt that parked the record.
  // `markBlocked` never clears it, so it is in flight only while that attempt's
  // charge is unsettled (proved below); requiring `intent === null` made a
  // settled park permanently unre-admittable. Any other intent kind is still
  // an unfinished publication or review operation and stays protected.
  const intent = record.intent;
  if (intent !== null && intent.kind !== "implementation") return false;
  const charges = reservations.filter((row) =>
    row.taskId === record.id &&
    row.repository.owner === record.repository.owner &&
    row.repository.name === record.repository.name &&
    row.repository.installationId === record.repository.installationId
  );
  // A `reserved` row is only in flight for a live attempt: an older attempt's
  // leaked row (passport-83's 2026-10-24 attempt-2 start) was already
  // superseded by later settlement and must not deny the current one. Review
  // reservations carry a review-round number in `attempt`, not an
  // implementation attempt, so they are never live implementation starts.
  if (
    charges.some((row) =>
      row.purpose !== "review_request" &&
      row.outcome === "reserved" &&
      row.attempt >= record.counters.attempts
    )
  ) return false;
  const current = charges.filter((row) =>
    row.purpose !== "review_request" &&
    row.attempt === record.counters.attempts
  );
  const charge = current[0];
  if (
    current.length !== 1 || charge.settledAt === null ||
    charge.purpose !==
      (record.counters.attempts === 1 ? "implementation" : "retry")
  ) return false;
  // A charge proves the retained attempt reached a settled end when it is a
  // confirmed `submitted`, or when an `ambiguous` charge of the current
  // attempt parked the record: the blocked record is that attempt's terminal
  // disposition. Timestamps cannot prove this order (`settleAndBlock` settles
  // from its own clock before blocking with the caller's earlier one), so the
  // attempt identity plus the terminal park is the invariant. The outcome
  // stays `ambiguous` (no refund, no new charge); a charge from an older
  // attempt, or a provably unsubmitted attempt, is not a settled model run.
  const settledAmbiguous = charge.outcome === "ambiguous" &&
    charge.attempt === record.counters.attempts &&
    charge.purpose ===
      (record.counters.attempts === 1 ? "implementation" : "retry") &&
    charge.settledAt !== null &&
    record.nextStep === "blocked" && record.blocker !== null;
  if (charge.outcome !== "submitted" && !settledAmbiguous) return false;
  if (intent !== null && intent.requestId !== charge.id) return false;
  if (charge.head === record.target.base) return true;
  const candidate = record.target.candidateState;
  const preserved = candidate?.preserved;
  if (
    !preserved || record.target.pr === null || record.target.head === null ||
    preserved.base !== record.target.base ||
    preserved.head !== record.target.head ||
    candidate?.publishedHead !== record.target.head
  ) return false;
  // Necessary tuple shape only. The async effect boundary must derive the ref.
  const match = /^base_refresh:([1-9][0-9]*):([0-9a-f]{40}):([0-9a-f]{40})$/
    .exec(preserved.operationKey);
  return match !== null && Number(match[1]) === record.target.pr &&
    match[3] === record.target.base &&
    /^refs\/heads\/sentinel-candidates\/[0-9a-f]{64}$/.test(preserved.ref);
}

/** Every published trial reentry needs the current exact preserved candidate. */
export function passportTrialCandidateBinding(
  record: WorkRecordV1,
  reservations: readonly BudgetReservationV1[],
): CandidatePreservationV1 | null {
  if (!passportTrialCanReconsider(record, reservations)) return null;
  const candidate = record.target.candidateState;
  const preserved = candidate?.preserved;
  return record.target.pr !== null && record.target.head !== null &&
      preserved !== null && preserved !== undefined &&
      preserved.base === record.target.base &&
      preserved.head === record.target.head &&
      candidate?.publishedHead === record.target.head
    ? preserved
    : null;
}
