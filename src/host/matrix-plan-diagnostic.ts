/**
 * Sanitized plan diagnostic line (2026-10-25 redesign, C5.1).
 *
 * The planner's `MatrixPlanReportV1.diagnostic` explains a zero-cell wave
 * (every record skipped or not implementation-shaped), but only the exact-key
 * plan carrier ever left the child, so a run that planned nothing could not
 * say why. The planner child now prints one `sentinel_matrix_plan_diagnostic`
 * line next to the carrier, with per-repository counts under a closed key
 * vocabulary (`planSkipKey`, `planNotReadyKey`). The launcher re-parses it
 * (`scanPlanDiagnostic`): only the known keys with non-negative integer counts
 * survive, everything else is dropped, and the line is re-emitted after the
 * carrier. The carrier, its exact keys and every reader of it (the launcher
 * carrier scan, the job-log marker reader) are unchanged; the line is
 * advisory and grants nothing.
 */
import type { MatrixPlanDiagnosticV1 } from "./matrix-planner.ts";
import { MaxItems } from "../contracts/validation.ts";
import {
  type MatrixPlanRefusalV1,
  parseMatrixPlanRefusalV1,
} from "./matrix-plan-refusal.ts";

export const MATRIX_PLAN_DIAGNOSTIC_KIND = "sentinel_matrix_plan_diagnostic";

/** `rankEligibleWork` skip reasons; anything else counts as `other`. */
export const MATRIX_PLAN_SKIP_REASONS: readonly string[] = [
  "terminal",
  "blocked",
  "waiting",
  "dependency",
  "unconfigured",
  "other",
];

/** Operation key families (`<family>:...`) a not-ready intent is named by. */
const INTENT_FAMILIES = [
  "impl",
  "push",
  "pull_request",
  "review",
  "merge",
  "base_refresh",
  "issue_closure",
  "satisfied",
  "base-review",
];

/**
 * `explainMatrixNotReady` reasons with every variable part closed: an intent
 * is named by its key family only (never its reservation id, head or PR).
 */
export const MATRIX_PLAN_NOT_READY_REASONS: readonly string[] = [
  "source.kind=incident",
  "source.kind=review_backlog",
  "nextStep=review",
  "nextStep=delivery",
  "nextStep=blocked",
  "nextStep=done",
  "review_rounds_spent",
  ...INTENT_FAMILIES.map((family) => `intent=${family}`),
  "intent=other",
  "candidateState.preserved=null",
  "target.branch=null",
  "config.sessionBound=null",
  "no_ci_and_no_local_verify",
  "target.head-not-null",
  "existing_head_continuation_live",
  "config=null",
  "conflictResolutionCap",
  "other",
];

/** Closed reason vocabulary for a considered record's preparation outcome. */
export const MATRIX_PLAN_DEFERRED_REASONS: readonly string[] = [
  "progress",
  "memory_refused",
  "blocked",
  "state_error",
  "bounds",
  "artifact",
  "cooldown",
  "admission_capacity",
  "admission",
  "deferred",
  "other",
];

const SKIP = new Set(MATRIX_PLAN_SKIP_REASONS);
const NOT_READY = new Set(MATRIX_PLAN_NOT_READY_REASONS);
const DEFERRED = new Set(MATRIX_PLAN_DEFERRED_REASONS);

/** The closed key of one preparation outcome (never its raw detail). */
export function planDeferredKey(
  outcome: { kind: string; detail?: string },
  waitReason?: string | null,
): string {
  if (outcome.kind === "progress") {
    // A capacity refusal writes a bounded wait and reports `progress`. A stale
    // wait must not override the reason of a current deferral or failure.
    return waitReason === "ledger_capacity" ? "admission_capacity" : "progress";
  }
  if (outcome.kind === "blocked") return "blocked";
  if (outcome.kind === "state_error") return "state_error";
  if (outcome.kind !== "deferred") return "other";
  const detail = (outcome.detail ?? "").toLowerCase();
  if (detail.includes("artifact")) return "artifact";
  if (
    detail.includes("cutoff") || detail.includes("run bounds") ||
    detail.includes("deadline")
  ) return "bounds";
  if (detail.includes("cooldown") || detail.includes("github")) {
    return "cooldown";
  }
  if (
    detail.includes("capacity") || detail.includes("ledger") ||
    detail.includes("invalid")
  ) return "admission_capacity";
  if (detail.includes("admission") || detail.includes("unavailable")) {
    return "admission";
  }
  return "deferred";
}

