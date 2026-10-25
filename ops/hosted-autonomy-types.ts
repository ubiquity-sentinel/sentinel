import type { ClosedCWaveRecoveryDepsV1 } from "../src/host/modern-matrix-recovery.ts";
import type { runMatrixUncertaintyMaintenance } from "../src/host/matrix-uncertainty-maintenance.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { ReviewTaskStatementV1 } from "../src/contracts/review-receipt.ts";
import type { HistoricalMatrixQuarantineDepsV1 } from "../src/host/matrix-actions.ts";
import type { ingestMatrixResults } from "../src/host/matrix.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { MismatchDispositionObservationsV1 } from "./runtime-mismatch-recovery-disposition.ts";
import type { HostedPlanArtifactV1 } from "./hosted-autonomy-producer-requests.ts";
import type { HostedTreeChangesV1 } from "./hosted-autonomy-github-trees.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../src/contracts/ports.ts";

/** Snapshot work record, as read from the durable repair state. */
export type HostedAutonomyRecordV1 = RepairStateSnapshotV1["work"][number];

export type HostedAutonomyReasonV1 =
  | "applied"
  | "no_change"
  | "retried"
  | "dispositioned"
  | "no_authorizing_review"
  | "base_moved"
  | "checks_pending"
  | "merge_refused"
  | "merge_not_observed"
  | "already_recorded"
  | "closed_issues"
  | "retired_records"
  | "foreign_author"
  | "release_not_terminal"
  | "clock_invalid"
  | "snapshot_invalid"
  | "write_conflict"
  | "write_ambiguous"
  | "write_unavailable"
  | "readback_unverified"
  | "identity_rejected"
  | "historical_quarantine_incomplete"
  | "deferred_matrix_history_budget"
  | "deferred_unexpected_error"
  | "unexpected_failure";

export interface HostedAutonomyResultV1 {
  kind: "hosted_autonomy";
  status: "applied" | "skipped" | "failed";
  reason: HostedAutonomyReasonV1;
  beforeHead: string | null;
  appliedHead: string | null;
  actions: readonly string[];
  revisions: readonly string[];
}

/** Remote merge facts this helper may not guess. */
export interface HostedAutonomyPullV1 {
  number: number;
  state: string;
  merged: boolean;
  mergeCommitSha: string | null;
  headSha: string | null;
  baseRef: string | null;
  baseSha: string | null;
  author: string | null;
  /** Required only when recovering a historical cleared publication. */
  mergedBy?: string | null;
  parents: readonly string[];
  revisionOnBaseBranch: boolean;
  /** The pull's own base commit is an ancestor of the merge revision. */
  baseAncestorOfRevision: boolean;
  /**
   * GitHub's own `mergeable` answer from the same pull read: true or false
   * once computed, null while GitHub is still computing it. Absent on a
   * surface that does not report it, which never proves mergeability.
   */
  mergeable?: boolean | null;
}

/**
 * One pull request whose head is EXACTLY a branch of the same repository (no
 * fork), as listed by head ref. Only the identity facts the base-refresh
 * credential-expiry re-admission rule verifies are carried.
 */
export interface HostedAutonomyHeadPullV1 {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  headSha: string;
  headRef: string;
  baseRef: string;
  author: string | null;
}

/**
 * One workflow run on an exact head, as the complete run listing reports it.
 * `runAttempt` is GitHub's own durable re-run counter for that run.
 * `createdAt` is the run's first-attempt creation time (GitHub's `created_at`,
 * epoch milliseconds), where GitHub's re-run window starts; null when GitHub
 * did not report it as a strict UTC timestamp (an unknown age).
 *
 * The optional fields serve only the CI resume pass
 * (`hosted-autonomy-ci-resume.ts`); absent or null is unknown, which never
 * re-runs anything: `updatedAt` (GitHub's `updated_at`, for a completed run
 * the completion of its latest attempt), `attemptStartedAt` (`run_started_at`,
 * the latest attempt's start) and `workflowId` (`workflow_id`).
 */
