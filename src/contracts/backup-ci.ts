/**
 * Backup CI receipts (docs/backup-ci-spec.md §6.1).
 *
 * When a target's own GitHub Actions job never started (an account billing
 * stop), the trusted `backup_ci` job runs that job of the target's committed
 * workflow in the ubiquity-sentinel org and records a receipt on the store
 * branch `sentinel-backup-ci`. These are the store's record shapes, their
 * fail-closed parsers (`backup-ci-parse-unit.ts`,
 * `backup-ci-parse.ts`) and the small pure rules every
 * writer and reader shares. Nothing here is part of Sentinel's persisted
 * repair state: receipts live only on the store branch, and a reader that
 * finds none, or anything it cannot verify, substitutes nothing.
 */
import { createHash } from "node:crypto";
import type { GitSha } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";

export const BACKUP_CI_STORE_REMOTE =
  "https://github.com/ubiquity-sentinel/sentinel.git";
export const BACKUP_CI_STORE_REF = "refs/heads/sentinel-backup-ci";
export const BACKUP_CI_LEGS_REF = "refs/heads/sentinel-backup-legs";
export const BACKUP_CI_RUN_REF = "refs/heads/sentinel-supervisor";
export const BACKUP_CI_WORKFLOW_PATH = ".github/workflows/backup-ci.yml";
export const BACKUP_CI_LEG_WORKFLOW_PATH =
  ".github/workflows/backup-ci-leg.yml";
export const BACKUP_CI_LEG_JOB = "leg";
/** The leg job's steps; they must appear in this order. */
export const BACKUP_CI_LEG_STEPS = [
  "Prepare and verify the unit",
  "Run the target job",
  "Upload the backup result",
  "Report the backup result",
] as const;
/** Bump when leg semantics change: a new revision is a new runner id. */
export const BACKUP_CI_LEG_REVISION = 2;
export const BACKUP_CI_MAX_PARALLEL = 2;
export const BACKUP_CI_MAX_JOB_MINUTES = 60;
export const BACKUP_CI_LEG_SETUP_MINUTES = 10;
export const BACKUP_CI_MAX_COMMITS_READ_PER_TARGET = 12;
export const BACKUP_CI_MAX_INGEST_PER_PASS = 32;
export const BACKUP_CI_TARGET_BUDGET_MS = 60_000;
/** Backoff after a leg ran without evidence (by legs run, last repeats). */
export const BACKUP_CI_BACKOFF_MS: readonly number[] = [
  15 * 60_000,
  60 * 60_000,
  4 * 3_600_000,
  24 * 3_600_000,
];
/** Retry after a planning or infrastructure refusal that ran no leg. */
export const BACKUP_CI_RETRY_MS = 10 * 60_000;
export const BACKUP_CI_LEG_MISSING_MS = 30 * 60_000;
export const BACKUP_CI_TIP_TTL_MS = 10_000;
export const BACKUP_CI_MAX_TREE_BYTES = 256 * 2 ** 20;
export const BACKUP_CI_MAX_FILE_BYTES = 256 * 1024;
export const BACKUP_CI_MAX_RESULT_BYTES = 64 * 1024;
export const BACKUP_CI_MAX_EXCERPT_BYTES = 8 * 1024;
export const BACKUP_CI_MAX_EVENT_BYTES = 16 * 1024;
export const BACKUP_CI_CALIBRATION = {
  agreements: 5,
  failureAgreements: 1,
  maxFalseReds: 1,
} as const;
export const BACKUP_CI_RUNNER_LIMITS = { cpus: 2, memoryGiB: 7 } as const;
export const BACKUP_CI_SETUP_ACTIONS = [
  "actions/checkout",
  "actions/setup-node",
  "actions/setup-python",
  "actions/setup-go",
  "actions/setup-java",
  "actions/cache",
  "denoland/setup-deno",
  "oven-sh/setup-bun",
  "pnpm/action-setup",
] as const;
/**
 * Trusted check-name shape; the same expression as `CI_CHECK_NAME_PATTERN`
 * (src/repair/ci-rejection.ts), pinned equal by a test.
 */
export const BACKUP_CI_CHECK_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9 ._:/()[\],+#@-]{0,63}$/;

export type BackupCiModeV1 = "off" | "shadow" | "on";
export type BackupCiContextV1 = "push" | "pull_request";
export type BackupCiRedV1 = "failure" | "timed_out";
export type BackupCiConclusionV1 = "success" | BackupCiRedV1;
export type BackupCiRunsOnV1 =
  | "ubuntu-latest"
  | "ubuntu-24.04"
  | "ubuntu-22.04";