/** The closed key of one planner skip reason. */
export function planSkipKey(raw: string): string {
  return SKIP.has(raw) ? raw : "other";
}

/** The closed key of one planner not-ready reason. */
export function planNotReadyKey(raw: string): string {
  if (raw.startsWith("intent=")) {
    const family = raw.slice("intent=".length).split(":", 1)[0];
    return INTENT_FAMILIES.includes(family)
      ? `intent=${family}`
      : "intent=other";
  }
  return NOT_READY.has(raw) ? raw : "other";
}

/** Why the line was printed: a planner run, or the queue-custody empty plan. */
export type MatrixPlanDiagnosticCauseV1 = "planner" | "queue_custody_idle";

export interface MatrixPlanRepositoryLineV1 {
  repository: string;
  skippedByReason: Record<string, number>;
  notReadyByReason: Record<string, number>;
}

/**
 * One deferred record of a planner pass (#335): the exact record the pass
 * left unplanned and its closed deferral key, so every unplanned ready record
 * is named, not only counted. No detail text, head or reservation is carried.
 */
export interface MatrixPlanDeferredRecordV1 {
  taskId: string;
  repository: string;
  reason: string;
}

/** At most this many deferred records ride one line (the rest are counted). */
export const MAX_PLAN_DEFERRED_RECORDS = 48;

/** The child's line (exact keys; `scanPlanDiagnostic` re-parses it). */
export interface MatrixPlanDiagnosticLineV1 {
  kind: typeof MATRIX_PLAN_DIAGNOSTIC_KIND;
  waveId: string;
  cause: MatrixPlanDiagnosticCauseV1;
  prepared: number;
  attempted: number;
  deferred: number;
  deferredByReason: Record<string, number>;
  totalRecords: number | null;
  repositories: MatrixPlanRepositoryLineV1[];
  /** #335 (optional: an older child omits both). */
  plannerRefusal?: MatrixPlanRefusalV1["reason"];
  readyUnplanned?: number | null;
  /** #335 per-record deferrals (optional: an older child omits it). */
  deferredRecords?: MatrixPlanDeferredRecordV1[];
}

/** The launcher's re-emitted advisory: only re-parsed, closed content. */
export interface HostedMatrixPlanDiagnosticV1 {
  version: "v1";
  kind: typeof MATRIX_PLAN_DIAGNOSTIC_KIND;
  advisory: true;
  waveId: string;
  cause: MatrixPlanDiagnosticCauseV1;
  prepared: number;
  attempted: number;
  deferred: number;
  deferredByReason: Record<string, number>;
  totalRecords: number | null;
  repositories: MatrixPlanRepositoryLineV1[];
  /** #335: present only when the child line carried a valid refusal. */
  plannerRefusal?: MatrixPlanRefusalV1["reason"];
  readyUnplanned?: number | null;
  /** #335: present only when the child line carried valid deferred records. */
  deferredRecords?: MatrixPlanDeferredRecordV1[];
}

const LINE_KEYS = [
  "attempted",
  "cause",
  "deferred",
  "deferredByReason",
  "kind",
  "prepared",
  "repositories",
  "totalRecords",
  "waveId",
];
/** Optional #335 keys; a line carries both or neither. */
const REFUSAL_KEYS = ["plannerRefusal", "readyUnplanned"];
/** Optional #335 per-record key. */
const DEFERRED_RECORDS_KEY = "deferredRecords";
const DEFERRED_RECORD_KEYS = ["reason", "repository", "taskId"];
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const REPOSITORY_KEYS = ["notReadyByReason", "repository", "skippedByReason"];
const MAX_LINE_CHARS = 16_384;
const MAX_REPOSITORIES = 32;
const MAX_COUNT = 1_000_000;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;

function planDeferredKeyOf(reason: string): string {
  return DEFERRED.has(reason) ? reason : "other";
}

