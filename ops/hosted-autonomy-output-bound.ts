/**
 * Historical finite-bound plans (including R80) still need this settlement.
 * Newly planned R81 sessions use Number.MAX_SAFE_INTEGER and cannot reach
 * their volume ceiling during the duration bound. Never compare an older
 * receipt against that new policy: the authenticated plan owns its bound.
 *
 * The one matrix receipt refusal with a closed settlement: an authenticated
 * runtime terminal that completed only AFTER crossing its output bound. The
 * model port counts output first and requests the `output_limit` interrupt,
 * but the runtime's completed terminal can still land inside the interrupt
 * settlement grace; the port then returns a `completed` receipt with a
 * candidate and `outputChars > maxOutputChars` (live: ai.ubq.fi 1127,
 * producer 38980356652, 4005441 > 4000000 chars).
 *
 * `verifyMatrixReceiptV1` refuses it (`receipt_rejected`, nothing written),
 * and no consumer can ever verify it, so left as is it fails every later
 * maintenance pass on the same producer. It proves exactly what an
 * authenticated interrupted-output terminal proves (`interruptedOutputFailure`):
 * the run did not complete with a trusted candidate inside its output bound.
 * It is settled with the runtime's own transition for that case (the reserved
 * charge becomes `ambiguous`, the record blocks with
 * ATTEMPT_DETAIL_INTERRUPTED_BOUND), never consumed: its candidate is not
 * imported, preserved or published. Every other receipt refusal stays an
 * integrity fault.
 */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
} from "../src/contracts/matrix.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  receiptIdentityMatches,
  sameRepository,
} from "../src/host/matrix-identity.ts";
import type {
  MatrixIngestOptionsV1,
  MatrixIngestReportV1,
} from "../src/host/matrix-ingest.ts";
import { ATTEMPT_DETAIL_INTERRUPTED_BOUND } from "../src/repair/attempt-policy.ts";
import {
  createRunBounds,
  loadRepairContext,
  type RepairCycleDepsV1,
  settleFailedImplementation,
} from "../src/repair/loop.ts";

/**
 * The trusted route the ingest verified these receipts against: the ingest's
 * own options object, never a second copy of its constants, so the
 * classifier can neither take a provider or model rejection for an overrun
 * nor miss an overrun the ingest authenticated.
 */
export type OutputBoundRouteV1 = Pick<
  MatrixIngestOptionsV1,
  "expectedProvider" | "failoverModel"
>;

/** Exactly `interruptedOutputFailure`, for a completed runtime terminal. */
export function outputBoundOverrun(
  result: MatrixCellResultV1,
  cell: MatrixCellPlanV1,
  route: OutputBoundRouteV1,
): boolean {
  const receipt = result.receipt;
  if (
    result.status !== "completed" || receipt === null ||
    receipt.outcome !== "completed" || receipt.candidate === null ||
    receipt.candidate.head === null || result.bundle === null ||
    !receiptIdentityMatches(
      receipt,
      cell.request,
      route.expectedProvider,
      route.failoverModel,
    )
  ) return false;
  const actual = receipt.actual;
  return actual.terminalOrigin === "runtime" &&
    actual.observedTerminalStatus === "completed" &&
    typeof receipt.invocationId === "string" &&
    receipt.invocationId.length > 0 &&
    typeof actual.threadId === "string" && actual.threadId.length > 0 &&
    typeof actual.turnId === "string" && actual.turnId.length > 0 &&
    Number.isSafeInteger(actual.durationMs) && actual.durationMs >= 0 &&
    Number.isSafeInteger(cell.request.maxDurationMs) &&
    cell.request.maxDurationMs > 0 &&
    actual.durationMs <= cell.request.maxDurationMs &&
    Number.isSafeInteger(actual.outputChars) &&
    Number.isSafeInteger(cell.request.maxOutputChars) &&
    cell.request.maxOutputChars > 0 &&
    actual.outputChars > cell.request.maxOutputChars;
}

/**
 * The cells of `report` refused only for an output-bound overrun: a
 * `receipt_rejected` entry whose one authenticated result is exactly that,
 * authenticated against `route`, the options the ingest that wrote `report`
 * itself verified with. Pure: the caller still refuses every other
 * non-benign entry first.
 */
export function outputBoundCells(
  report: MatrixIngestReportV1,
  cells: readonly MatrixCellPlanV1[],
  results: readonly MatrixCellResultV1[],
  route: OutputBoundRouteV1,
): Set<string> {
  const out = new Set<string>();
  for (const entry of report.entries) {
    if (entry.disposition !== "receipt_rejected") continue;
    const cell = cells.find((row) => row.cellId === entry.cellId);
    const rows = results.filter((row) => row.cellId === entry.cellId);
    if (
      cell && rows.length > 0 &&
      rows.every((row) => outputBoundOverrun(row, cell, route))
    ) {
      out.add(entry.cellId);
    }
  }
  return out;
}

/** The record and charge `cell` binds in `snapshot`, exactly as stored. */
function heldBy(snapshot: RepairStateSnapshotV1, cell: MatrixCellPlanV1) {
  return {
    record: snapshot.work.find((row) => row.id === cell.taskId) ?? null,
    charge:
      snapshot.reservations.find((row) => row.id === cell.reservationId) ??
        null,
  };
}