export const BACKUP_CI_UNSUPPORTED = [
  "runs_on",
  "services",
  "container",
  "environment",
  "needs_or_job_if",
  "reusable",
  "matrix_shape",
  "job_name",
  "secrets_or_vars",
  "token",
  "step_shape",
  "step_condition",
  "expression_context",
  "checkout_inputs",
  "docker_action",
  "action_unresolved",
  "timeout",
  "name_unmapped",
  "act_config_file",
  "context_reference",
  "coverage",
  "workflow_unreadable",
  "workflow_path",
  "not_account_cause",
  "other_app",
  "status_context",
  "mixed_paths",
  "head_not_on_base",
  "repository_id",
  "tree_too_large",
] as const;
export type BackupCiUnsupportedV1 = (typeof BACKUP_CI_UNSUPPORTED)[number];
/** Refusals that ran no leg: not counted, retried after `BACKUP_CI_RETRY_MS`. */
export const BACKUP_CI_NO_LEG_REASONS = [
  "pr_not_open",
  "pr_moved",
  "fetch_failed",
  "dispatch_failed",
  "legs_ref_behind",
  "leg_missing",
  "ingest_error",
] as const;
/** A leg ran without evidence: counted, backed off by `BACKUP_CI_BACKOFF_MS`. */
export const BACKUP_CI_LEG_RAN_REASONS = [
  "leg_failed",
  "leg_cancelled",
  "leg_stuck",
  "marker_missing",
  "log_unserved",
  "artifact_missing",
  "artifact_invalid",
  "digest_mismatch",
  "binding_mismatch",
  "result_invalid",
  "selftest_failed",
  "setup_action_failed",
  "act_internal",
  "act_inconsistent",
  "skipped_in_backup",
  "runner_timeout",
] as const;
export type BackupCiNoEvidenceReasonV1 =
  | `unsupported:${BackupCiUnsupportedV1}`
  | (typeof BACKUP_CI_NO_LEG_REASONS)[number]
  | (typeof BACKUP_CI_LEG_RAN_REASONS)[number];

/** One `sentinel.backup-ci-targets.json` row. */
export interface BackupCiTargetV1 {
  repository: `${string}/${string}`;
  id: number;
}
export interface BackupCiEntryKeyV1 {
  context: BackupCiContextV1;
  workflowPath: string;
  checkName: string;
  /** The reviewed base B; `pull_request` only, null for push. */
  base: GitSha | null;
  /** 2 = the confirmation of a red attempt 1. */
  attempt: 1 | 2;
}
export interface BackupCiPlannedStepV1 {
  index: number;
  actStepId: string;
  kind: "run" | "uses_local" | "uses_remote";
  uses: string | null;
  condition: "none" | "status_only";
  continueOnError: boolean;
}
export type BackupCiPurposeV1 = "stand_in" | "confirm" | "peer" | "calibration";
export type BackupCiMatrixV1 = Record<string, string | number | boolean> | null;
export interface BackupCiUnitV1 {
  version: 1;
  kind: "sentinel_backup_ci_unit";
  /** `backupCiUnitId`: hex24 of the unit without `unitId` and `plan`. */
  unitId: string;
  purpose: BackupCiPurposeV1;
  key: BackupCiEntryKeyV1;
  repository: {
    owner: string;
    name: string;
    id: number;
    defaultBranch: string;
    private: boolean;
  };
  /** The commit the check is about (head or base). */
  commit: GitSha;
  /** M (parents [B, H], tree(H)) for pull_request; the commit for push. */
  exec: { commit: GitSha; parents: GitSha[]; tree: GitSha; synthetic: boolean };
  pullRequest: {
    number: number;
    base: GitSha;
    baseRef: string;
    headRef: string;
  } | null;
  /** refs/pull/N/merge | refs/heads/<branch> */
  ref: string;
  workflow: { path: string; blob: GitSha; name: string };
  job: {
    key: string;
    matrix: BackupCiMatrixV1;
    checkName: string;
    runsOn: BackupCiRunsOnV1;
    capMinutes: number;
    targetTimeoutMinutes: number | null;
  };
  /** At most 100, main stage only. */
  steps: BackupCiPlannedStepV1[];
  /** At most 16 KiB canonical, allowlisted top-level keys (§9.4). */
  event: Record<string, unknown>;
  neverStarted: {
    checkRunIds: number[];
    runIds: number[];
    cause: "account_billing";
  } | null;
  /** The native observation compared against (peer and calibration units). */
  native: { checkRunId: number; conclusion: string } | null;
  plan: {
    runId: number;
    launcherSha: GitSha;
    plannedAt: number;
    mode: "shadow" | "on";
    runnerId: string;
  };
}
export type BackupCiStepResultV1 =
  | "success"
  | "failure"
  | "skipped"
  | "cancelled"
  | "missing";
