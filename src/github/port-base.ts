import {
  isNativeQueueTarget,
  type NativeQueueGuardV1,
  type QueueEffectRequest,
} from "./native-queue-guard.ts";
import type {
  ExistingPrTakeoverPort,
  TakeoverEffectAuthorization,
  TakeoverEffectBoundary,
} from "../contracts/existing-pr-takeover.ts";
// port base.

import type { GitSha } from "../contracts/brands.ts";
import type { ReviewNormalizationV1 } from "./review-normalize.ts";
import type {
  AlreadySatisfiedClosureRequestV1,
  CandidatePreservationRequestV1,
  Clock,
  GitHubBranchProtectionsV1,
  GitHubCheckSuitesV1,
  GitHubChecksV1,
  GitHubCooldownGateV1,
  GitHubRefV1,
  IssueCloseOutcomeV1,
  MergeOutcomeV1,
  MergeRequestV1,
  PortErrorV1,
  PortResultV1,
  PullRequestCreateV1,
  PullRequestPublishV1,
  ReviewDrainReportV1,
  ReviewDrainRequestV1,
  ReviewObservationRequestV1,
  ReviewObservationV1,
  ReviewRequestOutcomeV1,
  ReviewSubmissionV1,
  WriteOutcomeV1,
} from "../contracts/ports.ts";
import type { GitHubIssueV1, GitHubPullRequestV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { GitHubApiClient } from "./client.ts";
import type { GitExecutorV1 } from "./git-executor.ts";
import type {
  HumanResolutionVerifierV1,
  ReviewServiceTransportV1,
} from "./review-service.ts";
import { expectNonEmptyString, MaxText } from "../contracts/validation.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  DEFAULT_FINDING_CAP,
  type GitHubEffectiveProtectionsV1,
  type GitHubPortOptionsV1,
} from "./port-contracts.ts";

export abstract class GitHubPortBase {
  readonly existingPrTakeover?: ExistingPrTakeoverPort;
  readonly nativeQueue?: NativeQueueGuardV1;
  protected readonly selfMergeEnabled: boolean;
  /**
   * Exact trusted review publisher identity configured for this port. The
   * repair loop reads this value for every review request/receipt binding;
   * there is no hardcoded connector default.
   */
  readonly reviewerIdentity: string;
  protected readonly repository: RepositoryIdentityV1;
  protected readonly client: GitHubApiClient;
  protected readonly clock: Clock;
  protected readonly git: GitExecutorV1;
  protected readonly reviewService: ReviewServiceTransportV1;
  protected readonly trustedPrAuthor: string;
  protected readonly trustedReviewer: string;
  protected readonly trustedResolutionAuthors: ReadonlySet<string>;
  protected readonly resolutionVerifier: HumanResolutionVerifierV1 | null;
  protected readonly findingCap: number;
  protected readonly cooldownGate: GitHubCooldownGateV1;

  constructor(options: GitHubPortOptionsV1) {
    this.nativeQueue = options.nativeQueue;
    this.selfMergeEnabled = options.selfMergeEnabled === true &&
      options.repository.owner === "ubiquity-sentinel" &&
      options.repository.name === "sentinel" &&
      options.repository.installationId === 0;
    this.repository = options.repository;
    this.clock = options.clock;
    this.git = options.git;
    this.reviewService = options.reviewService;
    this.trustedPrAuthor = expectNonEmptyString(
      options.trustedPrAuthor,
      "trustedPrAuthor",
      MaxText.login,
    );
    this.trustedReviewer = expectNonEmptyString(
      options.trustedReviewer,
      "trustedReviewer",
      MaxText.login,
    );
    this.reviewerIdentity = this.trustedReviewer;
    this.trustedResolutionAuthors = new Set(options.trustedResolutionAuthors);
    this.resolutionVerifier = options.resolutionVerifier ?? null;
    this.findingCap = options.findingCap ?? DEFAULT_FINDING_CAP;
    this.cooldownGate = options.cooldownGate;
    this.client = new GitHubApiClient({
      repository: options.repository,
      apiBaseUrl: options.apiBaseUrl ?? "https://api.github.com",
      http: options.http,
      auth: options.auth,
      cooldownGate: options.cooldownGate,
      clock: options.clock,
      perPage: options.perPage,
      maxPages: options.maxPages,
      maxItems: options.maxItems,
      includeIssueRelations: options.includeIssueRelations,
      requestDeadlineMs: options.requestDeadlineMs,
    });
  }

  protected async queueEffect(
    input: Omit<QueueEffectRequest, "deadline">,
  ): Promise<PortResultV1<void>> {
    if (!isNativeQueueTarget(this.repository)) return portOk(undefined);
    if (this.nativeQueue === undefined) {
      return portError(
        "unavailable",
        "native queue custody capability missing",
      );
    }
    const decision = await this.nativeQueue.inspectEffect({
      ...input,
      deadline: this.clock.now() + 30_000,
    });
    return decision.status === "allow" ? portOk(undefined) : portError(
      "unavailable",
      `native queue custody hold: ${decision.reason}`,
    );
  }

