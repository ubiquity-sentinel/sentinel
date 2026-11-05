/**
 * The throughput watchdog's small durable memory (`throughput/watchdog.json`
 * on the metrics sidecar ref): per threshold, the issue last filed or adopted
 * for it, the measured value that issue's text carries, and when the issue
 * was observed closed (the re-file cooldown). Written only by the trusted
 * finalize stage through the metrics port's expected-head write, never by a
 * model worker; it grants no admission, accounting or merge authority.
 */

/** A threshold id: closed lowercase identifier (also the issue marker key). */
export const THROUGHPUT_WATCHDOG_ID = /^[a-z][a-z0-9_]{0,39}$/;
/** Bound on stored thresholds; ids outside the threshold table are dropped. */
export const THROUGHPUT_WATCHDOG_MAX_ENTRIES = 16;

export interface ThroughputWatchdogEntryV1 {
  /** The issue filed or adopted for this threshold. */
  issue: number;
  /** Measured value (x1000, rounded) the issue text carries; null unknown. */
  measuredMilli: number | null;
  /** When this finalize filed or adopted the issue. */
  filedAtMs: number;
  /** When the issue was first observed no longer open; null while open. */
  closedAtMs: number | null;
}

export interface ThroughputWatchdogStateV1 {
  version: 1;
  /** The last cycle evaluated, so a repeated finalize acts once. */
  lastCycle: { runId: number; attempt: number } | null;
  thresholds: Record<string, ThroughputWatchdogEntryV1>;
}

export const EMPTY_THROUGHPUT_WATCHDOG_STATE: ThroughputWatchdogStateV1 = {
  version: 1,
  lastCycle: null,
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

function parseEntry(value: unknown): ThroughputWatchdogEntryV1 | null {
  const row = plain(value);
  if (
    row === null ||
    !keysAre(row, ["issue", "measuredMilli", "filedAtMs", "closedAtMs"])
  ) return null;
  if (!count(row.issue, true) || !count(row.filedAtMs)) return null;
  if (row.measuredMilli !== null && !count(row.measuredMilli)) return null;
  if (row.closedAtMs !== null && !count(row.closedAtMs)) return null;
  return {
    issue: row.issue,
    measuredMilli: row.measuredMilli as number | null,
    filedAtMs: row.filedAtMs,
    closedAtMs: row.closedAtMs as number | null,
  };
}

/** Strict reader: anything but an exact bounded state reads as null. */
export function parseThroughputWatchdogStateV1(
  value: unknown,
): ThroughputWatchdogStateV1 | null {
  const row = plain(value);
  if (row === null || !keysAre(row, ["version", "lastCycle", "thresholds"])) {
    return null;
  }
  if (row.version !== 1) return null;
  let lastCycle: ThroughputWatchdogStateV1["lastCycle"] = null;
  if (row.lastCycle !== null) {
    const cycle = plain(row.lastCycle);
    if (
      cycle === null || !keysAre(cycle, ["runId", "attempt"]) ||
      !count(cycle.runId, true) || !count(cycle.attempt, true)
    ) return null;
    lastCycle = { runId: cycle.runId, attempt: cycle.attempt };
  }
  const table = plain(row.thresholds);
  if (table === null) return null;
  const ids = Object.keys(table).sort();
  if (ids.length > THROUGHPUT_WATCHDOG_MAX_ENTRIES) return null;
  const thresholds: Record<string, ThroughputWatchdogEntryV1> = {};
  for (const id of ids) {
    if (!THROUGHPUT_WATCHDOG_ID.test(id)) return null;
    const entry = parseEntry(table[id]);
    if (entry === null) return null;
    thresholds[id] = entry;
  }
  return { version: 1, lastCycle, thresholds };
}
