/**
 * Finalize wiring of the throughput watchdog (self-improvement loop).
 *
 * Trusted finalize stage only. It reads the metrics sidecar, evaluates the
 * threshold table over the stored records plus this cycle's record, lists
 * the self repository's open issues and pull requests once, files or edits
 * at most what `planThroughputWatchdogV1` allows through the trusted App
 * issue port, and records the filings and cooldowns in
 * `throughput/watchdog.json` with the metrics port's expected-head write.
 * Off when `SENTINEL_SELF_IMPROVE` is `off`.
 *
 * Advisory: one 60-second bound, never throws and never changes the
 * finalize outcome; the log line carries only closed values and numbers.
 */
import { createDeadline } from "../github/http.ts";
import type {
  ThroughputCycleIdV1,
  ThroughputMetricsRecordV1,
} from "../contracts/throughput-metrics.ts";
import type { ThroughputWatchdogStateV1 } from "../contracts/throughput-watchdog-state.ts";
import type {
  ThroughputAppendResultV1,
  ThroughputMetricsPortV1,
} from "../state/throughput-metrics-store.ts";
import {
  collectFinalizeMetricsV1,
  type FinalizeMetricsDepsV1,
  type FinalizeMetricsFactsV1,
  writeFinalizeThroughputMetricsV1,
} from "./throughput-metrics-finalize.ts";
import { evaluateThroughputWatchdogV1 } from "./throughput-watchdog.ts";
import {
  planThroughputWatchdogV1,
  type ThroughputWatchdogIssuesV1,
  type ThroughputWatchdogPlanV1,
} from "./throughput-watchdog-issue.ts";
import {
  THROUGHPUT_WATCHDOG_THRESHOLDS,
  type ThroughputThresholdV1,
} from "./throughput-watchdog-thresholds.ts";

export const SELF_IMPROVE_ENV = "SENTINEL_SELF_IMPROVE";
export const FINALIZE_WATCHDOG_BUDGET_MS = 60_000;

/** Default on; only `off` (any case, trimmed) disables. */
export function selfImproveEnabled(value: string | undefined): boolean {
  return value?.trim().toLowerCase() !== "off";
}

export interface FinalizeThroughputWatchdogDepsV1 {
  metrics: ThroughputMetricsPortV1;
  issues: ThroughputWatchdogIssuesV1;
  thresholds?: readonly ThroughputThresholdV1[];
  log?: (line: string) => void;
  budgetMs?: number;
}

export type ThroughputWatchdogStatusV1 =
  | "off"
  | "evaluated"
  | "already_evaluated"
  | "metrics_unavailable"
  | "listing_unavailable"
  | "timeout"
  | "failed";

export interface ThroughputWatchdogResultV1 {
  status: ThroughputWatchdogStatusV1;
  /** Issues filed this cycle; null when off or the outcome is unknown. */
  filed: number | null;
  edited: number;
  /** The recording write's outcome, or null when none was attempted. */
  stateWrite: "applied" | "conflict" | "unavailable" | null;
  createBlocked: ThroughputWatchdogPlanV1["createBlocked"];
  missed: string[];
  issue: number | null;
}

const sameCycle = (
  a: ThroughputCycleIdV1 | null,
  b: ThroughputCycleIdV1,
) => a !== null && a.runId === b.runId && a.attempt === b.attempt;

