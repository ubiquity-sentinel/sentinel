/**
 * Review follow-up candidates (owner decision 2026-10-16: "kick the can down
 * the road and merge with some tech debt to keep moving forward"; owner
 * directive 2026-10-31: one issue per finding). After a trusted merge, every
 * unresolved P1/P2/P3 finding of the latest current-head review becomes its
 * own follow-up issue, so independent workers can pick them up concurrently.
 * This module plans candidates only; rendering and v1/v2 marker identity live
 * in `hosted-autonomy-follow-up-render.ts`, and the launcher pass
 * (`hosted-autonomy-follow-up-pass.ts`) owns every read and write.
 */
import { BLOCKING_SEVERITIES } from "../src/contracts/review-receipt.ts";
import type { ReleaseRequestV1 } from "../src/contracts/release.ts";
import type {
  ReviewFindingV1,
  ReviewReceiptV1,
} from "../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  hostedRepositoryKey,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import {
  carriedRequestReceipt,
  identityBoundReviews,
  reviewBlocksMerge,
} from "./hosted-autonomy-spent-delivery.ts";
import { latestPullReview } from "../src/repair/carried-review.ts";
import { MERGED_OFF_TIP_PREFIX } from "../src/repair/merge-off-tip.ts";
import {
  REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX,
} from "../src/repair/review-round-cap.ts";

/** Requests created before 2026-10-16T00:00Z (the owner decision) never count. */
export const FOLLOW_UP_EPOCH = 1792108800000;
/** Historical bound retained for compatibility with older callers. */
export const FOLLOW_UP_WINDOW_MS = 72 * 60 * 60 * 1000;
/**
 * Historical two-create bound, retained for older callers only. The pass no
 * longer enforces it: one issue per finding is bounded by the pass deadline
 * and the listing/merge-check bounds instead of an artificial create count.
 */
export const FOLLOW_UP_MAX_CREATES_PER_PASS = 2;
/** Live merge verifications per pass. */
export const FOLLOW_UP_MAX_MERGE_CHECKS_PER_PASS = 4;
/** Candidates not already filed that one pass may look at. */
export const FOLLOW_UP_MAX_CANDIDATES_PER_PASS = 8;
/** Listing pages (100 items each) per repository and pass. */
export const FOLLOW_UP_MAX_LISTING_PAGES = 5;
/** GitHub's issue-list page size used by the follow-up surface. */
export const FOLLOW_UP_LISTING_PAGE_SIZE = 100;
/** Margin between the launcher's request clock and GitHub's `created_at`. */
export const FOLLOW_UP_LISTING_SKEW_MS = 10 * 60 * 1000;
/** Wall-clock budget of one pass, checked before every GitHub call. */
export const FOLLOW_UP_PASS_BUDGET_MS = 60_000;
/** Historical combined-issue bound retained for older callers. */
export const FOLLOW_UP_MAX_FINDINGS = 20;

/** One merged PR whose latest review left P1/P2/P3 findings unresolved. */
export interface FollowUpCandidateV1 {
  request: ReleaseRequestV1;
  repository: RepositoryIdentityV1;
  pullRequest: number;
  receipt: ReviewReceiptV1;
  findings: readonly ReviewFindingV1[];
  sourceIssue: number | null;
}

const OFF_TIP_MERGE_RE = /^merge ([0-9a-f]{40}) has parents /;

/** Parks that record an off-tip merge with the same detail suffix. */
const OFF_TIP_PARK_PREFIXES = [
  REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX,
  // The runtime's merge CAS park for any merge off its reviewed base.
  MERGED_OFF_TIP_PREFIX,
] as const;

/** The trusted merge revision recorded by an off-tip park, or null. */
function offTipParkMergeRevision(
  record: RepairStateSnapshotV1["work"][number],
): string | null {
  if (record.nextStep !== "blocked" || record.blocker?.kind !== "other") {
    return null;
  }
  const message = record.blocker.message;
  const prefix = OFF_TIP_PARK_PREFIXES.find((p) => message.startsWith(p));
  if (prefix === undefined) return null;
  return OFF_TIP_MERGE_RE.exec(message.slice(prefix.length))?.[1] ?? null;
}

