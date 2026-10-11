// review transport contracts.

import type { GitSha } from "../contracts/brands.ts";
import type { Clock, PortResultV1 } from "../contracts/ports.ts";
import type { ReviewSnapshotV1 } from "./review-snapshot.ts";
import type {
  PreparedStructuredReviewV1,
  StructuredReviewPrepareV1,
} from "./codex-reviewer.ts";
import type { GitHubApiClient } from "./client.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";

/** Trusted immutable snapshot capability (satisfied by `GitReviewSnapshot`). */
export interface GitReviewSnapshotCaptureV1 {
  capture(
    input: { base: GitSha; head: GitSha },
  ): Promise<PortResultV1<ReviewSnapshotV1>>;
}

/** Trusted producer prepare capability (satisfied by `CodexStructuredReviewer`). */
export interface CodexReviewPrepareCapabilityV1 {
  prepare(
    request: StructuredReviewPrepareV1,
  ): Promise<PortResultV1<PreparedStructuredReviewV1>>;
}

export interface GitHubCodexReviewTransportOptionsV1 {
  /** Exact authenticated GitHub API client (no second raw HTTP client). */
  client: GitHubApiClient;
  /** Exact repository identity of the one configured target. */
  repository: RepositoryIdentityV1;
  /** Exact trusted publisher login that authors and publishes every review. */
  publisher: string;
  clock: Clock;
  /** Owning run identity persisted in every journal execution record. */
  ownerRunId: string;
  /** Concrete trusted Git snapshot producer (public capture capability). */
  snapshot: GitReviewSnapshotCaptureV1;
  /** Concrete structured reviewer (public prepare capability). */
  reviewer: CodexReviewPrepareCapabilityV1;
  /**
   * Concurrent operation bound. Null or omitted means no artificial bound; a
   * finite positive safe integer is honored exactly (no silent clamp). Any
   * other provided value is invalid configuration and refuses construction.
   */
  maxActiveReviews?: number | null;
}