async function settle(
  deps: FinalizeThroughputWatchdogDepsV1,
  input: {
    cycle: ThroughputCycleIdV1;
    record: ThroughputMetricsRecordV1 | null;
    nowMs: number;
  },
  progress: ThroughputWatchdogResultV1,
): Promise<void> {
  const thresholds = deps.thresholds ?? THROUGHPUT_WATCHDOG_THRESHOLDS;
  const read = await deps.metrics.read();
  if (!read.ok) {
    progress.status = "metrics_unavailable";
    progress.filed = 0;
    return;
  }
  const ledger = read.value.ledger;
  if (sameCycle(ledger.watchdog?.lastCycle ?? null, input.cycle)) {
    progress.status = "already_evaluated";
    progress.filed = 0;
    return;
  }
  const verdicts = evaluateThroughputWatchdogV1({
    records: input.record === null
      ? ledger.records
      : [...ledger.records, input.record],
    daily: ledger.daily,
    nowMs: input.nowMs,
  }, thresholds);
  progress.missed = verdicts.filter((v) =>
    v.verdict === "missed" && !v.informational
  ).map((v) => v.id);
  const listing = await deps.issues.listOpen();
  if (listing === null) {
    progress.status = "listing_unavailable";
    progress.filed = 0;
    return;
  }
  const plan = planThroughputWatchdogV1({
    verdicts,
    thresholds,
    state: ledger.watchdog ?? null,
    listing,
    cycle: input.cycle,
    nowMs: input.nowMs,
  });
  progress.createBlocked = plan.createBlocked;
  const state: ThroughputWatchdogStateV1 = structuredClone(plan.state);
  progress.filed = 0;
  for (const action of plan.actions) {
    if (action.kind === "edit") {
      if (await deps.issues.update(action.number, action)) {
        progress.edited++;
        state.thresholds[action.thresholdId].measuredMilli =
          action.measuredMilli;
      }
      continue;
    }
    // An unknown create outcome stays unrecorded: the next cycle's listing
    // finds a landed issue by its marker and adopts it.
    progress.filed = null;
    const number = await deps.issues.create(action);
    progress.filed = number === null ? 0 : 1;
    if (number === null) continue;
    progress.issue = number;
    state.thresholds[action.thresholdId] = {
      issue: number,
      measuredMilli: action.measuredMilli,
      filedAtMs: input.nowMs,
      closedAtMs: null,
    };
  }
  progress.status = "evaluated";
  // Only finalize writes this file; a lost race re-reads and keeps every
  // other surface file as read.
  let head = read.value.head;
  let base = ledger;
  for (let attempt = 0; attempt < 2; attempt++) {
    const written = await deps.metrics.write({
      expectedHead: head,
      ledger: { ...base, watchdog: state },
    });
    if (!written.ok) {
      progress.stateWrite = "unavailable";
      return;
    }
    if (written.value.status === "applied") {
      progress.stateWrite = "applied";
      return;
    }
    progress.stateWrite = written.value.status === "conflict"
      ? "conflict"
      : "unavailable";
    const again = await deps.metrics.read();
    if (!again.ok) return;
    head = again.value.head;
    base = again.value.ledger;
  }
}

/** Evaluate and file under one bound. Never throws. */
export async function runFinalizeThroughputWatchdogV1(
  deps: FinalizeThroughputWatchdogDepsV1,
  input: {
    cycle: ThroughputCycleIdV1;
    record: ThroughputMetricsRecordV1 | null;
    nowMs: number;
    enabled: boolean;
  },
): Promise<ThroughputWatchdogResultV1> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const progress: ThroughputWatchdogResultV1 = {
    status: "off",
    filed: null,
    edited: 0,
    stateWrite: null,
    createBlocked: null,
    missed: [],
    issue: null,
  };
  if (input.enabled) {
    const deadline = createDeadline(
      deps.budgetMs ?? FINALIZE_WATCHDOG_BUDGET_MS,
    );
    try {
      await deadline.race(settle(deps, input, progress));
    } catch {
      progress.status = deadline.fired() ? "timeout" : "failed";
    } finally {
      deadline.dispose();
    }
  }
  // A snapshot: a timed-out settle may still mutate `progress` later.
  const result = structuredClone(progress);
  log(JSON.stringify({
    kind: "sentinel_throughput_watchdog",
    runId: input.cycle.runId,
    attempt: input.cycle.attempt,
    status: result.status,
    filed: result.filed,
    edited: result.edited,
    issue: result.issue,
    stateWrite: result.stateWrite,
    createBlocked: result.createBlocked,
    missed: result.missed,
  }));
  return result;
}

/**
 * Finalize's metrics tail: the watchdog evaluates this cycle's exact record
 * (cut once from `facts`), then the record is appended carrying the
 * `watchdogIssuesFiled` count. Either part absent is skipped; neither throws.
 */
export async function runFinalizeMetricsTailV1(
  deps: {
    metrics?: FinalizeMetricsDepsV1;
    watchdog?: FinalizeThroughputWatchdogDepsV1;
    selfImprove: string | undefined;
  },
  facts: FinalizeMetricsFactsV1,
): Promise<{
  watchdog: ThroughputWatchdogResultV1 | null;
  metrics: ThroughputAppendResultV1 | null;
}> {
  let watchdog: ThroughputWatchdogResultV1 | null = null;
  if (deps.watchdog !== undefined) {
    let record: ThroughputMetricsRecordV1 | null = null;
    try {
      record = collectFinalizeMetricsV1(facts);
    } catch {
      record = null;
    }
    watchdog = await runFinalizeThroughputWatchdogV1(deps.watchdog, {
      cycle: facts.cycle,
      record,
      nowMs: facts.nowMs,
      enabled: selfImproveEnabled(deps.selfImprove),
    });
  }
  const metrics = deps.metrics === undefined
    ? null
    : await writeFinalizeThroughputMetricsV1(deps.metrics, {
      ...facts,
      watchdogIssuesFiled: watchdog?.filed ?? null,
    });
  return { watchdog, metrics };
}
