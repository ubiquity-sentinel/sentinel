/** Serialized idempotent matrix artifact ingestion. */
import {
  matrixBundleFileNameV1,
  type MatrixCellResultV1,
  type MatrixPlanV1,
} from "../contracts/matrix.ts";
import { candidateBranch, candidatePreservationRef } from "../repair/keys.ts";
import {
  createRunBounds,
  handleModelReceipt,
  loadRepairContext,
  type RepairCycleDepsV1,
  type RunBoundsV1,
  settleFailedImplementation,
} from "../repair/loop.ts";
import { ATTEMPT_DETAIL_INTERRUPTED_BOUND } from "../repair/attempt-policy.ts";
import { sessionBoundExhausted } from "../repair/loop-implementation-result.ts";
import type { MatrixBundleImporterV1 } from "./matrix-git.ts";
import {
  configForRepository,
  interruptedOutputFailure,
  matrixResultsConflictV1,
  sameRepository,
  verifyMatrixReceiptV1,
} from "./matrix-identity.ts";
import {
  resetCellTimeouts,
  resultMatchesCell,
  settlementClassification,
} from "./matrix-ingest-state.ts";

export type MatrixIngestDispositionV1 =
  | "ingested"
  | "missing"
  | "duplicate"
  | "conflict"
  | "foreign"
  | "absent"
  | "binding_mismatch"
  | "receipt_rejected"
  | "candidate_unavailable"
  | "state_error";

export interface MatrixIngestEntryV1 {
  cellId: string;
  disposition: MatrixIngestDispositionV1;
  detail: string | null;
}

export interface MatrixIngestReportV1 {
  waveId: string;
  entries: MatrixIngestEntryV1[];
  ingested: number;
}

export interface MatrixIngestOptionsV1 {
  deadline: number;
  runStartedAt?: number;
  /**
   * Trusted provider identity (or the closed allowlist of documented routes)
   * the runtime route must have used.
   */
  expectedProvider: string | readonly string[];
  /**
   * Trusted per-target bundle importer. A completed result with a candidate
   * head is rejected as `candidate_unavailable` unless its bundle digest and
   * objects verify into this importer's repository.
   */
  bundleImporter?: MatrixBundleImporterV1;
}