/** Build the same candidate shape for a merge parked without a request. */
function offTipParkCandidate(
  snapshot: Pick<RepairStateSnapshotV1, "reviews">,
  record: RepairStateSnapshotV1["work"][number],
): FollowUpCandidateV1 | null {
  const mergeRevision = offTipParkMergeRevision(record);
  const pullRequest = record.target.pr;
  const head = record.target.head;
  const base = record.target.base;
  if (
    mergeRevision === null || record.source.kind !== "issue" ||
    record.related.issueNumber === null || pullRequest === null ||
    head === null || base === null || record.blocker === null
  ) return null;
  const receipt = latestPullReview(
    snapshot,
    record,
    HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  );
  if (
    receipt === null || receipt.resultId === null ||
    receipt.completedAt === null || reviewBlocksMerge(receipt)
  ) return null;
  const request: ReleaseRequestV1 = {
    version: "v1",
    kind: "release_request",
    id: `off-tip:${record.id}:${mergeRevision}`,
    target: { repository: record.repository, environment: "production" },
    revision: mergeRevision as ReleaseRequestV1["revision"],
    source: {
      pullRequest,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      head,
      base,
    },
    status: "fulfilled",
    failureReason: null,
    createdAt: record.blocker.since,
  };
  const findings = receipt.findings.filter((finding) =>
    !finding.resolved && !BLOCKING_SEVERITIES.includes(finding.severity)
  );
  if (findings.length === 0) return null;
  return {
    request,
    repository: record.repository,
    pullRequest,
    receipt,
    findings,
    sourceIssue: receipt.taskAcceptance?.issueNumber ??
      record.related.issueNumber,
  };
}

/**
 * Production release requests (open, or fulfilled by a release) created at or
 * after the owner-decision epoch, plus carried off-tip parks, newest first,
 * one per (repository, PR). The lower bound is fixed rather than anchored at
 * `now`: a launcher installed after a request was created must still see it.
 * The findings come from the LATEST identity-bound completed App review of
 * the request's exact PR, head and base, which must have zero uncounted
 * findings and no unresolved P0; only its unresolved P1/P2/P3 findings count,
 * and a request without one is not a candidate.
 */
export function planFollowUpCandidates(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests" | "reviews" | "work">,
  now: number,
): FollowUpCandidateV1[] {
  const requests = snapshot.releaseRequests
    .filter((request) =>
      request.target.environment === "production" &&
      (request.status === "open" || request.status === "fulfilled") &&
      request.createdAt >= FOLLOW_UP_EPOCH && request.createdAt <= now
    );
  const candidates: FollowUpCandidateV1[] = [];
  for (const request of requests) {
    const repository = request.target.repository;
    const pullRequest = request.source.pullRequest;
    // A refreshed head merged under a carried review files the findings of
    // the review it carried (the request names that exact receipt).
    const receipt = identityBoundReviews(
      snapshot.reviews,
      repository,
      pullRequest,
      request.source.head,
      request.source.base,
    ).at(-1) ?? carriedRequestReceipt(snapshot.reviews, request) ?? undefined;
    if (receipt === undefined || reviewBlocksMerge(receipt)) continue;
    const findings = receipt.findings.filter((finding) =>
      !finding.resolved && !BLOCKING_SEVERITIES.includes(finding.severity)
    );
    if (findings.length === 0) continue;
    const record = snapshot.work.find((item) =>
      sameRepository(item.repository, repository) &&
      item.target.pr === pullRequest &&
      item.target.head === request.source.head
    );
    candidates.push({
      request,
      repository,
      pullRequest,
      receipt,
      findings,
      sourceIssue: receipt.taskAcceptance?.issueNumber ??
        record?.related.issueNumber ?? null,
    });
  }
  for (const record of snapshot.work) {
    const candidate = offTipParkCandidate(snapshot, record);
    if (
      candidate !== null && candidate.request.createdAt >= FOLLOW_UP_EPOCH &&
      candidate.request.createdAt <= now
    ) candidates.push(candidate);
  }
  candidates.sort((a, b) =>
    b.request.createdAt - a.request.createdAt ||
    (a.request.id < b.request.id ? -1 : a.request.id > b.request.id ? 1 : 0)
  );
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${
      hostedRepositoryKey(candidate.repository)
    }#${candidate.pullRequest}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export {
  FOLLOW_UP_MAX_BODY_CHARS,
  FOLLOW_UP_MAX_DEPTH,
  FOLLOW_UP_MAX_FINDING_CHARS,
  FOLLOW_UP_MAX_TITLE_CHARS,
  followUpFindingKey,
  type FollowUpIssueCandidateV1,
  type FollowUpIssueV1,
  followUpMarker,
  type FollowUpMarkerInputV1,
  type FollowUpMarkerV1,
  inertText,
  markerCoversFinding,
  markerNamesCandidate,
  parseFollowUpMarker,
  renderFollowUpIssue,
} from "./hosted-autonomy-follow-up-render.ts";