function closedCounts(
  raw: Record<string, number>,
  key: (reason: string) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [reason, count] of Object.entries(raw)) {
    const closed = key(reason);
    counts[closed] = (counts[closed] ?? 0) + count;
  }
  return counts;
}

/** The child line for one planner report (repositories sorted by slug). */
export function matrixPlanDiagnosticLineOf(input: {
  waveId: string;
  prepared: number;
  attempted?: number;
  deferred?: number;
  deferredByReason?: Record<string, number>;
  deferredRecords?: readonly MatrixPlanDeferredRecordV1[];
  cause: MatrixPlanDiagnosticCauseV1;
  diagnostic?: MatrixPlanDiagnosticV1;
  refusal?: MatrixPlanRefusalV1;
}): MatrixPlanDiagnosticLineV1 {
  const byRepository = input.diagnostic?.byRepository ?? {};
  return {
    kind: MATRIX_PLAN_DIAGNOSTIC_KIND,
    waveId: input.waveId,
    cause: input.cause,
    prepared: input.prepared,
    attempted: input.attempted ?? input.diagnostic?.attempted ?? 0,
    deferred: input.deferred ?? input.diagnostic?.deferred ?? 0,
    deferredByReason: closedCounts(
      input.deferredByReason ?? input.diagnostic?.deferredByReason ?? {},
      planDeferredKeyOf,
    ),
    totalRecords: input.diagnostic?.totalRecords ?? null,
    repositories: Object.keys(byRepository).sort().map((repository) => ({
      repository,
      skippedByReason: closedCounts(
        byRepository[repository].skippedByReason,
        planSkipKey,
      ),
      notReadyByReason: closedCounts(
        byRepository[repository].notReadyByReason,
        planNotReadyKey,
      ),
    })),
    ...(input.refusal === undefined ? {} : {
      plannerRefusal: input.refusal.reason,
      readyUnplanned: input.refusal.readyUnplanned,
    }),
    ...(input.deferredRecords === undefined ? {} : {
      deferredRecords: input.deferredRecords
        .slice(0, MAX_PLAN_DEFERRED_RECORDS)
        .map((row) => ({
          taskId: row.taskId,
          repository: row.repository,
          reason: planDeferredKeyOf(row.reason),
        })),
    }),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isCount = (value: unknown, max = MAX_COUNT): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 &&
  value <= max;

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).sort().join() === keys.join();
}

/** Known keys with integer counts only; an unknown key or count is dropped. */
function keptCounts(
  value: unknown,
  vocabulary: ReadonlySet<string>,
): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const counts: Record<string, number> = {};
  for (const key of Object.keys(value).sort()) {
    const count = value[key];
    if (vocabulary.has(key) && isCount(count)) counts[key] = count;
  }
  return counts;
}

function parseLine(
  value: Record<string, unknown>,
  waveId: string,
): HostedMatrixPlanDiagnosticV1 | null {
  const refusal = Object.hasOwn(value, "plannerRefusal")
    ? parseMatrixPlanRefusalV1(value.plannerRefusal, value.readyUnplanned)
    : undefined;
  const deferredRecords = Object.hasOwn(value, DEFERRED_RECORDS_KEY)
    ? parseDeferredRecords(value[DEFERRED_RECORDS_KEY])
    : undefined;
  if (
    !exactKeys(
      value,
      [
        ...LINE_KEYS,
        ...(refusal === undefined ? [] : REFUSAL_KEYS),
        ...(deferredRecords === undefined ? [] : [DEFERRED_RECORDS_KEY]),
      ].sort(),
    ) || refusal === null || deferredRecords === null ||
    value.waveId !== waveId ||
    (value.cause !== "planner" && value.cause !== "queue_custody_idle") ||
    !isCount(value.prepared, MaxItems.snapshotRecords) ||
    !isCount(value.attempted, MaxItems.snapshotRecords) ||
    !isCount(value.deferred, MaxItems.snapshotRecords) ||
    (value.totalRecords !== null && !isCount(value.totalRecords)) ||
    !Array.isArray(value.repositories) ||
    value.repositories.length > MAX_REPOSITORIES
  ) return null;
  const repositories: MatrixPlanRepositoryLineV1[] = [];
  const seen = new Set<string>();
  for (const row of value.repositories) {
    if (!isRecord(row) || !exactKeys(row, REPOSITORY_KEYS)) return null;
    const repository = row.repository;
    if (
      typeof repository !== "string" || !SLUG.test(repository) ||
      seen.has(repository)
    ) return null;
    seen.add(repository);
    const skippedByReason = keptCounts(row.skippedByReason, SKIP);
    const notReadyByReason = keptCounts(row.notReadyByReason, NOT_READY);
    if (skippedByReason === null || notReadyByReason === null) return null;
    repositories.push({ repository, skippedByReason, notReadyByReason });
  }
  const deferredByReason = keptCounts(value.deferredByReason, DEFERRED);
  if (deferredByReason === null) return null;
  return {
    version: "v1",
    kind: MATRIX_PLAN_DIAGNOSTIC_KIND,
    advisory: true,
    waveId,
    cause: value.cause,
    prepared: value.prepared,
    attempted: value.attempted,
    deferred: value.deferred,
    deferredByReason,
    totalRecords: value.totalRecords as number | null,
    repositories,
    ...(refusal === undefined ? {} : {
      plannerRefusal: refusal.reason,
      readyUnplanned: refusal.readyUnplanned,
    }),
    ...(deferredRecords === undefined ? {} : { deferredRecords }),
  };
}

