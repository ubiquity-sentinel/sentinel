/**
 * Repair loop internals: pure policy of the base-refresh conflict resolution.
 *
 * A published candidate H whose deterministic refresh onto the moved base B
 * conflicts is no longer parked for good. While the route is open and the
 * record keeps the exact shape below, the conflict schedules ONE charged
 * resolution attempt per (task, base tip): the model resolves the conflicts
 * of a checkout of H with B merged in, the trusted host commits the merge M
 * (parents H and B), and M is preserved under the refresh binding and
 * published as a fast-forward of H with the normal lease, so the open pull
 * request updates in place and M is reviewed against B like any refresh.
 *
 * Rollback contract: nothing here adds a field, key or enum value. The whole
 * lifecycle is carried by existing intent shapes plus the optional intent
 * `failure` record (the "conflict marker"), which no consumer of an
 * implementation intent reads and which generation 77 already parses:
 *
 * - pending:   the `base_refresh` intent (P, H, B) with no result + marker;
 * - in flight: the ordinary implementation intent + marker;
 * - resolved:  the `base_refresh` intent (P, H, B) with result M + marker.
 *
 * A hosted ingest preserves M under the refresh binding of (P, H, B) before
 * it consumes the receipt (`preserveConflictMerge`), writing nothing else, so
 * any later job reconciles M from the remote instead of its own mirror.
 *
 * Generation 77, and generation 78 in a hosted run (route closed), runs a
 * pending intent as an ordinary refresh, which conflicts again and writes the
 * terminal block (nothing charged, nothing pushed); generation 78 publishes a
 * resolved intent exactly like this tree.
 */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { BASE_REFRESH_CONFLICT_DETAIL } from "../contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type {
  IncompleteOperationV1,
  OperationFailureV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import { CI_CORRECTION_REVIEW_ROUNDS } from "./ci-rejection.ts";
import { baseRefreshIntentKey, candidateBranch } from "./keys.ts";
import { releaseRequestMatchesDelivery } from "./loop-records.ts";
import { headRejectedByReview } from "./loop-review-records.ts";

/**
 * Whether a HOSTED run may open a conflict resolution. A hosted resolution
 * runs as a matrix cell, and a cell planned in one run may be consumed only
 * by a later run, which after a failed generation's rollback runs the
 * rollback target's code. Generation 77 (ab3613e02) refused every form of
 * that cell, so generation 78 kept the route closed. Generation 78
 * (474f87eb6), the rollback target of generation 79, handles or isolates
 * everything the open route writes, proven by tests that run its own code:
 * its strict plan parser accepts the `mergeBase` request, its wave gate
 * authenticates the bound cell and its runtime-mismatch isolation parks the
 * record with the admission (marker and `reserved` charge) retained; its
 * hosted loop terminal-blocks a pending intent uncharged, defers an in-flight
 * one, and publishes a resolved merge like this tree. So the route is open
 * in hosted runs from generation 79 on.
 */
export const HOSTED_CONFLICT_RESOLUTIONS = true;

/**
 * The conflict-resolution route is open for this run: always in process, and
 * in a hosted (matrix) run while `HOSTED_CONFLICT_RESOLUTIONS` is set.
 */
export function conflictResolutionRouteOpen(
  deps: { externalImplementations?: boolean },
): boolean {
  return deps.externalImplementations !== true || HOSTED_CONFLICT_RESOLUTIONS;
}

/**
 * Review rounds after which a refresh conflict keeps its terminal block: a
 * resolved merge needs a review round of its own. Equal to the CI-correction
 * ceiling, which a test pins to `HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS`.
 */
export const CONFLICT_RESOLUTION_REVIEW_ROUNDS = CI_CORRECTION_REVIEW_ROUNDS;

/**
 * Bound on conflict-resolution cells one hosted wave grants. Every cell still
 * unconsumed when a failed generation rolls back is isolated by the rollback
 * target with its admission retained (blocked for the owner, its charge kept),
 * so this bounds that exposure per wave; a pending resolution past the cap
 * stays pending, uncharged, for a later wave.
 */
export const HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE = 4;

/**
 * How long after its admission a hosted conflict-resolution receipt is kept
 * unconsumed while the preservation of its merge fails transiently (see
 * `preserveConflictMerge`). Past it the receipt is consumed as before.
 */
export const CONFLICT_MERGE_PRESERVE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Blocker of a resolved merge that touches a protected path. */
export const CONFLICT_PROTECTED_DETAIL = "candidate touches a protected path";

/** Operation-failure kind of the conflict marker. */
export const CONFLICT_MARKER_KIND = "conflict";

const MARKER_DETAIL = new RegExp(
  `^${BASE_REFRESH_CONFLICT_DETAIL} at ([0-9a-f]{40})$`,
);

/**
 * The conflict marker: the exact base tip the candidate conflicts with. Its
 * detail is the adapter's own closed conflict detail plus that base, a text
 * no other failure record carries; `attempts` starts at 1, so the bounded
 * refresh failure accounting counts `attempts - 1` for a marked intent.
 */
