/**
 * The throughput watchdog's small durable memory (`throughput/watchdog.json`
 * on the metrics sidecar ref): per threshold, the issue last filed or adopted
 * for it, the measured value that issue's text carries, how many cycles ran
 * since that text was written, and, once the issue was observed closed, the
 * outcome check (measurement and runtime installed at close, cycles since on
 * a newer runtime); plus the per-UTC-day filing count. Written only by the
 * trusted finalize stage through the metrics port's expected-head write,
 * never by a model worker; it grants no admission, accounting or merge
 * authority.
 *
 * Version 2. The reader still accepts the historical version 1 file
 * (closed-at instants for the retired 7-day cooldown) and lifts it to
 * version 2 with an unknown runtime at close, so the next cycle that knows
 * its runtime becomes the baseline; the writer only writes version 2.
 */

/** A threshold id: closed lowercase identifier (also the issue marker key). */
export const THROUGHPUT_WATCHDOG_ID = /^[a-z][a-z0-9_]{0,39}$/;
/** Bound on stored thresholds; ids outside the threshold table are dropped. */
export const THROUGHPUT_WATCHDOG_MAX_ENTRIES = 16;
/** Bound on any stored cycle counter (they saturate here). */
export const THROUGHPUT_WATCHDOG_COUNTER_CAP = 1_000_000;

const SHA = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The runtime a cycle ran on (launcher-installed generation and SHA). */
export interface ThroughputWatchdogRuntimeV2 {
  generation: number;
  sha: string;
}

export interface ThroughputWatchdogClosedV2 {
  /** When the issue was first observed no longer open. */
  atMs: number;
  /** Measured value (x1000) at that observation; null when insufficient. */
  measuredMilli: number | null;
  /** Runtime installed at close; null until a cycle knows its runtime. */
  runtime: ThroughputWatchdogRuntimeV2 | null;
  /** Cycles evaluated since on a runtime newer than `runtime` (saturating). */
  newerCycles: number;
}

export interface ThroughputWatchdogEntryV2 {
  /** The issue filed or adopted for this threshold. */
  issue: number;
  /** Measured value (x1000, rounded) the issue text carries; null unknown. */
  measuredMilli: number | null;
  /** When this finalize filed or adopted the issue. */
  filedAtMs: number;
  /** Cycles evaluated since the issue text was written (saturating). */
  cyclesSinceText: number;
  /** Null while the issue is open. */
  closed: ThroughputWatchdogClosedV2 | null;
}

export interface ThroughputWatchdogStateV2 {
  version: 2;
  /** The last cycle evaluated, so a repeated finalize acts once. */
  lastCycle: { runId: number; attempt: number } | null;
  /** Watchdog issues created (attempted) on one UTC day. */
  daily: { date: string; filed: number } | null;
  thresholds: Record<string, ThroughputWatchdogEntryV2>;
}

export const EMPTY_THROUGHPUT_WATCHDOG_STATE: ThroughputWatchdogStateV2 = {
  version: 2,
  lastCycle: null,
  daily: null,
  thresholds: {},
};

function plain(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function keysAre(row: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(row).sort().join(",") === [...keys].sort().join(",");
}

const count = (value: unknown, positive = false): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) &&
  (positive ? value > 0 : value >= 0);

const counter = (value: unknown): value is number =>
  count(value) && value <= THROUGHPUT_WATCHDOG_COUNTER_CAP;

const milli = (value: unknown): value is number | null =>
  value === null || count(value);

/** A cycle's runtime identity, or null unless exact. */
export function parseThroughputWatchdogRuntimeV2(
  value: unknown,
): ThroughputWatchdogRuntimeV2 | null {
  const row = plain(value);
  if (
    row === null || !keysAre(row, ["generation", "sha"]) ||
    !count(row.generation, true) || typeof row.sha !== "string" ||
    !SHA.test(row.sha)
  ) return null;
  return { generation: row.generation, sha: row.sha };
}

