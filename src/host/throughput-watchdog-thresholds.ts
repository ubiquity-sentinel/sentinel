/**
 * The throughput watchdog's threshold table (#340 children). This is the one
 * place the owner edits a limit, a window or the investigation guidance; the
 * pure evaluator (`throughput-watchdog.ts`), the finalize filer and
 * `sentinel report`'s Thresholds table all read it, so they always agree.
 *
 * Every limit is "measured <= limit". An informational threshold is shown
 * but never filed.
 */
import type {
  ThroughputPhaseV1,
  ThroughputRequiredCounterV1,
} from "../contracts/throughput-metrics.ts";

export type ThroughputThresholdMetricV1 =
  | {
    /** Median of the per-cycle sum of the phases (all must be recorded). */
    kind: "phase_median";
    phases: readonly ThroughputPhaseV1[];
    /** Latest eligible cycles evaluated. */
    windowCycles: number;
    /** Fewer eligible cycles is insufficient data. */
    minCycles: number;
    /** A cycle is eligible only when `recordsRead` is at least this. */
    minRecordsRead?: number;
  }
  | {
    /**
     * Cycles where the planner had ready work (`readyRecordsNotPlanned +
     * cellsPlanned > 0`), did not refuse, and still planned no cell.
     */
    kind: "cells_planned";
    windowCycles: number;
    minCycles: number;
  }
  | {
    /** Sum of `numerator` / sum of `denominator` over the latest days. */
    kind: "weekly_ratio";
    numerator: ThroughputRequiredCounterV1;
    denominator: ThroughputRequiredCounterV1;
    windowDays: number;
    /** Distinct UTC days with data required. */
    minDays: number;
    minCycles: number;
  }
  | {
    /** Sum of `ownerNoticesSent` over the latest cycles. */
    kind: "notice_count";
    windowCycles: number;
    minCycles: number;
  };

export type ThroughputThresholdUnitV1 = "min" | "cycles" | "ratio" | "notices";

export interface ThroughputThresholdV1 {
  /** Stable id: issue marker key and watchdog state key. */
  id: string;
  /** Short human name used in the issue title and the report. */
  name: string;
  /** The #340 child issue the threshold derives from. */
  childIssue: number;
  unit: ThroughputThresholdUnitV1;
  /** Met when measured <= limit (in `unit`). */
  limit: number;
  metric: ThroughputThresholdMetricV1;
  /** Exact metric fields of `ThroughputMetricsRecordV1` it reads. */
  fields: readonly string[];
  /** Shown, never filed. */
  informational?: boolean;
  /** "What to investigate" lines for the implementer (files, causes). */
  investigate: readonly string[];
}

