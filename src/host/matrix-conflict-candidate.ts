/** Exact read-only routing identity of a consumed conflict-resolution result. */
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  CandidatePreservationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { resolvedConflictResolution } from "../repair/conflict-resolution.ts";
import { MAX_BASE_REFRESH_FAILURES } from "../repair/loop-base-refresh-failure.ts";
import { isPassportWorkTrial } from "../repair/passport-work-trial.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../repair/keys.ts";
import type { MatrixArtifactRequestV1 } from "./matrix-artifact-port.ts";
import { sameRepository } from "./matrix-identity.ts";

export interface ResolvedConflictCandidateV1 extends MatrixArtifactRequestV1 {
  candidate: CandidatePreservationV1;
  publishedHead: NonNullable<WorkRecordV1["target"]["head"]>;
  /** Binds a synchronous routing hint to the complete row it was derived from. */
  recordFingerprint: string;
}

/** This identity grants no artifact, preservation, publication or state authority. */
export async function resolvedConflictCandidate(
  record: WorkRecordV1,
  reservations: readonly BudgetReservationV1[],
): Promise<ResolvedConflictCandidateV1 | null> {
  const intent = record.intent;
  const result = resolvedConflictResolution(intent);
  const { head, pr, branch, base, candidateState } = record.target;
  const preserved = candidateState?.preserved;
  if (
    record.nextStep !== "work" || record.blocker !== null ||
    (record.wait !== null && record.wait.reason !== "unavailable") ||
    record.source.kind !== "issue" || intent?.kind !== "base_refresh" ||
    result === null || head === null || pr === null || branch === null ||
    branch !== candidateBranch(record.id) || intent.branch !== branch ||
    intent.pr !== pr || intent.expectedHead !== head ||
    intent.requestId !== null || intent.observedBase === null ||
    intent.key !== baseRefreshIntentKey(pr, head, intent.observedBase) ||
    result === head || result === intent.observedBase ||
    !intent.failure || !Number.isSafeInteger(intent.failure.attempts) ||
    intent.failure.attempts < 1 ||
    (intent.failure.attempts - 1 >= MAX_BASE_REFRESH_FAILURES &&
      !isPassportWorkTrial(record.repository)) ||
    intent.failure.atMs < intent.startedAt ||
    record.target.selfMerge !== undefined || intent.selfMerge !== undefined ||
    candidateState?.publishedHead !== head || !preserved ||
    preserved.base !== base || preserved.head !== head ||
    preserved.operationKey === intent.key ||
    preserved.ref !==
      await candidatePreservationRef(
        record.repository,
        record.id,
        preserved.operationKey,
      )
  ) return null;
  // Include contradictory current-attempt admissions in the ambiguity check;
  // do not select the first good-looking row and ignore another charge.
  const matching = reservations.filter((row) =>
    row.taskId === record.id && row.attempt === record.counters.attempts &&
    row.purpose !== "review_request"
  );
  if (matching.length !== 1) return null;
  const charge = matching[0];
  if (
    !sameRepository(charge.repository, record.repository) ||
    charge.head !== base || charge.purpose !== "retry" ||
    charge.outcome !== "submitted" || charge.settledAt === null ||
    !Number.isSafeInteger(charge.settledAt) ||
    charge.settledAt < charge.createdAt || charge.createdAt > intent.startedAt
  ) return null;
  return {
    taskId: record.id,
    repository: record.repository,
    reservationId: charge.id,
    intentKey: implementationIntentKey(charge.id),
    expectedBase: base,
    attempt: charge.attempt,
    candidate: {
      operationKey: intent.key,
      base: intent.observedBase,
      head: result,
      ref: await candidatePreservationRef(
        record.repository,
        record.id,
        intent.key,
      ),
    },
    publishedHead: head,
    recordFingerprint: canonicalStringify(record),
  };
}

/** Never accept another row's typed hint, including a stale version of this row. */
export function resolvedConflictCandidateMatches(
  record: WorkRecordV1,
  binding: ResolvedConflictCandidateV1 | null | undefined,
): boolean {
  return binding !== null && binding !== undefined &&
    binding.taskId === record.id &&
    sameRepository(binding.repository, record.repository) &&
    binding.expectedBase === record.target.base &&
    binding.attempt === record.counters.attempts &&
    binding.intentKey === implementationIntentKey(binding.reservationId) &&
    binding.publishedHead === record.target.head &&
    binding.candidate.operationKey === record.intent?.key &&
    binding.candidate.base === record.intent?.observedBase &&
    binding.candidate.head === resolvedConflictResolution(record.intent) &&
    binding.recordFingerprint === canonicalStringify(record);
}
