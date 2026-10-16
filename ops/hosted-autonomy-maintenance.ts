import {
  CLOSED_C_WAVE,
  type ClosedCWaveBindingV1,
  closedCWaveNeedsRecovery,
  ingestClosedCWave,
} from "../src/host/modern-matrix-recovery.ts";
import { HOSTED_RUNTIME_ID } from "../src/contracts/hosted-supervisor.ts";
import { runHistoricalMatrixQuarantine } from "../src/host/matrix-actions.ts";
import { HistoricalQuarantineIncomplete } from "./hosted-autonomy-state.ts";
import {
  dedicatedMatrixReservations,
  recoverHostedCurrentMatrix,
} from "./hosted-autonomy-current-recovery.ts";
import { restoreExistingCandidateRefs } from "./hosted-autonomy-existing-candidate.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
  HostedClosedMatrixDepsV1,
} from "./hosted-autonomy-types.ts";
import { recoverHostedHistoricalC63 } from "./hosted-autonomy-historical-recovery.ts";
import { RECOVERY_ROUTE_FAILOVER_MODEL } from "./hosted-autonomy-matrix-bindings.ts";
import { isDeferredCurrentMatrixHistoryBudget } from "./hosted-autonomy-policy.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "./hosted-autonomy-producer-recovery.ts";

/**
 * Recover authenticated matrix custody before ordinary retry and delivery.
 * `dedicated` receives the reservations the dedicated matrix recoveries own,
 * so later passes leave their records to them exactly as this one does.
 */
