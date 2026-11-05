/**
 * Pure model of the throughput metrics surface (#338): a bounded hot tier of
 * per-cycle records grouped into one JSONL file per UTC day, and a cold tier
 * of deterministic daily rollups in one JSONL file. Only the trusted finalize
 * writer changes it, through `src/state/throughput-metrics-store.ts`.
 *
 * Retention: at most `THROUGHPUT_HOT_MAX_RECORDS` hot records. Appending past
 * the bound folds the oldest hot record into its day's rollup (so nothing is
 * counted twice and nothing silently vanishes from the totals), and at most
 * `THROUGHPUT_DAILY_MAX_SUMMARIES` rollups are retained (older ones remain
 * only in the ref's Git history). Advisory telemetry only: no accounting,
 * reservation or charge lives here.
 */

import { canonicalStringify } from "../contracts/canonical.ts";
import {
  foldThroughputRecordV1,
  parseThroughputDailySummaryV1,
  parseThroughputMetricsLineV1,
  parseThroughputMetricsRecordV1,
  type ThroughputDailySummaryV1,
  throughputDateV1,
  type ThroughputMetricsRecordV1,
} from "../contracts/throughput-metrics.ts";
import {
  parseUpkeepDeferralStreakV1,
  type UpkeepDeferralStreakV1,
} from "../contracts/upkeep-deferral-streak.ts";
import {
  parseThroughputWatchdogState,
  type ThroughputWatchdogStateV2,
} from "../contracts/throughput-watchdog-state.ts";

/** The metrics sidecar ref; no repair/release snapshot reader touches it. */
export const THROUGHPUT_METRICS_REF = "refs/heads/sentinel-state/metrics";
export const THROUGHPUT_HOT_MAX_RECORDS = 2000;
export const THROUGHPUT_DAILY_MAX_SUMMARIES = 400;
export const THROUGHPUT_DIR = "throughput";
export const THROUGHPUT_DAILY_PATH = `${THROUGHPUT_DIR}/daily.jsonl`;
/** Consecutive deferred upkeep passes (#327), one small canonical file. */
export const THROUGHPUT_UPKEEP_STREAK_PATH =
  `${THROUGHPUT_DIR}/upkeep-streak.json`;
/** The throughput watchdog's filings and outcome checks, one canonical file. */
export const THROUGHPUT_WATCHDOG_PATH = `${THROUGHPUT_DIR}/watchdog.json`;
const HOT_PATH = /^throughput\/(\d{4}-\d{2}-\d{2})\.jsonl$/;

export interface ThroughputMetricsLedgerV1 {
  /** Hot records ordered by (finishedAtMs, runId, attempt). */
  records: ThroughputMetricsRecordV1[];
  /** Daily rollups ordered by date, one per date. */
  daily: ThroughputDailySummaryV1[];
  /** Present once finalize recorded an upkeep deferral observation. */
  upkeepStreak?: UpkeepDeferralStreakV1;
  /** Present once the throughput watchdog recorded an evaluation. */
  watchdog?: ThroughputWatchdogStateV2;
}

export const EMPTY_THROUGHPUT_LEDGER: ThroughputMetricsLedgerV1 = {
  records: [],
  daily: [],
};

function order(a: ThroughputMetricsRecordV1, b: ThroughputMetricsRecordV1) {
  return a.finishedAtMs - b.finishedAtMs || a.cycle.runId - b.cycle.runId ||
    a.cycle.attempt - b.cycle.attempt;
}

const sameCycle = (
  a: ThroughputMetricsRecordV1,
  b: ThroughputMetricsRecordV1,
) => a.cycle.runId === b.cycle.runId && a.cycle.attempt === b.cycle.attempt;

/**
 * Append one cycle record. A cycle already present in the hot tier is a
 * `duplicate` (a rerun finalize never writes twice). Pure.
 */
export function appendThroughputRecordV1(
  ledger: ThroughputMetricsLedgerV1,
  input: ThroughputMetricsRecordV1,
): { status: "appended" | "duplicate"; ledger: ThroughputMetricsLedgerV1 } {
  const record = parseThroughputMetricsRecordV1(input);
  if (ledger.records.some((row) => sameCycle(row, record))) {
    return { status: "duplicate", ledger };
  }
  const records = [...ledger.records, record].sort(order);
  const daily = new Map(ledger.daily.map((row) => [row.date, row]));
  while (records.length > THROUGHPUT_HOT_MAX_RECORDS) {
    const oldest = records.shift()!;
    const date = throughputDateV1(oldest.finishedAtMs);
    daily.set(date, foldThroughputRecordV1(daily.get(date) ?? null, oldest));
  }
  const kept = [...daily.values()].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  ).slice(-THROUGHPUT_DAILY_MAX_SUMMARIES);
  return {
    status: "appended",
    ledger: {
      records,
      daily: kept,
      ...(ledger.upkeepStreak === undefined
        ? {}
        : { upkeepStreak: ledger.upkeepStreak }),
      ...(ledger.watchdog === undefined ? {} : { watchdog: ledger.watchdog }),
    },
  };
}

