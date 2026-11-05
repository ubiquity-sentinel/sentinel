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
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { waitCauseKeyV1 } from "../contracts/work-wait-cause.ts";
import { createDeadline } from "../github/http.ts";
import {
  appendThroughputMetricsV1,
  type ThroughputAppendResultV1,
  type ThroughputMetricsPortV1,
} from "../state/throughput-metrics-store.ts";
import type {
  HostedRuntimeRunSummaryV1,
  RepairPassCountsV1,
  RunJobSummaryV1,
} from "./run-summary.ts";
import type { DeliveryCountsV1 } from "./delivery-counts-output.ts";
import type { TierCountsV1 } from "./tier-counts-output.ts";

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
  /**
   * The maintenance delivery pass's train, CI-run and merge counts (#330),
   * from its step output; null/absent when unobserved.
   */
  deliveryCounts?: DeliveryCountsV1 | null;
  /**
   * The maintenance repair-tier step's counts (#324), from its step output;
   * null/absent when unobserved.
   */
  tierCounts?: TierCountsV1 | null;
  /**
   * The repair state the run summary's advisory read returned (#335), or
   * null/absent when it was not read; feeds the wait-cause histogram.
   */
  repair?: RepairStateSnapshotV1 | null;
}

/** Records waiting in `backoff`/`unavailable`, by cause key (#335). */
function collectWaitCauses(
  collector: MetricsCollectorV1,
  repair: RepairStateSnapshotV1,
): void {
  // An observed state with no such wait is an empty histogram, not null.
  collector.addWaitCause("legacy:none:backoff", 0);
  for (const record of repair.work) {
    const wait = record.wait;
    if (wait === null) continue;
    if (wait.reason !== "backoff" && wait.reason !== "unavailable") continue;
    collector.addWaitCause(
      wait.cause === undefined
        ? `legacy:none:${wait.reason}`
        : waitCauseKeyV1(wait.cause),
    );
  }
}

/**
 * Records read/stepped/skipped and the tier moves (#324, #326). Maintenance's
 * tier step and the repair pass each read the hot records; when both report
 * a read the record carries the larger one (never their sum).
 */
function collectRecordCounts(
  collector: MetricsCollectorV1,
  tier: TierCountsV1 | null,
  pass: RepairPassCountsV1 | null,
): void {
  const reads = [tier?.recordsRead, pass?.recordsRead].filter((
    value,
  ): value is number => value !== undefined);
  if (reads.length > 0) collector.addCount("recordsRead", Math.max(...reads));
  if (pass !== null) {
    collector.addCount("recordsStepped", pass.recordsStepped);
    collector.addCount("recordsSkipped", pass.recordsSkipped);
  }
  if (tier === null) return;
  collector.addCount("recordsDemoted", tier.demoted);
  collector.addCount("recordsPromoted", tier.promoted);
  if (tier.releaseRequestsMovedToCold !== null) {
    collector.addCount(
      "releaseRequestsMovedToCold",
      tier.releaseRequestsMovedToCold,
    );
  }
  if (tier.releaseRequestsSuperseded !== null) {
    collector.addCount(
      "releaseRequestsSuperseded",
      tier.releaseRequestsSuperseded,
    );
  }
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
  const repairJob = jobs.find((job) => job.name === "repair" && ran(job));
  // #336: the launcher's own child duration beats the job window.
  const bootstrapMs = bootstrap
    ? repairJob?.summary?.bootstrapDurationMs ?? null
    : null;
  if (bootstrapMs !== null) collector.addPhaseMs("bootstrap", bootstrapMs);
  for (const job of jobs) {
    const phase = phaseOf(job.name);
    const start = job.startedAtMs ?? null;
    const end = job.completedAtMs ?? null;
    if (phase === null || !ran(job) || start === null || end === null) {
      continue;
    }
    if (end < start) continue;
    if (bootstrap && phase === "repair") {
      if (bootstrapMs === null) collector.addPhaseMs("bootstrap", end - start);
      continue;
    }
    collector.addPhaseMs(phase, end - start);
  }
  collectRecordCounts(
    collector,
    facts.tierCounts ?? null,
    repairJob?.summary?.repairPass ?? null,
  );
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
  const delivery = facts.deliveryCounts ?? null;
  if (delivery !== null) {
    collector.addCount("trainsBuilt", delivery.trainsBuilt);
    collector.addCount("targetCiRunsTriggered", delivery.targetCiRunsTriggered);
    collector.addCount("mergesCompleted", delivery.mergesCompleted);
  }
  if (facts.ownerNoticesSent !== undefined && facts.ownerNoticesSent > 0) {
    collector.addCount("ownerNoticesSent", facts.ownerNoticesSent);
  }
  // The planner's refusal reason and ready-unplanned count (#335), from the
  // matrix_plan job's launcher-re-emitted plan diagnostic.
  const refusal = plan?.conclusion === "success"
    ? plan.summary?.plannerRefusal
    : undefined;
  if (refusal !== undefined) {
    collector.setPlannerRefusal(refusal.reason);
    if (refusal.readyUnplanned !== null) {
      collector.addCount("readyRecordsNotPlanned", refusal.readyUnplanned);
    }
  }
  if (facts.repair !== undefined && facts.repair !== null) {
    collectWaitCauses(collector, facts.repair);
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
