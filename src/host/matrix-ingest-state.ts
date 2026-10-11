/** Exact cell binding and trusted timeout settlement transitions. */
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
  MatrixPlanV1,
} from "../contracts/matrix.ts";
import {
  loadRepairContext,
  type RepairCycleDepsV1,
  type RunBoundsV1,
} from "../repair/loop.ts";
import type {
  AttemptFailureClassV1,
  AttemptStageV1,
} from "../contracts/attempt-memory.ts";
import {
  clearMatrixTimeouts,
  recordMatrixTimeout,
} from "../repair/transitions.ts";
import { sameRepository } from "./matrix-identity.ts";

export function resultMatchesCell(
  plan: MatrixPlanV1,
  cell: MatrixCellPlanV1,
  result: MatrixCellResultV1,
): boolean {
  return result.waveId === plan.waveId &&
    result.cellId === cell.cellId &&
    result.taskId === cell.taskId &&
    sameRepository(result.repository, cell.repository) &&
    result.run.runId === plan.run.runId &&
    result.run.runAttempt === plan.run.runAttempt &&
    result.run.launcherSha === plan.run.launcherSha &&
    result.runtimeSha === cell.runtimeSha &&
    result.generation === cell.generation &&
    result.reservationId === cell.reservationId &&
    result.intentKey === cell.intentKey &&
    result.requestDigest === cell.requestDigest;
}

/**
 * Record one host timeout for a cell's task: increment the consecutive-timeout
 * counter and clear the stale intent so the record becomes retry-eligible.
 * Returns the new timeout count, or null when state was unavailable.
 */
export async function recordCellTimeout(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
  taskId: string,
): Promise<number | null> {
  const context = await loadRepairContext(deps, bounds);
  if (context === null) return null;
  const record = context.snapshot.work.find((work) => work.id === taskId);
  if (record === undefined) return null;
  const timedOut = recordMatrixTimeout(record, deps.clock.now());
  const next = {
    ...context.snapshot,
    work: context.snapshot.work.map((work) =>
      work.id === timedOut.id ? timedOut : work
    ),
    sequence: context.snapshot.sequence + 1,
    updatedAt: deps.clock.now(),
  };
  const written = await deps.state.writeRepair(
    next,
    context.snapshot.stateHead,
  );
  if (!written.ok) return null;
  return timedOut.counters.timeouts ?? 1;
}

/**
 * Reset the consecutive-timeout counter after a cell's result was ingested
 * (the model ran to completion, breaking the timeout streak). No-op when the
 * record never timed out. Returns false only on state errors.
 */
export async function resetCellTimeouts(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
  taskId: string,
): Promise<boolean> {
  const context = await loadRepairContext(deps, bounds);
  if (context === null) return false;
  const record = context.snapshot.work.find((work) => work.id === taskId);
  if (record === undefined || record.counters.timeouts === undefined) {
    return true;
  }
  const cleared = clearMatrixTimeouts(record, deps.clock.now());
  const next = {
    ...context.snapshot,
    work: context.snapshot.work.map((work) =>
      work.id === cleared.id ? cleared : work
    ),
    sequence: context.snapshot.sequence + 1,
    updatedAt: deps.clock.now(),
  };
  const written = await deps.state.writeRepair(
    next,
    context.snapshot.stateHead,
  );
  return written.ok;
}

/**
 * Trusted stage/class classification for one non-completed cell result. The
 * ingester knows structured facts the detail string does not spell out:
 * `not_started` and the pre-start binding refusals prove the model never ran
 * (that is an infrastructure fact, never a tested code strategy), a `model run
 * failed (...)` result proves the run was invoked, and a `candidate bundle`
 * refusal proves a candidate existed but could not be carried. The detail
 * string itself is stored verbatim for diagnostics.
 */
export function settlementClassification(
  status: "failed" | "not_started",
  detail: string,
): { stage: AttemptStageV1; failureClass: AttemptFailureClassV1 } {
  if (status === "failed") {
    if (detail.startsWith("model run failed (")) {
      return { stage: "model", failureClass: "transient_infrastructure" };
    }
    if (detail.startsWith("candidate bundle ")) {
      return { stage: "candidate", failureClass: "transient_infrastructure" };
    }
  }
  // Pre-inference refusal (never started, or refused at a pre-start binding
  // check): only admission is proven, and the failure is infrastructure.
  return { stage: "reservation", failureClass: "transient_infrastructure" };
}

/**
 * Trusted, serialized, idempotent ingestion. Results are applied one cell at a
 * time against a FRESH authoritative context, so a successful sibling is never
 * rolled back and a restarted finalizer cannot double-apply. Conflicting
 * duplicate artifacts for one cell are rejected instead of picking the first;
 * identical reruns stay idempotent. A missing result records a host timeout
 * (incrementing the consecutive-timeout counter and clearing the stale intent
 * so the record becomes retry-eligible); repeated timeouts trigger
 * decomposition. A completed result whose receipt does not re-verify against
 * the exact planned request causes NO state update.
 */