export interface HostedAutonomyHeadRunV1 {
  id: number;
  headSha: string;
  status: string;
  conclusion: string | null;
  runAttempt: number;
  createdAt: number | null;
  updatedAt?: number | null;
  attemptStartedAt?: number | null;
  workflowId?: number | null;
}

export interface HostedAutonomyGitHubV1 {
  /**
   * The repository's own default branch, or null when it cannot be read. Only
   * a foreign repository consults this; the self scope keeps its recorded
   * `development` constant.
   */
  readDefaultBranch(): Promise<string | null>;
  /**
   * Current tip of one repository branch — the repository's configured base
   * branch or a managed candidate branch — or null when it cannot be read. The
   * response must name exactly `refs/heads/<branch>`: a ref that names any
   * other branch is not evidence for the requested branch and reads as null.
   */
  readBaseTip(branch: string): Promise<string | null>;
  /**
   * Self gate: true when the exact head carries a completed successful
   * check-run named `test-local`. The whole check-run listing is read and must
   * be proven complete and consistent; an unreadable, incomplete, drifted,
   * duplicated or malformed read is never green, and a later page may not hide
   * the named check or a failure.
   */
  hasSuccessfulCheck(head: string): Promise<boolean>;
  /**
   * Foreign gate, tri-state (sentinel issue #154). True when the exact head
   * carries at least one check-run, every one of them is completed with
   * conclusion `success` and, when `base` names the commit the head is tested
   * against, the head reports every check name of each `base` check suite it
   * shares a name with (`missingExpectedChecks`: a `needs:` job GitHub has not
   * created yet is not green). False for a readable listing that fails any of
   * that (pending, queued, failed or a missing expected check). Null when it
   * is unreadable: a head or base listing that cannot be proven complete
   * across every page or is malformed, or a head with no check-run at all.
   * Only true is green; null is no evidence either way, never red.
   */
  hasAllChecksGreen(head: string, base?: string): Promise<boolean | null>;
  /**
   * Base-repair read: the names of the check runs on the exact commit whose
   * latest run of that name completed with `failure`, `timed_out` or
   * `startup_failure`, leaving out a GitHub Actions run whose job never
   * started (no step, no runner: a billing or spending-limit stop; bounded
   * job reads, an unreadable job keeps its failure). Empty when none did,
   * null when the complete listing cannot be read. Optional: a surface
   * without it files no base-repair issue.
   */
  failedChecks?(head: string): Promise<string[] | null>;
  /**
   * CI resume read: true when the latest attempt of completed workflow run
   * `id` on `head` failed only through jobs that never started (at least one
   * failed job, each with no step and no runner), false when a failed job
   * ran, null when its job listing cannot be read completely and bound to
   * that run and head. Optional: a surface without it resumes nothing.
   */
  runNeverStarted?(id: number, head: string): Promise<boolean | null>;
  /**
   * `baseBranch` is the branch the merge must be integrated into; a merged
   * pull whose integration cannot be verified without it reads as null.
   */
  readPull(
    number: number,
    baseBranch: string | null,
  ): Promise<HostedAutonomyPullV1 | null>;
  /**
   * Every pull request (any state) whose head is exactly `branch` of THIS
   * repository, or null when that listing cannot be read and proven complete.
   * Optional: a surface without it re-admits no base-refresh terminal block,
   * because the owned PR on the exact branch could not be verified.
   */
  listPullsByHeadRef?(
    branch: string,
  ): Promise<readonly HostedAutonomyHeadPullV1[] | null>;
  /**
   * Every path pull request `number` changes, a rename's previous path
   * included, or null when the listing cannot be read and proven complete
   * (GitHub lists at most 3000 files). Optional: a fixture surface without
   * it skips the merge gate's protected-path check (issue #158).
   */
  listPullFiles?(number: number): Promise<readonly string[] | null>;
  /**
   * True when the source issue is open, false when it is closed or missing,
   * null when that cannot be read. Only a definitive false stops a retry.
   */
  readIssueOpen(number: number): Promise<boolean | null>;
  /**
   * Trusted, independent read of the exact source-issue task statement this
   * delivery must fulfill: the issue's own number, title and body with the
   * canonical digest of that text, read over THIS repository's authenticated
   * surface immediately before a merge, release request or closure. Null means
   * the statement could not be read or bounded, which never authorizes
   * issue-backed delivery. Absent means the surface cannot supply it, which
   * also fails closed for issue-backed records.
   */
  readIssueTask?(number: number): Promise<ReviewTaskStatementV1 | null>;
  /** Exact current source opt-out projection; null/absent cannot authorize gateway closure. */
  readIssueOptedOut?(number: number): Promise<boolean | null>;
  /**
   * True only when `base` is a strict ancestor of `tip` on THIS repository,
   * proven by the compare `base...tip` (status `ahead`, base and merge base
   * both exactly `base`). Optional: a surface without it proves nothing, so
   * no moved-base merge is ever made over it.
   */
  baseAdvanced?(base: string, tip: string): Promise<boolean>;
  /**
   * SHA-256 (lowercase hex) of the exact bytes of GitHub's merge-base diff of
   * `head` against `base` in THIS repository (compare `base...head`, diff
   * media type), or null when it cannot be read whole within its bound. The
   * carried merge's evidence only: a rendered diff abbreviates blob ids and
   * folds binary changes, so it proves no exact patch.
   */
  comparePatchDigest?(base: string, head: string): Promise<string | null>;
  /**
   * The exact merge-base patch of `head` against `base` in THIS repository:
   * every changed path as (path, old mode, old blob id, new mode, new blob
   * id) between the merge base's and the head's recursive trees, or null when
   * any read fails or GitHub truncates a tree. Optional: a surface without it
   * proves no carried patch, so it never makes a carried merge.
   */
  mergeBaseTreeChanges?(
    base: string,
    head: string,
  ): Promise<HostedTreeChangesV1 | null>;
  /**
   * Expected-head merge; null on any refusal. `message`, when given, is the
   * merge commit's plain evidence text (the carried merge's proof).
   */
  merge(
    number: number,
    head: string,
    message?: string,
  ): Promise<{ merged: boolean; sha: string | null } | null>;
  /** Idempotent issue closure: true when the issue ends closed. */
  closeIssue(number: number): Promise<boolean>;
  /**
   * Workflow-run ids parked for approval on exactly this commit, read from the
   * complete listing (a parked run on a later page is still found). A listing
   * that cannot be proven complete approves nothing.
   */
  listParkedRuns(head: string): Promise<number[]>;
  /** Approve one parked workflow run; true when the approval was accepted. */
  approveRun(id: number): Promise<boolean>;
  /**
   * Every workflow run on exactly this commit, read from the complete listing
   * and bound to that head, or null when it cannot be proven complete and
   * well formed. Optional: a surface without it re-runs nothing.
   */
  listHeadRuns?(
    head: string,
  ): Promise<readonly HostedAutonomyHeadRunV1[] | null>;
  /**
   * Re-run the failed jobs of one workflow run; true when GitHub accepted the
   * request (any 2xx, whatever the body). Optional, like `listHeadRuns`.
   */
  rerunFailedJobs?(id: number): Promise<boolean>;

