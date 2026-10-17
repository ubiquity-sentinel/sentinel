/**
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
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
} from "../src/contracts/matrix.ts";
import {
  receiptIdentityMatches,
  sameRepository,
} from "../src/host/matrix-identity.ts";
import type { MatrixIngestReportV1 } from "../src/host/matrix-ingest.ts";
import { ATTEMPT_DETAIL_INTERRUPTED_BOUND } from "../src/repair/attempt-policy.ts";
import {
  createRunBounds,
  loadRepairContext,
  type RepairCycleDepsV1,
  settleFailedImplementation,
} from "../src/repair/loop.ts";
import {
  HISTORICAL_RECOVERY_PROVIDERS,
  RECOVERY_ROUTE_FAILOVER_MODEL,
} from "./hosted-autonomy-matrix-bindings.ts";

/** Exactly `interruptedOutputFailure`, for a completed runtime terminal. */
export function outputBoundOverrun(
  result: MatrixCellResultV1,
  cell: MatrixCellPlanV1,
): boolean {
  const receipt = result.receipt;
  if (
    result.status !== "completed" || receipt === null ||
    receipt.outcome !== "completed" || receipt.candidate === null ||
    receipt.candidate.head === null || result.bundle === null ||
    !receiptIdentityMatches(
      receipt,
      cell.request,
      HISTORICAL_RECOVERY_PROVIDERS,
      RECOVERY_ROUTE_FAILOVER_MODEL,
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
 * `receipt_rejected` entry whose one authenticated result is exactly that.
 * Pure: the caller still refuses every other non-benign entry first.
 */
export function outputBoundCells(
  report: MatrixIngestReportV1,
  cells: readonly MatrixCellPlanV1[],
  results: readonly MatrixCellResultV1[],
): Set<string> {
  const out = new Set<string>();
  for (const entry of report.entries) {
    if (entry.disposition !== "receipt_rejected") continue;
    const cell = cells.find((row) => row.cellId === entry.cellId);
    const rows = results.filter((row) => row.cellId === entry.cellId);
    if (
      cell && rows.length > 0 &&
      rows.every((row) => outputBoundOverrun(row, cell))
    ) {
      out.add(entry.cellId);
    }
  }
  return out;
}

/**
 * Settle each output-bound cell through the composed custody writer the
 * consumer used, re-proving its exact charged binding first (the same
 * bindings the consumer just proved). `false` means an unavailable state or
 * settlement: the caller defers exactly like a consumer `state_error`.
 * A binding that no longer holds is not settled and returns `null` for the
 * caller's integrity refusal.
 *
 * The settlement is two writes (the charge, then the record with its attempt
 * memory). When only the first landed, the charge is already `ambiguous`
 * while the record still works on the same intent; that torn pair is
 * finished here (the charge write is idempotent), never refused, so a lost
 * second write cannot fail every later pass.
 */
export async function settleOutputBoundCells(
  deps: RepairCycleDepsV1,
  cells: readonly MatrixCellPlanV1[],
  ids: ReadonlySet<string>,
  deadline: number,
): Promise<boolean | null> {
  const bounds = createRunBounds(deps, { deadline });
  for (const cell of cells.filter((row) => ids.has(row.cellId))) {
    const context = await loadRepairContext(deps, bounds);
    if (context === null) return false;
    const record = context.snapshot.work.find((row) => row.id === cell.taskId);
    const charge = context.snapshot.reservations.find((row) =>
      row.id === cell.reservationId
    );
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
      (charge.purpose !== "implementation" && charge.purpose !== "retry") ||
      !((charge.outcome === "reserved" && charge.settledAt === null) ||
        (charge.outcome === "ambiguous" && charge.settledAt !== null &&
          record.nextStep === "work"))
    ) return null;
    const step = await settleFailedImplementation(
      { ...deps, controllerSha: cell.runtimeSha },
      context,
      record,
      cell.reservationId,
      ATTEMPT_DETAIL_INTERRUPTED_BOUND,
      { stage: "model", failureClass: "transient_infrastructure" },
    );
    if (step.kind === "state_error") return false;
  }
  return true;
}
