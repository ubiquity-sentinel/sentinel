/**
 * Throughput watchdog issues (pure): the marker, title and body Sentinel
 * files on its own repository for a missed threshold, and the trusted issue
 * port shape. The guardrail planner lives in `throughput-watchdog-plan.ts`.
 *
 * The issue carries no `sentinel:skip` marker or label, so the ordinary
 * issue intake admits it as work, at the modest `priority:2`.
 */
import { THROUGHPUT_WATCHDOG_ID } from "../contracts/throughput-watchdog-state.ts";
import type { ThroughputCycleIdV1 } from "../contracts/throughput-metrics.ts";
import {
  formatLimitV1,
  formatMeasuredV1,
  formatSpanV1,
  formatWindowV1,
  type ThroughputVerdictV1,
} from "./throughput-watchdog.ts";
import type { ThroughputThresholdV1 } from "./throughput-watchdog-thresholds.ts";

/** Cycles on a newer runtime before a closed threshold may be re-filed. */
export const THROUGHPUT_WATCHDOG_OUTCOME_CYCLES = 10;
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
    "- Review, CI, P0 and accounting gates are unchanged.",
    `- Outcome rule: this issue is re-evaluated after ${THROUGHPUT_WATCHDOG_OUTCOME_CYCLES} cycles on a newer runtime. After it closes, the threshold is re-filed only if it is still missed after ${THROUGHPUT_WATCHDOG_OUTCOME_CYCLES} cycles on a runtime newer than the one installed at close, or at once if the measurement gets more than 10% worse than at close.`,
  ].join("\n");
}
