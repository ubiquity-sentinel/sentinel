/**
 * Repository repair cells' contribution to the cycle metrics record (#328):
 * no phase slot exists for them, so their job windows stay out of every
 * phase, while their pass counts join the serial pass's records counters.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ChildRuntimeSummaryV1,
  RunJobSummaryV1,
} from "../../src/host/run-summary.ts";
import { collectFinalizeMetricsV1 } from "../../src/host/throughput-metrics-finalize.ts";

const T = Date.UTC(2026, 10, 5, 12, 0, 0);
const HEAD = "a".repeat(40) as GitSha;

function summary(
  recordsRead: number,
  recordsStepped: number,
  recordsSkipped: number,
): ChildRuntimeSummaryV1 {
  return {
    launcherSha: HEAD,
    runtimeSha: HEAD,
    generation: 90,
    purpose: "ordinary",
    targets: [],
    admittedWorkCount: 0,
    modelStarts: 0,
    prsTouched: [],
    outcome: "healthy",
    reasonCode: "ok",
    repairPass: { recordsRead, recordsStepped, recordsSkipped },
  };
}

function job(
  name: string,
  startS: number,
  endS: number,
  child: ChildRuntimeSummaryV1 | null = null,
  conclusion = "success",
): RunJobSummaryV1 {
  return {
    name,
    conclusion,
    summary: child,
    startedAtMs: T + startS * 1000,
    completedAtMs: T + endS * 1000,
  };
}

Deno.test("metrics: repository cells add their stepped and skipped records, never a phase", () => {
  const record = collectFinalizeMetricsV1({
    cycle: { runId: 7, attempt: 1 },
    finalizeStartedAtMs: T + 300_000,
    nowMs: T + 301_000,
    jobs: [
      job("prepare", 0, 20),
      job("matrix_plan", 21, 40),
      job("repair", 41, 200, summary(30, 4, 10)),
      job("repair_cell (c1)", 41, 120, summary(12, 3, 9)),
      job("repair_cell (c2)", 41, 90, summary(8, 2, 6)),
      job("repair_cell (c3)", 41, 60, summary(99, 50, 50), "skipped"),
    ],
    runSummary: null,
  });
  assert.equal(record.counts.recordsStepped, 9);
  assert.equal(record.counts.recordsSkipped, 25);
  assert.equal(record.counts.recordsRead, 30);
  // The repair phase is the serial job alone; cells fill no phase slot.
  assert.equal(record.phaseMs.repair, 159_000);
  assert.equal(record.phaseMs.matrixCellTotal, null);
});
