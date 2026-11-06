/**
 * Pure throughput readback (#339): renders plain-text tables from the #338
 * metrics surface and, for repository-level numbers the metrics record does
 * not carry, the repair state snapshot. Read-only and deterministic: the
 * caller loads both inputs and supplies `nowMs`; nothing here reads Git,
 * the clock or the network.
 *
 * A number the inputs do not observe prints `n/a (not recorded)`, never a
 * zero. Metrics are advisory telemetry: this report grants no health,
 * admission, accounting or merge authority.
 */

import {
  PLANNER_REFUSAL_REASONS_V1,
  type PlannerRefusalReasonV1,
  throughputDateV1,
} from "../contracts/throughput-metrics.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { ThroughputMetricsLedgerV1 } from "./throughput-metrics-ledger.ts";

export const NOT_RECORDED = "n/a (not recorded)";
export const NO_MERGES = "n/a (no merges)";
/** Longest window the report renders, in UTC days (inclusive). */
export const THROUGHPUT_REPORT_MAX_DAYS = 92;
/** Rows of the longest-waiting live records table. */
export const THROUGHPUT_REPORT_WAITING_ROWS = 10;

const DAY_MS = 86_400_000;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Inclusive UTC date window plus the instant ages are measured against. */
export interface ThroughputReportWindowV1 {
  since: string;
  until: string;
  nowMs: number;
}

/** The repair snapshot fields this report reads (a full snapshot fits). */
export interface ThroughputReportSnapshotV1 {
  updatedAt: number;
  work: ReadonlyArray<
    Pick<
      WorkRecordV1,
      | "repository"
      | "source"
      | "related"
      | "nextStep"
      | "wait"
      | "blocker"
      | "target"
      | "updatedAt"
    >
  >;
}

export class ThroughputReportRefusal extends Error {}

function dateMs(value: string, name: string): number {
  const match = DATE.exec(value);
  const ms = match === null
    ? NaN
    : Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (!Number.isFinite(ms) || throughputDateV1(ms) !== value) {
    throw new ThroughputReportRefusal(
      `${name} must be a UTC calendar date YYYY-MM-DD`,
    );
  }
  return ms;
}

/**
 * Validate `--since` (required) and `--until` (default: today UTC) into an
 * inclusive window of at most `THROUGHPUT_REPORT_MAX_DAYS` days.
 */
export function parseThroughputReportWindowV1(
  since: string | undefined,
  until: string | undefined,
  nowMs: number,
): ThroughputReportWindowV1 {
  if (since === undefined || since === "true") {
    throw new ThroughputReportRefusal("--since <YYYY-MM-DD> is required");
  }
  const untilDate = until === undefined ? throughputDateV1(nowMs) : until;
  const start = dateMs(since, "--since");
  const end = dateMs(untilDate, "--until");
  if (end < start) {
    throw new ThroughputReportRefusal("--until precedes --since");
  }
  if ((end - start) / DAY_MS + 1 > THROUGHPUT_REPORT_MAX_DAYS) {
    throw new ThroughputReportRefusal(
      `window exceeds ${THROUGHPUT_REPORT_MAX_DAYS} days`,
    );
  }
  return { since, until: untilDate, nowMs };
}

function windowDates(window: ThroughputReportWindowV1): string[] {
  const dates: string[] = [];
  const end = dateMs(window.until, "--until");
  for (let ms = dateMs(window.since, "--since"); ms <= end; ms += DAY_MS) {
    dates.push(throughputDateV1(ms));
  }
  return dates;
}

interface Sum {
  sum: number;
  known: number;
}

interface DayMetrics {
  cycles: number;
  folded: number;
  merges: Sum;
  refresh: Sum;
  ciRuns: Sum;
  /** Hot cycles with a recorded cell total: cell and controller time. */
  cellMs: number;
  controllerMs: number;
  dutyCycles: number;
  refusals: Record<PlannerRefusalReasonV1, number>;
}

function emptyDay(): DayMetrics {
  const zero = () => ({ sum: 0, known: 0 });
  const refusals = {} as Record<PlannerRefusalReasonV1, number>;
  for (const reason of PLANNER_REFUSAL_REASONS_V1) refusals[reason] = 0;
  return {
    cycles: 0,
    folded: 0,
    merges: zero(),
    refresh: zero(),
    ciRuns: zero(),
    cellMs: 0,
    controllerMs: 0,
    dutyCycles: 0,
    refusals,
  };
}

function add(target: Sum, value: number | null): void {
  if (value === null) return;
  target.sum += value;
  target.known += 1;
}

function addSum(target: Sum, value: Sum): void {
  target.sum += value.sum;
  target.known += value.known;
}

