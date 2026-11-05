/**
 * Finalize's one throughput metrics record per supervisor cycle (#338).
 *
 * Built only from facts finalize already holds: the run attempt's completed
 * job list (names, conclusions, jobs-API windows) and the aggregated run
 * summary it just printed. Anything finalize cannot observe stays `null`.
 * Other phases will later fill the same `MetricsCollectorV1`.
 *
 * Advisory: the write is bounded, never throws and never changes the
 * finalize outcome; the log line carries only a closed status.
 */
import {
  createMetricsCollectorV1,
  type MetricsCollectorV1,
} from "../contracts/throughput-metrics-collector.ts";
import type {
  ThroughputCycleIdV1,
  ThroughputMetricsRecordV1,
  ThroughputPhaseV1,
} from "../contracts/throughput-metrics.ts";
import { createDeadline } from "../github/http.ts";
import {
  appendThroughputMetricsV1,
  type ThroughputAppendResultV1,
  type ThroughputMetricsPortV1,
} from "../state/throughput-metrics-store.ts";
import type {
  HostedRuntimeRunSummaryV1,
  RunJobSummaryV1,
} from "./run-summary.ts";

/** Bound of the whole advisory metrics read/append/write. */
export const FINALIZE_METRICS_BUDGET_MS = 60_000;

export interface FinalizeMetricsFactsV1 {
  cycle: ThroughputCycleIdV1;
  /** When this finalize host began its trusted work. */
  finalizeStartedAtMs: number;
  /** The instant the record is cut. */
  nowMs: number;
  /** The run attempt's completed jobs, or null when unreadable. */
  jobs: readonly RunJobSummaryV1[] | null;
  /** The aggregated run summary finalize printed, or null. */
  runSummary: HostedRuntimeRunSummaryV1 | null;
  /** Owner notices this finalize claimed and published (#327). */
  ownerNoticesSent?: number;
}

function phaseOf(name: string): ThroughputPhaseV1 | null {
  if (name === "maintenance") return "maintenance";
  if (name === "prepare") return "prepare";
  if (name === "matrix_plan") return "matrixPlan";
  if (name === "matrix_cell" || name.startsWith("matrix_cell (")) {
    return "matrixCellTotal";
  }
  if (name === "repair") return "repair";
  return null;
}

const ran = (job: RunJobSummaryV1) =>
  job.conclusion !== null && job.conclusion !== "skipped";

/** Fill the collector from finalize's facts and cut the strict record. */
export function collectFinalizeMetricsV1(
  facts: FinalizeMetricsFactsV1,
  collector: MetricsCollectorV1 = createMetricsCollectorV1(),
): ThroughputMetricsRecordV1 {
  const jobs = facts.jobs ?? [];
  // A bootstrap execution runs in the repair job's slot (model-disabled).
  const bootstrap = facts.runSummary?.purpose === "bootstrap";
  for (const job of jobs) {
    const phase = phaseOf(job.name);
    const start = job.startedAtMs ?? null;
    const end = job.completedAtMs ?? null;
    if (phase === null || !ran(job) || start === null || end === null) {
      continue;
    }
    if (end < start) continue;
    collector.addPhaseMs(
      bootstrap && phase === "repair" ? "bootstrap" : phase,
      end - start,
    );
  }
  collector.addPhaseMs(
    "finalize",
    Math.max(0, facts.nowMs - facts.finalizeStartedAtMs),
  );
  const plan = jobs.find((job) => job.name === "matrix_plan");
  if (plan?.conclusion === "success") {
    collector.addCount(
      "cellsPlanned",
      jobs.filter((job) => phaseOf(job.name) === "matrixCellTotal" && ran(job))
        .length,
    );
  }
  if (facts.ownerNoticesSent !== undefined && facts.ownerNoticesSent > 0) {
    collector.addCount("ownerNoticesSent", facts.ownerNoticesSent);
  }
  const modelStarts = facts.runSummary?.modelStarts ?? null;
  if (modelStarts !== null) collector.addCount("modelStarts", modelStarts);
  const starts = jobs.flatMap((job) =>
    job.startedAtMs === null || job.startedAtMs === undefined
      ? []
      : [job.startedAtMs]
  );
  const startedAtMs = Math.min(facts.finalizeStartedAtMs, ...starts);
  return collector.snapshot({
    cycle: facts.cycle,
    startedAtMs,
    finishedAtMs: Math.max(startedAtMs, facts.nowMs),
  });
}

export interface FinalizeMetricsDepsV1 {
  port: ThroughputMetricsPortV1;
  log?: (line: string) => void;
}

/** Cut and append the cycle record under one bounded deadline. Never throws. */
export async function writeFinalizeThroughputMetricsV1(
  deps: FinalizeMetricsDepsV1,
  facts: FinalizeMetricsFactsV1,
): Promise<ThroughputAppendResultV1> {
  const log = deps.log ?? ((line: string) => console.log(line));
  let result: ThroughputAppendResultV1;
  const deadline = createDeadline(FINALIZE_METRICS_BUDGET_MS);
  try {
    const record = collectFinalizeMetricsV1(facts);
    result = await deadline.race(appendThroughputMetricsV1(deps.port, record));
  } catch {
    result = { status: "unavailable", detail: "invalid" };
  } finally {
    deadline.dispose();
  }
  log(JSON.stringify({
    kind: "throughput_metrics_write",
    runId: facts.cycle.runId,
    attempt: facts.cycle.attempt,
    status: result.status,
  }));
  return result;
}
