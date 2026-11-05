/**
 * ThroughputMetricsRecordV1: one bounded, advisory throughput record per
 * hosted supervisor cycle (#338).
 *
 * The trusted finalize writer appends exactly one record per run attempt to
 * the separate metrics sidecar ref (`src/state/throughput-metrics-store.ts`).
 * No step loop, planner or maintenance walk reads it, and it grants no
 * health, admission, accounting or merge authority.
 *
 * A field the writer did not observe is `null`, never an invented zero.
 * Every value is a closed enum or a nonnegative integer: no credentials,
 * URLs, bodies or raw diagnostics. The parser enforces that structurally and
 * additionally pre-scans the raw input so a URL-bearing or long string is
 * refused wherever it appears, including under an unknown key.
 */

import { canonicalStringify } from "./canonical.ts";
import {
  expectCount,
  expectEnum,
  expectExactKeys,
  expectExactKeysWithOptional,
  expectNullable,
  expectPattern,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
} from "./validation.ts";

/** Phases whose wall time a cycle record carries (integer milliseconds). */
export const THROUGHPUT_PHASES_V1 = [
  "maintenance",
  "prepare",
  "matrixPlan",
  "matrixCellTotal",
  "repair",
  "finalize",
  "bootstrap",
] as const;
export type ThroughputPhaseV1 = typeof THROUGHPUT_PHASES_V1[number];

/** Nullable per-cycle counters (each `null` until a phase observes it). */
export const THROUGHPUT_COUNTERS_V1 = [
  "recordsRead",
  "recordsStepped",
  "recordsSkipped",
  "cellsPlanned",
  "readyRecordsNotPlanned",
  "modelStarts",
  "reviewsRequested",
  "refreshCommits",
  "targetCiRunsTriggered",
  "trainsBuilt",
  "mergesCompleted",
  "ownerNoticesSent",
  "releaseRequestsMovedToCold",
] as const;
export type ThroughputCounterV1 = typeof THROUGHPUT_COUNTERS_V1[number];

/**
 * Closed planner refusal reasons (#335 fills them; `null` until then and
 * whenever the planner did not refuse).
 */
export const PLANNER_REFUSAL_REASONS_V1 = [
  "deadline_margin",
  "no_ready_records",
  "reservation_denied",
  "provider_unavailable",
  "target_unavailable",
] as const;
export type PlannerRefusalReasonV1 = typeof PLANNER_REFUSAL_REASONS_V1[number];

/**
 * Wait-cause histogram (#335): records waiting in `backoff`/`unavailable` at
 * the cycle's end, keyed `port:status:code` (the record's `wait.cause`) or
 * `legacy:none:<reason>` for a wait written without one. At most
 * `THROUGHPUT_WAIT_CAUSE_KEYS` keys; the rest fold into `other:none:other`.
 */
export type ThroughputWaitCausesV1 = Record<string, number>;
export const THROUGHPUT_WAIT_CAUSE_KEYS = 6;
export const THROUGHPUT_WAIT_CAUSE_OTHER = "other:none:other";
const WAIT_CAUSE_KEY = /^[a-z]{1,7}:[a-z0-9]{1,7}:[a-z0-9_]{1,16}$/;
export function isThroughputWaitCauseKeyV1(key: string): boolean {
  return WAIT_CAUSE_KEY.test(key);
}

/** Add `n` under `key`, keeping one slot for the fold key (mutates). */
export function addWaitCauseCountV1(
  causes: ThroughputWaitCausesV1,
  key: string,
  n: number,
): void {
  if (n === 0) return;
  const named =
    Object.keys(causes).filter((existing) =>
      existing !== THROUGHPUT_WAIT_CAUSE_OTHER
    ).length;
  const slot = Object.hasOwn(causes, key) ||
      key === THROUGHPUT_WAIT_CAUSE_OTHER ||
      named < THROUGHPUT_WAIT_CAUSE_KEYS - 1
    ? key
    : THROUGHPUT_WAIT_CAUSE_OTHER;
  const total = (causes[slot] ?? 0) + n;
  if (!Number.isSafeInteger(total)) throw new Error("wait cause overflow");
  causes[slot] = total;
}

export interface ThroughputCycleIdV1 {
  runId: number;
  attempt: number;
}