function metricsByDay(
  ledger: ThroughputMetricsLedgerV1,
  dates: readonly string[],
): Map<string, DayMetrics> {
  const days = new Map(dates.map((date) => [date, emptyDay()]));
  for (const record of ledger.records) {
    const day = days.get(throughputDateV1(record.finishedAtMs));
    if (day === undefined) continue;
    day.cycles += 1;
    add(day.merges, record.counts.mergesCompleted);
    add(day.refresh, record.counts.refreshCommits);
    add(day.ciRuns, record.counts.targetCiRunsTriggered);
    const cell = record.phaseMs.matrixCellTotal;
    if (cell !== null) {
      day.cellMs += cell;
      day.controllerMs += record.finishedAtMs - record.startedAtMs;
      day.dutyCycles += 1;
    }
    if (record.plannerRefusal !== null) day.refusals[record.plannerRefusal]++;
  }
  for (const summary of ledger.daily) {
    const day = days.get(summary.date);
    if (day === undefined) continue;
    day.cycles += summary.records;
    day.folded += summary.records;
    addSum(day.merges, summary.counts.mergesCompleted);
    addSum(day.refresh, summary.counts.refreshCommits);
    addSum(day.ciRuns, summary.counts.targetCiRunsTriggered);
    for (const reason of PLANNER_REFUSAL_REASONS_V1) {
      day.refusals[reason] += summary.plannerRefusals[reason];
    }
  }
  return days;
}

function total(days: Iterable<DayMetrics>): DayMetrics {
  const out = emptyDay();
  for (const day of days) {
    out.cycles += day.cycles;
    out.folded += day.folded;
    addSum(out.merges, day.merges);
    addSum(out.refresh, day.refresh);
    addSum(out.ciRuns, day.ciRuns);
    out.cellMs += day.cellMs;
    out.controllerMs += day.controllerMs;
    out.dutyCycles += day.dutyCycles;
    for (const reason of PLANNER_REFUSAL_REASONS_V1) {
      out.refusals[reason] += day.refusals[reason];
    }
  }
  return out;
}

const count = (value: Sum) => value.known === 0 ? NOT_RECORDED : `${value.sum}`;
const minutes = (ms: number) => (ms / 60_000).toFixed(1);

function perMerge(numerator: Sum, merges: Sum): string {
  if (numerator.known === 0 || merges.known === 0) return NOT_RECORDED;
  if (merges.sum === 0) return NO_MERGES;
  return (numerator.sum / merges.sum).toFixed(2);
}

function dayRow(label: string, day: DayMetrics): string[] {
  if (day.cycles === 0) {
    return [label, ...Array.from({ length: 8 }, () => NOT_RECORDED)];
  }
  const duty = day.dutyCycles === 0 || day.controllerMs === 0;
  return [
    label,
    `${day.cycles}`,
    count(day.merges),
    count(day.refresh),
    perMerge(day.refresh, day.merges),
    count(day.ciRuns),
    perMerge(day.ciRuns, day.merges),
    day.dutyCycles === 0 ? NOT_RECORDED : minutes(day.cellMs),
    duty ? NOT_RECORDED : (day.cellMs / day.controllerMs).toFixed(2),
  ];
}

/** Plain aligned table: the first `left` columns left, the rest right. */
function table(header: string[], rows: string[][], left = 1): string[] {
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...rows.map((row) => row[index].length))
  );
  const line = (row: string[]) =>
    row.map((cell, index) =>
      index < left ? cell.padEnd(widths[index]) : cell.padStart(widths[index])
    ).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

const repositoryKey = (record: ThroughputReportSnapshotV1["work"][number]) =>
  `${record.repository.owner}/${record.repository.name}`;