export async function ingestMatrixResults(
  deps: RepairCycleDepsV1,
  plan: MatrixPlanV1,
  results: readonly MatrixCellResultV1[],
  options: MatrixIngestOptionsV1,
): Promise<MatrixIngestReportV1> {
  const bounds: RunBoundsV1 = createRunBounds(deps, {
    deadline: options.deadline,
    runStartedAt: options.runStartedAt,
  });
  const entries: MatrixIngestEntryV1[] = [];
  const cellById = new Map(plan.cells.map((cell) => [cell.cellId, cell]));
  const chosen = new Map<string, MatrixCellResultV1>();
  const conflicted = new Set<string>();

  for (const result of results) {
    const cell = cellById.get(result.cellId);
    if (cell === undefined) {
      entries.push({
        cellId: result.cellId,
        disposition: "foreign",
        detail: "result does not belong to this wave plan",
      });
      continue;
    }
    const existing = chosen.get(result.cellId);
    if (existing !== undefined) {
      if (matrixResultsConflictV1(existing, result)) {
        chosen.delete(result.cellId);
        conflicted.add(result.cellId);
      }
      continue;
    }
    if (conflicted.has(result.cellId)) continue;
    if (!resultMatchesCell(plan, cell, result)) {
      entries.push({
        cellId: result.cellId,
        disposition: "binding_mismatch",
        detail: "result binding does not match the grant",
      });
      continue;
    }
    chosen.set(result.cellId, result);
  }

  for (const cellId of conflicted) {
    entries.push({
      cellId,
      disposition: "conflict",
      detail: "conflicting duplicate result artifacts for one cell",
    });
  }

  let ingested = 0;
  for (const cell of plan.cells) {
    if (conflicted.has(cell.cellId)) continue;
    const result = chosen.get(cell.cellId);
    if (result === undefined) {
      entries.push({
        cellId: cell.cellId,
        disposition: "missing",
        detail: "no result artifact; durable charge stays unreconciled",
      });
      continue;
    }
    const context = await loadRepairContext(deps, bounds);
    if (context === null) {
      entries.push({
        cellId: cell.cellId,
        disposition: "state_error",
        detail: "repair state unavailable",
      });
      break;
    }
    const record = context.snapshot.work.find((work) =>
      work.id === cell.taskId
    );
    if (record === undefined) {
      entries.push({
        cellId: cell.cellId,
        disposition: "absent",
        detail: "planned task is no longer present",
      });
      continue;
    }
    const reservation = context.snapshot.reservations.find((entry) =>
      entry.id === cell.reservationId
    );
    if (
      !sameRepository(record.repository, cell.repository) ||
      record.source.kind !== "issue" ||
      record.related.issueNumber !== cell.request.issue?.number ||
      record.target.base !== cell.expectedBase ||
      reservation === undefined ||
      !sameRepository(reservation.repository, record.repository) ||
      reservation.taskId !== record.id ||
      reservation.head !== cell.expectedBase ||
      reservation.attempt !== record.counters.attempts ||
      (reservation.purpose !== "implementation" &&
        reservation.purpose !== "retry")
    ) {
      entries.push({
        cellId: cell.cellId,
        disposition: "binding_mismatch",
        detail: "grant does not bind authoritative task/admission",
      });
      continue;
    }
    const config = configForRepository(deps, cell.repository);
    if (config === null) {
      entries.push({
        cellId: cell.cellId,
        disposition: "binding_mismatch",
        detail: "repository is not configured",
      });
      continue;
    }
    let exhausted = false;
    const intent = record.intent;
    if (
      intent?.kind === "candidate_preservation" &&
      intent.requestId === cell.reservationId &&
      intent.key === cell.intentKey
    ) {
      // The receipt was already consumed. Restore only its exact saved objects;
      // never settle this admission again or reopen implementation.
      const candidate = result.receipt?.candidate;
      const expectedRef = await candidatePreservationRef(
        record.repository,
        record.id,
        cell.intentKey,
      );
      if (
        reservation.outcome !== "submitted" || reservation.settledAt === null ||
        result.status !== "completed" || result.receipt === null ||
        candidate?.head === null ||
        candidate === undefined || candidate === null ||
        candidate.head !== record.target.head ||
        candidate.checkpointSha !== (record.target.checkpoint?.sha ?? null) ||
        (record.target.checkpoint !== null &&
          record.target.checkpoint.branch !== candidateBranch(record.id)) ||
        intent.expectedHead !== record.target.head ||
        intent.observedBase !== cell.expectedBase ||
        intent.branch !== expectedRef || intent.pr !== null ||
        intent.resultId !== null ||
        record.target.candidateState?.preserved !== null ||
        !verifyMatrixReceiptV1(
          result.receipt,
          cell.request,
          options.expectedProvider,
        )
      ) {
        entries.push({
          cellId: cell.cellId,
          disposition: "binding_mismatch",
          detail: "saved preservation does not bind authenticated candidate",
        });
        continue;
      }
      if (
        options.bundleImporter === undefined || result.bundle === null ||
        result.bundle.head !== candidate.head ||
        result.bundle.checkpointSha !== candidate.checkpointSha ||
        result.bundle.file !== matrixBundleFileNameV1(cell.cellId) ||
        !await options.bundleImporter.import({
          base: cell.expectedBase,
          file: result.bundle.file,
          digest: result.bundle.digest,
          head: candidate.head!,
          checkpointSha: candidate.checkpointSha,
        })
      ) {
        entries.push({
          cellId: cell.cellId,
          disposition: "candidate_unavailable",
          detail: "saved candidate artifact objects are unavailable",
        });
        continue;
      }
      entries.push({
        cellId: cell.cellId,
        disposition: "duplicate",
        detail:
          "receipt already consumed; exact saved candidate objects rehydrated",
      });
      continue;
    }
    if (
      intent === null || intent.kind !== "implementation" ||
      intent.requestId !== cell.reservationId || intent.key !== cell.intentKey
    ) {
      // Already consumed by an earlier/duplicate ingest or reconciled by the
      // ordinary cycle: replaying this artifact is a no-op.
      entries.push({
        cellId: cell.cellId,
        disposition: "duplicate",
        detail: "implementation intent already consumed",
      });
      continue;
    }
    if (interruptedOutputFailure(result, cell, options.expectedProvider)) {
      if (
        reservation.outcome === "ambiguous" && reservation.settledAt !== null &&
        record.nextStep === "blocked"
      ) {
        entries.push({
          cellId: cell.cellId,
          disposition: "duplicate",
          detail: "authenticated interrupted output failure already accounted",
        });
        continue;
      }
      const step = await settleFailedImplementation(
        { ...deps, controllerSha: cell.runtimeSha },
        context,
        record,
        cell.reservationId,
        ATTEMPT_DETAIL_INTERRUPTED_BOUND,
        { stage: "model", failureClass: "transient_infrastructure" },
      );
      if (step.kind === "state_error") {
        entries.push({
          cellId: cell.cellId,
          disposition: "state_error",
          detail: step.detail,
        });
        continue;
      }
    } else if (result.status === "completed" && result.receipt !== null) {
      exhausted = sessionBoundExhausted(result.receipt, config);
      if (
        !verifyMatrixReceiptV1(
          result.receipt,
          cell.request,
          options.expectedProvider,
        )
      ) {
        // No state update: the reservation/intent stay charged and
        // unreconciled so a later trusted reconciliation can decide.
        entries.push({
          cellId: cell.cellId,
          disposition: "receipt_rejected",
          detail: "receipt does not verify against the exact planned request",
        });
        continue;
      }
      const candidateHead = result.receipt.candidate?.head ?? null;
      if (candidateHead !== null) {
        // The candidate objects must become REAL objects in the trusted
        // per-target mirror before the production consumer runs: digest,
        // bundle verification, fetch, head presence and base ancestry are all
        // actual Git checks by the importer. Missing bytes stay unavailable.
        if (options.bundleImporter === undefined || result.bundle === null) {
          entries.push({
            cellId: cell.cellId,
            disposition: "candidate_unavailable",
            detail: "candidate bundle importer or bundle is unavailable",
          });
          continue;
        }
        const imported = await options.bundleImporter.import({
          base: cell.expectedBase,
          file: result.bundle.file,
          digest: result.bundle.digest,
          head: candidateHead,
          checkpointSha: result.bundle.checkpointSha,
        });
        if (!imported) {
          entries.push({
            cellId: cell.cellId,
            disposition: "candidate_unavailable",
            detail: "candidate bundle did not verify into the trusted mirror",
          });
          continue;
        }
      }
      const step = await handleModelReceipt(
        { ...deps, controllerSha: cell.runtimeSha },
        context,
        record,
        cell.reservationId,
        result.receipt,
        config,
      );
      if (step.kind === "state_error") {
        entries.push({
          cellId: cell.cellId,
          disposition: "state_error",
          detail: step.detail,
        });
        continue;
      }
    } else {
      const failureDetail = result.detail ??
        "matrix cell produced no trusted receipt";
      const step = await settleFailedImplementation(
        { ...deps, controllerSha: cell.runtimeSha },
        context,
        record,
        cell.reservationId,
        failureDetail,
        settlementClassification(
          result.status === "completed" ? "failed" : result.status,
          failureDetail,
        ),
      );
      if (step.kind === "state_error") {
        entries.push({
          cellId: cell.cellId,
          disposition: "state_error",
          detail: step.detail,
        });
        continue;
      }
    }
    ingested++;
    // A session the duration bound cut off is itself a time-bound exhaustion
    // (counted by the receipt consumer); only a run that ended inside its
    // bound breaks the streak.
    if (exhausted) {
      entries.push({
        cellId: cell.cellId,
        disposition: "ingested",
        detail: null,
      });
      continue;
    }
    // The model ran to completion: break any consecutive-timeout streak so a
    // later isolated timeout does not trigger decomposition on stale history.
    const reset = await resetCellTimeouts(deps, bounds, cell);
    entries.push({
      cellId: cell.cellId,
      disposition: reset ? "ingested" : "state_error",
      detail: reset
        ? null
        : "receipt settled; timeout reset unavailable or conflicted",
    });
  }

  return { waveId: plan.waveId, entries, ingested };
}

// ---------------------------------------------------------------------------
// Artifact IO and callable host entrypoints (fixed paths, no new flags/env)
// ---------------------------------------------------------------------------
