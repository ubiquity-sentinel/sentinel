/** One isolated already-admitted matrix implementation cell. */
import {
  MATRIX_CELL_RESULT_VERSION,
  matrixBundleFileNameV1,
  type MatrixCellActualIdentityV1,
  type MatrixCellBundleV1,
  type MatrixCellGrantV1,
  type MatrixCellResultV1,
  matrixDigestV1,
} from "../contracts/matrix.ts";
import type {
  Clock,
  GitHubPort,
  ImplementationPort,
  StateReadView,
} from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import { OPERATION_MARGIN_MS, type RunBoundsV1 } from "../repair/loop.ts";
import { ATTEMPT_DETAIL_PROVIDER_THROTTLED } from "../repair/attempt-policy.ts";
import { isProviderThrottledReceiptV1 } from "../repair/model-port-retry.ts";
import type { MatrixBundleExporterV1 } from "./matrix-git.ts";
import { sameRepository } from "./matrix-identity.ts";

export interface MatrixCellDepsV1 {
  /** Trusted fresh clock and original shared run bounds; never artifact claims. */
  clock: Clock;
  bounds: RunBoundsV1;
  /** Full configured session maximum, with the ordinary publication margin. */
  sessionBound: RepositoryConfigV1["sessionBound"];
  /** Read-only authoritative state view; the cell can never write state. */
  state: StateReadView;
  /**
   * Trusted per-cell GitHub port with scoped source-read credentials only. The
   * host composes the real opt-out scope (`scopeLocalRepairIssues`), so a
   * newly added `sentinel:skip` label revokes the read and refuses the start.
   */
  github: Pick<GitHubPort, "readIssue">;
  /** Isolated, credential-free implementation port (existing contract). */
  model: ImplementationPort;
  /**
   * Trusted candidate-object carrier over the isolated cell checkout. Absent
   * means a completed head cannot be transferred, so the cell refuses the
   * result as failed/ambiguous instead of claiming a recoverable candidate.
   */
  bundle?: MatrixBundleExporterV1;
}

function resultBinding(
  grant: MatrixCellGrantV1,
): Omit<
  MatrixCellResultV1,
  "status" | "receipt" | "bundle" | "detail" | "completedAt"
> {
  const { cell } = grant;
  return {
    version: MATRIX_CELL_RESULT_VERSION,
    kind: "matrix_cell_result",
    waveId: grant.waveId,
    cellId: cell.cellId,
    taskId: cell.taskId,
    repository: cell.repository,
    run: grant.run,
    runtimeSha: cell.runtimeSha,
    generation: cell.generation,
    reservationId: cell.reservationId,
    intentKey: cell.intentKey,
    requestDigest: cell.requestDigest,
  };
}

/**
 * Execute exactly one granted `ModelRunRequestV1`. The grant is not
 * self-authenticating: the trusted `actual` identity from the dispatched host
 * must match the grant's run/attempt/launcher/runtime revision/generation, so
 * a rerun or an already-owned cell cannot reuse a still-reserved admission.
 * All pre-start checks are read-only; any refusal is a `not_started`/`failed`
 * result with no model call, and the ingester keeps the charge.
 */