/** UNTRUSTED leg output. It contains no target-derived text. */
export interface BackupCiResultV1 {
  version: 1;
  kind: "sentinel_backup_ci_result";
  unitId: string;
  unitDigest: string;
  observed: {
    head: GitSha;
    tree: GitSha;
    parents: GitSha[];
    workflowBlob: GitSha;
    clean: true;
  };
  selftest: "passed";
  outcome: BackupCiConclusionV1 | "no_evidence";
  reason: BackupCiNoEvidenceReasonV1 | null;
  act: { exitCode: number | null; jobResults: number };
  steps: { index: number; result: BackupCiStepResultV1 }[];
  failingStep: number | null;
  startedAt: number;
  completedAt: number;
  /** imageOs / imageVersion match [A-Za-z0-9._-]{1,32}. */
  runner: { runnerId: string; imageOs: string; imageVersion: string };
}
export interface BackupCiWorkflowCoverageV1 {
  path: string;
  blob: GitSha;
  event: BackupCiContextV1;
  observedAt: number;
  supported: boolean;
  reason: BackupCiUnsupportedV1 | null;
  /** Every rendered check name of the file for that event (at most 64). */
  expected: string[];
}
export interface BackupCiDispatchedEntryV1 {
  state: "dispatched";
  key: BackupCiEntryKeyV1;
  mode: "shadow" | "on";
  runnerId: string;
  unit: BackupCiUnitV1;
  unitDigest: string;
  tree: { artifactId: number; sha256: string };
  dispatchedAt: number;
}
export interface BackupCiResultEntryV1 {
  state: "result";
  key: BackupCiEntryKeyV1;
  mode: "shadow" | "evidence";
  runnerId: string;
  purpose: BackupCiPurposeV1;
  conclusion: BackupCiConclusionV1;
  unitDigest: string;
  resultDigest: string;
  startedAt: number;
  completedAt: number;
  binding: {
    execCommit: GitSha;
    parents: GitSha[];
    tree: GitSha;
    workflowBlob: GitSha;
    jobKey: string;
    matrix: BackupCiMatrixV1;
  };
  leg: {
    runId: number;
    jobId: number;
    artifactId: number;
    launcherSha: GitSha;
  };
  native: { checkRunId: number; conclusion: string } | null;
  /** Sanitized, at most 8 KiB; null on success. */
  failure: { stepIndex: number; excerpt: string } | null;
  ingestedAt: number;
}
export interface BackupCiNoEvidenceEntryV1 {
  state: "no_evidence";
  key: BackupCiEntryKeyV1;
  mode: "shadow" | "evidence";
  runnerId: string;
  reason: BackupCiNoEvidenceReasonV1;
  legRuns: number;
  firstAt: number;
  lastAt: number;
  nextAt: number | null;
  final: boolean;
}
export type BackupCiEntryV1 =
  | BackupCiDispatchedEntryV1
  | BackupCiResultEntryV1
  | BackupCiNoEvidenceEntryV1;
/** v1/<owner>/<repo>/<sha[0:2]>/<sha>.json */
export interface BackupCiCommitFileV1 {
  version: 1;
  kind: "sentinel_backup_ci_commit";
  repository: { owner: string; name: string; id: number };
  commit: GitSha;
  /** At most 16. */
  workflows: BackupCiWorkflowCoverageV1[];
  /** At most 128, strictly sorted by `backupCiEntrySortKey`. */
  entries: BackupCiEntryV1[];
  updatedAt: number;
}
/** v1/suspended.json (scope "all") or v1/<owner>/<repo>/suspended.json */
export interface BackupCiSuspensionV1 {
  version: 1;
  kind: "sentinel_backup_ci_suspension";
  scope: "all" | `${string}/${string}`;
  runnerIds: string[] | "all";
  reason: "false_green" | "false_red" | "operator";
  since: number;
  evidence: {
    commit: GitSha;
    checkName: string;
    nativeCheckRunId: number;
    receipt: string;
  } | null;
}
export interface BackupCiCalibrationSampleV1 {
  commit: GitSha;
  checkName: string;
  native: string;
  backup: BackupCiConclusionV1;
}
export interface BackupCiRunnerCalibrationV1 {
  runnerId: string;
  agreements: number;
  failureAgreements: number;
  falseGreens: number;
  falseReds: number;
  samples: BackupCiCalibrationSampleV1[];
}
/** v1/<owner>/<repo>/calibration.json */
export interface BackupCiCalibrationV1 {
  version: 1;
  kind: "sentinel_backup_ci_calibration";
  repository: { owner: string; name: string; id: number };
  runners: BackupCiRunnerCalibrationV1[];
  updatedAt: number;
}