/**
 * Whether `cell`'s exact charged binding holds in `snapshot`: the charge
 * still reserved, or the settlement's first write landed (the charge is
 * `ambiguous` while the record still works the same intent, a torn pair).
 */
function chargedBinding(
  snapshot: RepairStateSnapshotV1,
  cell: MatrixCellPlanV1,
): boolean {
  const { record, charge } = heldBy(snapshot, cell);
  const intent = record?.intent;
  if (
    !record || !charge || !intent || intent.kind !== "implementation" ||
    intent.requestId !== cell.reservationId ||
    intent.key !== cell.intentKey ||
    !sameRepository(record.repository, cell.repository) ||
    record.source.kind !== "issue" ||
    record.related.issueNumber !== cell.request.issue?.number ||
    record.target.base !== cell.expectedBase ||
    !sameRepository(charge.repository, record.repository) ||
    charge.taskId !== record.id || charge.head !== cell.expectedBase ||
    charge.attempt !== record.counters.attempts ||
    (charge.purpose !== "implementation" && charge.purpose !== "retry")
  ) return false;
  return (charge.outcome === "reserved" && charge.settledAt === null) ||
    (charge.outcome === "ambiguous" && charge.settledAt !== null &&
      record.nextStep === "work");
}

/**
 * Settle each output-bound cell through the composed custody writer the
 * consumer used, re-proving its exact charged binding first. `false` means
 * an unavailable state or settlement, or a binding that moved during this
 * pass: the caller defers exactly like a consumer `state_error`. `null` is
 * the caller's integrity refusal.
 *
 * Each cell's record and charge must still be exactly what they were in
 * `start`, the repair snapshot this pass began from (the one its ingest
 * proved the same cells against; nothing this pass writes before the settle
 * touches them). When either moved (an owner edit, or any other writer,
 * landing between the ingest and the settle), nothing is written over it and
 * the pass defers: the next pass starts from the moved state, whose ingest
 * reports it benign (`binding_mismatch`, `duplicate`, `absent`) or proves it
 * again. Only a binding that was already wrong when the pass began, and is
 * unchanged, is never settled and returns `null`: a binding that is
 * genuinely wrong still fails that pass, and the next one.
 *
 * The settlement is two writes (the charge, then the record with its attempt
 * memory). When only the first landed, the charge is already `ambiguous`
 * while the record still works on the same intent; that torn pair is
 * finished here (the charge write is idempotent), never refused, so a lost
 * second write cannot fail every later pass. Any pair already torn when this
 * pass began is finished; the start-of-pass guard only keeps a pair torn
 * during this pass (which moved the charge) from being finished in the same
 * pass, so it defers once. No code checks who tore a pair: that a pair torn
 * before the pass is this settler's own rests on the audit below, and
 * `AUDITED_SETTLERS` in tests/host/hosted-autonomy-output-bound_test.ts pins
 * the direct calls to the primitive settlers (not wrappers or direct
 * snapshot edits), so a new settler of this charge must be re-audited:
 *
 * - the charge is the cell's own admission (its id derives from repository,
 *   task, base, attempt and purpose), so no other plan's settler holds it;
 * - the consumer (`ingestMatrixResults`, any generation) settles only an
 *   interrupted or receipt-less result, or a verified receipt, and this
 *   cell's one authenticated result is a completed receipt past its bound,
 *   which it refuses without a write on every pass;
 * - the serial work step (`settleFailedImplementation`,
 *   `handleImplementationUncertainty`) defers every saved implementation
 *   intent under external implementations, which every hosted cycle sets
 *   (the repair job's target cycles run through the matrix aggregate);
 * - review settlements touch only `review_request` charges;
 * - the historical quarantine settles only dedicated charges, which no
 *   producer request ever carries (`dedicatedMatrixReservations`);
 * - the uncertainty quarantine settles only its fixed generation-63 charges,
 *   and only while generation 63 is the active runtime, so it settles
 *   nothing under any later generation;
 * - snapshot-level dispositions (runtime mismatch, historical retry) write
 *   the charge and the record in one commit and never tear a pair.
 *
 * A settler that could tear this charge must tag its first write before the
 * audit admits it, so this re-entry can tell whose pair it is finishing.
 */
export async function settleOutputBoundCells(
  deps: RepairCycleDepsV1,
  cells: readonly MatrixCellPlanV1[],
  ids: ReadonlySet<string>,
  deadline: number,
  start: RepairStateSnapshotV1,
): Promise<boolean | null> {
  const bounds = createRunBounds(deps, { deadline });
  for (const cell of cells.filter((row) => ids.has(row.cellId))) {
    const context = await loadRepairContext(deps, bounds);
    if (context === null) return false;
    const held = heldBy(context.snapshot, cell);
    if (
      canonicalStringify(held) !== canonicalStringify(heldBy(start, cell))
    ) return false;
    if (!chargedBinding(context.snapshot, cell)) return null;
    const step = await settleFailedImplementation(
      { ...deps, controllerSha: cell.runtimeSha },
      context,
      held.record!,
      cell.reservationId,
      ATTEMPT_DETAIL_INTERRUPTED_BOUND,
      { stage: "model", failureClass: "transient_infrastructure" },
    );
    if (
      step.kind === "state_error" || step.kind === "deferred" ||
      (step.kind === "progress" && step.queueHold === true)
    ) return false;
  }
  return true;
}
