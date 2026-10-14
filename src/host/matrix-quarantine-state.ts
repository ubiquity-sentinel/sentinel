/** Historical matrix quarantine identity, custody and accounting transitions. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { matrixDigestV1 } from "../contracts/matrix.ts";
import {
  type MatrixArtifactTransportV1,
  MatrixMissingCellArtifactError,
  type MatrixRejectedCellEvidenceV1,
  type MatrixRejectedWaveV1,
} from "./matrix-artifact-port.ts";
import type { BudgetControllerV1 } from "../budget/mod.ts";
import type {
  Clock,
  PortResultV1,
  RepairStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedExecutionIntentV1,
  type HostedExecutionSettlementV1,
  type HostedRunProofV1,
} from "../contracts/hosted-supervisor.ts";
import { markBlocked } from "../repair/transitions.ts";
import { implementationIntentKey } from "../repair/keys.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { GitSha } from "../contracts/brands.ts";
import { HISTORICAL_MATRIX_QUARANTINE } from "./matrix-artifact-port.ts";

export const HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE =
  "authenticated historical matrix artifact missing under rejection proof; absence unproven; model outcome uncertain";

/**
 * The exact truthful disposition of one legacy manifest rejection whose
 * authenticated cell never started. It is the proven not-started outcome, not
 * a fresh-work authorization: the existing maintenance retry authority decides
 * separately whether an eligible retry may follow.
 */
export const HISTORICAL_NOT_STARTED_DETAIL =
  "authenticated historical matrix cell did not start: implementation start is past the model cutoff or no longer fits the run bounds";

/**
 * The two named historical quarantine blockers remain closed. Only the
 * original manifest class may enter explicit not-started revalidation;
 * missing-cell quarantine is excluded by selection before any witness read.
 */
export function isHistoricalQuarantineBlocked(record: {
  readonly nextStep: string;
  readonly blocker: {
    readonly kind: string;
    readonly message: string;
  } | null;
}): boolean {
  return record.nextStep === "blocked" &&
    record.blocker?.kind === "other" &&
    (record.blocker.message === HISTORICAL_MATRIX_QUARANTINE ||
      record.blocker.message === HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE);
}

/**
 * True only when the authenticated legacy witness proves this exact
 * reservation never started: the wave is the exact diagnosed
 * `reservation_after_manifest` class, the cell's own authenticated result is
 * `not_started` with no receipt and no bundle, and the reservation's admission
 * instant falls inside the authenticated planner job interval. Unknown,
 * completed, receipt-bearing, bundle-bearing, missing-evidence or
 * outside-the-window admissions return false and stay quarantined.
 */
export function historicalNotStartedProven(
  wave: Pick<
    MatrixRejectedWaveV1,
    "reason" | "plannerStartedAt" | "plannerCompletedAt"
  >,
  cell: MatrixRejectedCellEvidenceV1 | undefined,
  reservation: Pick<BudgetReservationV1, "id" | "createdAt">,
): boolean {
  if (wave.reason !== "reservation_after_manifest") return false;
  if (cell === undefined) return false;
  if (
    cell.status !== "not_started" || !cell.receiptNull || !cell.bundleNull ||
    cell.reservationId !== reservation.id
  ) return false;
  const started = Date.parse(wave.plannerStartedAt);
  const completed = Date.parse(wave.plannerCompletedAt);
  if (
    !Number.isSafeInteger(started) || !Number.isSafeInteger(completed) ||
    completed < started
  ) return false;
  return reservation.createdAt >= started && reservation.createdAt <= completed;
}

