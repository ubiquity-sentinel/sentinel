/**
 * The maintenance pass's bounded hot/cold repair-tier step (#324).
 *
 * Runs after the matrix maintenance pre-passes (so every dedicated matrix
 * reservation is known) and before the ordinary phases and the later repair
 * job's intake. Protected from demotion: queue custody records, closed-wave
 * cell tasks and every reservation a dedicated matrix recovery owns. The
 * step never fails the pass; one closed-vocabulary JSON line carries its
 * counts for the throughput metrics collector.
 */

import { CLOSED_C_WAVE } from "../src/host/modern-matrix-recovery.ts";
import {
  type RepairTierMaintenanceResultV1,
  runRepairTierMaintenance,
} from "../src/host/repair-tier-maintenance.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  HOSTED_AUTONOMY_PASS_DEADLINE_MS,
  HOSTED_AUTONOMY_PHASE_RESERVE_MS,
} from "./hosted-autonomy-continuation.ts";
import { dedicatedMatrixReservations } from "./hosted-autonomy-current-recovery.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";

/**
 * Rows one pass may demote. A full 731-record surface (about 3,200 cold
 * rows) drains in a handful of passes while each tier write stays a small
 * bounded tree move.
 */
export const HOSTED_REPAIR_TIER_BUDGET = 1_200;

/** The single summary line kind the metrics collector reads. */
export const REPAIR_TIER_SUMMARY_KIND = "sentinel_repair_tier";

export interface HostedRepairTierStepV1 {
  /** An applied tier write, absorbed into the pass like any other write. */
  write: HostedAutonomyResultV1 | null;
  /** The hot snapshot the write started from (the pass baseline). */
  before: RepairStateSnapshotV1 | null;
  outcome: RepairTierMaintenanceResultV1 | null;
}

export async function runHostedRepairTierStep(
  deps: HostedAutonomyDepsV1,
  startedAt: number,
  actions: string[],
  dedicated: ReadonlySet<string>,
): Promise<HostedRepairTierStepV1> {
  const tiers = deps.repairTiers;
  if (tiers === undefined) return { write: null, before: null, outcome: null };
  const reservationIds = new Set<string>([
    ...dedicated,
    ...dedicatedMatrixReservations(deps, CLOSED_C_WAVE),
  ]);
  const closedWaveTasks = CLOSED_C_WAVE.cells.map((cell) =>
    String(cell.taskId)
  );
  const outcome = await runRepairTierMaintenance({
    store: {
      readRepair: () => deps.state.readRepair(),
      tierRepair: (input) => tiers.store.tierRepair(input),
    },
    listOpenIssueNumbers: (repository) =>
      tiers.listOpenIssueNumbers(repository),
    clock: deps.clock,
    // The same point after which no continued phase may start.
    deadlineAt: startedAt + HOSTED_AUTONOMY_PASS_DEADLINE_MS -
      HOSTED_AUTONOMY_PHASE_RESERVE_MS,
    protect: (snapshot) => ({
      workIds: new Set([
        ...closedWaveTasks,
        ...snapshot.work.filter((row) =>
          queueRecordProtected(row, deps.queueCustody)
        ).map((row) => row.id),
      ]),
      reservationIds,
    }),
    demotionBudget: tiers.demotionBudget ?? HOSTED_REPAIR_TIER_BUDGET,
  });
  actions.push(outcome.action);
  console.log(JSON.stringify({
    kind: REPAIR_TIER_SUMMARY_KIND,
    version: "v1",
    status: outcome.status,
    reason: outcome.reason,
    recordsRead: outcome.recordsRead,
    demoted: outcome.demoted,
    promoted: outcome.promoted,
    deferred: outcome.deferred,
  }));
  if (
    outcome.status !== "applied" || outcome.beforeHead === null ||
    outcome.appliedHead === null
  ) {
    return { write: null, before: null, outcome };
  }
  return {
    write: {
      kind: "hosted_autonomy",
      status: "applied",
      reason: "applied",
      beforeHead: outcome.beforeHead,
      appliedHead: outcome.appliedHead,
      actions,
      revisions: [],
    },
    before: outcome.before,
    outcome,
  };
}
