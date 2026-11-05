/**
 * Pure throughput watchdog evaluation (#340 self-improvement loop): the
 * metrics records and daily rollups in, one verdict per threshold of
 * `THROUGHPUT_WATCHDOG_THRESHOLDS` out. Nothing here reads Git, the clock or
 * the network; the caller supplies `nowMs`.
 *
 * A threshold is `insufficient_data` (never `missed`) when its fields are
 * null in every record, when fewer cycles than its minimum observed them, or
 * when a weekly ratio covers fewer days than its minimum.
 */
import {
  type ThroughputDailySummaryV1,
  throughputDateV1,
  type ThroughputMetricsRecordV1,
  type ThroughputSumV1,
} from "../contracts/throughput-metrics.ts";
import {
  THROUGHPUT_WATCHDOG_THRESHOLDS,
  type ThroughputThresholdV1,
} from "./throughput-watchdog-thresholds.ts";

export type ThroughputVerdictKindV1 = "met" | "missed" | "insufficient_data";

export interface ThroughputVerdictV1 {
  id: string;
  name: string;
  childIssue: number;
  informational: boolean;
  verdict: ThroughputVerdictKindV1;
  /** In the threshold's unit; null when insufficient. */
  measured: number | null;
  limit: number;
  unit: ThroughputThresholdV1["unit"];
  /** `cycles:N` (latest eligible cycles) or `days:N` (latest UTC days). */
  window: { kind: "cycles" | "days"; size: number };
  /** Instants the evaluated data spans; null when nothing was evaluated. */
  fromMs: number | null;
  toMs: number | null;
  /** Cycles evaluated (folded rollup records included for ratios). */
  cycles: number;
  /** Closed, short explanation (why insufficient, or the aggregate). */
  detail: string;
}

