/**
 * Throughput watchdog issues (pure): the issue text Sentinel files on its
 * own repository for a missed threshold, and the guardrail planner that
 * decides, from the verdicts, the stored watchdog state and one complete
 * open-item listing, which single issue to create and which to edit.
 *
 * Guardrails: at most one new issue per cycle; nothing is created while any
 * open watchdog issue exists or any open pull request references one; a
 * threshold whose issue was closed is not re-filed for 7 days; an open issue
 * is edited only when its measured number moved by more than 10%.
 *
 * The issue carries no `sentinel:skip` marker or label, so the ordinary
 * issue intake admits it as work, at the modest `priority:2`.
 */
import {
  EMPTY_THROUGHPUT_WATCHDOG_STATE,
  THROUGHPUT_WATCHDOG_ID,
  type ThroughputWatchdogStateV1,
} from "../contracts/throughput-watchdog-state.ts";
import type { ThroughputCycleIdV1 } from "../contracts/throughput-metrics.ts";
import {
  formatLimitV1,
  formatMeasuredV1,
  formatSpanV1,
  formatWindowV1,
  measuredMilliV1,
  type ThroughputVerdictV1,
} from "./throughput-watchdog.ts";
import type { ThroughputThresholdV1 } from "./throughput-watchdog-thresholds.ts";

export const THROUGHPUT_WATCHDOG_COOLDOWN_MS = 7 * 86_400_000;
/** Intake's numeric priority convention (`src/repair/transitions.ts`). */
export const THROUGHPUT_WATCHDOG_LABELS: readonly string[] = ["priority:2"];
export const THROUGHPUT_WATCHDOG_TITLE_PREFIX = "Throughput: ";

const MARKER = /^<!-- sentinel:throughput-watchdog:([a-z][a-z0-9_]{0,39}) -->$/;

/** The second body line of a watchdog issue for `id`. */
export function throughputWatchdogMarkerV1(id: string): string {
  if (!THROUGHPUT_WATCHDOG_ID.test(id)) throw new Error("invalid threshold");
  return `<!-- sentinel:throughput-watchdog:${id} -->`;
}

/** The threshold id a body's second line marks, or null. */
export function parseThroughputWatchdogMarkerV1(
  body: string | null,
): string | null {
  if (body === null) return null;
  const second = body.split(/\r?\n/, 2)[1];
  return second === undefined ? null : MARKER.exec(second.trim())?.[1] ?? null;
}

