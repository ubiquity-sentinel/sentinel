import type { TakeoverPublicationProof } from "../src/contracts/existing-pr-takeover.ts";
import { hasBlockingSeverity } from "../src/contracts/review-receipt.ts";
import { hasTakeoverCustody } from "../src/github/existing-pr-takeover-provenance.ts";
import { takeoverPublicationMatches } from "../src/github/existing-pr-publication-proof.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { isGatewayVpsRepository } from "../src/repair/vps-delivery.ts";
import { QUEUE_PROOF_ACTIVATED } from "../src/github/queue-runtime-policy.ts";
import {
  type HostedQueueCustodyContext,
  queueRecordProtected,
} from "./hosted-autonomy-queue-context.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
} from "../src/contracts/release.ts";
import type {
  ReviewReceiptV1,
  ReviewTaskStatementV1,
} from "../src/contracts/review-receipt.ts";
import { reviewAuthorizesMerge } from "../src/repair/review-gate.ts";
import { RETIRED_MERGED_MESSAGE } from "../src/repair/selection.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  releaseRequestId,
} from "../src/repair/keys.ts";
import { intentClosable } from "./hosted-autonomy-retries.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  isHostedSelf,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyRecordV1,
} from "./hosted-autonomy-types.ts";

/**
 * Every completed receipt this record's delivery identity binds: same
 * repository, pull request, reviewed head and observed base, a result and
 * completion instant, and a reviewer-bound identity with zero uncounted
 * findings and no unresolved P0/P1. This is the identity pre-filter only; it
 * NEVER authorizes a delivery. `authorizingReceipt` applies the shared semantic
 * predicate to these candidates.
 */
export function boundReviewReceipts(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
): ReviewReceiptV1[] {
  const pullRequest = record.target.pr;
  const head = record.target.head;
  const base = record.target.base;
  if (pullRequest === null || head === null || base === null) return [];
  const repository = record.repository;
  return snapshot.reviews.filter((review) =>
    review.repository.owner === repository.owner &&
    review.repository.name === repository.name &&
    review.repository.installationId === repository.installationId &&
    review.pullRequest.number === pullRequest &&
    review.pullRequest.head === head &&
    review.pullRequest.base === base &&
    review.outcome === "completed" &&
    review.resultId !== null &&
    review.completedAt !== null &&
    review.observedReviewer !== null &&
    review.observedReviewer === review.expectedReviewer &&
    review.findingsUncounted === 0 &&
    !hasBlockingSeverity(review.unresolvedSeverities)
  );
}

/**
 * The ONE authorization for an issue-delivery action: the shared predicate from
 * `src/repair/review-gate.ts` over the exact existing receipt and WorkRecord,
 * with the TRUSTED live source-issue statement independently read immediately
 * before the merge/release/closure, AND the fixed GitHub App reviewer identity
 * pinned by the contract's own reviewer field. A legacy quality-only receipt, a
 * receipt bound to another issue or to changed issue text, a not-fulfilled/
 * uncertain verdict, an already-satisfied base, an alternate self-consistent
 * reviewer identity and an unreadable task context all refuse.
 */
export function authorizingReceipt(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
  task: ReviewTaskStatementV1 | null | "unavailable",
): ReviewReceiptV1 | null {
  const candidates = boundReviewReceipts(snapshot, record);
  return candidates.find((candidate) =>
    reviewAuthorizesMerge(
      candidate,
      record,
      HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
      task,
    )
  ) ?? null;
}

/**
 * The trusted source-issue statement for one record, read over that record's
 * OWN repository surface. A record without a source issue keeps the existing
 * change-only contract (null); an unreadable, throwing or absent read is
 * `"unavailable"`, which never authorizes issue-backed delivery.
 */
