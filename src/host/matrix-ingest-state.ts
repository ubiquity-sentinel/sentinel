/** Exact cell binding and trusted timeout settlement transitions. */
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
  MatrixPlanV1,
} from "../contracts/matrix.ts";
import { matrixDigestV1 } from "../contracts/matrix.ts";
import {
  loadRepairContext,
  type RepairCycleDepsV1,
  type RunBoundsV1,
} from "../repair/loop.ts";
import type {
  AttemptFailureClassV1,
  AttemptStageV1,
} from "../contracts/attempt-memory.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  conflictMarkerBase,
  resolvedConflictResolution,
} from "../repair/conflict-resolution.ts";
import { clearMatrixTimeouts } from "../repair/transitions.ts";
import {
  baseRefreshIntentKey,
  implementationIntentKey,
} from "../repair/keys.ts";
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
 * The resolved conflict intent a consumed conflict-resolution receipt of this
 * cell wrote (`handleConflictResolutionReceipt`): the marked refresh intent of
 * the record's own (PR, H) and the cell's merge base B, whose result is the
 * receipt's merge head. It carries no request id, so the cell's merge request
 * (H, B) and the receipt head bind it instead.
 */
function resolvedConflictOfCell(
  record: WorkRecordV1,
  cell: MatrixCellPlanV1,
  receiptHead: GitSha | null,
): boolean {
  const intent = record.intent;
  const { checkoutBase, mergeBase } = cell.request;
  const { head, pr, branch } = record.target;
  return receiptHead !== null && intent !== null &&
    mergeBase !== undefined && head !== null && pr !== null &&
    checkoutBase === head && intent.requestId === null &&
    resolvedConflictResolution(intent) === receiptHead &&
    conflictMarkerBase(intent) === mergeBase &&
    intent.expectedHead === head && intent.pr === pr &&
    intent.branch === branch &&
    intent.key === baseRefreshIntentKey(pr, head, mergeBase);
}

/**
 * Reset only the exact settled admission's timeout streak. Missing artifacts
 * never enter this path. Candidate/implementation intents and charged history
 * remain untouched; an unbound, conflicted or unreadable result is false. A
 * consumed conflict-resolution receipt leaves the resolved refresh intent of
 * its merge instead of an implementation intent; it is bound through the
 * cell's merge request and `receiptHead`, the head of the consumed receipt.
 */
export async function resetCellTimeouts(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
  cell: MatrixCellPlanV1,
  receiptHead: GitSha | null = null,
): Promise<boolean> {
  const context = await loadRepairContext(deps, bounds);
  if (context === null) return false;
  const record = context.snapshot.work.find((work) => work.id === cell.taskId);
  const reservation = context.snapshot.reservations.find((row) =>
    row.id === cell.reservationId
  );
  if (
    record === undefined || reservation === undefined ||
    !sameRepository(record.repository, cell.repository) ||
    !sameRepository(reservation.repository, cell.repository) ||
    record.source.kind !== "issue" ||
    record.related.issueNumber !== cell.request.issue?.number ||
    record.target.base !== cell.expectedBase ||
    reservation.taskId !== cell.taskId ||
    reservation.head !== cell.expectedBase ||
    reservation.attempt !== record.counters.attempts ||
    (reservation.purpose !== "implementation" &&
      reservation.purpose !== "retry") ||
    (reservation.outcome !== "submitted" &&
      reservation.outcome !== "ambiguous") ||
    reservation.settledAt === null ||
    cell.intentKey !== implementationIntentKey(cell.reservationId) ||
    cell.request.taskId !== cell.taskId ||
    cell.request.base !== cell.expectedBase ||
    !sameRepository(cell.request.repository, cell.repository) ||
    await matrixDigestV1(cell.request) !== cell.requestDigest ||
    (record.intent !== null &&
      (record.intent.requestId !== cell.reservationId ||
        record.intent.key !== cell.intentKey ||
        (record.intent.kind !== "implementation" &&
          record.intent.kind !== "candidate_preservation")) &&
      (reservation.outcome !== "submitted" ||
        !resolvedConflictOfCell(record, cell, receiptHead))) ||
    (reservation.outcome === "submitted" &&
      (record.target.head === null ||
        record.target.candidateState === undefined))
  ) return false;
  if (record.counters.timeouts === undefined) return true;
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < context.snapshot.updatedAt) {
    return false;
  }
  const cleared = clearMatrixTimeouts(record, now);
  const next = {
    ...context.snapshot,
    stateHead: context.head,
    work: context.snapshot.work.map((work) =>
      work.id === cleared.id ? cleared : work
    ),
    sequence: context.snapshot.sequence + 1,
    updatedAt: now,
  };
  const written = await deps.state.writeRepair(
    next,
    context.head,
  );
  if (!written.ok || written.value.status !== "applied") return false;
  const verified = await deps.state.readRepair();
  if (
    !verified.ok || verified.value.status !== "found" ||
    verified.value.head !== written.value.head
  ) return false;
  const verifiedWork = verified.value.snapshot.work.find((work) =>
    work.id === cell.taskId
  );
  const verifiedReservation = verified.value.snapshot.reservations.find((row) =>
    row.id === cell.reservationId
  );
  return verifiedWork !== undefined && verifiedReservation !== undefined &&
    canonicalStringify(verifiedWork) === canonicalStringify(cleared) &&
    canonicalStringify(verifiedReservation) === canonicalStringify(reservation);
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
 * identical reruns stay idempotent. A missing result changes no state and
 * preserves its charged admission. A completed result that does not verify against
 * the exact planned request causes NO state update.
 */
