/** Throughput watchdog test fixtures: strict cycle records. */
import { createMetricsCollectorV1 } from "../../src/contracts/throughput-metrics-collector.ts";
import type {
  PlannerRefusalReasonV1,
  ThroughputMetricsRecordV1,
} from "../../src/contracts/throughput-metrics.ts";

export const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
export const M = 60_000;
export const H = 60 * M;

export interface CycleFacts {
  runId: number;
  finishedAtMs: number;
  maintenanceMin?: number;
  repairMin?: number;
  bootstrapMin?: number;
  recordsRead?: number;
  cells?: number;
  ready?: number;
  refusal?: PlannerRefusalReasonV1;
  refresh?: number;
  ci?: number;
  merges?: number;
  notices?: number;
}

export function cycleRecord(facts: CycleFacts): ThroughputMetricsRecordV1 {
  const c = createMetricsCollectorV1();
  if (facts.maintenanceMin !== undefined) {
    c.addPhaseMs("maintenance", facts.maintenanceMin * M);
  }
  if (facts.repairMin !== undefined) {
    c.addPhaseMs("repair", facts.repairMin * M);
  }
  if (facts.bootstrapMin !== undefined) {
    c.addPhaseMs("bootstrap", facts.bootstrapMin * M);
  }
  const counts: Array<[Parameters<typeof c.addCount>[0], number | undefined]> =
    [
      ["recordsRead", facts.recordsRead],
      ["cellsPlanned", facts.cells],
      ["readyRecordsNotPlanned", facts.ready],
      ["refreshCommits", facts.refresh],
      ["targetCiRunsTriggered", facts.ci],
      ["mergesCompleted", facts.merges],
      ["ownerNoticesSent", facts.notices],
    ];
  for (const [key, value] of counts) {
    if (value !== undefined) c.addCount(key, value);
  }
  if (facts.refusal !== undefined) c.setPlannerRefusal(facts.refusal);
  return c.snapshot({
    cycle: { runId: facts.runId, attempt: 1 },
    startedAtMs: facts.finishedAtMs - 10 * M,
    finishedAtMs: facts.finishedAtMs,
  });
}

/** `n` cycles five minutes apart, the newest finishing at `NOW`. */
export function cycles(
  n: number,
  facts: (i: number) => Omit<CycleFacts, "runId" | "finishedAtMs">,
  endMs = NOW,
  stepMs = 5 * M,
  runIdBase = 1000,
): ThroughputMetricsRecordV1[] {
  return Array.from({ length: n }, (_, i) =>
    cycleRecord({
      runId: runIdBase + i,
      finishedAtMs: endMs - (n - 1 - i) * stepMs,
      ...facts(i),
    }));
}