/** Bounded per-record deferrals with closed reasons, or null when malformed. */
function parseDeferredRecords(
  value: unknown,
): MatrixPlanDeferredRecordV1[] | null {
  if (!Array.isArray(value) || value.length > MAX_PLAN_DEFERRED_RECORDS) {
    return null;
  }
  const rows: MatrixPlanDeferredRecordV1[] = [];
  for (const row of value) {
    if (
      !isRecord(row) || !exactKeys(row, DEFERRED_RECORD_KEYS) ||
      typeof row.taskId !== "string" || !TASK_ID.test(row.taskId) ||
      typeof row.repository !== "string" || !SLUG.test(row.repository) ||
      typeof row.reason !== "string" || !DEFERRED.has(row.reason)
    ) return null;
    rows.push({
      taskId: row.taskId,
      repository: row.repository,
      reason: row.reason,
    });
  }
  return rows;
}

/**
 * The planner refusal of one job log's launcher-re-emitted plan diagnostic
 * (#335), or null when the log carries none, several or a malformed one.
 * Actions prefixes each line with a timestamp; only the JSON object is read.
 */
export function scanPlanRefusalFromLog(
  log: string,
): MatrixPlanRefusalV1 | null {
  let found: MatrixPlanRefusalV1 | null = null;
  let count = 0;
  for (const line of log.split("\n")) {
    if (
      line.length > MAX_LINE_CHARS + 64 ||
      !line.includes(MATRIX_PLAN_DIAGNOSTIC_KIND)
    ) continue;
    const start = line.indexOf("{");
    if (start < 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    // Only the launcher's re-parsed advisory, never the raw child line.
    if (
      !isRecord(value) || value.kind !== MATRIX_PLAN_DIAGNOSTIC_KIND ||
      value.advisory !== true
    ) continue;
    count += 1;
    found = Object.hasOwn(value, "plannerRefusal")
      ? parseMatrixPlanRefusalV1(value.plannerRefusal, value.readyUnplanned)
      : null;
  }
  return count === 1 ? found : null;
}

/**
 * The one plan diagnostic line of a planner child's stdout, re-parsed and
 * bound to the verified execution's wave, or null: absent, malformed,
 * oversized, foreign to this wave, or ambiguous (more than one line).
 */
export function scanPlanDiagnostic(
  stdout: string,
  execution: { id: string },
): HostedMatrixPlanDiagnosticV1 | null {
  let found: HostedMatrixPlanDiagnosticV1 | null = null;
  let count = 0;
  for (const line of stdout.split("\n")) {
    if (
      line.length > MAX_LINE_CHARS ||
      !line.includes(MATRIX_PLAN_DIAGNOSTIC_KIND)
    ) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(value) || value.kind !== MATRIX_PLAN_DIAGNOSTIC_KIND) {
      continue;
    }
    count += 1;
    found = parseLine(value, execution.id);
  }
  return count === 1 ? found : null;
}
