/**
 * Pure policy of the carried review (owner decision 2026-10-16 (2), the
 * coordinator's option (b); the loop half is `loop-carried-delivery.ts`): which
 * completed review a spent record's refreshed head may carry. No I/O, no
 * clock; the patch proof itself is git's (`proveCarriedPatch`).
 */
import { hasBlockingSeverity } from "../contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1, WorkWaitV1 } from "../contracts/work-record.ts";
import { sameRepositoryIdentity } from "./loop-records.ts";

type Reviews = Pick<RepairStateSnapshotV1, "reviews">;

/**
 * Length of the carried-merge marker's wait (4 minutes). No other wait any
 * runtime writes (generation 79 or 80) is a `backoff` this long: the CI fix
 * marker is zero-length, the merge port's refusal backoff (at `delivery`) is
 * `CHECK_POLL_MS` (5 minutes) and every red-base backoff ends at least
 * `RED_BASE_RECHECK_MS` (30 minutes) after its start.
 */
export const CARRIED_MERGE_MARKER_MS = 4 * 60_000;

/**
 * The runtime's carried-merge marker: the only state in which the launcher's
 * delivery pass may merge a carried head (round-2 recheck P3: any `backoff`
 * at `work`, the CI-first red-base hold of a model-written CI fix included,
 * used to read as "proved and awaiting"). The runtime writes it only once it has
 * proved the carried patch from git, seen the refreshed head's own CI green
 * on an unmoved tip and the live task accepted, so its `since` restarts on
 * every poll and its length is exact (`CARRIED_MERGE_MARKER_MS`).
 */
export function carriedMergeMarker(now: number): WorkWaitV1 {
  return {
    reason: "backoff",
    since: now,
    until: now + CARRIED_MERGE_MARKER_MS,
  };
}

/** True exactly for the carried-merge marker wait. */
export function isCarriedMergeMarker(wait: WorkWaitV1 | null): boolean {
  return wait !== null && wait.reason === "backoff" && wait.until !== null &&
    wait.until - wait.since === CARRIED_MERGE_MARKER_MS;
}

function laterReview(a: ReviewReceiptV1, b: ReviewReceiptV1): boolean {
  const at = (review: ReviewReceiptV1) => review.completedAt ?? -1;
  if (at(a) !== at(b)) return at(a) > at(b);
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt;
  return a.id > b.id;
}

/**
 * The latest completed review of the record's pull request (any head) by
 * `reviewer` (by completion, then observation instant, then id), or by any
 * reviewer whose observed identity is the expected one when `reviewer` is
 * omitted (the delivery line, which has no port).
 */
export function latestPullReview(
  snapshot: Reviews,
  record: Pick<WorkRecordV1, "repository" | "target">,
  reviewer?: string,
): ReviewReceiptV1 | null {
  const pr = record.target.pr;
  if (pr === null) return null;
  let latest: ReviewReceiptV1 | null = null;
  for (const review of snapshot.reviews) {
    if (
      review.outcome !== "completed" || review.pullRequest.number !== pr ||
      !sameRepositoryIdentity(review.repository, record.repository) ||
      review.observedReviewer === null ||
      review.observedReviewer !== review.expectedReviewer ||
      (reviewer !== undefined && review.expectedReviewer !== reviewer)
    ) continue;
    if (latest === null || laterReview(review, latest)) latest = review;
  }
  return latest;
}

/** No unresolved P0/P1 and nothing uncounted: the review blocks nothing. */
export function cleanReview(review: ReviewReceiptV1): boolean {
  return review.findingsUncounted === 0 &&
    !hasBlockingSeverity(review.unresolvedSeverities);
}

/** The record as of the identity its review binds (authorization only). */
export function reviewedIdentity(
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
): WorkRecordV1 {
  return {
    ...record,
    target: {
      ...record.target,
      head: receipt.pullRequest.head,
      base: receipt.pullRequest.base,
    },
  };
}

/**
 * The delivery line's view of a spent record (no round left): its latest
 * completed pull request review is clean, so on a moved base it refreshes
 * mechanically and the launcher merges it under that review (or it parks at
 * its next step), and a refreshed head at `work` is heading for that carried
 * merge.
 */
export function carriedLine(
  snapshot: Reviews,
  record: Pick<WorkRecordV1, "repository" | "target" | "source">,
): boolean {
  if (record.source.kind !== "issue" || record.target.head === null) {
    return false;
  }
  const latest = latestPullReview(snapshot, record);
  return latest !== null && cleanReview(latest);
}