/** The exact files of the surface: canonical JSON, one value per line. */
export function encodeThroughputLedgerV1(
  ledger: ThroughputMetricsLedgerV1,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const record of ledger.records) {
    const path = `${THROUGHPUT_DIR}/${
      throughputDateV1(record.finishedAtMs)
    }.jsonl`;
    files.set(path, `${files.get(path) ?? ""}${canonicalStringify(record)}\n`);
  }
  if (ledger.daily.length > 0) {
    files.set(
      THROUGHPUT_DAILY_PATH,
      ledger.daily.map((row) => `${canonicalStringify(row)}\n`).join(""),
    );
  }
  if (ledger.upkeepStreak !== undefined) {
    const streak = parseUpkeepDeferralStreakV1(ledger.upkeepStreak);
    if (streak === null) throw new Error("upkeep streak is malformed");
    files.set(
      THROUGHPUT_UPKEEP_STREAK_PATH,
      `${canonicalStringify(streak)}\n`,
    );
  }
  if (ledger.watchdog !== undefined) {
    const watchdog = parseThroughputWatchdogState(ledger.watchdog);
    if (watchdog === null) throw new Error("watchdog state is malformed");
    files.set(THROUGHPUT_WATCHDOG_PATH, `${canonicalStringify(watchdog)}\n`);
  }
  return files;
}

function lines(text: string, path: string): string[] {
  if (text.length === 0 || !text.endsWith("\n")) {
    throw new Error(`${path} is not newline-terminated JSONL`);
  }
  return text.slice(0, -1).split("\n");
}

/** One canonical JSON value on one newline-terminated line; else throws. */
function singleValue<T>(
  text: string,
  path: string,
  parse: (value: unknown) => T | null,
): T {
  const [line, ...rest] = lines(text, path);
  const value = rest.length === 0 ? parse(JSON.parse(line)) : null;
  if (value === null || canonicalStringify(value) !== line) {
    throw new Error(`${path} is not one canonical value`);
  }
  return value;
}

/**
 * Strictly decode the surface's files: only known paths, canonical lines,
 * each record in its own day file, ordered, unique and within the bounds.
 * Throws on any deviation.
 */
export function decodeThroughputLedgerV1(
  files: ReadonlyMap<string, string>,
): ThroughputMetricsLedgerV1 {
  const records: ThroughputMetricsRecordV1[] = [];
  let daily: ThroughputDailySummaryV1[] = [];
  let upkeepStreak: UpkeepDeferralStreakV1 | undefined;
  let watchdog: ThroughputWatchdogStateV2 | undefined;
  for (const [path, text] of [...files.entries()].sort()) {
    if (path === THROUGHPUT_UPKEEP_STREAK_PATH) {
      upkeepStreak = singleValue(text, path, parseUpkeepDeferralStreakV1);
      continue;
    }
    if (path === THROUGHPUT_WATCHDOG_PATH) {
      // The line must be canonical as written: a historical version 1 file
      // is lifted to version 2 by the reader, so the parsed value's
      // encoding differs from the line by design.
      const [line, ...rest] = lines(text, path);
      const raw = rest.length === 0 ? JSON.parse(line) : null;
      const value = raw === null ? null : parseThroughputWatchdogState(raw);
      if (value === null || canonicalStringify(raw) !== line) {
        throw new Error(`${path} is not one canonical value`);
      }
      watchdog = value;
      continue;
    }
    if (path === THROUGHPUT_DAILY_PATH) {
      daily = lines(text, path).map((line) => {
        const summary = parseThroughputDailySummaryV1(JSON.parse(line));
        if (canonicalStringify(summary) !== line) {
          throw new Error("daily summary is not canonical JSON");
        }
        return summary;
      });
      continue;
    }
    const match = HOT_PATH.exec(path);
    if (match === null) throw new Error("unknown metrics path");
    for (const line of lines(text, path)) {
      const record = parseThroughputMetricsLineV1(line);
      if (throughputDateV1(record.finishedAtMs) !== match[1]) {
        throw new Error("metrics record is in the wrong day file");
      }
      records.push(record);
    }
  }
  for (let index = 1; index < records.length; index++) {
    if (order(records[index - 1], records[index]) >= 0) {
      throw new Error("metrics records are not strictly ordered");
    }
  }
  if (
    new Set(records.map((r) => `${r.cycle.runId}:${r.cycle.attempt}`)).size !==
      records.length
  ) {
    throw new Error("metrics records repeat a cycle");
  }
  for (let index = 1; index < daily.length; index++) {
    if (daily[index - 1].date >= daily[index].date) {
      throw new Error("daily summaries are not strictly ordered");
    }
  }
  if (
    records.length > THROUGHPUT_HOT_MAX_RECORDS ||
    daily.length > THROUGHPUT_DAILY_MAX_SUMMARIES
  ) {
    throw new Error("metrics surface exceeds its retention bound");
  }
  return {
    records,
    daily,
    ...(upkeepStreak === undefined ? {} : { upkeepStreak }),
    ...(watchdog === undefined ? {} : { watchdog }),
  };
}