  /** Optional trusted effect evidence; absent means no disposition reads or writes. */
  mismatchDisposition?: MismatchDispositionObservationsV1;

  /**
   * Optional self-observation capability. Present only where the deployment
   * may read its own Actions history and file defects into its own tracker.
   */
  selfObservation?: HostedSelfObservationV1;

  /**
   * Optional trusted launcher capability: list and create issues in THIS
   * repository for review follow-ups. Absent means no follow-up is filed.
   */
  followUpIssues?: HostedFollowUpIssuesV1;

  /**
   * Optional trusted launcher capability: the owner's `sentinel:retry` label
   * on THIS repository's issues (`ops/hosted-autonomy-retry-label.ts`).
   * Absent means no label exit is read or taken.
   */
  retryLabel?: HostedRetryLabelV1;
  /** Sentinel's own CI-outage tracker (used on the self scope only). */
  ciOutageTracker?:
    import("./hosted-autonomy-outage-observation.ts").OutageTrackerV1;
  /**
   * The start class of one target tip's complete check listing (never
   * started, started, undetermined), or null when it cannot be read.
   */
  classifyTipStart?(
    tip: string,
  ): Promise<
    import("./hosted-autonomy-outage-observation.ts").OutageTipStartV1 | null
  >;
}

/** The owner's one-label re-admission handle (redesign 2026-10-25, C6). */
export interface HostedRetryLabelV1 {
  /**
   * Numbers of THIS repository's OPEN issues (never pull requests) that carry
   * the `sentinel:retry` label, from one complete bounded listing; null when
   * the listing cannot be proven complete and well formed.
   */
  listOpenRetryLabeled(): Promise<ReadonlySet<number> | null>;
  /**
   * Remove `sentinel:retry` from one issue: true only when GitHub accepted
   * the removal and its answer (the remaining labels) no longer carries it.
   */
  removeRetryLabel(number: number): Promise<boolean>;
}