export function conflictMarker(
  mergeBase: GitSha,
  atMs: number,
): OperationFailureV1 {
  return {
    kind: CONFLICT_MARKER_KIND,
    detail: `${BASE_REFRESH_CONFLICT_DETAIL} at ${mergeBase}`,
    atMs,
    attempts: 1,
  };
}

/** The base tip a marked intent names, or null for any other intent. */
export function conflictMarkerBase(
  intent: IncompleteOperationV1 | null | undefined,
): GitSha | null {
  const failure = intent?.failure;
  if (failure === undefined || failure.kind !== CONFLICT_MARKER_KIND) {
    return null;
  }
  const match = MARKER_DETAIL.exec(failure.detail);
  return match === null ? null : match[1] as GitSha;
}

/** Pending: the unresolved refresh intent of the marked base, or null. */
export function pendingConflictResolution(
  intent: IncompleteOperationV1 | null | undefined,
): GitSha | null {
  if (intent?.kind !== "base_refresh" || intent.resultId !== null) return null;
  const mergeBase = conflictMarkerBase(intent);
  return mergeBase !== null && mergeBase === intent.observedBase
    ? mergeBase
    : null;
}

/** In flight: the marked base of a charged resolution attempt, or null. */
export function conflictResolutionInFlight(
  intent: IncompleteOperationV1 | null | undefined,
): GitSha | null {
  return intent?.kind === "implementation" ? conflictMarkerBase(intent) : null;
}

/** Resolved: the model-resolved merge commit awaiting publication, or null. */
export function resolvedConflictResolution(
  intent: IncompleteOperationV1 | null | undefined,
): GitSha | null {
  if (intent?.kind !== "base_refresh" || intent.resultId === null) return null;
  const mergeBase = conflictMarkerBase(intent);
  return mergeBase !== null && mergeBase === intent.observedBase &&
      isGitSha(intent.resultId)
    ? intent.resultId
    : null;
}

/**
 * The record shape a refresh conflict may be resolved for: an issue task
 * holding its exact, durably described publication (deterministic branch,
 * open PR identity, preserved descriptor and published head all at H on its
 * base), no self-merge, a review round left for the merge, a head no review
 * rejected (that head needs a correction, not a refresh) and no release.
 */
export function conflictResolutionShape(
  record: WorkRecordV1,
  snapshot: RepairStateSnapshotV1,
): boolean {
  const { head, pr, branch, base, candidateState } = record.target;
  if (
    record.source.kind !== "issue" || head === null || pr === null ||
    branch === null || branch !== candidateBranch(record.id) || head === base
  ) return false;
  const preserved = candidateState?.preserved ?? null;
  if (
    preserved === null || preserved.head !== head || preserved.base !== base ||
    candidateState?.publishedHead !== head
  ) return false;
  if (
    record.target.selfMerge !== undefined ||
    record.intent?.selfMerge !== undefined
  ) return false;
  if (record.counters.reviewRounds >= CONFLICT_RESOLUTION_REVIEW_ROUNDS) {
    return false;
  }
  if (headRejectedByReview(snapshot, record)) return false;
  return !snapshot.releaseRequests.some((request) =>
    releaseRequestMatchesDelivery(request, record)
  );
}

/**
 * The pending resolution this run may admit (a charged model start), or
 * null: the route is open, the record is at `work`, its pending intent binds
 * the record's exact publication and the shape still holds.
 */
export function conflictResolutionAdmissible(
  routeOpen: boolean,
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): GitSha | null {
  if (!routeOpen || record.nextStep !== "work") return null;
  const intent = record.intent;
  const mergeBase = pendingConflictResolution(intent);
  const { head, pr, branch } = record.target;
  if (
    mergeBase === null || intent === null || head === null || pr === null ||
    intent.expectedHead !== head || intent.pr !== pr ||
    intent.branch !== branch ||
    intent.key !== baseRefreshIntentKey(pr, head, mergeBase)
  ) return null;
  return conflictResolutionShape(record, snapshot) ? mergeBase : null;
}

/**
 * The pending state written instead of the terminal conflict block: the same
 * refresh intent (exact key, no result) carrying the marker, at `work` with
 * the PR identity kept. Nothing is charged here.
 */
export function pendingConflictRecord(
  record: WorkRecordV1,
  intent: IncompleteOperationV1,
  mergeBase: GitSha,
  at: number,
): WorkRecordV1 {
  const { head, pr } = record.target;
  return {
    ...record,
    nextStep: "work",
    wait: null,
    blocker: null,
    intent: {
      ...intent,
      key: head === null || pr === null
        ? intent.key
        : baseRefreshIntentKey(pr, head, mergeBase),
      observedBase: mergeBase,
      resultId: null,
      failure: conflictMarker(mergeBase, at),
    },
    updatedAt: at,
  };
}