function age(ms: number): string {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

function snapshotSections(
  snapshot: ThroughputReportSnapshotV1 | null,
  dates: readonly string[],
  nowMs: number,
): string[] {
  const out: string[] = [];
  const section = (title: string, body: string[]) =>
    out.push("", title, ...body);
  if (snapshot === null) {
    for (
      const title of [
        "Merges per day by repository",
        "Delivery-queue depth per repository",
        "Blocked-cause histogram",
        "Longest-waiting live records",
      ]
    ) section(title, [NOT_RECORDED]);
    return out;
  }
  const repositories = [...new Set(snapshot.work.map(repositoryKey))].sort();
  if (repositories.length === 0) {
    section("Merges per day by repository", [NOT_RECORDED]);
    section("Delivery-queue depth per repository", [NOT_RECORDED]);
  } else {
    const merged = new Map<string, number>();
    for (const record of snapshot.work) {
      if (record.nextStep !== "done" || record.target.pr === null) continue;
      const key = `${throughputDateV1(record.updatedAt)} ${
        repositoryKey(record)
      }`;
      merged.set(key, (merged.get(key) ?? 0) + 1);
    }
    const rows = dates.map((date) => [
      date,
      ...repositories.map((repo) => `${merged.get(`${date} ${repo}`) ?? 0}`),
    ]);
    rows.push([
      "total",
      ...repositories.map((repo) =>
        `${
          dates.reduce((sum, date) =>
            sum + (merged.get(`${date} ${repo}`) ?? 0), 0)
        }`
      ),
    ]);
    section(
      "Merges per day by repository (repair snapshot: done records with a PR, by UTC completion date)",
      table(["date", ...repositories], rows),
    );
    section(
      "Delivery-queue depth per repository (current snapshot)",
      table(
        ["repository", "delivery"],
        repositories.map((repo) => [
          repo,
          `${
            snapshot.work.filter((record) =>
              record.nextStep === "delivery" && repositoryKey(record) === repo
            ).length
          }`,
        ]),
      ),
    );
  }
  const causes = new Map<string, number>();
  for (const record of snapshot.work) {
    if (record.nextStep !== "blocked") continue;
    const cause = record.blocker?.kind ?? "unrecorded";
    causes.set(cause, (causes.get(cause) ?? 0) + 1);
  }
  section(
    "Blocked-cause histogram (current snapshot)",
    causes.size === 0 ? ["none blocked"] : table(
      ["cause", "records"],
      [...causes.entries()].sort((a, b) =>
        b[1] - a[1] || (a[0] < b[0] ? -1 : 1)
      ).map(([cause, n]) => [cause, `${n}`]),
    ),
  );
  const live = snapshot.work.filter((record) =>
    record.nextStep !== "done" && record.nextStep !== "blocked"
  ).map((record) => ({
    record,
    since: record.wait?.since ?? record.updatedAt,
  })).sort((a, b) =>
    a.since - b.since ||
    (repositoryKey(a.record) < repositoryKey(b.record) ? -1 : 1)
  ).slice(0, THROUGHPUT_REPORT_WAITING_ROWS);
  section(
    `Longest-waiting live records (current snapshot, top ${THROUGHPUT_REPORT_WAITING_ROWS})`,
    live.length === 0 ? ["none live"] : table(
      ["repository", "source", "step", "wait", "since (UTC)", "waiting"],
      live.map(({ record, since }) => [
        repositoryKey(record),
        record.related.issueNumber === null
          ? record.source.kind
          : `#${record.related.issueNumber}`,
        record.nextStep,
        record.wait?.reason ?? "-",
        new Date(since).toISOString().slice(0, 16).replace("T", " "),
        age(nowMs - since),
      ]),
      5,
    ),
  );
  return out;
}

/**
 * Render the report. `records` null means the metrics ref is absent;
 * `snapshot` null means the repair snapshot is absent. Pure.
 */
export function renderThroughputReport(
  records: ThroughputMetricsLedgerV1 | null,
  snapshot: ThroughputReportSnapshotV1 | null,
  window: ThroughputReportWindowV1,
): string {
  const dates = windowDates(window);
  const out = [
    `Sentinel throughput report ${window.since} .. ${window.until} (UTC, inclusive)`,
    `repair snapshot updated ${
      snapshot === null
        ? NOT_RECORDED
        : new Date(snapshot.updatedAt).toISOString().slice(0, 16).replace(
          "T",
          " ",
        )
    }`,
  ];
  if (records === null) {
    out.push("", "Cycles per day (all repositories, metrics)", NOT_RECORDED);
    out.push("", "Planner refusal histogram", NOT_RECORDED);
  } else {
    const days = metricsByDay(records, dates);
    const sum = total(days.values());
    out.push(
      "",
      "Cycles per day (all repositories, metrics)",
      ...table(
        [
          "date",
          "cycles",
          "merges",
          "refresh commits",
          "refresh/merge",
          "CI runs",
          "CI runs/merge",
          "cell min",
          "duty cycle",
        ],
        [
          ...dates.map((date) => dayRow(date, days.get(date)!)),
          dayRow("total", sum),
        ],
      ),
      "duty cycle = matrix cell minutes / controller minutes over hot cycles " +
        `with a recorded cell total (${sum.dutyCycles} of ${sum.cycles}; ` +
        `${sum.folded} folded into daily rollups)`,
      "",
      "Planner refusal histogram (metrics)",
    );
    const refused = PLANNER_REFUSAL_REASONS_V1.reduce(
      (n, reason) => n + sum.refusals[reason],
      0,
    );
    // A null refusal means "did not refuse" or "not filled yet"; with no
    // recorded refusal at all, a zero is indistinguishable from unrecorded.
    out.push(...table(
      ["reason", "cycles"],
      PLANNER_REFUSAL_REASONS_V1.map((reason) => [
        reason,
        refused === 0 ? NOT_RECORDED : `${sum.refusals[reason]}`,
      ]),
    ));
  }
  out.push(...snapshotSections(snapshot, dates, window.nowMs));
  return `${out.join("\n")}\n`;
}