export interface ThroughputMetricsRecordV1 {
  version: "v1";
  kind: "throughput_metrics";
  cycle: ThroughputCycleIdV1;
  startedAtMs: number;
  finishedAtMs: number;
  phaseMs: Record<ThroughputPhaseV1, number | null>;
  counts: Record<ThroughputCounterV1, number | null>;
  plannerRefusal: PlannerRefusalReasonV1 | null;
  /**
   * Additive (#335): absent on records written before it existed; `null`
   * when finalize did not observe the repair state.
   */
  waitCauses?: ThroughputWaitCausesV1 | null;
}

/** Byte bound of one canonical record line (without its newline). */
export const THROUGHPUT_METRICS_RECORD_MAX_BYTES = 1024;
/** Largest string the raw pre-scan admits anywhere in a metrics input. */
export const THROUGHPUT_METRICS_MAX_STRING = 32;

const RECORD_KEYS = [
  "version",
  "kind",
  "cycle",
  "startedAtMs",
  "finishedAtMs",
  "phaseMs",
  "counts",
  "plannerRefusal",
] as const;
const RECORD_OPTIONAL_KEYS = ["waitCauses"] as const;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|^www\.|[a-z0-9-]+\.[a-z]{2,}\//i;

/**
 * Refuse any string that is long or URL-shaped, anywhere in the input
 * (unknown keys included), and any key that is. Depth-bounded.
 */
export function scanThroughputMetricsStringsV1(
  input: unknown,
  path = "$",
  depth = 0,
): void {
  if (depth > 4) fail(path, "bound_exceeded", "metrics input is too deep");
  const check = (value: string, at: string) => {
    if (value.length > THROUGHPUT_METRICS_MAX_STRING) {
      fail(at, "bound_exceeded", "metrics string exceeds its bound");
    }
    if (URL_LIKE.test(value)) {
      fail(at, "invalid_value", "metrics string looks like a URL");
    }
  };
  if (typeof input === "string") return check(input, path);
  if (Array.isArray(input)) {
    if (input.length > 64) fail(path, "bound_exceeded", "array too long");
    input.forEach((item, index) =>
      scanThroughputMetricsStringsV1(item, `${path}[${index}]`, depth + 1)
    );
    return;
  }
  if (input !== null && typeof input === "object") {
    const keys = Object.keys(input);
    if (keys.length > 64) fail(path, "bound_exceeded", "too many keys");
    for (const key of keys) {
      check(key, `${path}.<key>`);
      scanThroughputMetricsStringsV1(
        (input as Record<string, unknown>)[key],
        `${path}.${key}`,
        depth + 1,
      );
    }
  }
}

function parseNullableCounts<K extends string>(
  input: unknown,
  keys: readonly K[],
  path: string,
): Record<K, number | null> {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, keys, path);
  const out = {} as Record<K, number | null>;
  for (const key of keys) {
    out[key] = expectNullable(obj[key], `${path}.${key}`, expectCount);
  }
  return out;
}

/** A bounded `port:status:code` histogram with positive counts. */
export function parseThroughputWaitCausesV1(
  input: unknown,
  path: string,
): ThroughputWaitCausesV1 {
  const obj = expectRecord(input, path);
  const keys = Object.keys(obj);
  if (keys.length > THROUGHPUT_WAIT_CAUSE_KEYS) {
    fail(path, "bound_exceeded", "too many wait cause keys");
  }
  const out: ThroughputWaitCausesV1 = {};
  for (const key of keys.sort()) {
    if (!WAIT_CAUSE_KEY.test(key)) {
      fail(`${path}.<key>`, "invalid_pattern", "invalid wait cause key");
    }
    out[key] = expectPositiveInt(obj[key], `${path}.${key}`);
  }
  return out;
}

