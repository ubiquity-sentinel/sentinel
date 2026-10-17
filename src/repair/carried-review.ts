/**
 * Pure policy of the carried review (owner decision 2026-10-16 (2), the
 * coordinator's option (b); the loop half is `loop-carried-delivery.ts`): which
 * completed review a spent record's refreshed head may carry. No I/O, no
 * clock; the patch proof itself is git's (`proveCarriedPatch`).
 */
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { sameRepositoryIdentity } from "./loop-records.ts";

type Reviews = Pick<RepairStateSnapshotV1, "reviews">;

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
    !review.unresolvedSeverities.some((severity) =>
      severity === "P0" || severity === "P1"
    );
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
 * mechanically and merges under that review (or parks at its next step), and
 * a refreshed head at `work` is heading for that carried merge.
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
