/**
 * MetricsCollectorV1: the in-process accumulator phases fill during one
 * supervisor cycle (#338). Finalize turns it into exactly one
 * ThroughputMetricsRecordV1 through `snapshot`.
 *
 * Every field starts `null` (unobserved). `addCount`/`addPhaseMs` turn a
 * `null` into the first observed value and add to it afterwards, so a phase
 * that runs several times (matrix cells) accumulates and a phase that never
 * reports stays `null`, never zero. Inputs are validated eagerly: a negative,
 * fractional or unsafe value throws, so a caller bug cannot persist.
 */

import {
  addWaitCauseCountV1,
  isThroughputWaitCauseKeyV1,
  parseThroughputMetricsRecordV1,
  PLANNER_REFUSAL_REASONS_V1,
  type PlannerRefusalReasonV1,
  THROUGHPUT_COUNTERS_V1,
  THROUGHPUT_OPTIONAL_COUNTERS_V1,
  THROUGHPUT_PHASES_V1,
  type ThroughputCounterV1,
  type ThroughputCountsV1,
  type ThroughputCycleIdV1,
  type ThroughputMetricsRecordV1,
  type ThroughputPhaseV1,
} from "./throughput-metrics.ts";

export interface MetricsCollectorV1 {
  /** Add milliseconds to a phase (first call replaces the `null`). */
  addPhaseMs(phase: ThroughputPhaseV1, ms: number): void;
  /** Add to a counter (first call replaces the `null`); `0` records "observed none". */
  addCount(counter: ThroughputCounterV1, n: number): void;
  /** Record the planner's refusal reason; the last call wins. */
  setPlannerRefusal(reason: PlannerRefusalReasonV1 | null): void;
  /**
   * Count one waiting record under its `port:status:code` key (#335); the
   * first call turns `waitCauses` from `null` into a histogram. Keys past the
   * bound fold into `other:none:other`.
   */
  addWaitCause(key: string, n?: number): void;
  /** The strict record for one cycle; throws if the facts are invalid. */
  snapshot(input: {
    cycle: ThroughputCycleIdV1;
    startedAtMs: number;
    finishedAtMs: number;
  }): ThroughputMetricsRecordV1;
}

function nonnegative(value: number, what: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${what} must be a nonnegative safe integer`);
  }
  return value;
}

export function createMetricsCollectorV1(): MetricsCollectorV1 {
  const phaseMs = Object.fromEntries(
    THROUGHPUT_PHASES_V1.map((key) => [key, null]),
  ) as Record<ThroughputPhaseV1, number | null>;
  const counts = Object.fromEntries(
    THROUGHPUT_COUNTERS_V1.map((key) => [key, null]),
  ) as unknown as ThroughputCountsV1;
  let plannerRefusal: PlannerRefusalReasonV1 | null = null;
  let waitCauses: Record<string, number> | null = null;
  return {
    addPhaseMs(phase, ms) {
      if (!THROUGHPUT_PHASES_V1.includes(phase)) {
        throw new Error("unknown metrics phase");
      }
      phaseMs[phase] = nonnegative(
        (phaseMs[phase] ?? 0) + nonnegative(ms, "phase duration"),
        "phase duration",
      );
    },
    addCount(counter, n) {
      if (
        !(THROUGHPUT_COUNTERS_V1 as readonly string[]).includes(counter) &&
        !(THROUGHPUT_OPTIONAL_COUNTERS_V1 as readonly string[]).includes(
          counter,
        )
      ) {
        throw new Error("unknown metrics counter");
      }
      // An optional counter appears in the record only once observed.
      counts[counter] = nonnegative(
        (counts[counter] ?? 0) + nonnegative(n, "metrics count"),
        "metrics count",
      );
    },
    setPlannerRefusal(reason) {
      if (reason !== null && !PLANNER_REFUSAL_REASONS_V1.includes(reason)) {
        throw new Error("unknown planner refusal reason");
      }
      plannerRefusal = reason;
    },
    addWaitCause(key, n = 1) {
      nonnegative(n, "wait cause count");
      if (!isThroughputWaitCauseKeyV1(key)) {
        throw new Error("invalid wait cause key");
      }
      // One slot stays reserved for the fold key, so at most the bound.
      addWaitCauseCountV1(waitCauses ??= {}, key, n);
    },
    snapshot({ cycle, startedAtMs, finishedAtMs }) {
      return parseThroughputMetricsRecordV1({
        version: "v1",
        kind: "throughput_metrics",
        cycle: { runId: cycle.runId, attempt: cycle.attempt },
        startedAtMs,
        finishedAtMs,
        phaseMs: { ...phaseMs },
        counts: { ...counts },
        plannerRefusal,
        waitCauses: waitCauses === null ? null : { ...waitCauses },
      });
    },
  };
}
