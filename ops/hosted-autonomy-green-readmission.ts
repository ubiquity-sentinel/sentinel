/**
 * The launcher's green re-admission predicates in one place
 * (docs/backup-ci-spec.md §9.3, B13). A blocked record whose head may be
 * re-admitted once its CI reads green is a candidate for backup CI evidence:
 * the backup planner reads `greenReadmissionCandidate` instead of copying
 * the predicates, so a predicate added to a pass later is added here once.
 *
 * Exports only: every predicate is the pass's own, unchanged.
 * - `preReviewGateParked` (the pre-review gate's red, pending or exhausted
 *   park: the CI re-run pass and the retry pass's green rule);
 * - `ciRedeliveryEligible` / `ciGreenRedeliveryEligible` (the merge gate's
 *   CI park: correction and green re-delivery, also the retry pass's green
 *   read);
 * - `protectedOriginalCandidateShape` (the original-candidate pass, whose
 *   restoration requires `hasAllChecksGreen` on the original head);
 * - `closureCandidateShape`: a blocked record whose issue closure is in
 *   flight on a published head (the closure pass re-checks
 *   `hasAllChecksGreen` on that head before it closes; it has no exported
 *   predicate of its own, so this is the narrowest shape it reads).
 */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { preReviewGateParked } from "./hosted-autonomy-ci-first.ts";
import {
  ciGreenRedeliveryEligible,
  ciRedeliveryEligible,
} from "./hosted-autonomy-ci-retries.ts";
import { protectedOriginalCandidateShape } from "./hosted-autonomy-original-candidate.ts";

export {
  ciGreenRedeliveryEligible,
  ciRedeliveryEligible,
  preReviewGateParked,
  protectedOriginalCandidateShape,
};

type WorkRow = RepairStateSnapshotV1["work"][number];

/** A blocked record with its issue closure in flight on a published head. */
export function closureCandidateShape(record: WorkRow): boolean {
  return record.nextStep === "blocked" &&
    record.intent?.kind === "issue_closure" &&
    record.related.issueNumber !== null && record.target.pr !== null &&
    record.target.head !== null;
}

/** The union of the launcher's green re-admission predicates. */
export function greenReadmissionCandidate(
  snapshot: RepairStateSnapshotV1,
  record: WorkRow,
): boolean {
  return preReviewGateParked(snapshot, record) ||
    ciRedeliveryEligible(snapshot, record) ||
    ciGreenRedeliveryEligible(snapshot, record) ||
    protectedOriginalCandidateShape(record) ||
    closureCandidateShape(record);
}
