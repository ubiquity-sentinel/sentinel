/** Hosted actions-candidates-legacy-bindings responsibility. */
import type { GitSha, WorkItemId } from "../contracts/brands.ts";
import type {
  GitHubCooldownGateV1,
  GitHubIssueV1,
  GitHubPort,
  GitHubPullRequestV1,
  LegacyBaseRefreshLossProofV1,
  PortResultV1,
  StateReadView,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { ReplayRuntimeV1 } from "../replay/runtime.ts";
import { hasBlockingFindings } from "../repair/loop-review-records.ts";
import { sameRepository } from "./actions-candidates-shared.ts";

// ---------------------------------------------------------------------------
// Legacy candidate-loss proof (read-only scoped absence evidence)
// ---------------------------------------------------------------------------

export const STATIC_LOSS_INPUT = "legacy loss proof task id is invalid";

export const STATIC_LOSS_BINDING =
  "legacy loss proof has no exact legacy durable binding";

export const STATIC_LOSS_SOURCE =
  "legacy loss proof source issue is not eligible";

export const STATIC_LOSS_REF =
  "legacy loss proof task branch is not the predecessor";

export const STATIC_LOSS_PR = "legacy loss proof PR identity is not exact";

const STATIC_LOSS_AUTHOR = "legacy loss proof PR author is not trusted";

export const STATIC_LOSS_REVIEW =
  "legacy loss proof historical correction review is unavailable";

export const STATIC_LOSS_PRESENT =
  "legacy loss proof found the lost candidate present";

export const STATIC_LOSS_LOCAL =
  "legacy loss proof local candidate availability is unknown";

export const STATIC_LOSS_PROOF = "legacy loss proof fresh fetch did not verify";

export const STATIC_LOSS_DRIFT = "legacy loss proof durable state moved";

/** Exact owned scratch prefix of one legacy-loss proof store. */
export const LEGACY_LOSS_STORE_PREFIX = "sentinel-legacy-loss-store-";

/** Transient proof function returned by the trusted factory. */
export type LegacyBaseRefreshLossProverV1 = (
  taskId: WorkItemId,
) => Promise<PortResultV1<LegacyBaseRefreshLossProofV1 | null>>;

/**
 * Trusted legacy candidate-loss prover input. `port` is THE same host port the
 * host publishes and reads through, never a second API client: the issue read
 * is resolved dynamically at invocation, so the exact local scope wrapper that
 * replaces `readIssue` after composition remains authoritative.
 */
export interface ActionsLegacyLossProverInputV1 {
  state: StateReadView;
  /** THE same host port instance: scoped reads only, no write capability. */
  port: Pick<
    GitHubPort,
    "readIssue" | "readPullRequest" | "readRef" | "reviewerIdentity"
  >;
  gate: GitHubCooldownGateV1;
  token: string;
  /**
   * Exact target repository this prover is scoped to. Omitted callers keep the
   * sentinel self-identity.
   */
  repository?: RepositoryIdentityV1;
  /** Private owned scratch root for the one fresh empty object store. */
  scratch: string;
  trustedPath: string;
  gitExecutable: string;
  /** Exact configured base branch the owned PR must target. */
  baseBranch: string;
  /** Trusted PR author login for this scope. */
  trustedPrAuthor: string;
  /**
   * Trusted exact-object loader. `not_found` is a proven scoped absence;
   * every other error is unproven availability and passes through unchanged.
   */
  ensureLocalCandidate(
    taskId: WorkItemId,
    head: GitSha,
  ): Promise<PortResultV1<void>>;
  /** Injectable bounded subprocess runtime; default `DenoReplayRuntime`. */
  runtime?: ReplayRuntimeV1;
  /** Fixed self remote; overridden ONLY by tests with a fixture file:// URL. */
  remoteUrl?: string;
}

/**
 * The exact historical predecessor correction review: completed with machine-
 * verifiable result/completion identity, bound to the same full repository and
 * PR, the observed predecessor head H0 and the original base B0, reviewed by
 * the trusted reviewer, with an unresolved P0/P1 finding (a P2/P3-only
 * review is deliverable and never required a correction). More than one
 * match is resolved deterministically by review id — never by time or list
 * order.
 */
export function historicalCorrectionReview(
  reviews: readonly ReviewReceiptV1[],
  repository: RepositoryIdentityV1,
  pr: number,
  predecessor: GitSha,
  base: GitSha,
  reviewer: string,
): ReviewReceiptV1 | null {
  const matching = reviews.filter((review) =>
    review.outcome === "completed" &&
    review.resultId !== null &&
    review.completedAt !== null &&
    hasBlockingFindings(review) &&
    review.expectedReviewer === reviewer &&
    review.observedReviewer === reviewer &&
    review.pullRequest.number === pr &&
    review.pullRequest.head === predecessor &&
    review.pullRequest.base === base &&
    sameRepository(review.repository, repository)
  );
  if (matching.length === 0) return null;
  return matching.slice().sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  )[0]!;
}

/** Open exact-number issue with known relations and no blocking metadata. */
export function eligibleSourceIssue(
  issue: GitHubIssueV1,
  issueNumber: number,
): PortResultV1<void> {
  if (issue.number !== issueNumber) {
    return portError("unavailable", STATIC_LOSS_SOURCE);
  }
  if (issue.state !== "open") {
    return portError("conflict", STATIC_LOSS_SOURCE);
  }
  const relations = issue.relations;
  if (relations === undefined) {
    return portError("unavailable", STATIC_LOSS_SOURCE);
  }
  if (relations.subIssueCount !== 0 || relations.openBlockers.length !== 0) {
    return portError("conflict", STATIC_LOSS_SOURCE);
  }
  return portOk(undefined);
}

/** Exact owned open PR on the predecessor head and configured base branch. */
export function exactOwnedPullRequest(
  pull: GitHubPullRequestV1,
  expected: {
    pr: number;
    predecessor: GitSha;
    branch: string;
    baseBranch: string;
    trustedPrAuthor: string;
  },
): PortResultV1<void> {
  if (pull.number !== expected.pr || pull.head !== expected.predecessor) {
    return portError("conflict", STATIC_LOSS_PR);
  }
  if (
    pull.headRef !== expected.branch || pull.baseRef !== expected.baseBranch
  ) {
    return portError("conflict", STATIC_LOSS_PR);
  }
  if (pull.author !== expected.trustedPrAuthor) {
    return portError("conflict", STATIC_LOSS_AUTHOR);
  }
  if (
    pull.state !== "open" || pull.mergeSha !== null || pull.mergedAt !== null
  ) {
    return portError("conflict", STATIC_LOSS_PR);
  }
  return portOk(undefined);
}
