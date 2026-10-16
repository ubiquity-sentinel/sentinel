import type { ClosedCWaveBindingV1 } from "../src/host/modern-matrix-recovery.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedExecutionIntentV1,
} from "../src/contracts/hosted-supervisor.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import type { ReleaseHistoryViewV1 } from "../src/contracts/ports.ts";
import {
  CurrentMatrixRecoveryIntegrityFailure,
  recoverHostedMatrixProducer,
} from "./hosted-autonomy-producer-recovery.ts";
import {
  CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE,
  isDeferredCurrentMatrixHistoryBudget,
} from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import { HISTORICAL_C63 } from "./hosted-autonomy-matrix-bindings.ts";
import {
  blockedCandidateBinding,
  blockedCandidateMatchesProducer,
  isMatrixRecoveryPending,
} from "../src/host/matrix-blocked-candidate.ts";
import {
  type HostedProducerRecoveryV1,
  type HostedProducerScopeV1,
  producerPointerConsistent,
  producerWanted,
} from "./hosted-autonomy-producer-requests.ts";

/**
 * While in-flight work is pending, the blocker-bound traversal stops reading
 * back once only this much of the walk budget is left for the ordinary walk.
 */
const BLOCKER_WALK_RESERVE_MS = 30_000;

/** Reservations owned by the fixed historical passes, never by this walk. */
export function dedicatedMatrixReservations(
  deps: HostedAutonomyDepsV1,
  binding: ClosedCWaveBindingV1,
): Set<string> {
  return new Set<string>([
    ...binding.cells.map((row) => row.reservationId),
    ...(deps.historicalMatrix
      ? HISTORICAL_C63.rows.map((row) => row.reservation)
      : []),
    ...(deps.historicalMatrix?.historicalReleaseWitnesses?.flatMap((row) =>
      row.reservationIds
    ) ?? []),
  ]);
}