/** One issue or pull request of a created-since listing. */
export interface HostedIssueListingItemV1 {
  number: number;
  /** The creator's login, exactly as GitHub reports it. */
  author: string;
  /** GitHub's `created_at`, epoch milliseconds. */
  createdAt: number;
  /** True for a pull request (the issues listing returns both). */
  pullRequest: boolean;
  /** The body's first line (LF or CRLF), empty for an empty body. */
  firstLine: string;
}

/** The creator and first body line of one existing issue (never a PR). */
export interface HostedIssueOriginV1 {
  number: number;
  author: string;
  firstLine: string;
}

/**
 * Launcher-only issue capability for review follow-ups in ONE repository,
 * over the sentinel App token. Every answer is bound to the exact repository
 * identity; anything unproven is null.
 */
export interface HostedFollowUpIssuesV1 {
  /**
   * Every issue and pull request created at or after `sinceMs`, newest first.
   * A short last page proves completeness; when the page bound is reached the
   * returned prefix is still proven down to its oldest item. Null means the
   * prefix itself could not be read and validated.
   */
  listCreatedSince(input: {
    sinceMs: number;
    maxPages: number;
  }): Promise<readonly HostedIssueListingItemV1[] | null>;
  /** One existing issue's creator and first body line, or null. */
  readIssueOrigin(number: number): Promise<HostedIssueOriginV1 | null>;
  /**
   * Create one issue with exactly this title and body, optionally adding the
   * named labels. The new number only when GitHub's answer is an issue of this
   * repository created by the sentinel App that echoes the exact text;
   * otherwise null (the create may still have happened).
   */
  create(input: {
    title: string;
    body: string;
    labels?: readonly string[];
  }): Promise<number | null>;
}

export interface HostedSelfRunV1 {
  id: number;
  name: string;
  conclusion: string | null;
  createdAt: string;
}

export interface HostedSelfJobV1 {
  id: number;
  name: string;
  conclusion: string | null;
}

/**
 * Optional self-observation surface: this deployment's own recent workflow
 * runs, the failed job logs (bounded read) and the issue write used to report
 * a defect class. Absent means the pass is skipped entirely — no reads, no
 * writes — so a host without the capability behaves exactly as before.
 */
export interface HostedSelfObservationV1 {
  listRuns(input: {
    sinceIso: string;
    limit: number;
  }): Promise<HostedSelfRunV1[] | null>;
  listJobs(runId: number): Promise<HostedSelfJobV1[] | null>;
  readJobLog(
    input: { jobId: number; maxBytes: number },
  ): Promise<string | null>;
  listOpenIssueBodies(): Promise<string[] | null>;
  fileIssue(
    input: { title: string; body: string; labels?: string[] },
  ): Promise<number | null>;
}

/**
 * The protected maintenance matrix slice. `readPlanArtifact` is the
 * launcher-only native listing of one producer run's exact plan artifact (null
 * when unlisted); when absent, the authenticated transport alone decides.
 */