  protected takeoverEffect(
    boundary: TakeoverEffectBoundary,
    authorization?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<void>> {
    if (this.existingPrTakeover !== undefined) {
      return this.existingPrTakeover.authorizeBoundary(boundary, authorization);
    }
    return Promise.resolve(
      authorization === undefined
        ? portOk(undefined)
        : portError("unavailable", "existing PR effect capability missing"),
    );
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    return this.client.readIssue(issueNumber);
  }

  listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    return this.client.listOpenIssues();
  }

  async findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    const listed = await this.client.listPullRequestsByHeadRef(headRef);
    if (!listed.ok) return listed;
    const pulls = listed.value;
    const open = pulls.filter((pull) => pull.state === "open");
    if (open.length === 1) return portOk(open[0]);
    if (open.length > 1) {
      return portError(
        "conflict",
        "multiple open pull requests share the head ref",
      );
    }
    if (pulls.length === 1) return portOk(pulls[0]);
    if (pulls.length === 0) return portOk(null);
    return portError("conflict", "multiple pull requests share the head ref");
  }

  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    return this.client.readPullRequest(number);
  }

  readChecks(
    head: GitSha,
    names?: ReadonlySet<string>,
  ): Promise<PortResultV1<GitHubChecksV1>> {
    return this.client.readChecks(head, names);
  }

  readCheckSuites(head: GitSha): Promise<PortResultV1<GitHubCheckSuitesV1>> {
    return this.client.readCheckSuites(head);
  }

  readProtections(
    baseBranch: string,
  ): Promise<PortResultV1<GitHubBranchProtectionsV1>> {
    return this.client.readProtections(baseBranch);
  }

  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>> {
    return this.client.readRef(ref);
  }

  readCommitParents(sha: GitSha): Promise<PortResultV1<GitSha[] | null>> {
    return this.client.readCommitParents(sha);
  }

  /**
   * Candidate preservation is a host-composed capability, not a generic port
   * behavior: this instance has no trusted candidate-object loader and no
   * fresh empty object store, so every call is a static `unavailable` and no
   * external effect happens. The trusted host composes the real capability on
   * this same port instance (SAME readRef/pushHead transport).
   */
  preserveCandidate(
    _request: CandidatePreservationRequestV1,
  ): Promise<PortResultV1<void>> {
    return Promise.resolve(
      portError(
        "unavailable",
        "candidate preservation is not composed on this port",
      ),
    );
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * One narrow guard for the remote invocations that bypass the HTTP client's
   * own gate (trusted git transport and injected review-service transport).
   * The durable cooldown gate is checked immediately before the actual remote
   * call, and a typed rate-limited result is settled into the gate before the
   * error is returned. Gate throws are sanitized to unavailable; the remote
   * operation is never retried or mutated, and a gate denial is returned
   * as-is.
   */
  protected async gatedRemoteCall<T>(
    operation: () => Promise<PortResultV1<T>>,
  ): Promise<PortResultV1<T>> {
    let granted: PortResultV1<void>;
    try {
      granted = await this.cooldownGate.beforeRequest(
        this.repository.installationId,
      );
    } catch {
      return portError("unavailable", "cooldown gate unavailable");
    }
    if (!granted.ok) return granted;
    const result = await operation();
    if (result.ok) return result;
    if (
      result.error.kind !== "rate_limited" ||
      result.error.rateLimit === undefined
    ) {
      return result;
    }
    let recorded: PortResultV1<void>;
    try {
      recorded = await this.cooldownGate.recordRateLimit(
        this.repository.installationId,
        result.error.rateLimit,
      );
    } catch {
      return portError("unavailable", "cooldown gate unavailable");
    }
    if (!recorded.ok) {
      return portError("unavailable", "cooldown gate unavailable");
    }
    return result;
  }
  protected abstract currentReviewEvidence(
    prNumber: number,
    merge: {
      expectedHead: GitSha;
      review: { requestId: string; id: string };
    },
  ): Promise<
    | { ok: true; normalized: ReviewNormalizationV1 | null }
    | { ok: false; error: PortErrorV1 }
  >;

  protected abstract resolutionsTrusted(
    receipt: MergeRequestV1["review"],
    pull: GitHubPullRequestV1,
  ): Promise<boolean>;

  abstract readEffectiveProtections(
    branch: string,
  ): Promise<PortResultV1<GitHubEffectiveProtectionsV1>>;

  abstract pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
  ): Promise<PortResultV1<WriteOutcomeV1>>;

  abstract createPullRequest(
    request: PullRequestCreateV1,
  ): Promise<PortResultV1<PullRequestPublishV1>>;

  abstract requestReview(
    request: ReviewSubmissionV1,
  ): Promise<PortResultV1<ReviewRequestOutcomeV1>>;

  abstract observeReview(
    request: ReviewObservationRequestV1,
  ): Promise<PortResultV1<ReviewObservationV1>>;

  abstract drainReviews(
    request: ReviewDrainRequestV1,
  ): Promise<PortResultV1<ReviewDrainReportV1>>;

  abstract mergePullRequest(
    request: MergeRequestV1,
  ): Promise<PortResultV1<MergeOutcomeV1>>;

  abstract closeAlreadySatisfiedTask(
    request: AlreadySatisfiedClosureRequestV1,
  ): Promise<PortResultV1<IssueCloseOutcomeV1>>;

  abstract closeIssue(
    issueNumber: number,
  ): Promise<PortResultV1<IssueCloseOutcomeV1>>;

  abstract assignIssue(issueNumber: number): Promise<PortResultV1<void>>;
}
