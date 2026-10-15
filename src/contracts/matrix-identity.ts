import type { GitSha, WorkItemId } from "./brands.ts";
import type { ModelRunReceiptV1, ModelRunRequestV1 } from "./ports.ts";
import type { RepositoryIdentityV1 } from "./shared.ts";
import {
  expectExactKeys,
  expectGitSha,
  expectPositiveInt,
  expectRecord,
} from "./validation.ts";

export const MATRIX_PLAN_VERSION = "v1" as const;
export const MATRIX_CELL_RESULT_VERSION = "v1" as const;
/** Native GitHub Actions matrix ceiling; the planner never throttles below it. */
export const MAX_MATRIX_CELLS = 256;
/**
 * Consecutive time-bound exhaustions (a matrix-cell host timeout, or a session
 * cut off by its configured duration bound) after which the planner decomposes
 * an issue into serial sub-tasks instead of granting the whole issue again.
 * One exhaustion already proves the whole task does not fit one session, so a
 * replay of the same scope is never planned. Each part is independently
 * completable within the session bound, so a later timeout discards at most
 * one part's work instead of the whole issue's.
 */
export const MATRIX_DECOMPOSE_AFTER_TIMEOUTS = 1;
/** Upper bound on sub-task parts for one decomposed issue. */
export const MATRIX_DECOMPOSE_MAX_PARTS = 4;

/**
 * Fixed launcher artifact paths, relative to the dispatched runner workspace:
 * the planner output, the per-cell grant input and one result file per cell.
 */
export const MATRIX_PLAN_PATH = ".sentinel-matrix/plan.json";
export const MATRIX_CELL_PATH = ".sentinel-matrix/cell.json";
export const MATRIX_RESULT_PATH = ".sentinel-matrix/result.json";
export const MATRIX_RESULTS_DIR = ".sentinel-matrix/results";
/** Bound on one result artifact so a hostile file cannot exhaust the ingester. */
export const MAX_MATRIX_ARTIFACT_BYTES = 2 * 1024 * 1024;
/** Shared producer/importer bound on one candidate Git bundle. */
export const MAX_MATRIX_BUNDLE_BYTES = 64 * 1024 * 1024;
/** Finite allowance for two ZIP headers, metadata and deflate/stored framing. */
export const MAX_MATRIX_ARCHIVE_OVERHEAD_BYTES = 1024 * 1024;
/** One bundle plus one result JSON, including bounded ZIP overhead. */
export const MAX_MATRIX_ARCHIVE_BYTES = MAX_MATRIX_BUNDLE_BYTES +
  MAX_MATRIX_ARTIFACT_BYTES + MAX_MATRIX_ARCHIVE_OVERHEAD_BYTES;

export const MAX_ID_CHARS = 256;
export const MAX_TEXT_CHARS = 100_000;
export const MAX_ERROR_CHARS = 8192;
export const MAX_CHANGED_PATHS = 4096;
export const MAX_PATH_CHARS = 1024;
export const MAX_EVIDENCE_REFS = 64;
export const MAX_REVIEW_FINDINGS = 128;

export const REQUEST_REQUIRED = [
  "taskId",
  "repository",
  "base",
  "issue",
  "evidence",
  "model",
  "reasoning",
  "maxDurationMs",
  "maxOutputChars",
] as const;
export const REQUEST_OPTIONAL = [
  "checkoutBase",
  "reviewFindings",
  "scopeNote",
  "priorAttempts",
  "repositoryLessons",
  "regressions",
] as const;
/** Bound on verified prior-attempt facts carried into one model request. */
export const MAX_PRIOR_ATTEMPT_FACTS = 8;
/** Bound on one closed settlement detail constant carried in a fact. */
export const MAX_PRIOR_ATTEMPT_DETAIL_CHARS = 512;
export const PRIOR_ATTEMPT_KEYS = [
  "detail",
  "stage",
  "failureClass",
  "count",
  "lastAtMs",
] as const;
/** Bound on versioned regression facts carried into one model request. */
export const MAX_REGRESSION_FACTS = 3;
export const REGRESSION_KEYS = [
  "detail",
  "priorSuccessRevision",
  "priorSuccessAtMs",
  "failuresAtCurrentRevision",
  "lastFailureAtMs",
] as const;
export const FINDING_KEYS = ["severity", "path", "message"] as const;
export const RUN_KEYS = ["runId", "runAttempt", "launcherSha"] as const;
export const CELL_KEYS = [
  "cellId",
  "taskId",
  "repository",
  "reservationId",
  "intentKey",
  "expectedBase",
  "runtimeSha",
  "generation",
  "requestDigest",
  "request",
] as const;
export const PLAN_KEYS = [
  "version",
  "kind",
  "waveId",
  "run",
  "plannedAt",
  "cells",
] as const;
export const RESULT_KEYS = [
  "version",
  "kind",
  "waveId",
  "cellId",
  "taskId",
  "repository",
  "run",
  "runtimeSha",
  "generation",
  "reservationId",
  "intentKey",
  "requestDigest",
  "status",
  "receipt",
  "bundle",
  "detail",
  "completedAt",
] as const;
export const BUNDLE_KEYS = ["file", "digest", "head", "checkpointSha"] as const;
export const RECEIPT_KEYS = [
  "invocationId",
  "outcome",
  "actual",
  "candidate",
  "error",
] as const;
export const ACTUAL_KEYS = [
  "evidenceKind",
  "provider",
  "threadId",
  "turnId",
  "terminalOrigin",
  "observedTerminalStatus",
  "observedModel",
  "observedReasoning",
  "durationMs",
  "outputChars",
] as const;
export const CANDIDATE_KEYS = [
  "head",
  "checkpointSha",
  "changedPaths",
] as const;
/** Literal tuple so enum inference stays the exact union, never `string`. */
export const TERMINAL_STATUSES = [
  "completed",
  "interrupted",
  "failed",
] as const;