export async function runMatrixCell(
  deps: MatrixCellDepsV1,
  grant: MatrixCellGrantV1,
  actual: MatrixCellActualIdentityV1,
  _now: number,
): Promise<MatrixCellResultV1> {
  const { cell } = grant;
  const binding = resultBinding(grant);
  const refuse = (
    status: "failed" | "not_started",
    detail: string,
  ): MatrixCellResultV1 => ({
    ...binding,
    status,
    receipt: null,
    bundle: null,
    detail,
    completedAt: deps.clock.now(),
  });

  // Trusted actual identity, never the grant's own claim.
  if (
    actual.run.runId !== grant.run.runId ||
    actual.run.runAttempt !== grant.run.runAttempt ||
    actual.run.launcherSha !== grant.run.launcherSha
  ) {
    return refuse(
      "failed",
      "actual workflow run identity does not match grant",
    );
  }
  if (
    actual.runtimeSha !== cell.runtimeSha ||
    actual.generation !== cell.generation
  ) {
    return refuse(
      "failed",
      "actual runtime revision/generation does not match grant",
    );
  }

  if (cell.requestDigest !== await matrixDigestV1(cell.request)) {
    return refuse("failed", "planned request digest mismatch");
  }
  if (cell.request.taskId !== cell.taskId) {
    return refuse("failed", "planned request task identity mismatch");
  }
  if (cell.request.base !== cell.expectedBase) {
    return refuse("failed", "planned request base mismatch");
  }
  if (
    cell.request.repository.owner !== cell.repository.owner ||
    cell.request.repository.name !== cell.repository.name ||
    cell.request.repository.installationId !== cell.repository.installationId
  ) {
    return refuse("failed", "planned request repository mismatch");
  }

  // Fresh source re-read through the host's opt-out-scoped port: a skip label,
  // close or change after planning consumes no inference.
  const issueNumber = cell.request.issue?.number ?? null;
  if (issueNumber !== null) {
    const read = await deps.github.readIssue(issueNumber);
    if (!read.ok) {
      return refuse("not_started", "source issue read is unavailable");
    }
    const issue = read.value;
    if (issue === null || issue.state !== "open") {
      return refuse("not_started", "source issue is no longer eligible");
    }
    const planned = cell.request.issue;
    if (
      planned !== null &&
      (issue.title !== planned.title || issue.body !== planned.body)
    ) {
      return refuse("not_started", "source issue changed after planning");
    }
    const relations = issue.relations;
    if (
      relations !== undefined &&
      (relations.subIssueCount > 0 || relations.openBlockers.length > 0)
    ) {
      return refuse("not_started", "source issue has open native dependencies");
    }
  }

  // Durable identity: the exact reservation and implementation intent planned
  // by the trusted planner must still be current.
  const stateRead = await deps.state.readRepair();
  if (!stateRead.ok || stateRead.value.status !== "found") {
    return refuse("not_started", "authoritative repair state is unavailable");
  }
  const record = stateRead.value.snapshot.work.find((work) =>
    work.id === cell.taskId
  );
  if (record === undefined) {
    return refuse("not_started", "planned task is not in authoritative state");
  }
  if (
    !sameRepository(record.repository, cell.repository) ||
    record.source.kind !== "issue" ||
    record.related.issueNumber !== issueNumber || cell.request.issue === null
  ) {
    return refuse(
      "not_started",
      "planned task source/repository does not match authoritative state",
    );
  }
  const intent = record.intent;
  if (
    intent === null || intent.kind !== "implementation" ||
    intent.requestId !== cell.reservationId || intent.key !== cell.intentKey ||
    intent.observedBase !== cell.expectedBase || intent.expectedHead !== null
  ) {
    return refuse(
      "not_started",
      "planned implementation intent is not current",
    );
  }
  if (record.target.base !== cell.expectedBase) {
    return refuse("not_started", "planned base is no longer current");
  }
  const reservation = stateRead.value.snapshot.reservations.find((entry) =>
    entry.id === cell.reservationId
  );
  if (
    reservation === undefined || reservation.outcome !== "reserved" ||
    !sameRepository(reservation.repository, record.repository) ||
    reservation.taskId !== record.id ||
    reservation.head !== cell.expectedBase ||
    reservation.attempt !== record.counters.attempts ||
    (reservation.purpose !== "implementation" &&
      reservation.purpose !== "retry")
  ) {
    return refuse("not_started", "planned reservation is not reserved");
  }

  // Source and durable-intent reads were awaited wall-clock work. Recheck at
  // the final start boundary with the full configured session and margin.
  const startsAt = deps.clock.now();
  if (
    deps.sessionBound === null ||
    startsAt >= deps.bounds.modelCutoff ||
    startsAt + deps.sessionBound.maxDurationMs + OPERATION_MARGIN_MS >
      deps.bounds.runDeadline
  ) {
    return refuse(
      "not_started",
      "implementation start is past the model cutoff or no longer fits the run bounds",
    );
  }

  // Exactly one model session; the port owns the isolated, credential-free
  // checkout and validates the request against its configured model/effort.
  const receipt = await deps.model.runModel(cell.request);
  if (!receipt.ok) {
    return refuse("failed", `model run failed (${receipt.error.kind})`);
  }
  // The gateway throttled the whole turn (HTTP 429 even after the port's
  // failover and bounded backoff) and nothing was produced: transient
  // provider unavailability, settled exactly like the port-unavailable
  // refusal above (charged ambiguous, transient memory). Its raw receipt
  // never leaves the cell, so a final failover-model receipt cannot be
  // rejected against the planned primary model and strand the admission.
  if (isProviderThrottledReceiptV1(receipt.value, cell.request)) {
    return refuse("failed", ATTEMPT_DETAIL_PROVIDER_THROTTLED);
  }
  // Candidate objects must be durably carried by a real bounded bundle before
  // a completed result exists: a candidate head with no transferred objects
  // stays failed/ambiguous, never a fabricated recovery.
  const candidate = receipt.value.candidate;
  let bundle: MatrixCellBundleV1 | null = null;
  if (candidate !== null && candidate.head !== null) {
    if (deps.bundle === undefined) {
      return refuse("failed", "candidate bundle capability is unavailable");
    }
    const file = matrixBundleFileNameV1(cell.cellId);
    const created = await deps.bundle.create({
      base: cell.request.base,
      head: candidate.head,
      checkpointSha: candidate.checkpointSha,
      file,
    });
    if (created === null) {
      return refuse("failed", "candidate bundle could not be created");
    }
    bundle = {
      file,
      digest: created.digest,
      head: candidate.head,
      checkpointSha: candidate.checkpointSha,
    };
  }
  return {
    ...binding,
    status: "completed",
    receipt: {
      ...receipt.value,
      // Runtime error text stays in private model evidence. Export only a fixed
      // classification; the exact trusted loop-stop marker retains its meaning.
      error: receipt.value.error === null ||
          receipt.value.error === "failed_command_loop"
        ? receipt.value.error
        : "runtime_error",
    },
    bundle,
    detail: null,
    completedAt: deps.clock.now(),
  };
}

// ---------------------------------------------------------------------------
// Ingester
// ---------------------------------------------------------------------------