/** Strict parser: exact keys at every level, closed enums, bounded size. */
export function parseThroughputMetricsRecordV1(
  input: unknown,
): ThroughputMetricsRecordV1 {
  scanThroughputMetricsStringsV1(input);
  const obj = expectRecord(input, "$");
  expectExactKeysWithOptional(obj, RECORD_KEYS, RECORD_OPTIONAL_KEYS, "$");
  expectVersion(obj.version, "$.version");
  if (obj.kind !== "throughput_metrics") {
    fail("$.kind", "invalid_enum", 'expected kind "throughput_metrics"');
  }
  const cycleObj = expectRecord(obj.cycle, "$.cycle");
  expectExactKeys(cycleObj, ["runId", "attempt"], "$.cycle");
  const cycle = {
    runId: expectPositiveInt(cycleObj.runId, "$.cycle.runId"),
    attempt: expectPositiveInt(cycleObj.attempt, "$.cycle.attempt"),
  };
  const startedAtMs = expectTimestamp(obj.startedAtMs, "$.startedAtMs");
  const finishedAtMs = expectTimestamp(obj.finishedAtMs, "$.finishedAtMs");
  if (finishedAtMs < startedAtMs) {
    fail("$.finishedAtMs", "invalid_value", "finishedAtMs precedes start");
  }
  const record: ThroughputMetricsRecordV1 = {
    version: "v1",
    kind: "throughput_metrics",
    cycle,
    startedAtMs,
    finishedAtMs,
    phaseMs: parseNullableCounts(
      obj.phaseMs,
      THROUGHPUT_PHASES_V1,
      "$.phaseMs",
    ),
    counts: parseNullableCounts(
      obj.counts,
      THROUGHPUT_COUNTERS_V1,
      "$.counts",
    ),
    plannerRefusal: expectNullable(
      obj.plannerRefusal,
      "$.plannerRefusal",
      (value, path) => expectEnum(value, PLANNER_REFUSAL_REASONS_V1, path),
    ),
    // Absent stays absent so an older line re-serializes byte for byte.
    ...(obj.waitCauses === undefined ? {} : {
      waitCauses: expectNullable(
        obj.waitCauses,
        "$.waitCauses",
        parseThroughputWaitCausesV1,
      ),
    }),
  };
  if (
    utf8Length(canonicalStringify(record)) >
      THROUGHPUT_METRICS_RECORD_MAX_BYTES
  ) {
    fail("$", "bound_exceeded", "metrics record exceeds its byte bound");
  }
  return record;
}

/** Parse one stored line; the byte bound is checked before JSON parsing. */
export function parseThroughputMetricsLineV1(
  line: string,
): ThroughputMetricsRecordV1 {
  if (utf8Length(line) > THROUGHPUT_METRICS_RECORD_MAX_BYTES) {
    fail("$", "bound_exceeded", "metrics line exceeds its byte bound");
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    fail("$", "wrong_type", "metrics line is not JSON");
  }
  const record = parseThroughputMetricsRecordV1(value);
  if (canonicalStringify(record) !== line) {
    fail("$", "invalid_value", "metrics line is not canonical JSON");
  }
  return record;
}

// ---------------------------------------------------------------------------
// Daily rollup (cold tier of the same surface).
// ---------------------------------------------------------------------------

/** Sum of the known values of one field and how many records knew it. */
export interface ThroughputSumV1 {
  sum: number;
  known: number;
}

export interface ThroughputDailySummaryV1 {
  version: "v1";
  kind: "throughput_metrics_daily";
  /** UTC date of the folded records' `finishedAtMs`. */
  date: string;
  records: number;
  firstStartedAtMs: number;
  lastFinishedAtMs: number;
  phaseMs: Record<ThroughputPhaseV1, ThroughputSumV1>;
  counts: Record<ThroughputCounterV1, ThroughputSumV1>;
  plannerRefusals: Record<PlannerRefusalReasonV1, number>;
  /** Additive (#335): summed record histograms; absent until one had it. */
  waitCauses?: ThroughputWaitCausesV1;
}

export const THROUGHPUT_DAILY_SUMMARY_MAX_BYTES = 4096;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAILY_KEYS = [
  "version",
  "kind",
  "date",
  "records",
  "firstStartedAtMs",
  "lastFinishedAtMs",
  "phaseMs",
  "counts",
  "plannerRefusals",
] as const;

/** UTC calendar date (`YYYY-MM-DD`) of an epoch-millisecond instant. */
export function throughputDateV1(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

function parseSums<K extends string>(
  input: unknown,
  keys: readonly K[],
  records: number,
  path: string,
): Record<K, ThroughputSumV1> {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, keys, path);
  const out = {} as Record<K, ThroughputSumV1>;
  for (const key of keys) {
    const at = `${path}.${key}`;
    const row = expectRecord(obj[key], at);
    expectExactKeys(row, ["sum", "known"], at);
    const sum = expectCount(row.sum, `${at}.sum`);
    const known = expectCount(row.known, `${at}.known`);
    if (known > records || (known === 0 && sum !== 0)) {
      fail(at, "invalid_value", "sum is inconsistent with its records");
    }
    out[key] = { sum, known };
  }
  return out;
}