export async function readTrustedTask(
  surface: HostedAutonomyGitHubV1 | null,
  record: HostedAutonomyRecordV1,
): Promise<ReviewTaskStatementV1 | null | "unavailable"> {
  const issueNumber = record.related.issueNumber;
  if (issueNumber === null) return null;
  const read = surface?.readIssueTask;
  if (surface === null || read === undefined) return "unavailable";
  try {
    const task = await read.call(surface, issueNumber);
    return task ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

/** Recover only the PR erased by the merged/base-refresh disposition. */
export async function historicalMergedPublication(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
): Promise<HostedAutonomyRecordV1 | null> {
  const head = record.target.head;
  const base = record.target.base;
  const preserved = record.target.candidateState?.preserved;
  if (
    isHostedSelf(record.repository) || record.nextStep !== "blocked" ||
    record.blocker?.kind !== "other" ||
    record.blocker.message !== RETIRED_MERGED_MESSAGE ||
    record.target.pr !== null || record.source.kind !== "issue" ||
    record.related.issueNumber === null ||
    record.source.id !== String(record.related.issueNumber) ||
    head === null || base === null || preserved == null ||
    record.target.branch !== candidateBranch(record.id) ||
    preserved.head !== head || preserved.base !== base ||
    record.target.candidateState?.publishedHead !== head ||
    !intentClosable(record, snapshot.reservations)
  ) return null;
  if (
    preserved.ref !== await candidatePreservationRef(
      record.repository,
      record.id,
      preserved.operationKey,
    )
  ) return null;
  const numbers = new Set(
    snapshot.reviews.filter((review) =>
      sameRepository(review.repository, record.repository) &&
      review.pullRequest.head === head && review.pullRequest.base === base &&
      review.taskAcceptance?.issueNumber === record.related.issueNumber &&
      record.evidence.some((evidence) =>
        evidence.kind === "review_receipt" &&
        evidence.ref === `artifact:review-receipt/${review.id}`
      )
    ).map((review) => review.pullRequest.number),
  );
  if (numbers.size !== 1) return null;
  return { ...record, target: { ...record.target, pr: [...numbers][0] } };
}

/**
 * True exactly when the pull's merge commit has the parents [tip, head], in
 * that order, so the merged tree is that tip plus that head (#156). GitHub's
 * merge API has no compare-and-swap on the base: a merge the pass made after
 * re-reading the tip may still land on a later commit, a tree no CI ran on,
 * which is never booked. A merge made outside the pass is adopted by
 * `baseAndHeadAreMerged` instead.
 */
export function mergedExactlyOn(
  pull: HostedAutonomyPullV1,
  tip: string,
  head: string,
): boolean {
  return pull.parents.length === 2 && pull.parents[0] === tip &&
    pull.parents[1] === head;
}

/** Verified merge facts: the exact revision a foreign record delivered. */
export interface HostedMergedDeliveryV1 {
  readonly revision: string;
}

/**
 * The exact merged-delivery evidence a FOREIGN record's closure requires: the
 * pull is merged under a named merge commit, it is authored by a trusted
 * identity, it targets the record's own base branch, that commit has exactly
 * two parents whose second one is the recorded head, the recorded base is
 * either the first parent or a proven ancestor of the merge revision, and the
 * revision is integrated into the recorded base branch. Any missing,
 * unreadable or mismatched fact yields null: an ambiguous merge is never
 * evidence.
 */
export function baseAndHeadAreMerged(
  pull: HostedAutonomyPullV1,
  base: string,
  head: string,
): boolean {
  if (pull.parents.length !== 2 || !pull.parents.includes(head)) return false;
  if (pull.parents.includes(base)) return true;
  // The merge may land on a descendant of the reviewed base: the base branch
  // can advance between the reviewed snapshot and a trusted external merge,
  // so bind the recorded base by its own ancestry proof instead of parent
  // equality. A divergent or unproven base is still refused.
  return pull.baseSha === base && pull.baseAncestorOfRevision;
}

export function verifiedMergedDelivery(
  record: HostedAutonomyRecordV1,
  pull: HostedAutonomyPullV1,
  baseBranch: string | null,
  custody?: HostedQueueCustodyContext,
  publicationProof?: TakeoverPublicationProof,
): HostedMergedDeliveryV1 | null {
  if (
    isGatewayVpsRepository(record.repository) &&
    (QUEUE_PROOF_ACTIVATED || custody?.proofActivated === true ||
      queueRecordProtected(record, custody))
  ) return null;
  const head = record.target.head;
  const base = record.target.base;
  if (head === null || base === null || baseBranch === null) return null;
  if (pull.merged !== true || pull.mergeCommitSha === null) return null;
  if (pull.headSha !== head) return null;
  if (
    typeof pull.author !== "string" ||
    (hasTakeoverCustody(record)
      ? !takeoverPublicationMatches(
        publicationProof,
        record,
        pull.mergeCommitSha,
        pull.author,
      )
      : !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author))
  ) {
    return null;
  }
  if (pull.baseRef !== baseBranch) return null;
  if (!baseAndHeadAreMerged(pull, base, head)) return null;
  if (!pull.revisionOnBaseBranch) return null;
  return { revision: pull.mergeCommitSha };
}

/** The exact request the loop's delivery step would have written. */
export async function buildHostedReleaseRequest(
  repository: ReleaseRequestV1["target"]["repository"],
  revision: string,
  head: string,
  base: string,
  pullRequest: number,
  receipt: ReviewReceiptV1,
  now: number,
): Promise<ReleaseRequestV1 | null> {
  try {
    return parseReleaseRequestV1({
      version: "v1",
      kind: "release_request",
      id: await releaseRequestId(repository, revision as GitSha, pullRequest),
      target: { repository, environment: "production" },
      revision,
      source: {
        pullRequest,
        reviewRequestId: receipt.requestId,
        reviewReceiptId: receipt.id,
        head,
        base,
      },
      status: "open",
      failureReason: null,
      createdAt: now,
    });
  } catch {
    return null;
  }
}
