import type { ClosedCWaveBindingV1 } from "../src/host/modern-matrix-recovery.ts";
import { HOSTED_RUNTIME_ID } from "../src/contracts/hosted-supervisor.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import {
  CurrentMatrixRecoveryIntegrityFailure,
  recoverHostedMatrixProducer,
} from "./hosted-autonomy-producer-recovery.ts";
import { CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE } from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import { HISTORICAL_C63 } from "./hosted-autonomy-matrix-bindings.ts";
import { isMatrixRecoveryPending } from "../src/host/matrix-blocked-candidate.ts";

export async function recoverHostedCurrentMatrix(
  deps: HostedAutonomyDepsV1,
  binding: ClosedCWaveBindingV1,
  onDeferred: () => void,
): Promise<HostedAutonomyResultV1 | null> {
  if (!deps.closedMatrix) return null;
  const deadlineAt = deps.clock.now() + 60_000;
  const dedicated = new Set<string>([
    ...binding.cells.map((row) => row.reservationId),
    ...(deps.historicalMatrix
      ? HISTORICAL_C63.rows.map((row) => row.reservation)
      : []),
    ...(deps.historicalMatrix?.historicalReleaseWitnesses?.flatMap((row) =>
      row.reservationIds
    ) ?? []),
  ]);
  const [repair, release] = await Promise.all([
    deps.state.readRepair(),
    deps.state.readRelease(),
  ]);
  // Missing or temporarily unavailable custody defers recovery.
  if (
    !repair.ok || repair.value.status !== "found" || !release.ok ||
    release.value.status !== "found"
  ) {
    onDeferred();
    return null;
  }
  if (
    !repair.value.snapshot.work.some((row) =>
      isMatrixRecoveryPending(row) &&
      !dedicated.has(row.intent?.requestId ?? "")
    )
  ) return null;
  const current = release.value;
  const beforeHead = repair.value.head;
  const integrityFailure = (message: string) =>
    new CurrentMatrixRecoveryIntegrityFailure(message, beforeHead, null, null);
  const runtime = current.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  if (!runtime) {
    onDeferred();
    return null;
  }
  // An active execution or a nonterminal release defers current-matrix
  // recovery; the existing maintenance guard owns that disposition and the
  // pass must never fail here. Return no recovery so active promotion stays
  // a deferred condition.
  if (
    runtime.execution !== null ||
    current.snapshot.hostedReleases.some((row) =>
      !["accepted", "rolled_back", "cancelled"].includes(row.phase)
    )
  ) {
    onDeferred();
    return null;
  }
  const snapshots = new Set<string>();
  const proofs = new Map<string, string>();
  const covered = new Set<string>();
  const pending = repair.value.snapshot.work.filter((row) =>
    isMatrixRecoveryPending(row) &&
    !dedicated.has(row.intent?.requestId ?? "")
  );
  const scan = async () => {
    let producer = current;
    while (true) {
      if (deps.clock.now() >= deadlineAt) {
        throw new Error(CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE);
      }
      if (snapshots.has(producer.head)) {
        throw integrityFailure("current matrix history cycle");
      }
      snapshots.add(producer.head);
      const producerRuntime = producer.snapshot.hostedRuntimes.find((row) =>
        row.id === HOSTED_RUNTIME_ID
      );
      const saved = producerRuntime?.lastExecutionProof;
      if (
        producerRuntime?.execution === null && saved &&
        saved.outcome !== "not_started" &&
        saved.execution.purpose === "ordinary"
      ) {
        const deferred = (saved.execution.runId === binding.run.runId &&
          saved.execution.runAttempt === binding.run.runAttempt &&
          saved.execution.launcherSha === binding.run.launcherSha &&
          saved.execution.revision === binding.runtimeSha &&
          saved.execution.generation === binding.generation) ||
          saved.execution.id === HISTORICAL_C63.executionId ||
          deps.historicalMatrix?.historicalReleaseWitnesses?.some((row) =>
            row.executionId === saved.execution.id
          );
        if (!deferred) {
          const identity = canonicalStringify(saved.execution);
          const proof = canonicalStringify({ ...saved, observedAt: 0 });
          const prior = proofs.get(identity);
          if (prior !== undefined && prior !== proof) {
            throw integrityFailure("current matrix historical proof conflicts");
          }
          if (prior === undefined) {
            proofs.set(identity, proof);
            const produced = await recoverHostedMatrixProducer(
              deps,
              current,
              producer,
              deadlineAt,
              covered,
              dedicated,
              onDeferred,
            );
            // An unresolved newer producer stops older-history recovery:
            // an older wave must never settle a reservation whose newer
            // producer outcome is still unavailable.
            if (produced.deferred) return null;
            if (produced.result?.status === "applied") {
              return produced.result;
            }
            if (
              pending.every((row) =>
                row.intent?.requestId && covered.has(row.intent.requestId)
              )
            ) return null;
          }
        }
      }
      const parent = producer.snapshot.stateHead;
      if (parent === null) {
        if (producer.snapshot.sequence !== 1) {
          throw integrityFailure("current matrix history root unavailable");
        }
        return null;
      }
      // Unauthenticated or tampered release history stays fail-closed: the
      // offline-history controls pin a rejection for missing, wrong-head,
      // wrong-sequence and cycle faults.
      if (snapshots.has(parent) || !deps.state.readReleaseAt) {
        throw integrityFailure("current matrix history unavailable");
      }
      const prior = await deps.state.readReleaseAt({
        commit: parent,
        expectedHead: current.head,
      });
      if (
        !prior.ok || prior.value.status !== "found" ||
        prior.value.head !== parent ||
        prior.value.snapshot.sequence !== producer.snapshot.sequence - 1
      ) throw integrityFailure("current matrix history ancestry unavailable");
      producer = prior.value;
    }
  };
  return await scan();
}
