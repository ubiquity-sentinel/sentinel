/**
 * One-time launcher re-arms of two park classes whose parking rule has since
 * been fixed (owner approval 2026-11-13). Each is a retry-table rule
 * (`historicalRearm` in `HOSTED_AUTONOMY_RETRYABLE`) bounded by the table's
 * `blockedBefore` cutoff (`HISTORICAL_PARK_REARM_CUTOFF_MS`): only a park
 * written before it qualifies, so a re-armed record parked again for the same
 * reason stays parked. Nothing here charges, refunds, settles or reuses a
 * reservation; every start that follows is admitted and charged by the
 * runtime's ordinary gates.
 *
 * - `carried_patch`: a spent record whose latest completed review of another
 *   head is clean and accepted, parked because its refreshed head "does not
 *   carry the reviewed patch" under the exact-digest rule. It returns to
 *   `work` with nothing else changed, where the runtime's carried delivery
 *   (`executeCarriedDelivery`) re-proves the patch under the drift rule and
 *   parks it again if it still does not carry; otherwise it gates the head's
 *   own CI, refreshes onto a moved tip (a conflict takes the existing
 *   conflict path), requires the live task acceptance and only then writes
 *   the carried-merge marker the launcher's merge gates re-derive.
 * - `base_review_work_needed`: a no-change issue record parked with
 *   `BASE_REVIEW_NOT_ESTABLISHED` whose completed base review, recovered from
 *   its digest-bound result comment (`hosted-autonomy-base-review-verdicts.ts`),
 *   answered that work is still needed. It returns to `work` exactly as the
 *   runtime now writes that outcome (intent, wait and blocker cleared, the
 *   reviewed base and the review evidence kept) while the task's durable
 *   no-change outcomes are below `MAX_NO_CHANGE_BASE_REVIEWS`.
 */
