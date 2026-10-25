import type {
  ExistingPrTakeoverPort,
  TakeoverEffectAuthorization,
} from "./existing-pr-takeover.ts";
import type { NativeQueueGuardV1 } from "../github/native-queue-guard.ts";
import type { GitSha, WorkItemId } from "./brands.ts";
import type { SelfMergeExecutionV1 } from "./self-merge.ts";
import type { GitHubRateLimitV1 } from "./github-cooldown.ts";
import type { PortResultV1, WriteOutcomeV1 } from "./ports.ts";
import type {
  AlreadySatisfiedClosureRequestV1,
  CandidatePreservationRequestV1,
  CarriedPatchProofV1,
  CarriedPatchRequestV1,
  GitHubBranchProtectionsV1,
  GitHubCheckSuitesV1,
  GitHubChecksV1,
  GitHubIssueV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  IssueCloseOutcomeV1,
  LegacyBaseRefreshLossProofV1,
  MergeOutcomeV1,
  MergeRequestV1,
  PrepareBaseRefreshRequestV1,
  PullRequestCreateV1,
  PullRequestPublishV1,
  ReviewDrainReportV1,
  ReviewDrainRequestV1,
  ReviewObservationRequestV1,
  ReviewObservationV1,
  ReviewRequestOutcomeV1,
  ReviewSubmissionV1,
} from "./ports-github-requests.ts";