export function parseThroughputDailySummaryV1(
  input: unknown,
): ThroughputDailySummaryV1 {
  scanThroughputMetricsStringsV1(input);
  const obj = expectRecord(input, "$");
  expectExactKeysWithOptional(obj, DAILY_KEYS, RECORD_OPTIONAL_KEYS, "$");
  expectVersion(obj.version, "$.version");
  if (obj.kind !== "throughput_metrics_daily") {
    fail("$.kind", "invalid_enum", 'expected kind "throughput_metrics_daily"');
  }
  const date = expectPattern(
    obj.date,
    "$.date",
    DATE,
    "invalid_pattern",
    "expected a UTC YYYY-MM-DD date",
    10,
  );
  const records = expectPositiveInt(obj.records, "$.records");
  const firstStartedAtMs = expectTimestamp(
    obj.firstStartedAtMs,
    "$.firstStartedAtMs",
  );
  const lastFinishedAtMs = expectTimestamp(
    obj.lastFinishedAtMs,
    "$.lastFinishedAtMs",
  );
  if (lastFinishedAtMs < firstStartedAtMs) {
    fail("$.lastFinishedAtMs", "invalid_value", "window is inverted");
  }
  const refusalsObj = expectRecord(obj.plannerRefusals, "$.plannerRefusals");
  expectExactKeys(refusalsObj, PLANNER_REFUSAL_REASONS_V1, "$.plannerRefusals");
  const plannerRefusals = {} as Record<PlannerRefusalReasonV1, number>;
  for (const reason of PLANNER_REFUSAL_REASONS_V1) {
    plannerRefusals[reason] = expectCount(
      refusalsObj[reason],
      `$.plannerRefusals.${reason}`,
    );
  }
  const summary: ThroughputDailySummaryV1 = {
    version: "v1",
    kind: "throughput_metrics_daily",
    date,
    records,
    firstStartedAtMs,
    lastFinishedAtMs,
    phaseMs: parseSums(obj.phaseMs, THROUGHPUT_PHASES_V1, records, "$.phaseMs"),
    counts: parseSums(obj.counts, THROUGHPUT_COUNTERS_V1, records, "$.counts"),
    plannerRefusals,
    ...(obj.waitCauses === undefined ? {} : {
      waitCauses: parseThroughputWaitCausesV1(obj.waitCauses, "$.waitCauses"),
    }),
  };
  if (
    utf8Length(canonicalStringify(summary)) > THROUGHPUT_DAILY_SUMMARY_MAX_BYTES
  ) {
    fail("$", "bound_exceeded", "daily summary exceeds its byte bound");
  }
  return summary;
}

/** Fold one record into its day's summary (pure; creates it when absent). */
export function foldThroughputRecordV1(
  summary: ThroughputDailySummaryV1 | null,
  record: ThroughputMetricsRecordV1,
): ThroughputDailySummaryV1 {
  const date = throughputDateV1(record.finishedAtMs);
  if (summary !== null && summary.date !== date) {
    throw new Error("metrics record folds into a different day");
  }
  const sums = <K extends string>(
    keys: readonly K[],
    prior: Record<K, ThroughputSumV1> | undefined,
    values: Record<K, number | null>,
  ) => {
    const out = {} as Record<K, ThroughputSumV1>;
    for (const key of keys) {
      const base = prior?.[key] ?? { sum: 0, known: 0 };
      const value = values[key];
      out[key] = value === null ? { ...base } : {
        sum: base.sum + value,
        known: base.known + 1,
      };
    }
    return out;
  };
  const plannerRefusals = {} as Record<PlannerRefusalReasonV1, number>;
  for (const reason of PLANNER_REFUSAL_REASONS_V1) {
    plannerRefusals[reason] = (summary?.plannerRefusals[reason] ?? 0) +
      (record.plannerRefusal === reason ? 1 : 0);
  }
  let waitCauses = summary?.waitCauses;
  if (record.waitCauses !== undefined && record.waitCauses !== null) {
    waitCauses = { ...waitCauses };
    for (const [key, n] of Object.entries(record.waitCauses)) {
      addWaitCauseCountV1(waitCauses, key, n);
    }
  }
  return {
    version: "v1",
    kind: "throughput_metrics_daily",
    date,
    records: (summary?.records ?? 0) + 1,
    firstStartedAtMs: Math.min(
      summary?.firstStartedAtMs ?? record.startedAtMs,
      record.startedAtMs,
    ),
    lastFinishedAtMs: Math.max(
      summary?.lastFinishedAtMs ?? record.finishedAtMs,
      record.finishedAtMs,
    ),
    phaseMs: sums(THROUGHPUT_PHASES_V1, summary?.phaseMs, record.phaseMs),
    counts: sums(THROUGHPUT_COUNTERS_V1, summary?.counts, record.counts),
    plannerRefusals,
    ...(waitCauses === undefined ? {} : { waitCauses }),
  };
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}
