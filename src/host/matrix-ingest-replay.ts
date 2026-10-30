/** Replay-only matrix checks: prove consumed effects without applying them again. */
import type { GitSha } from "../contracts/brands.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import {
  matrixBundleFileNameV1,
  matrixCellIdV1,
  type MatrixCellPlanV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../contracts/matrix.ts";
import { HOSTED_ACTIONS_CLOCK_TOLERANCE_MS } from "../contracts/hosted-supervisor.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../contracts/work-record.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  RunBoundsV1,
} from "../repair/loop.ts";
import { ATTEMPT_DETAIL_NO_CHANGE } from "../repair/attempt-policy.ts";
import {
  attemptFingerprintV1,
  attemptMemoryIdV1,
} from "../contracts/attempt-memory.ts";
import { candidateBranch } from "../repair/keys.ts";
import { baseReviewOrigin } from "../repair/base-satisfaction-marker.ts";
import { resolvedConflictCandidate } from "./matrix-conflict-candidate.ts";
import type { MatrixBundleImporterV1 } from "./matrix-git.ts";
import { resetCellTimeouts } from "./matrix-ingest-state.ts";
import { sameRepository, verifyMatrixReceiptV1 } from "./matrix-identity.ts";

/** One replay outcome; the caller owns the cell id and report accumulation. */
export interface MatrixIngestReplayResultV1 {
  disposition:
    | "duplicate"
    | "binding_mismatch"
    | "candidate_unavailable"
    | "state_error";
  detail: string;
}

interface ReplayOptionsV1 {
  expectedProvider: string | readonly string[];
  failoverModel?: string;
  bundleImporter?: MatrixBundleImporterV1;
}

/**
 * A consumed conflict result can outlive the mirror that imported it. Restore
 * only that exact operation's objects, without consuming again, reopening a
 * blocked record or granting any publication authority.
 */
export async function replayConsumedConflict(
  cell: MatrixCellPlanV1,
  result: MatrixCellResultV1,
  record: WorkRecordV1,
  reservation: BudgetReservationV1,
  context: LoopContextV1,
  intent: IncompleteOperationV1 | null,
  resolved: GitSha | null,
  options: ReplayOptionsV1,
): Promise<MatrixIngestReplayResultV1 | null> {
  if (intent?.kind !== "base_refresh" || resolved === null) return null;
  const candidate = result.receipt?.candidate;
  const binding = await resolvedConflictCandidate(
    record,
    context.snapshot.reservations,
  );
  if (
    binding === null || binding.reservationId !== cell.reservationId ||
    binding.intentKey !== cell.intentKey ||
    cell.request.checkoutBase !== binding.publishedHead ||
    cell.request.mergeBase !== intent.observedBase ||
    cell.request.reviewFindings !== undefined ||
    intent.observedBase === null ||
    result.status !== "completed" || result.receipt === null ||
    candidate?.head !== resolved || candidate.checkpointSha !== null ||
    result.completedAt >
      intent.startedAt + HOSTED_ACTIONS_CLOCK_TOLERANCE_MS ||
    reservation.settledAt === null ||
    result.completedAt >
      reservation.settledAt + HOSTED_ACTIONS_CLOCK_TOLERANCE_MS ||
    !verifyMatrixReceiptV1(
      result.receipt,
      cell.request,
      options.expectedProvider,
      options.failoverModel,
    )
  ) {
    return {
      disposition: "binding_mismatch",
      detail: "saved refresh does not bind authenticated conflict result",
    };
  }
  if (
    options.bundleImporter === undefined || result.bundle === null ||
    result.bundle.head !== resolved ||
    result.bundle.checkpointSha !== null ||
    result.bundle.file !== matrixBundleFileNameV1(cell.cellId) ||
    !await options.bundleImporter.import({
      base: cell.expectedBase,
      file: result.bundle.file,
      digest: result.bundle.digest,
      head: resolved,
      checkpointSha: null,
      ancestors: [binding.publishedHead, intent.observedBase],
    })
  ) {
    return {
      disposition: "candidate_unavailable",
      detail: "saved conflict result objects are unavailable",
    };
  }
  return {
    disposition: "duplicate",
    detail: "receipt already consumed; exact conflict result rehydrated",
  };
}