/** Only the exact values `on` and `shadow` enable anything (lower-only). */
export function parseBackupCiMode(raw: string | undefined): BackupCiModeV1 {
  return raw === "on" || raw === "shadow" ? raw : "off";
}

const LEG_RAN: ReadonlySet<string> = new Set(BACKUP_CI_LEG_RAN_REASONS);

/** Whether a no-evidence reason means a leg ran (counted, backed off). */
export function noEvidenceLegRan(reason: BackupCiNoEvidenceReasonV1): boolean {
  return LEG_RAN.has(reason);
}

/** A result's mode class: `on` plans record `evidence` results. */
export function backupCiModeClass(
  mode: "shadow" | "on" | "evidence",
): "shadow" | "evidence" {
  return mode === "shadow" ? "shadow" : "evidence";
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 over the unit's canonical serialization. */
export function backupCiUnitDigest(unit: BackupCiUnitV1): string {
  return sha256Hex(canonicalStringify(unit));
}

/** hex24 of the unit's canonical serialization without `unitId` and `plan`. */
export function backupCiUnitId(
  unit: Omit<BackupCiUnitV1, "unitId" | "plan">,
): string {
  const { unitId: _id, plan: _plan, ...rest } = unit as BackupCiUnitV1;
  return sha256Hex(canonicalStringify(rest)).slice(0, 24);
}

/** sha256 hex of exact bytes (a result file as the leg uploaded it). */
export function backupCiBytesDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * A runner is calibrated for a target once it agreed with native CI at least
 * `agreements` times, at least `failureAgreements` of them on a red, never
 * reported green where native was red, and at most `maxFalseReds` times red
 * where native was green.
 */
export function isBackupCiCalibrated(
  calibration: BackupCiCalibrationV1 | null,
  runnerId: string,
): boolean {
  const runner = calibration?.runners.find((row) => row.runnerId === runnerId);
  return runner !== undefined &&
    runner.agreements >= BACKUP_CI_CALIBRATION.agreements &&
    runner.failureAgreements >= BACKUP_CI_CALIBRATION.failureAgreements &&
    runner.falseGreens === 0 &&
    runner.falseReds <= BACKUP_CI_CALIBRATION.maxFalseReds;
}

export function backupCiCommitPath(
  owner: string,
  repo: string,
  sha: GitSha,
): string {
  return `v1/${owner}/${repo}/${sha.slice(0, 2)}/${sha}.json`;
}

export function backupCiSuspensionPath(owner?: string, repo?: string): string {
  return owner === undefined || repo === undefined
    ? "v1/suspended.json"
    : `v1/${owner}/${repo}/suspended.json`;
}

export function backupCiCalibrationPath(owner: string, repo: string): string {
  return `v1/${owner}/${repo}/calibration.json`;
}

/** `bci1:<owner>/<repo>@<sha12>:<path>#<checkName>:<context>[:<base12>]:a<n>` */
export function backupCiReceiptId(
  repo: string,
  commit: GitSha,
  key: BackupCiEntryKeyV1,
): string {
  const base = key.base === null ? "" : `:${key.base.slice(0, 12)}`;
  return `bci1:${repo}@${
    commit.slice(0, 12)
  }:${key.workflowPath}#${key.checkName}:${key.context}${base}:a${key.attempt}`;
}

/** The canonical identity entries are sorted (and made unique) by. */
export function backupCiEntrySortKey(entry: BackupCiEntryV1): string {
  return canonicalStringify({
    key: entry.key,
    mode: backupCiModeClass(entry.mode),
    runnerId: entry.runnerId,
    state: entry.state,
  });
}

export function sameBackupCiKey(
  a: BackupCiEntryKeyV1,
  b: BackupCiEntryKeyV1,
): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}

export {
  parseBackupCiResult,
  parseBackupCiUnit,
} from "./backup-ci-parse-unit.ts";
export {
  parseBackupCiCalibration,
  parseBackupCiCommitFile,
  parseBackupCiSuspension,
  parseBackupCiTargets,
} from "./backup-ci-parse.ts";