function parseClosed(value: unknown): ThroughputWatchdogClosedV2 | null {
  const row = plain(value);
  if (
    row === null ||
    !keysAre(row, ["atMs", "measuredMilli", "runtime", "newerCycles"]) ||
    !count(row.atMs) || !milli(row.measuredMilli) || !counter(row.newerCycles)
  ) return null;
  const runtime = row.runtime === null
    ? null
    : parseThroughputWatchdogRuntimeV2(row.runtime);
  if (row.runtime !== null && runtime === null) return null;
  return {
    atMs: row.atMs,
    measuredMilli: row.measuredMilli,
    runtime,
    newerCycles: row.newerCycles,
  };
}

function parseEntryV2(value: unknown): ThroughputWatchdogEntryV2 | null {
  const row = plain(value);
  if (
    row === null ||
    !keysAre(row, [
      "issue",
      "measuredMilli",
      "filedAtMs",
      "cyclesSinceText",
      "closed",
    ])
  ) return null;
  if (!count(row.issue, true) || !count(row.filedAtMs)) return null;
  if (!milli(row.measuredMilli) || !counter(row.cyclesSinceText)) return null;
  const closed = row.closed === null ? null : parseClosed(row.closed);
  if (row.closed !== null && closed === null) return null;
  return {
    issue: row.issue,
    measuredMilli: row.measuredMilli,
    filedAtMs: row.filedAtMs,
    cyclesSinceText: row.cyclesSinceText,
    closed,
  };
}

/** Historical version 1 entry, lifted to version 2. */
function parseEntryV1(value: unknown): ThroughputWatchdogEntryV2 | null {
  const row = plain(value);
  if (
    row === null ||
    !keysAre(row, ["issue", "measuredMilli", "filedAtMs", "closedAtMs"])
  ) return null;
  if (!count(row.issue, true) || !count(row.filedAtMs)) return null;
  if (!milli(row.measuredMilli)) return null;
  if (row.closedAtMs !== null && !count(row.closedAtMs)) return null;
  return {
    issue: row.issue,
    measuredMilli: row.measuredMilli,
    filedAtMs: row.filedAtMs,
    cyclesSinceText: 0,
    closed: row.closedAtMs === null ? null : {
      atMs: row.closedAtMs,
      measuredMilli: row.measuredMilli,
      runtime: null,
      newerCycles: 0,
    },
  };
}

/**
 * Strict reader: anything but an exact bounded version 2 state, or an exact
 * historical version 1 state (lifted), reads as null.
 */
export function parseThroughputWatchdogState(
  value: unknown,
): ThroughputWatchdogStateV2 | null {
  const row = plain(value);
  if (row === null) return null;
  const v1 = row.version === 1;
  if (!v1 && row.version !== 2) return null;
  const keys = v1
    ? ["version", "lastCycle", "thresholds"]
    : ["version", "lastCycle", "daily", "thresholds"];
  if (!keysAre(row, keys)) return null;
  let lastCycle: ThroughputWatchdogStateV2["lastCycle"] = null;
  if (row.lastCycle !== null) {
    const cycle = plain(row.lastCycle);
    if (
      cycle === null || !keysAre(cycle, ["runId", "attempt"]) ||
      !count(cycle.runId, true) || !count(cycle.attempt, true)
    ) return null;
    lastCycle = { runId: cycle.runId, attempt: cycle.attempt };
  }
  let daily: ThroughputWatchdogStateV2["daily"] = null;
  if (!v1 && row.daily !== null) {
    const day = plain(row.daily);
    if (
      day === null || !keysAre(day, ["date", "filed"]) ||
      typeof day.date !== "string" || !DATE.test(day.date) ||
      !counter(day.filed)
    ) return null;
    daily = { date: day.date, filed: day.filed };
  }
  const table = plain(row.thresholds);
  if (table === null) return null;
  const ids = Object.keys(table).sort();
  if (ids.length > THROUGHPUT_WATCHDOG_MAX_ENTRIES) return null;
  const thresholds: Record<string, ThroughputWatchdogEntryV2> = {};
  for (const id of ids) {
    if (!THROUGHPUT_WATCHDOG_ID.test(id)) return null;
    const entry = v1 ? parseEntryV1(table[id]) : parseEntryV2(table[id]);
    if (entry === null) return null;
    thresholds[id] = entry;
  }
  return { version: 2, lastCycle, daily, thresholds };
}