/**
 * The held operation's semantic effect is already accounted. Its original
 * intent and ambiguity stay in place for base review; replay grants no effect.
 * If the original ingestion stopped before the timeout streak reset, complete
 * only that outstanding reset before acknowledging the duplicate.
 */
export async function replayAccountedNoChange(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
  context: LoopContextV1,
  plan: MatrixPlanV1,
  cell: MatrixCellPlanV1,
  result: MatrixCellResultV1,
  record: WorkRecordV1,
  reservation: BudgetReservationV1,
  intent: IncompleteOperationV1,
  receiptHead: GitSha | null,
): Promise<MatrixIngestReplayResultV1 | null> {
  if (
    result.status !== "failed" || result.detail !== ATTEMPT_DETAIL_NO_CHANGE ||
    result.receipt !== null || result.bundle !== null ||
    reservation.outcome !== "ambiguous" || reservation.settledAt === null ||
    record.nextStep !== "work" || record.blocker !== null ||
    baseReviewOrigin(record, context.snapshot) !== cell.reservationId ||
    intent.expectedHead !== null || intent.pr !== null ||
    intent.resultId !== null ||
    intent.branch !== candidateBranch(record.id) ||
    intent.observedBase !== cell.expectedBase ||
    intent.failure?.attempts !== 1 ||
    // The resumed timeout reset advances record.updatedAt, so bind the
    // accounted failure identity and hold instead of that bookkeeping stamp.
    record.wait?.since !== intent.failure.atMs ||
    result.completedAt <
      intent.startedAt - HOSTED_ACTIONS_CLOCK_TOLERANCE_MS ||
    result.completedAt >
      reservation.settledAt + HOSTED_ACTIONS_CLOCK_TOLERANCE_MS ||
    cell.request.taskId !== record.id ||
    cell.request.base !== cell.expectedBase ||
    !sameRepository(cell.request.repository, record.repository) ||
    await matrixDigestV1(cell.request) !== cell.requestDigest ||
    await matrixCellIdV1(plan.waveId, record.id, cell.reservationId) !==
      cell.cellId
  ) return null;
  const identity = {
    repository: record.repository,
    taskId: record.id,
    base: cell.expectedBase,
    purpose: "implementation" as const,
  };
  const memoryId = await attemptMemoryIdV1(identity);
  const fingerprint = await attemptFingerprintV1({
    ...identity,
    controllerSha: cell.runtimeSha,
    detail: ATTEMPT_DETAIL_NO_CHANGE,
  });
  const accounted = context.snapshot.attemptMemory.some((memory) =>
    memory.id === memoryId && memory.taskId === record.id &&
    sameRepository(memory.repository, record.repository) &&
    memory.base === cell.expectedBase &&
    memory.purpose === "implementation" &&
    memory.entries.some((entry) =>
      entry.fingerprint === fingerprint &&
      entry.controllerSha === cell.runtimeSha &&
      entry.detail === ATTEMPT_DETAIL_NO_CHANGE &&
      entry.stage === "model" &&
      entry.failureClass === "semantic_no_progress" && entry.count > 0 &&
      entry.lastAtMs === intent.failure!.atMs
    )
  );
  if (!accounted) return null;
  if (record.counters.timeouts !== undefined) {
    const reset = await resetCellTimeouts(deps, bounds, cell, receiptHead);
    if (!reset) {
      return {
        disposition: "state_error",
        detail: "receipt settled; timeout reset unavailable or conflicted",
      };
    }
  }
  return {
    disposition: "duplicate",
    detail: "authenticated no-change semantic effect already accounted",
  };
}