export interface HistoricalMatrixQuarantineDepsV1 {
  state: StateReadView & RepairStateWriter;
  clock: Clock;
  budget: Pick<BudgetControllerV1, "settleModelStart">;
  /**
   * Explicit authenticated not-started revalidation. When true, the exact
   * already-quarantined blocked class may be re-examined and reconciled to the
   * proven not-started disposition. When false (default), every
   * already-quarantined record stays closed exactly as in the original
   * quarantine pass: no repeat action, no witness/archive read, no count.
   */
  revalidateNotStarted?: boolean;
  transport: MatrixArtifactTransportV1;
  /** Closed owner-selected release witnesses; never a history scan or fallback. */
  historicalReleaseWitnesses?: readonly {
    commit: GitSha;
    executionId: string;
    logDigest: string;
    reservationIds: readonly string[];
    reject(
      proof: HostedRunProofV1,
      expectedHead: GitSha,
      revalidateNotStarted?: boolean,
      deadline?: number,
    ): Promise<readonly MatrixRejectedWaveV1[]>;
  }[];
  readExecution(
    execution: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>>;
}
export interface HistoricalProofCustodyV1 {
  commit: GitSha;
  expectedHead: GitSha;
  proofDigest: string;
}
export function reservationIdentity(row: BudgetReservationV1) {
  return canonicalStringify({
    ...row,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
  });
}
export async function proofInCustody(
  deps: HistoricalMatrixQuarantineDepsV1,
  proof: HostedRunProofV1,
  current?: HostedExecutionIntentV1 | null,
  historical?: HistoricalProofCustodyV1,
) {
  const read = await deps.state.readRelease();
  if (!read.ok || read.value.status !== "found") return false;
  const runtime = read.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const identity = canonicalStringify(proof.execution);
  if (
    current !== undefined &&
    canonicalStringify(runtime?.execution ?? null) !==
      canonicalStringify(current)
  ) return false;
  if (historical) {
    if (
      read.value.head !== historical.expectedHead ||
      !deps.state.readReleaseAt
    ) return false;
    const saved = await deps.state.readReleaseAt(historical);
    if (
      !saved.ok || saved.value.status !== "found" ||
      saved.value.head !== historical.commit
    ) return false;
    const prior = saved.value.snapshot.hostedRuntimes.find((row) =>
      row.id === HOSTED_RUNTIME_ID
    )?.lastExecutionProof;
    if (
      !prior || prior.outcome === "not_started" ||
      await matrixDigestV1({ ...prior, observedAt: 0 }) !==
        historical.proofDigest ||
      canonicalStringify({ ...prior, observedAt: proof.observedAt }) !==
        canonicalStringify(proof)
    ) return false;
    // The exact completed native proof was authenticated once for this operation.
    // Its immutable bytes remain bound by the full historical digest and frozen head.
    return true;
  }
  if (
    runtime?.execution && canonicalStringify(runtime.execution) === identity
  ) return true;
  const prior = runtime?.lastExecutionProof;
  return prior !== null && prior !== undefined &&
    prior.outcome !== "not_started" &&
    canonicalStringify({ ...prior, observedAt: proof.observedAt }) ===
      canonicalStringify(proof);
}
export async function quarantineRow(
  deps: HistoricalMatrixQuarantineDepsV1,
  wave: MatrixRejectedWaveV1 | MatrixMissingCellArtifactError,
  captured: MatrixRejectedWaveV1["affected"][number],
  currentExecution: HostedExecutionIntentV1 | null,
  historical?: HistoricalProofCustodyV1,
) {
  const revalidate = deps.revalidateNotStarted === true;
  const unprovable = wave instanceof MatrixMissingCellArtifactError;
  if (
    (!unprovable && wave.reason !== "reservation_after_manifest") ||
    ((!revalidate || !isHistoricalQuarantineBlocked(captured.work)) &&
      captured.work.nextStep !== "work") ||
    captured.work.intent?.kind !== "implementation" ||
    captured.work.target.candidateState !== undefined ||
    captured.work.intent.requestId !== captured.reservation.id ||
    captured.work.intent.key !==
      implementationIntentKey(captured.reservation.id) ||
    captured.work.intent.observedBase !== captured.reservation.head ||
    captured.work.target.base !== captured.reservation.head ||
    captured.work.counters.attempts !== captured.reservation.attempt ||
    captured.work.id !== captured.reservation.taskId ||
    captured.request.taskId !== captured.work.id ||
    captured.request.base !== captured.work.target.base ||
    canonicalStringify(captured.work.repository) !==
      canonicalStringify(captured.reservation.repository) ||
    canonicalStringify(captured.work.repository) !==
      canonicalStringify(captured.request.repository) ||
    await matrixDigestV1(captured.request) !== captured.requestDigest ||
    await matrixDigestV1(captured.work) !== captured.workDigest ||
    await matrixDigestV1(captured.reservation) !== captured.reservationDigest ||
    !await proofInCustody(deps, wave.proof, currentExecution, historical)
  ) throw new Error("historical matrix custody unavailable");
  const read = await deps.state.readRepair();
  if (!read.ok || read.value.status !== "found") {
    throw new Error("historical matrix state unavailable");
  }
  const work = read.value.snapshot.work.find((row) =>
    row.id === captured.work.id &&
    canonicalStringify(row.repository) ===
      canonicalStringify(captured.work.repository)
  );
  const reservation = read.value.snapshot.reservations.find((row) =>
    row.id === captured.reservation.id
  );
  if (
    !work || !reservation ||
    ((!revalidate || !isHistoricalQuarantineBlocked(work)) &&
      work.nextStep !== "work") ||
    work.intent?.kind !== "implementation" ||
    work.target.candidateState !== undefined ||
    await matrixDigestV1(work) !== captured.workDigest ||
    await matrixDigestV1(reservation) !== captured.reservationDigest ||
    (reservation.outcome !== "reserved" && reservation.outcome !== "ambiguous")
  ) {
    throw new Error("historical matrix captured identity changed");
  }
  const provenNotStarted = !unprovable && revalidate &&
    isHistoricalQuarantineBlocked(work) &&
    historicalNotStartedProven(
      wave,
      wave.cells.find((cell) => cell.reservationId === reservation.id),
      reservation,
    );
  // An already-quarantined record is only reconciled when explicit not-started
  // revalidation is enabled AND the authenticated witness proves this exact
  // reservation never started; every other class is refused before any
  // settlement or write.
  if (
    !unprovable && revalidate && isHistoricalQuarantineBlocked(work) &&
    !provenNotStarted
  ) {
    throw new Error("historical matrix not-started admission unproven");
  }
  if (!await proofInCustody(deps, wave.proof, currentExecution, historical)) {
    throw new Error("historical matrix pre-settlement custody unavailable");
  }
  // An already-settled ambiguous charge is preserved byte for byte: it is
  // never re-settled and never receives a new settlement instant. A missing
  // cell artifact cannot prove non-submission, but its admission must still
  // reach a final ambiguous settlement; the charge is retained, never
  // refunded, and the terminal blocker records that absence is unproven.
  let settledReservation = reservation;
  if (reservation.outcome !== "ambiguous" || reservation.settledAt === null) {
    const settled = await deps.budget.settleModelStart({
      id: reservation.id,
      outcome: "ambiguous",
      proofRef: null,
    });
    if (
      (settled.status !== "settled" && settled.status !== "idempotent") ||
      settled.reservation.outcome !== "ambiguous" ||
      settled.reservation.settledAt === null ||
      settled.reservation.proofRef !== null ||
      reservationIdentity(settled.reservation) !==
        reservationIdentity(reservation)
    ) {
      throw new Error("historical matrix settlement incomplete");
    }
    settledReservation = settled.reservation;
  }
  const fresh = await deps.state.readRepair();
  if (
    !fresh.ok || fresh.value.status !== "found" ||
    !await proofInCustody(deps, wave.proof, currentExecution, historical)
  ) {
    throw new Error("historical matrix post-settlement custody unavailable");
  }
  const current = fresh.value.snapshot.work.find((row) =>
    row.id === work.id &&
    canonicalStringify(row.repository) === canonicalStringify(work.repository)
  );
  const charged = fresh.value.snapshot.reservations.find((row) =>
    row.id === reservation.id
  );
  if (
    !current || await matrixDigestV1(current) !== captured.workDigest ||
    !charged ||
    canonicalStringify(charged) !== canonicalStringify(settledReservation)
  ) {
    throw new Error("historical matrix post-settlement identity changed");
  }
  const now = deps.clock.now();
  if (!Number.isSafeInteger(now) || now < fresh.value.snapshot.updatedAt) {
    throw new Error("historical matrix clock unavailable");
  }
  const blocked = markBlocked(
    current,
    "other",
    unprovable
      ? HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE
      : provenNotStarted
      ? HISTORICAL_NOT_STARTED_DETAIL
      : HISTORICAL_MATRIX_QUARANTINE,
    now,
  );
  if (!await proofInCustody(deps, wave.proof, currentExecution, historical)) {
    throw new Error("historical matrix pre-block custody unavailable");
  }
  const write = await deps.state.writeRepair({
    ...fresh.value.snapshot,
    stateHead: fresh.value.head,
    sequence: fresh.value.snapshot.sequence + 1,
    updatedAt: now,
    work: fresh.value.snapshot.work.map((row) =>
      row === current ? blocked : row
    ),
  }, fresh.value.head);
  if (!write.ok || write.value.status !== "applied") {
    throw new Error("historical matrix block incomplete");
  }
  const verified = await deps.state.readRepair();
  if (
    !verified.ok || verified.value.status !== "found" ||
    !await proofInCustody(deps, wave.proof, currentExecution, historical) ||
    canonicalStringify(
        verified.value.snapshot.work.find((row) =>
          row.id === work.id &&
          canonicalStringify(row.repository) ===
            canonicalStringify(work.repository)
        ),
      ) !== canonicalStringify(blocked) ||
    canonicalStringify(
        verified.value.snapshot.reservations.find((row) =>
          row.id === reservation.id
        ),
      ) !== canonicalStringify(charged)
  ) {
    throw new Error("historical matrix block readback incomplete");
  }
}
/** Protected repair-owner checkpoint; no model, release-write or ingestion capability. */
