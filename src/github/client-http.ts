// client http.

import type {
  GitHubBranchProtectionsV1,
  GitHubCheckSuitesV1,
  GitHubChecksV1,
  GitHubIssueRelationsV1,
  GitHubIssueV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  GitHubReviewDecisionV1,
  IssueSourceErrorContextV1,
  PortErrorV1,
  PortResultV1,
} from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import type {
  GitHubBranchRuleWireV1,
  GitHubReviewCommentWireV1,
  GitHubReviewWireV1,
  GitHubRuleSetWireV1,
} from "./wire.ts";
import {
  createDeadline,
  type DeadlineV1,
  DEFAULT_HTTP_DEADLINE_MS,
} from "./http.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
  HostedNotStartedProofV1,
} from "../contracts/hosted-supervisor.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { HttpRequestV1, HttpResponseV1 } from "./http.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { GitHubRateLimitV1 } from "../contracts/github-cooldown.ts";
import { classifyGitHubRateLimit } from "./rate-limit.ts";
import {
  type ApproveExactCiRunInputV1,
  type CiApprovalOutcomeV1,
  type CreatePullWireV1,
  type GitHubApiClientOptionsV1,
  MAX_OPEN_ISSUE_PAGES,
  MAX_OPEN_ISSUES,
  type MergePutWireV1,
  type RawSendResult,
  type ReviewMutationOutcomeV1,
} from "./client-contracts.ts";
import type {
  ExactCiPullIdentityV1,
  ExactCiRunIdentityV1,
} from "./client-ci-wire.ts";
import type { HostedJobsV1 } from "./client-hosted-revision-wire.ts";
import {
  combineDeadline,
  nextLinkUrl,
  parseWire,
  parseWith,
  sameOrigin,
  sanitizeIssueSourceContext,
  unavailable,
} from "./client-response.ts";

export abstract class GitHubClientHttp {
  protected readonly repository: RepositoryIdentityV1;
  protected readonly apiBaseUrl: string;
  protected readonly perPage: number;
  protected readonly maxPages: number;
  protected readonly maxItems: number;
  protected readonly requestDeadlineMs: number;
  protected readonly includeIssueRelations: boolean;

  constructor(protected readonly options: GitHubApiClientOptionsV1) {
    this.repository = options.repository;
    this.apiBaseUrl = options.apiBaseUrl.replace(/\/+$/, "");
    this.perPage = options.perPage ?? 100;
    this.maxPages = options.maxPages ?? MAX_OPEN_ISSUE_PAGES;
    this.maxItems = options.maxItems ?? MAX_OPEN_ISSUES;
    this.requestDeadlineMs = options.requestDeadlineMs ??
      DEFAULT_HTTP_DEADLINE_MS;
    // Exactly `true` opts in. Every other value (absent, false, truthy
    // non-boolean) leaves relations unknown: an untrusted or malformed
    // setting can never fabricate an unblocked issue.
    this.includeIssueRelations = options.includeIssueRelations === true;
  }

  // -------------------------------------------------------------------------
  // Transport plumbing
  // -------------------------------------------------------------------------

  protected async request(
    method: HttpRequestV1["method"],
    path: string,
    query: Record<string, string> = {},
    parent?: DeadlineV1,
  ): Promise<PortResultV1<HttpResponseV1>> {
    const sent = await this.send(method, path, query, null, parent);
    if (!sent.ok) return sent;
    if (sent.value.status >= 200 && sent.value.status < 300) return sent;
    if (sent.value.status === 404) {
      // 404 is a real observed value ("absent") for the read callers; they
      // decide whether that means null or not_found.
      return sent;
    }
    const [kind, detail] = this.mapError(sent.value);
    return portError(
      kind,
      detail,
      undefined,
      method === "GET"
        ? this.issueSourceContext(
          path,
          1,
          sent.value.status,
          "http",
          "http_error",
        )
        : undefined,
    );
  }