export async function recoverHostedCurrentMatrix(
  deps: HostedAutonomyDepsV1,
  binding: ClosedCWaveBindingV1,
  onDeferred: () => void,
  onUnrecoverable: (kind: "expired" | "unlisted") => void = () => {},
): Promise<HostedAutonomyResultV1 | null> {
  if (!deps.closedMatrix) return null;
  const deadlineAt = deps.clock.now() + 60_000;
  const dedicated = dedicatedMatrixReservations(deps, binding);
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
  const covered = new Set<string>();
  // Reservations of a newer producer whose plan evidence is gone: no older
  // wave may settle them in this walk.
  const excluded = new Set<string>();
  const pending = repair.value.snapshot.work.filter((row) =>
    isMatrixRecoveryPending(row) &&
    !dedicated.has(row.intent?.requestId ?? "")
  );
  // Bounded diagnostic counters only: integers, never record content.
  const progress = {
    steps: 0,
    producers: 0,
    sequence: current.snapshot.sequence,
  };
  const report = (outcome: "deferred_budget" | "deferred_producer") =>
    console.log(JSON.stringify({
      kind: "sentinel_current_matrix_walk",
      outcome,
      ...progress,
    }));
  // One complete release fetch serves the whole walk; when the bounded view
  // is unavailable the walk keeps its exact per-step history reads. Either
  // reader's result passes the same head, sequence and cycle refusals below.
  const history: { view: ReleaseHistoryViewV1 | null | undefined } = {
    view: undefined,
  };
  const readParent = async (commit: GitSha) => {
    if (history.view === undefined) {
      history.view = null;
      try {
        const opened = await deps.state.openReleaseHistory?.({
          expectedHead: current.head,
        });
        if (opened?.ok) history.view = opened.value;
      } catch {
        history.view = null;
      }
    }
    return history.view !== null
      ? await history.view.readAt(commit)
      : await deps.state.readReleaseAt!({
        commit,
        expectedHead: current.head,
      });
  };
  /**
   * One newest-to-oldest traversal under every history refusal. `visit`
   * sees each ordinary producer once, at the newest snapshot holding its
   * proof, and returns true to stop; `step` bounds how far it reads back.
   */
  const traverse = async (
    visit: (
      producer: typeof current,
      execution: HostedExecutionIntentV1,
    ) => Promise<boolean>,
    step: () => boolean,
  ): Promise<void> => {
    const snapshots = new Set<string>();
    const proofs = new Map<string, string>();
    let producer = current;
    while (true) {
      if (deps.clock.now() >= deadlineAt) {
        throw new Error(CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE);
      }
      if (snapshots.has(producer.head)) {
        throw integrityFailure("current matrix history cycle");
      }
      snapshots.add(producer.head);
      progress.steps++;
      progress.sequence = producer.snapshot.sequence;
      const producerRuntime = producer.snapshot.hostedRuntimes.find((row) =>
        row.id === HOSTED_RUNTIME_ID
      );
      const saved = producerRuntime?.lastExecutionProof;
      // An owner install moves the active pointer to a later generation and
      // keeps the previous ordinary proof. That snapshot is not the proof's
      // custody snapshot: read past it to the older snapshot of the same
      // execution instead of failing every later maintenance on it. Any other
      // pointer mismatch still reaches the producer's integrity refusal.
      const ownerInstall = producerRuntime !== undefined && !!saved &&
        saved.outcome !== "not_started" &&
        saved.execution.releaseId === null &&
        producerRuntime.generation > saved.execution.generation;
      if (
        producerRuntime?.execution === null && saved && !ownerInstall &&
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
            // Every producer snapshot must hold its own proof's pointer, the
            // same refusal the producer pass applies, before any skip below.
            if (!producerPointerConsistent(producerRuntime, saved.execution)) {
              throw integrityFailure(
                "current matrix producer custody unavailable",
              );
            }
            if (await visit(producer, saved.execution)) return;
          }
        }
      }
      const parent = producer.snapshot.stateHead;
      if (parent === null) {
        if (producer.snapshot.sequence !== 1) {
          throw integrityFailure("current matrix history root unavailable");
        }
        return;
      }
      if (!step()) return;
      // Unauthenticated or tampered release history stays fail-closed: the
      // offline-history controls pin a rejection for missing, wrong-head,
      // wrong-sequence and cycle faults.
      if (snapshots.has(parent) || !deps.state.readReleaseAt) {
        throw integrityFailure("current matrix history unavailable");
      }
      const prior = await readParent(parent);
      if (
        !prior.ok || prior.value.status !== "found" ||
        prior.value.head !== parent ||
        prior.value.snapshot.sequence !== producer.snapshot.sequence - 1
      ) throw integrityFailure("current matrix history ancestry unavailable");
      producer = prior.value;
    }
  };
  const recover = (producer: typeof current, scope: HostedProducerScopeV1) => {
    progress.producers++;
    return recoverHostedMatrixProducer(
      deps,
      current,
      producer,
      deadlineAt,
      covered,
      new Set([...dedicated, ...excluded]),
      onDeferred,
      readParent,
      scope,
    );
  };
  const reported = new Set<string>();
  const unrecoverable = (
    execution: HostedExecutionIntentV1,
    lost: NonNullable<HostedProducerRecoveryV1["unrecoverable"]>,
  ) => {
    for (const id of lost.reservations) covered.add(id);
    // A producer both walks reach is one lost plan, reported once.
    const identity = canonicalStringify(execution);
    if (reported.has(identity)) return;
    reported.add(identity);
    onUnrecoverable(lost.kind);
    console.log(JSON.stringify({
      kind: "sentinel_current_matrix_producer_unrecoverable",
      runId: execution.runId,
      runAttempt: execution.runAttempt,
      artifact: lost.kind,
      requests: lost.reservations.length,
    }));
  };
  const scan = async (): Promise<HostedAutonomyResultV1 | null> => {
    const walked: { done: boolean; result: HostedAutonomyResultV1 | null } = {
      done: false,
      result: null,
    };
    // A runtime-mismatch candidate binds to exactly the producer its blocker
    // names (run, attempt and runtime): no other producer, newer or older, can
    // request or settle it, so no newer producer's outcome can withhold it.
    // Those producers are visited first, under the same refusals, requesting
    // only those candidates: their plan artifacts expire, and newer producers
    // that only in-flight work binds to may otherwise spend every budget.
    const parked = new Set(
      pending.filter((row) => blockedCandidateBinding(row) !== null),
    );
    // In-flight work keeps the newest-first walk below; while it is pending,
    // the first traversal leaves that walk its reserve of the budget.
    const inFlight = parked.size < pending.length;
    if (parked.size > 0) {
      await traverse(
        async (producer, execution) => {
          const bound = [...parked].filter((row) =>
            blockedCandidateMatchesProducer(row, execution)
          );
          if (bound.length === 0) return false;
          for (const row of bound) parked.delete(row);
          const produced = await recover(producer, "blocked");
          // A deferred pass may already have applied a write: stop as the
          // ordinary walk does, so one walk never writes past that pass.
          if (produced.deferred) {
            report("deferred_producer");
            walked.done = true;
          } else if (produced.result?.status === "applied") {
            walked.done = true;
            walked.result = produced.result;
          } else if (produced.unrecoverable) {
            // Nothing was written. These candidates stay requestable by their
            // own producer in the walk below, which repeats this classification
            // for every request it binds there.
            unrecoverable(execution, produced.unrecoverable);
          }
          return walked.done || parked.size === 0;
        },
        () =>
          !inFlight || deps.clock.now() < deadlineAt - BLOCKER_WALK_RESERVE_MS,
      );
      if (walked.done || !inFlight) return walked.result;
    }
    await traverse(async (producer, execution) => {
      // A producer no pending record can bind to costs no custody, target or
      // artifact read: nothing could be recovered from it.
      if (!producerWanted(pending, execution, excluded)) return false;
      const produced = await recover(producer, "all");
      // An unresolved newer producer stops older-history recovery: an older
      // wave must never settle a reservation whose newer producer outcome is
      // still unavailable.
      if (produced.deferred) {
        report("deferred_producer");
        return true;
      }
      if (produced.result?.status === "applied") {
        walked.result = produced.result;
        return true;
      }
      const lost = produced.unrecoverable;
      if (lost) {
        for (const id of lost.reservations) excluded.add(id);
        unrecoverable(execution, lost);
      }
      return pending.every((row) =>
        row.intent?.requestId && covered.has(row.intent.requestId)
      );
    }, () => true);
    return walked.result;
  };
  try {
    return await scan();
  } catch (error) {
    if (isDeferredCurrentMatrixHistoryBudget(error)) report("deferred_budget");
    throw error;
  } finally {
    await history.view?.close();
  }
}