/** Exact workflow run/attempt and launcher revision that owns the wave. */
export interface MatrixRunIdentityV1 {
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
}

/** One admitted implementation start: the exact grant a cell may execute. */
export interface MatrixCellPlanV1 {
  /** Stable wave+task identity; unique per task/repository/admission. */
  cellId: string;
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  /** Durable reservation that admitted this exact start. */
  reservationId: string;
  /** Durable implementation intent key on the work record. */
  intentKey: string;
  /** Exact planned checkout base (re-verified before the model starts). */
  expectedBase: GitSha;
  /** Trusted runtime implementation revision the wave is running. */
  runtimeSha: GitSha;
  /** Trusted hosted runtime pointer generation the wave is running. */
  generation: number;
  /** Canonical digest of `request`; a cell refuses any mismatch. */
  requestDigest: string;
  /** Exact secret-free request the cell runs once. */
  request: ModelRunRequestV1;
}

export interface MatrixPlanV1 {
  version: typeof MATRIX_PLAN_VERSION;
  kind: "matrix_plan";
  waveId: string;
  run: MatrixRunIdentityV1;
  plannedAt: number;
  cells: MatrixCellPlanV1[];
}

/** One cell's input artifact: the wave identity plus its single grant. */
export interface MatrixCellGrantV1 {
  waveId: string;
  run: MatrixRunIdentityV1;
  cell: MatrixCellPlanV1;
}

/**
 * Trusted actual identity of the running cell, derived by the host from the
 * dispatched workflow run and the hosted runtime pointer. It is NEVER read
 * from the untrusted grant artifact.
 */
export interface MatrixCellActualIdentityV1 {
  run: MatrixRunIdentityV1;
  runtimeSha: GitSha;
  generation: number;
}

export type MatrixCellResultStatusV1 = "completed" | "failed" | "not_started";

/**
 * Bounded candidate Git bundle produced by one cell. It carries only the
 * objects between the planned base and the candidate head, so the trusted
 * ingester can verify and import the exact candidate into its own mirror
 * before the existing preservation/publication consumers run. `file` is a safe
 * basename inside the wave results/bundles directory.
 */
export interface MatrixCellBundleV1 {
  /** Safe basename: the 64-hex cell id plus ".bundle". */
  file: string;
  /** SHA-256 of the exact bundle bytes. */
  digest: string;
  /** Exact candidate head the bundle must contain. */
  head: GitSha;
  /** Durable checkpoint SHA carried by the bundle, or null. */
  checkpointSha: GitSha | null;
}

/** One cell's output artifact; untrusted until trusted ingestion validates it. */
export interface MatrixCellResultV1 {
  version: typeof MATRIX_CELL_RESULT_VERSION;
  kind: "matrix_cell_result";
  waveId: string;
  cellId: string;
  taskId: WorkItemId;
  repository: RepositoryIdentityV1;
  run: MatrixRunIdentityV1;
  runtimeSha: GitSha;
  generation: number;
  reservationId: string;
  intentKey: string;
  requestDigest: string;
  status: MatrixCellResultStatusV1;
  /** Present exactly for a completed status; validated by production consumers. */
  receipt: ModelRunReceiptV1 | null;
  /** Candidate object carrier; required for a completed receipt with a head. */
  bundle: MatrixCellBundleV1 | null;
  /** Static sanitized detail for a non-completed status. */
  detail: string | null;
  completedAt: number;
}

// ---------------------------------------------------------------------------
// Strict parsers (identical rules at plan write and result read)
// ---------------------------------------------------------------------------

export function parseMatrixRunIdentityV1(
  input: unknown,
  path: string,
): MatrixRunIdentityV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, RUN_KEYS, path);
  return {
    runId: expectPositiveInt(obj.runId, `${path}.runId`),
    runAttempt: expectPositiveInt(obj.runAttempt, `${path}.runAttempt`),
    launcherSha: expectGitSha(obj.launcherSha, `${path}.launcherSha`),
  };
}