  protected send(
    method: HttpRequestV1["method"],
    path: string,
    query: Record<string, string>,
    body: Record<string, unknown> | null,
    parent?: DeadlineV1,
  ): Promise<PortResultV1<HttpResponseV1>> {
    const queryText = new URLSearchParams(query).toString();
    const url = `${this.apiBaseUrl}${path}${
      queryText.length === 0 ? "" : `?${queryText}`
    }`;
    return this.sendCore(method, url, body, undefined, parent).then((raw) => {
      if (raw.status === "response") return portOk(raw.response);
      if (raw.status === "lost") {
        return portError(
          "unavailable",
          "GitHub API request failed",
          undefined,
          method === "GET"
            ? this.issueSourceContext(path, 1, null, "request", "unavailable")
            : undefined,
        );
      }
      return portError(
        raw.error.kind,
        raw.error.detail,
        raw.error.rateLimit,
        raw.error.issueSource ??
          (method === "GET"
            ? this.issueSourceContext(path, 1, null, "request", raw.error.kind)
            : undefined),
      );
    });
  }

  protected async sendCore(
    method: HttpRequestV1["method"],
    url: string,
    body: Record<string, unknown> | null,
    redirect?: "error" | "manual",
    parent?: DeadlineV1,
  ): Promise<RawSendResult> {
    // One finite whole-operation deadline starts before authentication,
    // covers the gate reads, the HTTP request and the body read. A hung
    // injected gate or auth provider cannot block the operation beyond it.
    // An optional shared parent bound (the hosted reader's whole-operation
    // limit) is combined in without ever being disposed from here.
    const deadline = combineDeadline(
      createDeadline(this.requestDeadlineMs),
      parent,
    );
    try {
      // Durable cooldown gate before authentication: a blocked installation
      // never reaches the provider or the network, and its typed error is
      // preserved (including rate-limit metadata).
      const before = await this.requestGate(deadline);
      if (before !== null) return before;
      let header: PortResultV1<string>;
      try {
        const authPromise = Promise.resolve().then(() =>
          this.options.auth.authorizationHeader()
        );
        // The auth promise may settle after the deadline fired; it must never
        // surface as an unhandled rejection.
        authPromise.catch(() => {});
        header = await deadline.race(authPromise);
      } catch {
        // The auth provider threw or hung without ever completing: no request
        // was issued, so no write was submitted. Sanitized typed failure.
        return {
          status: "error",
          error: {
            kind: "auth_failed",
            detail: "GitHub API authentication failed",
          },
        };
      }
      if (!header.ok) {
        // Auth can fail with typed rate-limit metadata (token refresh was
        // throttled): the observation is durably recorded before the error
        // propagates. Duplicate identity recording is safe — the real gate is
        // idempotent — and a recording failure overrides with unavailable.
        const recorded = await this.recordGateRateLimit(
          deadline,
          header.error.rateLimit,
        );
        if (recorded !== null) return recorded;
        return { status: "error", error: header.error };
      }
      if (header.value.includes("\r") || header.value.includes("\n")) {
        return {
          status: "error",
          error: { kind: "invalid", detail: "invalid authorization header" },
        };
      }
      // The gate is re-checked immediately before the request, and an expired
      // whole-operation deadline never submits HTTP.
      const again = await this.requestGate(deadline);
      if (again !== null) return again;
      let response: HttpResponseV1;
      try {
        response = await deadline.race(
          Promise.resolve().then(() =>
            this.options.http({
              method,
              url,
              headers: new Map<string, string>([
                ["authorization", header.value],
                ["accept", "application/vnd.github+json"],
                ["x-github-api-version", "2022-11-28"],
              ]),
              body: body === null ? null : JSON.stringify(body),
              redirect: redirect ?? "error",
            })
          ),
        );
      } catch {
        // The deadline fired or the transport rejected/throw before a
        // response was received: the effect of a write is unknown (it may
        // have been submitted), a read is unavailable.
        return { status: "lost" };
      }
      // Classification is intercepted here, before mapError: a confirmed
      // rate-limit observation is durably recorded before any typed error
      // leaves this method, and no request starts while persistence is
      // unsettled. A thrown classifier (or recordRateLimit) never escapes;
      // it becomes the sanitized static unavailable failure.
      let responseSource: IssueSourceErrorContextV1 | undefined;
      try {
        const endpoint = new URL(url);
        responseSource = method === "GET"
          ? this.issueSourceContext(
            endpoint.pathname,
            Number(endpoint.searchParams.get("page") ?? 1),
            response.status,
            "http",
            "unavailable",
          )
          : undefined;
      } catch { /* Advisory context cannot change transport semantics. */ }
      const responseUnavailable = (): RawSendResult => ({
        status: "error",
        error: {
          kind: "unavailable",
          detail: "GitHub API request failed",
          ...(responseSource === undefined
            ? {}
            : { issueSource: responseSource }),
        },
      });
      let rateLimit: GitHubRateLimitV1 | null;
      try {
        rateLimit = await classifyGitHubRateLimit(
          response,
          this.options.clock.now(),
        );
      } catch {
        return responseUnavailable();
      }
      if (rateLimit !== null) {
        const recorded = await this.recordGateRateLimit(deadline, rateLimit);
        if (recorded !== null) return responseUnavailable();
        return {
          status: "error",
          error: {
            kind: "rate_limited",
            detail: "GitHub API rate limit exceeded",
            rateLimit,
            ...(responseSource === undefined
              ? {}
              : { issueSource: { ...responseSource, code: "rate_limited" } }),
          },
        };
      }
      return { status: "response", response };
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Await the durable gate read, bounded by the whole-operation deadline. A
   * thrown gate, an expired bound or a late resolution is the sanitized
   * static unavailable failure — never an escaped error, never a request. A
   * real gate answer (blocked) is preserved as-is and prevents HTTP.
   */
  protected async requestGate(
    deadline: DeadlineV1,
  ): Promise<RawSendResult | null> {
    let result: PortResultV1<void>;
    try {
      const gatePromise = Promise.resolve().then(() =>
        this.options.cooldownGate.beforeRequest(this.repository.installationId)
      );
      // A gate that settles after the deadline fired must never surface as an
      // unhandled rejection.
      gatePromise.catch(() => {});
      result = await deadline.race(gatePromise);
    } catch {
      return unavailable();
    }
    if (deadline.fired()) return unavailable();
    if (!result.ok) return { status: "error", error: result.error };
    return null;
  }

  /**
   * Durably record a rate-limit observation. Persistence is awaited to
   * settlement directly — never raced against the operation deadline, so a
   * record cannot be abandoned mid-write while a later request proceeds.
   * Returns null on success (or when there is no observation); a
   * thrown/rejected gate or failed persistence overrides with the sanitized
   * static unavailable failure and prevents any further request. The
   * deadline is checked only after persistence has settled: an expired bound
   * after a completed record is still unavailable, but it can never make
   * this method return before persistence completes.
   */
  protected async recordGateRateLimit(
    deadline: DeadlineV1,
    rateLimit: GitHubRateLimitV1 | undefined,
  ): Promise<RawSendResult | null> {
    if (rateLimit === undefined) return null;
    try {
      const result = await Promise.resolve().then(() =>
        this.options.cooldownGate.recordRateLimit(
          this.repository.installationId,
          rateLimit,
        )
      );
      if (deadline.fired()) return unavailable();
      if (!result.ok) return unavailable();
      return null;
    } catch {
      return unavailable();
    }
  }

  protected mapError(response: HttpResponseV1): [PortErrorV1["kind"], string] {
    if (response.status === 401) {
      return ["auth_failed", "GitHub API authentication failed"];
    }
    if (response.status === 403) {
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        return ["rate_limited", "GitHub API rate limit exceeded"];
      }
      return ["auth_failed", "GitHub API request was forbidden"];
    }
    if (response.status === 404) {
      return ["not_found", "GitHub resource not found"];
    }
    if (response.status === 429) {
      return ["rate_limited", "GitHub API rate limit exceeded"];
    }
    return ["unavailable", "GitHub API request failed"];
  }

  protected async collectPages<T>(
    path: string,
    query: Record<string, string>,
    extract: (body: unknown, source?: IssueSourceErrorContextV1) => unknown[],
  ): Promise<PortResultV1<T[]>> {
    const queryText = new URLSearchParams({ ...query, page: "1" }).toString();
    let url = `${this.apiBaseUrl}${path}?${queryText}`;
    const seen = new Set<string>([url]);
    const items: T[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const source = (
        status: number | null,
        stage: IssueSourceErrorContextV1["stage"],
        code: IssueSourceErrorContextV1["code"],
      ) => this.issueSourceContext(path, page, status, stage, code);
      const sent = await this.sendCore("GET", url, null);
      if (sent.status === "lost") {
        return portError(
          "unavailable",
          "GitHub API request failed",
          undefined,
          source(null, "request", "unavailable"),
        );
      }
      if (sent.status === "error") {
        return portError(
          sent.error.kind,
          sent.error.detail,
          sent.error.rateLimit,
          sent.error.issueSource ?? source(null, "request", sent.error.kind),
        );
      }
      const response = sent.response;
      if (response.status !== 200) {
        const [kind, detail] = this.mapError(response);
        return portError(
          kind,
          detail,
          undefined,
          source(response.status, "http", "http_error"),
        );
      }
      const context = source(response.status, "validation", "invalid");
      const body = parseWire(response, (v) => v, context);
      if (!body.ok) return body;
      const parsed = parseWith(body.value, (v) => extract(v, context), context);
      if (!parsed.ok) return parsed;
      items.push(...(parsed.value as T[]));
      if (items.length > this.maxItems) {
        return portError(
          "unavailable",
          "GitHub API pagination size bound exceeded",
          undefined,
          source(response.status, "pagination", "item_limit"),
        );
      }
      const next = nextLinkUrl(response.headers);
      if (next === null) return portOk(items);
      if (!sameOrigin(url, next)) {
        // The bearer token must never follow a Link outside the API origin.
        return portError(
          "invalid",
          "GitHub API response is malformed",
          undefined,
          source(response.status, "pagination", "invalid"),
        );
      }
      if (seen.has(next)) {
        return portError(
          "unavailable",
          "GitHub API pagination cycle detected",
          undefined,
          source(response.status, "pagination", "pagination_cycle"),
        );
      }
      seen.add(next);
      url = next;
    }
    return portError(
      "unavailable",
      "GitHub API pagination page bound exceeded",
      undefined,
      this.issueSourceContext(
        path,
        this.maxPages,
        200,
        "pagination",
        "page_limit",
      ),
    );
  }

  /** Only our repository's issue endpoints can carry issue-source diagnostics. */
  protected issueSourceContext(
    path: string,
    page: number,
    httpStatus: number | null,
    stage: IssueSourceErrorContextV1["stage"],
    code: IssueSourceErrorContextV1["code"],
  ): IssueSourceErrorContextV1 | undefined {
    return sanitizeIssueSourceContext({
      target: `${this.repository.owner}/${this.repository.name}`,
      method: "GET",
      endpointPath: path,
      httpStatus,
      page,
      stage,
      code,
      ...(/\/issues\/(\d+)$/.test(path)
        ? { issueNumber: Number(path.slice(path.lastIndexOf("/") + 1)) }
        : {}),
    });
  }
  abstract listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>>;

  abstract readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>>;

  protected abstract readIssueRelations(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueRelationsV1>>;

  abstract listPullRequestsByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1[]>>;

  abstract readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>>;

  abstract readPullRequestReviewDecision(
    number: number,
  ): Promise<PortResultV1<GitHubReviewDecisionV1>>;

  abstract readChecks(
    sha: GitSha,
    names?: ReadonlySet<string>,
  ): Promise<PortResultV1<GitHubChecksV1>>;

  abstract readCheckSuites(
    sha: GitSha,
  ): Promise<PortResultV1<GitHubCheckSuitesV1>>;

  abstract readProtections(
    branch: string,
  ): Promise<PortResultV1<GitHubBranchProtectionsV1>>;

  abstract readRef(inputRef: string): Promise<PortResultV1<GitHubRefV1 | null>>;

  abstract readReviews(
    number: number,
  ): Promise<PortResultV1<GitHubReviewWireV1[]>>;

  abstract readReviewComments(
    number: number,
  ): Promise<PortResultV1<GitHubReviewCommentWireV1[]>>;

  abstract readBranchRules(
    branch: string,
  ): Promise<PortResultV1<GitHubBranchRuleWireV1[]>>;

  abstract readRepositoryRuleSets(): Promise<
    PortResultV1<GitHubRuleSetWireV1[]>
  >;

  abstract readRepositoryRuleSet(
    ruleSetId: number,
  ): Promise<PortResultV1<GitHubRuleSetWireV1>>;

  abstract createPull(create: {
    title: string;
    headRef: string;
    baseRef: string;
    body: string;
  }): Promise<PortResultV1<CreatePullWireV1>>;

  abstract mergePull(
    number: number,
    sha: GitSha,
  ): Promise<PortResultV1<MergePutWireV1>>;

  abstract assignIssue(
    issueNumber: number,
    login: string,
  ): Promise<PortResultV1<void>>;

  abstract closeIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1>>;

  abstract closePullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1>>;

  abstract approveExactCiRun(
    input: ApproveExactCiRunInputV1,
  ): Promise<PortResultV1<CiApprovalOutcomeV1>>;

  protected abstract readExactCiPull(
    path: string,
    input: ApproveExactCiRunInputV1,
  ): Promise<PortResultV1<ExactCiPullIdentityV1>>;

  protected abstract readExactCiRun(
    path: string,
    input: ApproveExactCiRunInputV1,
    expected: ExactCiRunIdentityV1,
    repositoryId: number,
  ): Promise<PortResultV1<{ actionRequired: boolean }>>;

  protected abstract listExactCiRuns(
    repo: string,
    input: ApproveExactCiRunInputV1,
    repositoryId: number,
  ): Promise<PortResultV1<ExactCiRunIdentityV1[]>>;

  protected abstract actionsReleaseGet(
    path: string,
    query?: Record<string, string>,
    parent?: DeadlineV1,
  ): Promise<PortResultV1<unknown>>;

  protected abstract isHostedSelfScope(): boolean;

  protected abstract hostedExecutionTimeout(): PortResultV1<never>;

  abstract verifyHostedRevision(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>>;

  abstract verifyMatrixOrdinaryRevision(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>>;

  abstract verifyHostedReleaseRequest(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<boolean>>;

  abstract readHostedExecution(
    intent: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>>;

  protected abstract hostedNotStarted(
    intent: HostedExecutionIntentV1,
    jobId: number | null,
    finishedAt: number,
    evidenceDigest: string,
  ): PortResultV1<HostedNotStartedProofV1>;

  protected abstract readHostedAttemptJobs(
    intent: HostedExecutionIntentV1,
    deadline: DeadlineV1,
  ): Promise<
    PortResultV1<{ raw: unknown } & HostedJobsV1>
  >;

  protected abstract readHostedRuntimeLog(
    jobId: number,
    deadline: DeadlineV1,
  ): Promise<PortResultV1<string>>;

  abstract readPullReview(
    number: number,
    reviewId: number,
  ): Promise<PortResultV1<GitHubReviewWireV1 | null>>;

  abstract createPendingReview(
    number: number,
    head: GitSha,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>>;

  abstract updatePendingReview(
    number: number,
    reviewId: number,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>>;

  abstract submitReview(
    number: number,
    reviewId: number,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>>;

  protected abstract reviewMutationOutcome(
    raw: RawSendResult,
    expectedState: "pending" | "commented",
  ): PortResultV1<ReviewMutationOutcomeV1>;
}
