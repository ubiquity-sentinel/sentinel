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
  if (!isPassportWorkTrial(record.repository) || record.intent !== null) {
    return false;
  }
  const charges = reservations.filter((row) =>
    row.taskId === record.id &&
    row.repository.owner === record.repository.owner &&
    row.repository.name === record.repository.name &&
    row.repository.installationId === record.repository.installationId
  );
  if (charges.some((row) => row.outcome === "reserved")) return false;
  const current = charges.filter((row) =>
    row.purpose !== "review_request" &&
    row.attempt === record.counters.attempts
  );
  if (
    current.length !== 1 || current[0].outcome !== "submitted" ||
    current[0].settledAt === null || current[0].purpose !==
      (record.counters.attempts === 1 ? "implementation" : "retry")
  ) return false;
  if (current[0].head === record.target.base) return true;
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