/** Issue numbers a pull request title or body names (`#N`, `issue N`). */
export function referencedIssueNumbersV1(text: string): number[] {
  const out = new Set<number>();
  for (const match of text.matchAll(/(?:#|\bissue\s+)([1-9][0-9]{0,8})\b/gi)) {
    out.add(Number(match[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/** One complete listing of the repository's open issues and pull requests. */
export interface ThroughputWatchdogListingV1 {
  /** Open issues whose second body line is a watchdog marker. */
  issues: Array<{ number: number; thresholdId: string; appAuthored: boolean }>;
  /** Open pull requests: the issue numbers they name and their title. */
  pulls: Array<{ number: number; title: string; references: number[] }>;
}

/** The trusted issue port the finalize watchdog uses (fakeable). */
export interface ThroughputWatchdogIssuesV1 {
  /** Null when the listing cannot be proven complete. */
  listOpen(): Promise<ThroughputWatchdogListingV1 | null>;
  /** The created issue's number, or null when unproven. */
  create(input: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<number | null>;
  /** True only when GitHub confirms the exact new title and body. */
  update(
    number: number,
    input: { title: string; body: string },
  ): Promise<boolean>;
}

export function throughputWatchdogTitleV1(
  verdict: ThroughputVerdictV1,
): string {
  return `${THROUGHPUT_WATCHDOG_TITLE_PREFIX}${verdict.name} missed (${
    formatMeasuredV1(verdict)
  } vs ${formatLimitV1(verdict)})`;
}

export function throughputWatchdogBodyV1(
  verdict: ThroughputVerdictV1,
  threshold: ThroughputThresholdV1,
  cycle: ThroughputCycleIdV1,
): string {
  return [
    `Sentinel throughput watchdog: \`${threshold.id}\` is missed.`,
    throughputWatchdogMarkerV1(threshold.id),
    "",
    "## Measurement",
    "",
    `- Threshold: ${threshold.name} (\`${threshold.id}\`), from the #340 child #${threshold.childIssue}.`,
    `- Measured: ${formatMeasuredV1(verdict)} (${verdict.detail}); limit: ${
      formatLimitV1(verdict)
    }.`,
    `- Window: ${formatWindowV1(verdict)}, ${
      formatSpanV1(verdict)
    }; cycles evaluated: ${verdict.cycles}.`,
    `- Metric fields: ${
      threshold.fields.map((field) => `\`${field}\``).join(", ")
    } of \`ThroughputMetricsRecordV1\` (\`src/contracts/throughput-metrics.ts\`), stored on \`refs/heads/sentinel-state/metrics\`.`,
    `- Evaluated by finalize of run ${cycle.runId} attempt ${cycle.attempt}; the same evaluation prints in the \`sentinel report\` Thresholds table.`,
    "",
    "## What to investigate",
    "",
    ...threshold.investigate.map((line) => `- ${line}`),
    "",
    "## Done when",
    "",
    "- A focused change reduces the measured value for the cause you find, with a regression test over fake ports.",
    "- Thresholds live in `src/host/throughput-watchdog-thresholds.ts`; do not raise a limit to make it pass.",
    "- Review, CI, P0 and accounting gates are unchanged. After this issue closes the threshold is not re-filed for 7 days.",
  ].join("\n");
}

export type ThroughputWatchdogActionV1 =
  | {
    kind: "create";
    thresholdId: string;
    title: string;
    body: string;
    labels: readonly string[];
    measuredMilli: number;
  }
  | {
    kind: "edit";
    thresholdId: string;
    number: number;
    title: string;
    body: string;
    measuredMilli: number;
  };

export interface ThroughputWatchdogPlanV1 {
  /** The state to record once the actions settle (filings applied later). */
  state: ThroughputWatchdogStateV1;
  actions: ThroughputWatchdogActionV1[];
  /** Closed reason the create guardrail refused, or null. */
  createBlocked:
    | "open_watchdog_issue"
    | "open_pull_request"
    | "cooldown"
    | "nothing_missed"
    | null;
}

/** More than 10% away from the stored value (exact on integers). */
export function measuredChangedV1(
  prior: number | null,
  next: number,
): boolean {
  if (prior === null) return true;
  if (prior === 0) return next !== 0;
  return Math.abs(next - prior) * 10 > prior;
}

/** Decide this cycle's watchdog actions. Pure. */
export function planThroughputWatchdogV1(input: {
  verdicts: readonly ThroughputVerdictV1[];
  thresholds: readonly ThroughputThresholdV1[];
  state: ThroughputWatchdogStateV1 | null;
  listing: ThroughputWatchdogListingV1;
  cycle: ThroughputCycleIdV1;
  nowMs: number;
}): ThroughputWatchdogPlanV1 {
  const prior = input.state ?? EMPTY_THROUGHPUT_WATCHDOG_STATE;
  const table = new Map(input.thresholds.map((row) => [row.id, row]));
  const thresholds = structuredClone(prior.thresholds);
  // Only ids in the table are remembered, which bounds the stored state.
  for (const id of Object.keys(thresholds)) {
    if (!table.has(id)) delete thresholds[id];
  }
  const openNumbers = new Set(input.listing.issues.map((row) => row.number));
  // The lowest open issue per threshold is the one edited and remembered.
  const openById = new Map<string, (typeof input.listing.issues)[number]>();
  for (
    const row of [...input.listing.issues].sort((a, b) => a.number - b.number)
  ) {
    if (!openById.has(row.thresholdId)) openById.set(row.thresholdId, row);
  }
  for (const entry of Object.values(thresholds)) {
    if (entry.closedAtMs === null && !openNumbers.has(entry.issue)) {
      entry.closedAtMs = input.nowMs;
    }
  }
  for (const [id, row] of openById) {
    if (!table.has(id)) continue;
    const entry = thresholds[id];
    if (entry === undefined || entry.issue !== row.number) {
      // Adopted: a filing whose state write was lost, or a reopened issue.
      thresholds[id] = {
        issue: row.number,
        measuredMilli: null,
        filedAtMs: input.nowMs,
        closedAtMs: null,
      };
    } else if (entry.closedAtMs !== null) {
      thresholds[id] = { ...entry, closedAtMs: null };
    }
  }
  const actions: ThroughputWatchdogActionV1[] = [];
  const byId = new Map(input.verdicts.map((verdict) => [verdict.id, verdict]));
  for (const [id, row] of openById) {
    const verdict = byId.get(id);
    const threshold = table.get(id);
    const measured = verdict === undefined ? null : measuredMilliV1(verdict);
    if (
      !row.appAuthored || verdict === undefined || threshold === undefined ||
      verdict.informational || verdict.verdict !== "missed" ||
      measured === null ||
      !measuredChangedV1(thresholds[id]?.measuredMilli ?? null, measured)
    ) continue;
    actions.push({
      kind: "edit",
      thresholdId: id,
      number: row.number,
      title: throughputWatchdogTitleV1(verdict),
      body: throughputWatchdogBodyV1(verdict, threshold, input.cycle),
      measuredMilli: measured,
    });
  }
  const known = new Set([
    ...openNumbers,
    ...Object.values(thresholds).map((entry) => entry.issue),
  ]);
  let createBlocked: ThroughputWatchdogPlanV1["createBlocked"] = null;
  if (input.listing.issues.length > 0) {
    createBlocked = "open_watchdog_issue";
  } else if (
    input.listing.pulls.some((pull) =>
      pull.title.startsWith(THROUGHPUT_WATCHDOG_TITLE_PREFIX) ||
      pull.references.some((number) => known.has(number))
    )
  ) {
    createBlocked = "open_pull_request";
  } else {
    const missed = input.verdicts.filter((verdict) =>
      !verdict.informational && verdict.verdict === "missed" &&
      table.has(verdict.id)
    );
    const ready = missed.find((verdict) => {
      const closed = thresholds[verdict.id]?.closedAtMs ?? null;
      return closed === null ||
        input.nowMs - closed >= THROUGHPUT_WATCHDOG_COOLDOWN_MS;
    });
    if (missed.length === 0) createBlocked = "nothing_missed";
    else if (ready === undefined) createBlocked = "cooldown";
    else {
      actions.push({
        kind: "create",
        thresholdId: ready.id,
        title: throughputWatchdogTitleV1(ready),
        body: throughputWatchdogBodyV1(
          ready,
          table.get(ready.id)!,
          input.cycle,
        ),
        labels: THROUGHPUT_WATCHDOG_LABELS,
        measuredMilli: measuredMilliV1(ready)!,
      });
    }
  }
  return {
    state: {
      version: 1,
      lastCycle: { runId: input.cycle.runId, attempt: input.cycle.attempt },
      thresholds,
    },
    actions,
    createBlocked,
  };
}