export interface GitHubPort {
  /** Trusted issue-bound existing-PR capability; never available to model workers. */
  readonly existingPrTakeover?: ExistingPrTakeoverPort;
  /** Trusted queue custody capability; absent gateway effect authority fails closed. */
  readonly nativeQueue?: NativeQueueGuardV1;
  /**
   * Exact trusted review publisher identity configured for this port. The
   * repair loop uses this value for every review request and receipt binding;
   * there is no hardcoded connector default.
   */
  readonly reviewerIdentity: string;
  readIssue(issueNumber: number): Promise<PortResultV1<GitHubIssueV1 | null>>;
  listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>>;
  /** Find the PR for a deterministic head branch; null when none exists. */
  findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>>;
  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>>;
  /**
   * The strict check runs and commit statuses of `head`. With `names`, only
   * the runs and statuses carrying one of those exact names are parsed and
   * returned; every other one is skipped unread. A caller attributing given
   * head failures against a base passes their names, so an unrelated base run
   * (sentinel `development` carries 78-character `matrix_cell (<cellId>)`
   * runs over the label bound) never refuses the read. Without `names`, a
   * status context whose latest status is pending is advisory and left out
   * once at least one check run exists and every check run has completed
   * (sentinel issue #192). A GitHub Actions run that completed `failure`
   * while its job never started (no step, no runner) carries `neverStarted`
   * (`src/github/never-started-job.ts`: bounded job reads, an unreadable job
   * keeps the run as reported).
   */
  readChecks(
    head: GitSha,
    names?: ReadonlySet<string>,
  ): Promise<PortResultV1<GitHubChecksV1>>;
  /**
   * The check runs of `head` reduced to name and check suite, for the
   * required-CI coverage rule's read of a base only (`absentExpectedChecks`).
   * Lenient where `readChecks` is strict: it judges no conclusion, so a run's
   * name has no label bound (sentinel `development` carries 78-character
   * `matrix_cell (<cellId>)` runs) and commit statuses, which are never
   * expected, are not read; the item bound and the exact-head binding stay.
   */
  readCheckSuites(head: GitSha): Promise<PortResultV1<GitHubCheckSuitesV1>>;
  readProtections(
    baseBranch: string,
  ): Promise<PortResultV1<GitHubBranchProtectionsV1>>;
  /** Observe the current head of a ref (exact identity, not list order). */
  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>>;
  /**
   * Optional exact parents of one commit, in order (null: no such commit).
   * The carried delivery reads a merge commit's parents to park a merge that
   * landed off its tip at once (#156); absent, it keeps its bounded wait.
   */
  readCommitParents?(sha: GitSha): Promise<PortResultV1<GitSha[] | null>>;
  /**
   * Optional trusted deterministic candidate-base integration capability.
   *
   * When present, it re-observes the exact open trusted-author PR (state,
   * author, head branch, base branch), requires the current configured base ref
   * to equal `expectedBase` and the PR head to equal `expectedHead` (or, on
   * recovery only, the exact persisted `preparedHead`), ensures the candidate
   * ancestors exist through the SAME trusted restore capability the port uses,
   * and returns one deterministic prepared commit containing both the old
   * candidate and the new base. It never merges the PR, never publishes and
   * never spends model work. Optional is capability availability: a host
   * without it leaves the method absent, and a durable base-refresh intent then
   * waits bounded (never a deprecated-path fallback and never a silent
   * success). A wrong/foreign head, author, branch or moved base fails closed.
   */
  prepareBaseRefresh?(
    request: PrepareBaseRefreshRequestV1,
    takeover?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<GitSha>>;
  /** Pushes the trusted candidate commit; the model never publishes itself. */
  pushHead(
    ref: string,
    sha: GitSha,
    expectedRef: GitSha | null,
    takeover?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<WriteOutcomeV1>>;
  createPullRequest(
    request: PullRequestCreateV1,
  ): Promise<PortResultV1<PullRequestPublishV1>>;
  requestReview(
    request: ReviewSubmissionV1,
    takeover?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<ReviewRequestOutcomeV1>>;
  observeReview(
    request: ReviewObservationRequestV1,
  ): Promise<PortResultV1<ReviewObservationV1>>;
  mergePullRequest(
    request: MergeRequestV1,
    execution?: SelfMergeExecutionV1,
    takeover?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<MergeOutcomeV1>>;
  /**
   * Optional trusted carried-review patch proof (owner decision 2026-10-16
   * (2), option (b)), derived from git over the SAME executor and restore
   * capability the port publishes through. Absent: no refreshed head ever
   * carries a review. Unknown objects or an ambiguous merge base are typed
   * failures, never a proof. The runtime never merges a carried head: the
   * launcher's delivery pass does, after its own proof
   * (`ops/hosted-autonomy-spent-delivery.ts`).
   */
  proveCarriedPatch?(
    request: CarriedPatchRequestV1,
  ): Promise<PortResultV1<CarriedPatchProofV1>>;
  closeIssue(issueNumber: number): Promise<PortResultV1<IssueCloseOutcomeV1>>;
  closeAlreadySatisfiedTask?(
    request: AlreadySatisfiedClosureRequestV1,
  ): Promise<PortResultV1<IssueCloseOutcomeV1>>;
  /**
   * Assigns the trusted publication identity to the source issue BEFORE any
   * pull request for it is created. The organization's anti-spam policy closes
   * a pull request whose author is not assigned to the issue first, so this is
   * a publication prerequisite rather than bookkeeping. Idempotent: a login
   * that is already assigned is a success; it never closes, comments on or
   * otherwise mutates the issue.
   */
  assignIssue(issueNumber: number): Promise<PortResultV1<void>>;
  /**
   * Required trusted candidate-preservation capability.
   *
   * It revalidates the exact durable operation binding, stores the exact
   * candidate objects in a create-only deterministic remote ref and proves a
   * fresh empty object store can retrieve them, all through this SAME port
   * instance (repository identity is fixed here, never by the request).
   * Success means validated candidate plus exact create-only remote ref and
   * independently fetched objects in a new empty object store. A generic
   * transport/auth/CAS/permission/read failure is `unavailable`, never proof
   * of permanent loss; an existing different ref SHA is `conflict`. A port
   * without a composed preservation capability returns a static `unavailable`
   * for every call — it never reports success and never writes.
   */
  preserveCandidate(
    request: CandidatePreservationRequestV1,
    takeover?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<void>>;
  /**
   * Optional trusted legacy candidate-loss proof capability.
   *
   * It answers only whether ONE exact scoped legacy record has a provable
   * missing candidate: the durable legacy record and its submitted
   * reservation, the scoped source issue, the exact task branch/PR at the
   * predecessor head, the historical completed correction review and a fresh
   * empty object store fetched from the fixed remote must all line up, and the
   * recorded lost head must be absent there as both a commit and an object.
   * `null` is an explicit "this record is not a legacy-loss case" (new-format
   * candidate state, another intent, ineligible lifecycle); every unreadable,
   * moved, mismatched or otherwise unprovable input is a typed error, never an
   * absence and never a null. It writes no state or remote ref, starts no
   * model, runs no candidate-controlled code and creates no review.
   */
  proveLegacyBaseRefreshLoss?(
    taskId: WorkItemId,
  ): Promise<PortResultV1<LegacyBaseRefreshLossProofV1 | null>>;
  /**
   * Bounded lifecycle finalization forwarded to the SAME review-service
   * transport instance the port submits through: admission stops, owned
   * review operations are awaited or interrupted, and every journal is
   * reconciled inside the supplied deadline. Never starts a model, never
   * reserves budget and never writes repair state.
   */
  drainReviews(
    request: ReviewDrainRequestV1,
  ): Promise<PortResultV1<ReviewDrainReportV1>>;
}

// ---------------------------------------------------------------------------
// GitHubCooldownGateV1: durable cooldown in front of every authenticated
// request. beforeRequest must be checked before any read or write for an
// affected installation credential (intake included, before a work record
// exists), and recordRateLimit persists an observed limit before any later
// request. The production adapter and repair-loop wiring follow this contract
// freeze; no fake production default is defined here.
// ---------------------------------------------------------------------------

export interface GitHubCooldownGateV1 {
  beforeRequest(installationId: number): Promise<PortResultV1<void>>;
  recordRateLimit(
    installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>>;
}
