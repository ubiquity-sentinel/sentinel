/**
 * Producer-pass settlement of LOST conflict-resolution cells
 * (`src/repair/conflict-lost-cell.ts`).
 *
 * The producer pass reaches its consumer only after the producer's native run
 * is confirmed completed (`confirmCompletedExecution`), and the transport then
 * authenticates the producer's plan and its run's complete artifact listing.
 * A planned cell that run uploaded no artifact for is omitted from the wave,
 * and the consumer reports it `missing` ("durable charge stays unreconciled").
 * For a marked conflict-resolution admission that is proof of loss: the run
 * that was the only producer of its artifact is complete and holds none. Such
 * a cell is settled here (charged `ambiguous`, record back to its pending
 * resolution); every other `missing` cell is left exactly as before.
 */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
} from "../src/contracts/matrix.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { MatrixIngestReportV1 } from "../src/host/matrix-ingest.ts";
import {
  lostCellLine,
  lostConflictCellBinding,
  settleLostConflictCell,
} from "../src/repair/conflict-lost-cell.ts";
import {
  createRunBounds,
  loadRepairContext,
  type RepairCycleDepsV1,
} from "../src/repair/loop.ts";

/** Cells the consumer reported `missing` that hold no result at all. */
export function missingCells(
  report: MatrixIngestReportV1,
  results: readonly MatrixCellResultV1[],
): Set<string> {
  return new Set(
    report.entries.filter((entry) =>
      entry.disposition === "missing" &&
      !results.some((result) => result.cellId === entry.cellId)
    ).map((entry) => entry.cellId),
  );
}

function heldBy(snapshot: RepairStateSnapshotV1, cell: MatrixCellPlanV1) {
  return {
    record: snapshot.work.find((row) => row.id === cell.taskId) ?? null,
    charge:
      snapshot.reservations.find((row) => row.id === cell.reservationId) ??
        null,
  };
}

/**
 * Settle every lost conflict cell among `ids` of the completed producer run
 * `runId`. Each cell's record and charge must still be exactly what they were
 * in `start` (the snapshot the pass's ingest proved), and its record must
 * hold the marked resolution bound to exactly this cell; a cell that is not
 * such a resolution is skipped (left `missing`, unchanged). Returns the
 * observability line of each settled cell, or `false` when the state or a
 * settlement was unavailable or a binding moved during the pass: the caller
 * defers like a consumer `state_error`.
 */
export async function settleLostCells(
  deps: RepairCycleDepsV1,
  cells: readonly MatrixCellPlanV1[],
  ids: ReadonlySet<string>,
  deadline: number,
  start: RepairStateSnapshotV1,
  runId: number,
): Promise<string[] | false> {
  const bounds = createRunBounds(deps, { deadline });
  const lines: string[] = [];
  for (const cell of cells.filter((row) => ids.has(row.cellId))) {
    const context = await loadRepairContext(deps, bounds);
    if (context === null) return false;
    const held = heldBy(context.snapshot, cell);
    if (
      canonicalStringify(held) !== canonicalStringify(heldBy(start, cell))
    ) return false;
    const record = held.record;
    if (
      record === null || record.intent?.requestId !== cell.reservationId ||
      record.intent.key !== cell.intentKey ||
      lostConflictCellBinding(context.snapshot, record) === null
    ) continue;
    const step = await settleLostConflictCell(deps, context, record, {
      runId,
    });
    if (
      step.kind !== "progress" || step.queueHold === true
    ) return false;
    lines.push(lostCellLine(record.id, cell.reservationId, { runId }));
  }
  return lines;
}
