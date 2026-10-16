/** Repair loop internals: eligibility. */
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { ciCorrectionRouteOpen } from "./ci-rejection.ts";
import { OPERATION_MARGIN_MS } from "./loop-bounds.ts";
import { configFor } from "./loop-records.ts";
import { headNeedsCorrection } from "./loop-review-records.ts";
import type { LoopContextV1, RepairCycleDepsV1 } from "./loop-types.ts";

/**
 * True only when this record's NEXT work step is an implementation start the
 * ordinary lifecycle would dispatch to `executeImplementationStep`: a GitHub
 * issue at `work`, with no in-flight operation intent, no unusable candidate
 * lifecycle, a deterministic branch and a real session bound, and either a
 * fresh candidate (no saved head) or a review-rejected candidate correction.
 * This mirrors the real dispatcher's implementation branch; review, delivery,
 * preservation, live-intent and unpublished-head records are left to the
 * ordinary serial lifecycle and must never receive a matrix grant.
 */
/**
 * TTL for an in-flight implementation intent. Any implementation intent older
 * than this with no result is treated as stale (its run died without settling)
 * and no longer blocks re-admission. 6h exceeds the 5h matrix timeout ceiling.
 */
export const STALE_IMPLEMENTATION_INTENT_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * True when an implementation intent is stale: started longer than the TTL ago
 * with no result recorded. Stale intents come from runs that died after
 * reserving but before settling; they must not block re-admission forever.
 */
export function isStaleImplementationIntent(
  intent: IncompleteOperationV1 | null,
  now: number,
): boolean {
  if (intent === null) return false;
  if (intent.kind !== "implementation") return false;
  if (intent.resultId !== null) return false;
  return intent.startedAt <= now - STALE_IMPLEMENTATION_INTENT_TTL_MS;
}

export function isMatrixImplementationReadyV1(
  record: WorkRecordV1,
  snapshot: RepairStateSnapshotV1,
  config: RepositoryConfigV1,
  now: number,
  /** `ciCorrectionRouteOpen(deps)` of the planning run. */
  ciRouteOpen = true,
): boolean {
  if (record.source.kind !== "issue") return false;
  if (record.nextStep !== "work") return false;
  if (
    record.intent !== null &&
    !isStaleImplementationIntent(record.intent, now)
  ) return false;
  const candidateState = record.target.candidateState;
  if (candidateState !== undefined && candidateState.preserved === null) {
    return false;
  }
  if (record.target.branch === null) return false;
  if (config.sessionBound === null) return false;
  return record.target.head === null ||
    headNeedsCorrection(snapshot, record, ciRouteOpen);
}

// ---------------------------------------------------------------------------
// Scheduling: declared operations must fit the run bounds.
// ---------------------------------------------------------------------------

/**
 * A record whose immediate next action starts NEW model work (implementation
 * or a correction session). Review/publish phases keep their deterministic
 * parts but their review request is gated at the request site (they have no
 * declared session duration of their own).
 */
export function isModelStartAction(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  /** `ciCorrectionRouteOpen(deps)` of the run. */
  ciRouteOpen = true,
): boolean {
  return record.nextStep === "work" &&
    (record.target.head === null ||
      headNeedsCorrection(snapshot, record, ciRouteOpen));
}

/**
 * Whether the declared operation of `record` may start now: the clock must be
 * before the bounded run deadline, and a model start additionally requires the
 * full declared session plus the reserved margin AND a clock before the
 * no-new-model-work cutoff. Deterministic operations stay available within
 * the reserved margin up to the total deadline.
 */
export function declaredOperationFits(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): boolean {
  const bounds = context.bounds;
  const now = deps.clock.now();
  if (now >= bounds.runDeadline) return false;
  const config = configFor(deps, record.repository);
  if (config === null) return false;
  // Fresh matrix intake still needs the ordinary deterministic branch assignment.
  // No model admission occurs until the planner prepares the resulting record.
  if (
    deps.externalImplementations === true && record.nextStep === "work" &&
    record.intent === null && record.target.branch === null
  ) return true;
  if (
    isModelStartAction(context.snapshot, record, ciCorrectionRouteOpen(deps))
  ) {
    if (now >= bounds.modelCutoff) return false;
    const bound = config.sessionBound;
    if (bound === null) return true;
    if (now + bound.maxDurationMs + OPERATION_MARGIN_MS > bounds.runDeadline) {
      return false;
    }
  }
  return true;
}
