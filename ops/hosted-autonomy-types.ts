import type { ClosedCWaveRecoveryDepsV1 } from "../src/host/modern-matrix-recovery.ts";
import type { runMatrixUncertaintyMaintenance } from "../src/host/matrix-uncertainty-maintenance.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { ReviewTaskStatementV1 } from "../src/contracts/review-receipt.ts";
import type { HistoricalMatrixQuarantineDepsV1 } from "../src/host/matrix-actions.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import type { MismatchDispositionObservationsV1 } from "./runtime-mismatch-recovery-disposition.ts";
import type { HostedPlanArtifactV1 } from "./hosted-autonomy-producer-requests.ts";
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
   * Foreign gate: true when the exact head carries at least one check-run and
   * every one of them is completed with conclusion `success`. Zero check-runs
   * is not green, no run may still be pending or queued on that head, and the
   * listing must be proven complete across every page: a read that cannot be
   * completed is never green.
   */
  hasAllChecksGreen(head: string): Promise<boolean>;
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
  /** Expected-head merge; null on any refusal. */
  merge(
    number: number,
    head: string,
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

  /** Optional trusted effect evidence; absent means no disposition reads or writes. */
  mismatchDisposition?: MismatchDispositionObservationsV1;

  /**
   * Optional self-observation capability. Present only where the deployment
   * may read its own Actions history and file defects into its own tracker.
   */
  selfObservation?: HostedSelfObservationV1;
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
  fileIssue(input: { title: string; body: string }): Promise<number | null>;
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
};

export interface HostedAutonomyDepsV1 {
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
  uncertainMatrix?: () => ReturnType<typeof runMatrixUncertaintyMaintenance>;
  /**
   * Exact corrected runtime revisions for the refresh re-arm. Production never
   * sets it and uses HOSTED_AUTONOMY_REFRESH_REARM_RUNTIMES.
   */
  refreshRearmRuntimes?: readonly string[];
}

/** Fixed safe categories for maintenance failure logging; never raw text. */
export type MaintenanceFailureCategoryV1 =
  | "historical_quarantine_incomplete"
  | "historical_matrix_recovery"
  | "current_matrix_ingestion"
  | "closed_c_maintenance"
  | "unexpected_error";