export interface ThroughputWatchdogInputV1 {
  records: readonly ThroughputMetricsRecordV1[];
  daily: readonly ThroughputDailySummaryV1[];
  nowMs: number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function ordered(
  records: readonly ThroughputMetricsRecordV1[],
  nowMs: number,
): ThroughputMetricsRecordV1[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = `${record.cycle.runId}:${record.cycle.attempt}`;
    if (record.finishedAtMs > nowMs || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) =>
    a.finishedAtMs - b.finishedAtMs || a.cycle.runId - b.cycle.runId ||
    a.cycle.attempt - b.cycle.attempt
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function base(threshold: ThroughputThresholdV1) {
  const metric = threshold.metric;
  return {
    id: threshold.id,
    name: threshold.name,
    childIssue: threshold.childIssue,
    informational: threshold.informational === true,
    limit: threshold.limit,
    unit: threshold.unit,
    window: metric.kind === "weekly_ratio"
      ? { kind: "days" as const, size: metric.windowDays }
      : { kind: "cycles" as const, size: metric.windowCycles },
  };
}

function insufficient(
  threshold: ThroughputThresholdV1,
  cycles: number,
  detail: string,
  span: { fromMs: number | null; toMs: number | null } = {
    fromMs: null,
    toMs: null,
  },
): ThroughputVerdictV1 {
  return {
    ...base(threshold),
    verdict: "insufficient_data",
    measured: null,
    cycles,
    detail,
    ...span,
  };
}

function judged(
  threshold: ThroughputThresholdV1,
  measured: number,
  rows: readonly ThroughputMetricsRecordV1[],
  detail: string,
): ThroughputVerdictV1 {
  return {
    ...base(threshold),
    verdict: measured <= threshold.limit ? "met" : "missed",
    measured,
    cycles: rows.length,
    fromMs: rows.length === 0 ? null : rows[0].startedAtMs,
    toMs: rows.length === 0 ? null : rows[rows.length - 1].finishedAtMs,
    detail,
  };
}

/** Latest `windowCycles` eligible rows, or an insufficient verdict. */
function latest(
  threshold: ThroughputThresholdV1,
  eligible: readonly ThroughputMetricsRecordV1[],
  windowCycles: number,
  minCycles: number,
  none: string,
): ThroughputMetricsRecordV1[] | ThroughputVerdictV1 {
  if (eligible.length === 0) return insufficient(threshold, 0, none);
  const rows = eligible.slice(-windowCycles);
  if (rows.length < minCycles) {
    return insufficient(
      threshold,
      rows.length,
      `fewer than ${minCycles} cycles recorded the fields`,
    );
  }
  return rows;
}

function evaluateOne(
  threshold: ThroughputThresholdV1,
  records: readonly ThroughputMetricsRecordV1[],
  daily: readonly ThroughputDailySummaryV1[],
  nowMs: number,
): ThroughputVerdictV1 {
  const metric = threshold.metric;
  if (metric.kind === "phase_median") {
    const eligible = records.filter((record) =>
      metric.phases.every((phase) => record.phaseMs[phase] !== null) &&
      (metric.minRecordsRead === undefined ||
        (record.counts.recordsRead ?? -1) >= metric.minRecordsRead)
    );
    const rows = latest(
      threshold,
      eligible,
      metric.windowCycles,
      metric.minCycles,
      metric.minRecordsRead === undefined
        ? "fields not recorded"
        : `no cycle with recordsRead >= ${metric.minRecordsRead}`,
    );
    if (!Array.isArray(rows)) return rows;
    const values = rows.map((record) =>
      metric.phases.reduce((sum, phase) => sum + record.phaseMs[phase]!, 0)
    );
    return judged(threshold, median(values) / MINUTE_MS, rows, "median");
  }
  if (metric.kind === "cells_planned") {
    const eligible = records.filter((record) =>
      record.counts.cellsPlanned !== null &&
      record.counts.readyRecordsNotPlanned !== null
    );
    const rows = latest(
      threshold,
      eligible,
      metric.windowCycles,
      metric.minCycles,
      "fields not recorded",
    );
    if (!Array.isArray(rows)) return rows;
    const violations = rows.filter((record) => {
      const cells = record.counts.cellsPlanned!;
      const ready = record.counts.readyRecordsNotPlanned!;
      return record.plannerRefusal === null && ready + cells > 0 &&
        cells === 0;
    }).length;
    return judged(threshold, violations, rows, "cycles with none planned");
  }
  if (metric.kind === "notice_count") {
    const eligible = records.filter((record) =>
      record.counts.ownerNoticesSent !== null
    );
    if (eligible.length === 0) {
      return insufficient(threshold, 0, "fields not recorded");
    }
    const rows = records.slice(-metric.windowCycles);
    if (rows.length < metric.minCycles) {
      return insufficient(
        threshold,
        rows.length,
        `fewer than ${metric.minCycles} cycles recorded`,
      );
    }
    const sent = rows.reduce(
      (sum, record) => sum + (record.counts.ownerNoticesSent ?? 0),
      0,
    );
    return judged(threshold, sent, rows, "informational, never filed");
  }
  // weekly_ratio: hot records in (now - window, now] plus whole folded days.
  const startMs = nowMs - metric.windowDays * DAY_MS;
  const firstDate = throughputDateV1(startMs);
  const lastDate = throughputDateV1(nowMs);
  const hot = records.filter((record) => record.finishedAtMs > startMs);
  const folded = daily.filter((row) =>
    row.date >= firstDate && row.date <= lastDate
  );
  const num: ThroughputSumV1 = { sum: 0, known: 0 };
  const den: ThroughputSumV1 = { sum: 0, known: 0 };
  const add = (into: ThroughputSumV1, value: number | null) => {
    if (value === null) return;
    into.sum += value;
    into.known += 1;
  };
  for (const record of hot) {
    add(num, record.counts[metric.numerator]);
    add(den, record.counts[metric.denominator]);
  }
  for (const row of folded) {
    num.sum += row.counts[metric.numerator].sum;
    num.known += row.counts[metric.numerator].known;
    den.sum += row.counts[metric.denominator].sum;
    den.known += row.counts[metric.denominator].known;
  }
  const days = new Set([
    ...hot.map((record) => throughputDateV1(record.finishedAtMs)),
    ...folded.map((row) => row.date),
  ]);
  const cycles = hot.length +
    folded.reduce((sum, row) => sum + row.records, 0);
  const starts = [
    ...hot.map((record) => record.startedAtMs),
    ...folded.map((row) => row.firstStartedAtMs),
  ];
  const ends = [
    ...hot.map((record) => record.finishedAtMs),
    ...folded.map((row) => row.lastFinishedAtMs),
  ];
  const span = {
    fromMs: starts.length === 0 ? null : Math.min(...starts),
    toMs: ends.length === 0 ? null : Math.max(...ends),
  };
  if (num.known === 0 || den.known === 0) {
    return insufficient(threshold, cycles, "fields not recorded", span);
  }
  if (days.size < metric.minDays) {
    return insufficient(
      threshold,
      cycles,
      `fewer than ${metric.minDays} days recorded`,
      span,
    );
  }
  if (cycles < metric.minCycles) {
    return insufficient(
      threshold,
      cycles,
      `fewer than ${metric.minCycles} cycles recorded`,
      span,
    );
  }
  if (den.sum === 0) {
    return insufficient(threshold, cycles, "no merges in window", span);
  }
  const measured = num.sum / den.sum;
  return {
    ...base(threshold),
    verdict: measured <= threshold.limit ? "met" : "missed",
    measured,
    cycles,
    ...span,
    detail: `${num.sum} / ${den.sum}`,
  };
}

/** One verdict per threshold, in table order. Pure. */
export function evaluateThroughputWatchdogV1(
  input: ThroughputWatchdogInputV1,
  thresholds: readonly ThroughputThresholdV1[] = THROUGHPUT_WATCHDOG_THRESHOLDS,
): ThroughputVerdictV1[] {
  const records = ordered(input.records, input.nowMs);
  return thresholds.map((threshold) =>
    evaluateOne(threshold, records, input.daily, input.nowMs)
  );
}

/** The measured value, x1000 and rounded (the stored comparison key). */
export function measuredMilliV1(verdict: ThroughputVerdictV1): number | null {
  return verdict.measured === null ? null : Math.round(verdict.measured * 1000);
}

function amount(value: number, unit: ThroughputVerdictV1["unit"]): string {
  if (unit === "min") return `${value.toFixed(1)} min`;
  if (unit === "ratio") return value.toFixed(2);
  return `${value} ${unit}`;
}

export function formatMeasuredV1(verdict: ThroughputVerdictV1): string {
  return verdict.measured === null
    ? "n/a"
    : amount(verdict.measured, verdict.unit);
}

export function formatLimitV1(verdict: ThroughputVerdictV1): string {
  return `<= ${amount(verdict.limit, verdict.unit)}`;
}

export function formatWindowV1(verdict: ThroughputVerdictV1): string {
  return verdict.window.kind === "cycles"
    ? `latest ${verdict.window.size} cycles`
    : `latest ${verdict.window.size} days`;
}

const iso = (ms: number | null) =>
  ms === null
    ? "n/a"
    : new Date(ms).toISOString().slice(0, 16).replace("T", " ");

export function formatSpanV1(verdict: ThroughputVerdictV1): string {
  return `${iso(verdict.fromMs)} .. ${iso(verdict.toMs)} UTC`;
}

/** Plain aligned Thresholds table for `sentinel report`. Pure. */
export function renderThroughputThresholdsV1(
  verdicts: readonly ThroughputVerdictV1[],
  nowMs: number,
): string[] {
  const header = [
    "threshold",
    "child",
    "verdict",
    "measured",
    "limit",
    "window",
    "cycles",
    "note",
  ];
  const rows = verdicts.map((verdict) => [
    verdict.id,
    `#${verdict.childIssue}`,
    verdict.informational ? `${verdict.verdict} (info)` : verdict.verdict,
    formatMeasuredV1(verdict),
    formatLimitV1(verdict),
    formatWindowV1(verdict),
    `${verdict.cycles}`,
    verdict.detail,
  ]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length))
  );
  const line = (row: string[]) =>
    row.map((cell, index) => cell.padEnd(widths[index])).join("  ")
      .trimEnd();
  return [
    `Thresholds (watchdog evaluation as of ${iso(nowMs)} UTC; ` +
    "a missed, non-informational threshold files one Sentinel issue)",
    line(header),
    ...rows.map(line),
  ];
}