import {
  findReservationV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import {
  type BaseReviewEvidenceV1,
  parseBaseReviewEvidenceRef,
} from "../src/github/base-review-evidence.ts";
import {
  BASE_REVIEW_NOT_ESTABLISHED,
  MAX_NO_CHANGE_BASE_REVIEWS,
  noChangeIssue,
  noChangeOutcomes,
} from "../src/repair/base-satisfaction-marker.ts";
import { candidateBranch } from "../src/repair/keys.ts";
import {
  latestCompletedPullRequestReview,
  spentReviewedHead,
} from "../src/repair/review-round-cap.ts";
import {
  HISTORICAL_PARK_REARM_CUTOFF_MS,
  type HistoricalRearmV1,
  hostedRepositoryKey,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import type { RetryPlanV1 } from "./hosted-autonomy-retries.ts";

type WorkRecord = RepairStateSnapshotV1["work"][number];

/** Denial: the park is not the exact historical shape this re-arm takes. */
export const HISTORICAL_REARM_SHAPE = "historical_rearm_shape";
/** Denial: the task already reached the runtime's no-change bound. */
export const HISTORICAL_REARM_NO_CHANGE_BOUND =
  "historical_rearm_no_change_bound";
/** Denial: no work-needed verdict was recovered for the base review. */
export const HISTORICAL_REARM_VERDICT_UNVERIFIED =
  "historical_rearm_verdict_unverified";

/**
 * The carried-delivery shape the runtime enters at `work` with no intent: an
 * issue record with its own published pull request whose latest completed
 * review is of an earlier head, clean and task-accepted, with its ordinary
 * review rounds spent (`spentReviewedHead`, the runtime's
 * `reviewRoundsSpentOut`).
 */
export function carriedPatchRearmable(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecord,
): boolean {
  const { head, pr, branch } = record.target;
  if (
    record.nextStep !== "blocked" || record.blocker?.kind !== "other" ||
    record.intent !== null || record.source.kind !== "issue" ||
    head === null || pr === null || branch !== candidateBranch(record.id)
  ) return false;
  const latest = latestCompletedPullRequestReview(snapshot, record);
  return latest !== null && latest.pullRequest.head !== head &&
    spentReviewedHead(snapshot, record);
}

const BASE_REVIEW_KEY = /^base-review:([0-9a-f]{64}):([0-9a-f]{64})$/;

/**
 * The exact base-review binding a historical `BASE_REVIEW_NOT_ESTABLISHED`
 * park retains, or null: the runtime's issue-closure intent naming its
 * settled review admission and result digest, the one evidence ref binding
 * both at the record's base and issue, the review charge `submitted` at that
 * base and the original no-change implementation charge settled, all of
 * this task in this repository.
 */
export function baseReviewRearmBinding(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecord,
): BaseReviewEvidenceV1 | null {
  const intent = record.intent;
  const base = record.target.base;
  if (
    record.nextStep !== "blocked" ||
    record.blocker?.kind !== "missing_evidence" ||
    record.blocker.message !== BASE_REVIEW_NOT_ESTABLISHED ||
    !noChangeIssue(record) || base === null ||
    intent?.kind !== "issue_closure" || intent.requestId === null ||
    intent.resultId === null || intent.expectedHead !== base ||
    intent.observedBase !== base || intent.pr !== null
  ) return null;
  const key = BASE_REVIEW_KEY.exec(intent.key);
  if (key === null) return null;
  const bindings = record.evidence.flatMap((row) => {
    const binding = row.kind === "review_receipt"
      ? parseBaseReviewEvidenceRef(row.ref)
      : null;
    return binding !== null && binding.admission === intent.requestId &&
        binding.resultDigest === intent.resultId
      ? [binding]
      : [];
  });
  if (bindings.length !== 1) return null;
  const binding = bindings[0];
  if (
    binding.issueNumber !== record.related.issueNumber ||
    binding.base !== base || binding.taskDigest !== key[2]
  ) return null;
  const own = (id: string) => {
    const charge = findReservationV1(snapshot, id);
    return charge !== undefined && charge.taskId === record.id &&
        sameRepository(charge.repository, record.repository)
      ? charge
      : null;
  };
  const review = own(binding.admission);
  const origin = own(key[1]);
  return review !== null && review.purpose === "review_request" &&
      review.outcome === "submitted" && review.head === base &&
      origin !== null &&
      (origin.purpose === "implementation" || origin.purpose === "retry") &&
      (origin.outcome === "submitted" || origin.outcome === "ambiguous")
    ? binding
    : null;
}

/** The identity a recovered work-needed verdict is reported under. */
export function baseReviewVerdictKey(
  record: WorkRecord,
  binding: BaseReviewEvidenceV1,
): string {
  return `${
    hostedRepositoryKey(record.repository)
  }#${record.id}#${binding.admission}#${binding.resultDigest}`;
}

/**
 * The candidate whose verdict the retry pass reads: a historical park of the
 * exact base-review shape still below the no-change bound. Null otherwise.
 */
export function baseReviewRearmCandidate(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecord,
): BaseReviewEvidenceV1 | null {
  if (
    record.blocker === null ||
    !(record.blocker.since < HISTORICAL_PARK_REARM_CUTOFF_MS)
  ) return null;
  const binding = baseReviewRearmBinding(snapshot, record);
  return binding !== null &&
      noChangeOutcomes(snapshot, record) < MAX_NO_CHANGE_BASE_REVIEWS
    ? binding
    : null;
}

/**
 * The one-time re-arm of a historical park (its rule's `blockedBefore`
 * already checked by the caller): a plain, uncharged, non-advancing return to
 * `work`, or the denial reason. `workNeeded` holds the
 * `baseReviewVerdictKey` values whose result comment the retry pass verified.
 */
export function planHistoricalRearm(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecord,
  kind: HistoricalRearmV1,
  workNeeded: ReadonlySet<string>,
): RetryPlanV1 | string {
  if (kind === "carried_patch") {
    if (!carriedPatchRearmable(snapshot, record)) return HISTORICAL_REARM_SHAPE;
  } else {
    const binding = baseReviewRearmBinding(snapshot, record);
    if (binding === null) return HISTORICAL_REARM_SHAPE;
    if (noChangeOutcomes(snapshot, record) >= MAX_NO_CHANGE_BASE_REVIEWS) {
      return HISTORICAL_REARM_NO_CHANGE_BOUND;
    }
    if (!workNeeded.has(baseReviewVerdictKey(record, binding))) {
      return HISTORICAL_REARM_VERDICT_UNVERIFIED;
    }
  }
  return {
    id: record.id,
    repository: record.repository,
    grant: 0,
    nextStep: "work",
    reviewRounds: null,
    advanceBase: false,
    observedBase: null,
    detail: `${record.blocker!.kind}:historical_rearm:${kind}`,
  };
}