export type HostedClosedMatrixDepsV1 = ClosedCWaveRecoveryDepsV1 & {
  readPlanArtifact?(
    run: { runId: number; runAttempt: number },
    deadline: number,
  ): Promise<HostedPlanArtifactV1 | null>;
  /**
   * A producer pass's matrix consumer. Production never sets it and uses
   * ingestMatrixResults; a test substitutes the consumer's exact report.
   */
  ingest?: typeof ingestMatrixResults;
};

export interface HostedAutonomyDepsV1 {
  /** Trusted queue composition. Production gateway maintenance refuses when missing. */
  queue?:
    import("./hosted-autonomy-queue-contracts.ts").HostedQueueCoordinatorDeps;
  /** Shared custody for every prephase, retry, delivery and follow-up consumer. */
  queueCustody?:
    import("./hosted-autonomy-queue-context.ts").HostedQueueCustodyContext;
  onQueueCustodyReady?(ready: boolean): void | Promise<void>;
  state: StateReadView & RepairStateWriter;
  /**
   * Resolve the GitHub surface for one exact repository identity. A null (or
   * throwing) resolver is an unreadable surface: the affected record is
   * skipped with an explicit action and nothing changes. No repository ever
   * borrows another repository's surface.
   */
  githubFor(repository: RepositoryIdentityV1): HostedAutonomyGitHubV1 | null;
  clock: { now(): number };
  /** Present on protected maintenance; rejection-only, before retry/delivery. */
  historicalMatrix?: HistoricalMatrixQuarantineDepsV1;
  closedMatrix?: (
    state?: StateReadView & RepairStateWriter,
  ) => Promise<HostedClosedMatrixDepsV1>;
  /** Charged uncertainty only; no producer, artifact, health or release authority. */
  uncertainMatrix?: (
    state?: StateReadView & RepairStateWriter,
    protectedRecordIds?: ReadonlySet<string>,
  ) => ReturnType<typeof runMatrixUncertaintyMaintenance>;
  /**
   * Exact corrected runtime revisions for the refresh re-arm, each with its
   * pinned activation bound. Production never sets it and uses
   * HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES.
   */
  refreshRearmRuntimes?: readonly HostedRefreshRearmRuntimeV1[];
  /**
   * Exact conflict-resolution runtime revisions for the conflict
   * re-admission, each with its pinned activation bound. Production never
   * sets it and uses HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES.
   */
  conflictResolutionRuntimes?: readonly HostedRefreshRearmRuntimeV1[];
  /**
   * The moved-base spent merge (decision D3) for tests of its gate.
   * Production never sets it and uses HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE.
   */
  spentMovedBaseMerge?: boolean;
  /**
   * The legacy review cutoff for tests of the legacy class. Production never
   * sets it and uses the one pinned cutoff under a proven CI-first runtime
   * (`launcherLegacyCutoff`).
   */
  legacyReviewCutoff?: number | null;
  /**
   * Exact acceptance-correction runtime revisions for the B6a re-admission,
   * for tests. Production never sets it and uses
   * HOSTED_AUTONOMY_ACCEPTANCE_CORRECTION_RUNTIMES.
   */
  acceptanceCorrectionRuntimes?: ReadonlySet<string>;
  /**
   * `repeatFailureRouteIdentity` of the non-secret model-route selector this
   * maintenance job was handed; a change re-arms a repeat-failure park.
   * Absent means the unset selector (`REPEAT_FAILURE_DEFAULT_ROUTE`).
   */
  modelRoute?: string;
}

/** One corrected runtime the refresh re-arm trusts, pinned in launcher source. */
export interface HostedRefreshRearmRuntimeV1 {
  /** The exact runtime revision; never a generation number. */
  revision: string;
  /**
   * Epoch milliseconds no later than the revision's first activation: the
   * instant of the launcher commit that pins this entry, which precedes the
   * owner install that commit performs.
   */
  activatedNotBefore: number;
}

/** Fixed safe categories for maintenance failure logging; never raw text. */
export type MaintenanceFailureCategoryV1 =
  | "historical_quarantine_incomplete"
  | "historical_matrix_recovery"
  | "current_matrix_ingestion"
  | "closed_c_maintenance"
  | "unexpected_error";
