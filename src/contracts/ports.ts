import { parseGitHubRateLimitV1 } from "./github-cooldown.ts";
import type { GitHubRateLimitV1 } from "./github-cooldown.ts";
import type { DeploymentIdentityV1, MetricsSampleV1 } from "./shared.ts";
import type { ParseIssueCode } from "./validation.ts";

/**
 * Typed operational ports. Every port returns explicit results: unavailable,
 * ambiguous or blocked outcomes are distinct values and are never represented
 * as an empty list, a null, a success or a thrown exception. Transports are
 * injected through these interfaces; product logic never lives in test fakes.
 */

export type { DeploymentIdentityV1, MetricsSampleV1 };

export type PortErrorKindV1 =
  | "unavailable"
  | "auth_failed"
  | "rate_limited"
  | "not_found"
  | "conflict"
  | "invalid";

/** Advisory issue-read context. No response text, URL, header or credential. */
export interface IssueSourceErrorContextV1 {
  target: string;
  method: "GET";
  endpointPath: string;
  httpStatus: number | null;
  page: number;
  stage: "request" | "http" | "json" | "validation" | "pagination";
  code:
    | ParseIssueCode
    | PortErrorKindV1
    | "http_error"
    | "malformed_json"
    | "pagination_cycle"
    | "page_limit"
    | "item_limit";
  validationPath?: string;
  limit?: number;
  observedLength?: number;
  issueNumber?: number;
}

/** One positively identified issue excluded by a finite wire-contract bound. */
export interface SkippedIssueV1 {
  number: number;
  code: "bound_exceeded";
  validationPath: string;
  limit: number | null;
  observedLength: number | null;
}

export interface PortErrorV1 {
  kind: PortErrorKindV1;
  detail: string;
  issueSource?: IssueSourceErrorContextV1;
  /**
   * Structured rate-limit metadata, present only on rate_limited errors.
   * Rate limiting is never encoded inside `detail` strings.
   */
  rateLimit?: GitHubRateLimitV1;
}

export type PortResultV1<T> = { ok: true; value: T } | {
  ok: false;
  error: PortErrorV1;
};

export function portOk<T>(value: T): PortResultV1<T> {
  return { ok: true, value };
}

export function portError(
  kind: PortErrorKindV1,
  detail: string,
  rateLimit?: GitHubRateLimitV1,
  issueSource?: IssueSourceErrorContextV1,
): PortResultV1<never> {
  if (rateLimit !== undefined) {
    if (kind !== "rate_limited") {
      throw new TypeError(
        "rate-limit metadata is only valid for rate_limited errors",
      );
    }
    // Validate through the strict parser so a caller-supplied plain object
    // cannot smuggle unvalidated metadata into an error.
    parseGitHubRateLimitV1(rateLimit);
  }
  return {
    ok: false,
    error: {
      kind,
      detail,
      ...(rateLimit === undefined ? {} : { rateLimit }),
      ...(issueSource === undefined ? {} : { issueSource }),
    },
  };
}

/**
 * A write whose external effect could not be confirmed. Distinguish from
 * failure: "ambiguous" means the effect may have been applied; the caller
 * must reconcile against exact authoritative state before repeating.
 */
export type WriteOutcomeV1 = "applied" | "ambiguous";

// ---------------------------------------------------------------------------
// GitHubPort (m01): authenticated reads, exact-head writes, review observation.
// Each instance targets exactly one configured repository. Model candidates
// are locally validated commits; the trusted GitHub writer publishes them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Clock: testable time for deterministic tests.
// ---------------------------------------------------------------------------

export interface Clock {
  /** Current millisecond epoch. */
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export {
  BASE_REFRESH_CONFLICT_DETAIL,
  carriedPatchHolds,
} from "./ports-github-requests.ts";

export type {
  AlreadySatisfiedClosureRequestV1,
  CandidatePreservationRequestV1,
  CarriedPatchProofV1,
  CarriedPatchRequestV1,
  GitHubBranchProtectionsV1,
  GitHubCheckSuitesV1,
  GitHubChecksV1,
  GitHubCheckV1,
  GitHubIssueRelationsV1,
  GitHubIssueV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  GitHubReviewDecisionV1,
  IssueCloseOutcomeV1,
  LegacyBaseRefreshLossProofV1,
  MergeOutcomeV1,
  MergeRequestV1,
  PrepareBaseRefreshRequestV1,
  PullRequestCreateV1,
  PullRequestPublishV1,
  ReviewDrainOperationV1,
  ReviewDrainOutcomeV1,
  ReviewDrainReportV1,
  ReviewDrainRequestV1,
  ReviewObservationRequestV1,
  ReviewObservationV1,
  ReviewRequestOutcomeV1,
  ReviewSubmissionV1,
} from "./ports-github-requests.ts";

export type { GitHubCooldownGateV1, GitHubPort } from "./ports-github.ts";

export type {
  EncryptedArtifactV1,
  IncidentAdapter,
  IncidentPageV1,
  IsolatedReplayResultV1,
  ReplayPort,
  ReplayRunRequestV1,
} from "./ports-evidence.ts";

export type {
  CandidateOutcomeV1,
  ImplementationPort,
  ModelIdV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PriorAttemptFactV1,
  ReasoningEffortV1,
  RepositoryRegressionFactV1,
} from "./ports-model.ts";

export { DENO_PROMOTION_REQUIRED_STATUS } from "./ports-release.ts";

export type {
  BuildLookupV1,
  DenoBuildV1,
  DenoDeploymentV1,
  DenoPromotionOutcomeV1,
  DenoPromotionRequestV1,
  DenoReleasePort,
  HealthSampleConfigV1,
  HealthSampleV1,
  MetricsSampleConfigV1,
} from "./ports-release.ts";

export type {
  ReleaseHistoryViewV1,
  ReleaseStateWriter,
  RepairHistoryViewV1,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateStore,
  StateWriteResultV1,
} from "./ports-state.ts";