export const THROUGHPUT_WATCHDOG_THRESHOLDS: readonly ThroughputThresholdV1[] =
  [
    {
      id: "maintenance_repair_median",
      name: "maintenance+repair phase median",
      childIssue: 324,
      unit: "min",
      limit: 8,
      metric: {
        kind: "phase_median",
        phases: ["maintenance", "repair"],
        windowCycles: 30,
        minCycles: 10,
      },
      fields: ["phaseMs.maintenance", "phaseMs.repair"],
      investigate: [
        "Maintenance job wall time: `ops/hosted-autonomy-maintenance.ts` and the passes it runs (`ops/hosted-autonomy-delivery-pass.ts`, `ops/hosted-autonomy-closure-pass.ts`, `ops/hosted-autonomy-follow-up-pass.ts`, the repair tier step `ops/hosted-autonomy-repair-tier.ts` / `src/host/repair-tier-maintenance.ts`). Look for passes that read every record or every PR each cycle.",
        "Repair job wall time: `src/host/hosted-runtime-launcher.ts` and the step loop (`src/repair/loop*.ts`, `src/repair/repository-pass.ts`). Compare `recordsRead` with `recordsStepped`/`recordsSkipped`: a hot tier that is not shrinking (`recordsDemoted` stays 0) keeps every pass long (#324).",
        "Likely causes: hot repair state not demoted to `repair-archive/`, per-record GitHub reads instead of the batched `readLiveInputs` (`src/repair/loop-live-inputs.ts`), or unchanged records stepped instead of skipped by `stepInputs` (`src/repair/step-inputs.ts`).",
      ],
    },
    {
      id: "repair_median",
      name: "repair phase median at >= 60 live records",
      childIssue: 326,
      unit: "min",
      limit: 5,
      metric: {
        kind: "phase_median",
        phases: ["repair"],
        windowCycles: 30,
        minCycles: 10,
        minRecordsRead: 60,
      },
      fields: ["phaseMs.repair", "counts.recordsRead"],
      investigate: [
        "Batched live reads: `src/repair/loop-live-inputs.ts` and `readLiveInputs` in `src/github/client.ts`; a failed batch falls back to per-record reads, which dominates the phase at 60+ records.",
        "Changed-input stepping: `src/repair/step-inputs.ts` and `src/repair/loop-input-gate.ts`. If `recordsSkipped` is low relative to `recordsRead`, the fingerprint is changing every pass (an input that should not be in the digest, or a deadline that is too short).",
        "Check the `sentinel_repair_pass` log line's skip reasons in the repair job and the per-repository cells (`src/repair/repair-fanout-plan.ts`).",
      ],
    },
    {
      id: "bootstrap_median",
      name: "bootstrap duration median",
      childIssue: 336,
      unit: "min",
      limit: 5,
      metric: {
        kind: "phase_median",
        phases: ["bootstrap"],
        windowCycles: 3,
        minCycles: 3,
      },
      fields: ["phaseMs.bootstrap"],
      investigate: [
        "The bootstrap health pass `src/host/bootstrap-health-pass.ts` and `src/host/hosted-runtime-bootstrap.ts` must only read release state, pins, custody and contract versions and write the healthy proof (#336). Anything that steps records, polls or composes belongs in the next ordinary pass.",
        "The launcher's `bootstrapDurationMs` (`src/host/hosted-runtime-launcher.ts`) is the measured value; compare it with the repair job window to separate setup time from the pass itself.",
      ],
    },
    {
      id: "cells_planned",
      name: "cells planned when ready work exists",
      childIssue: 335,
      unit: "cycles",
      limit: 0,
      metric: { kind: "cells_planned", windowCycles: 30, minCycles: 10 },
      fields: [
        "counts.cellsPlanned",
        "counts.readyRecordsNotPlanned",
        "plannerRefusal",
      ],
      investigate: [
        "A cycle with ready records, no planner refusal and zero matrix cells means the planner dropped work silently (#324/#335). Start at `src/host/matrix-planner.ts`, `src/host/matrix.ts` (`planMatrixWave`) and the refusal classifier `src/host/matrix-plan-refusal.ts`.",
        "Every path that plans nothing must set a closed `plannerRefusal` reason (`src/host/matrix-plan-diagnostic.ts`); a missing reason is itself the defect to fix.",
        "Check `readyRecordsNotPlanned` against the wait causes (`waitCauses`) of the same cycles for a budget or reservation that is denied without being reported.",
      ],
    },
    {
      id: "refresh_per_merge",
      name: "refresh commits per merge",
      childIssue: 329,
      unit: "ratio",
      limit: 1,
      metric: {
        kind: "weekly_ratio",
        numerator: "refreshCommits",
        denominator: "mergesCompleted",
        windowDays: 7,
        minDays: 7,
        minCycles: 10,
      },
      fields: ["counts.refreshCommits", "counts.mergesCompleted"],
      investigate: [
        "Just-in-time refresh (#329): a reviewed head keeps its reviewed base until it is next to land. See `src/repair/delivery-queue.ts`, `src/repair/loop-carried-delivery.ts` (`CARRIED_REFRESH_LIMIT`) and `ops/hosted-autonomy-base-refresh-retries.ts` / `ops/hosted-autonomy-refresh-rearm.ts`.",
        "More than one refresh per merge means siblings behind the head of line are still refreshing, or a refreshed head loses its review and is refreshed again.",
      ],
    },
    {
      id: "ci_runs_per_merge",
      name: "target CI runs per merge",
      childIssue: 330,
      unit: "ratio",
      limit: 3,
      metric: {
        kind: "weekly_ratio",
        numerator: "targetCiRunsTriggered",
        denominator: "mergesCompleted",
        windowDays: 7,
        minDays: 7,
        minCycles: 10,
      },
      fields: ["counts.targetCiRunsTriggered", "counts.mergesCompleted"],
      investigate: [
        "Delivery trains (#330): ready reviewed records of one repository should land as one validated train with one CI run. See `ops/hosted-autonomy-delivery-train.ts`, `ops/hosted-autonomy-train-git.ts` and `src/contracts/delivery-train-ledger.ts`.",
        "Many CI runs per merge suggest trains of one member, repeated red-train retries, or refreshes that re-trigger CI (`src/host/delivery-counts-output.ts` carries the counts).",
      ],
    },
    {
      id: "owner_notice_count",
      name: "owner notices sent",
      childIssue: 327,
      unit: "notices",
      limit: 0,
      informational: true,
      metric: { kind: "notice_count", windowCycles: 30, minCycles: 10 },
      fields: ["counts.ownerNoticesSent"],
      investigate: [
        "Upkeep deferral streak notices (#327): `src/contracts/upkeep-deferral-streak.ts` and `src/host/upkeep-deferral-finalize.ts`.",
      ],
    },
  ];