export async function runHostedMatrixMaintenance(
  deps: HostedAutonomyDepsV1,
  actions: string[],
  dedicated: Set<string> = new Set(),
): Promise<HostedAutonomyResultV1 | null> {
  let closedBinding: ClosedCWaveBindingV1 = CLOSED_C_WAVE;
  let closed: HostedClosedMatrixDepsV1 | undefined;
  if (deps.closedMatrix) {
    const read = await deps.state.readRepair();
    // Missing or temporarily unavailable repair custody defers the closed and
    // current matrix pre-passes instead of failing the maintenance pass.
    closed = read.ok && read.value.status === "found"
      ? await deps.closedMatrix()
      : undefined;
    closedBinding = closed?.binding ?? CLOSED_C_WAVE;
    const releaseRead = read.ok && read.value.status === "found"
      ? await deps.state.readRelease()
      : null;
    if (
      releaseRead?.ok && releaseRead.value.status === "found" &&
      releaseRead.value.snapshot.hostedRuntimes.every((row) =>
        row.execution === null
      ) &&
      releaseRead.value.snapshot.hostedRuntimes.some((row) =>
        row.id === HOSTED_RUNTIME_ID
      ) &&
      !releaseRead.value.snapshot.hostedReleases.some((row) =>
        row.phase !== "accepted" && row.phase !== "rolled_back"
      ) &&
      read.ok && read.value.status === "found" && closed !== undefined &&
      closedCWaveNeedsRecovery(read.value.snapshot, closed.binding)
    ) {
      const recovered = await ingestClosedCWave({
        ...closed,
        // The producer route's 429 failover, from launcher source only.
        failoverModel: RECOVERY_ROUTE_FAILOVER_MODEL,
      });
      console.log(
        JSON.stringify({ kind: "sentinel_closed_c_recovery", ...recovered }),
      );
      return {
        kind: "hosted_autonomy",
        status: recovered.repairHead === read.value.head
          ? "skipped"
          : "applied",
        reason: recovered.repairHead === read.value.head
          ? "no_change"
          : "applied",
        beforeHead: read.value.head,
        appliedHead: recovered.repairHead,
        actions: ["closed-c-matrix:ingested:" + recovered.dispositions.length],
        revisions: [],
      };
    }
  }
  for (const id of dedicatedMatrixReservations(deps, closedBinding)) {
    dedicated.add(id);
  }
  // A parked preserved candidate whose exact deterministic preservation ref
  // already exists needs no artifact and no history walk.
  if (closed !== undefined) {
    const restored = await restoreExistingCandidateRefs({
      deps,
      ports: closed,
      dedicated,
      actions,
    });
    if (restored !== null) return restored;
  }
  let custodyDeferred = false;
  let currentMatrix: HostedAutonomyResultV1 | null;
  try {
    currentMatrix = await recoverHostedCurrentMatrix(
      deps,
      closedBinding,
      () => {
        custodyDeferred = true;
      },
      // A producer whose plan evidence expired or was never listed is a
      // typed skip: nothing is written and later passes still run.
      (kind) => actions.push(`current-matrix:unrecoverable:${kind}`),
    );
  } catch (error) {
    if (
      error instanceof CurrentMatrixRecoveryIntegrityFailure ||
      !isDeferredCurrentMatrixHistoryBudget(error)
    ) throw error;
    // Defer this bounded pre-pass; the runner rereads state before delivery.
    actions.push("matrix-history:deferred");
    return null;
  }
  if (currentMatrix?.status === "applied") return currentMatrix;
  if (deps.historicalMatrix) {
    let count: number;
    try {
      const c63 = await recoverHostedHistoricalC63(deps.historicalMatrix);
      if (c63.deferred) custodyDeferred = true;
      if (c63.ingested > 0) {
        actions.push(`historical-c63:ingested:${c63.ingested}`);
      }
      // A custody-absent pre-pass must not fall through to the legacy
      // quarantine pass, whose refusals would turn it into a hard failure.
      count = custodyDeferred
        ? 0
        : await runHistoricalMatrixQuarantine(deps.historicalMatrix);
    } catch (error) {
      // Only fixed quarantine vocabulary reaches hosted logs, never transport text.
      let errorName: unknown;
      let errorMessage: unknown;
      try {
        if (error instanceof Error) {
          errorName = error.name;
          errorMessage = error.message;
        }
      } catch {
        // A throwing accessor must not replace the quarantine refusal.
      }
      const name = typeof errorName === "string" && [
          "Error",
          "TypeError",
          "RangeError",
          "SyntaxError",
          "ReferenceError",
          "URIError",
          "EvalError",
          "AggregateError",
        ].includes(errorName)
        ? errorName
        : "UnknownError";
      const message = typeof errorMessage === "string" && [
          "matrix artifact provenance unavailable or conflicting",
          "historical matrix not-started admission unproven",
          "historical matrix state unavailable",
          "historical matrix selected reservation binding unavailable",
          "historical matrix release unavailable",
          "historical matrix current native writers unsettled",
          "historical matrix current native settlement unavailable",
          "historical matrix current native binding changed",
          "historical matrix saved custody unavailable",
          "historical matrix current custody changed",
          "historical matrix release witness unavailable",
          "historical matrix release witness binding changed",
          "historical matrix verification custody changed",
          "historical matrix verification completion unavailable",
          "historical matrix verification proof unavailable",
          "historical matrix verification binding changed",
          "historical matrix verification observation changed",
          "historical matrix saved execution unavailable",
          "historical matrix native settlement unavailable",
          "historical matrix native custody unavailable",
          "historical matrix selected witness rejection unavailable",
          "historical matrix applicability changed",
          "historical matrix rejection identity unavailable",
          "historical matrix rejection reservation outside witness",
          "historical matrix final custody changed",
          "historical matrix custody unavailable",
          "historical matrix captured identity changed",
          "historical matrix pre-settlement custody unavailable",
          "historical matrix settlement incomplete",
          "historical matrix post-settlement custody unavailable",
          "historical matrix post-settlement identity changed",
          "historical matrix clock unavailable",
          "historical matrix pre-block custody unavailable",
          "historical matrix block incomplete",
          "historical matrix block readback incomplete",
        ].includes(errorMessage)
        ? errorMessage
        : "[redacted]";
      console.error(JSON.stringify({
        kind: "sentinel_historical_quarantine_error",
        name,
        message,
      }));
      throw new HistoricalQuarantineIncomplete();
    }
    if (count > 0) actions.push(`historical-matrix:quarantined:${count}`);
  }
  const uncertainty = await deps.uncertainMatrix?.();
  if (uncertainty && uncertainty.quarantined > 0) {
    actions.push(`matrix-uncertainty:quarantined:${uncertainty.quarantined}`);
  }
  return null;
}
