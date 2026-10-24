import type {
  IncidentAdapter,
  RepairStateWriter,
  ReplayPort,
  StateReadView,
} from "../src/contracts/ports.ts";
import { ingestMatrixResults } from "../src/host/matrix.ts";
import { matrixDigestV1 } from "../src/contracts/matrix.ts";
import {
  HOSTED_RUNTIME_ID,
  isHostedReleaseTerminal,
  parseHostedRunProofV1,
} from "../src/contracts/hosted-supervisor.ts";
import { RollingStartBudget } from "../src/budget/mod.ts";
import { HostedRepairCooldownGate } from "../src/host/hosted-cooldown.ts";
import type { HistoricalMatrixQuarantineDepsV1 } from "../src/host/matrix-actions.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { implementationIntentKey } from "../src/repair/keys.ts";
import { createLocalRepositoryConfig } from "../src/host/local.ts";
import {
  MaintenanceQueueCustodyUnavailable,
  maintenanceQueueOnlyPort,
} from "../src/host/maintenance-native-queue.ts";
import {
  HISTORICAL_C63,
  HISTORICAL_RECOVERY_PROVIDERS,
  RECOVERY_ROUTE_FAILOVER_MODEL,
} from "./hosted-autonomy-matrix-bindings.ts";

/** Only these three authenticated failed cells may bypass legacy rejection. */
export async function recoverHostedHistoricalC63(
  deps: HistoricalMatrixQuarantineDepsV1,
): Promise<{ ingested: number; deferred: boolean }> {
  const repair = await deps.state.readRepair();
  // Missing or temporarily unavailable repair custody defers recovery.
  if (!repair.ok || repair.value.status !== "found") {
    return { ingested: 0, deferred: true };
  }
  const before = repair.value;
  if (
    !HISTORICAL_C63.rows.some((binding) =>
      before.snapshot.work.some((row) => row.id === binding.id) ||
      before.snapshot.reservations.some((row) => row.id === binding.reservation)
    )
  ) return { ingested: 0, deferred: false };
  const captured = HISTORICAL_C63.rows.flatMap((binding) => {
    if (deps.protectedRecordIds?.has(binding.id)) return [];
    const record = before.snapshot.work.find((row) => row.id === binding.id);
    const reservation = before.snapshot.reservations.find((row) =>
      row.id === binding.reservation
    );
    // Only a row absent from BOTH repair halves is treated as already
    // removed. A half-present binding is incomplete custody and fails closed:
    // durable settlement never removes one side alone.
    if (record === undefined && reservation === undefined) return [];
    if (record === undefined || reservation === undefined) {
      throw new Error(
        "historical matrix selected reservation binding unavailable",
      );
    }
    const recoverable = record.nextStep === "work" ||
      (record.nextStep === "blocked" && reservation.outcome === "ambiguous");
    if (!recoverable) return [];
    // A row whose bound C63 charge is already settled ambiguous and whose
    // record no longer carries that admission's intent was moved on by the
    // ordinary retry authority: its failed C63 cell can settle nothing more,
    // so the row is consumed exactly like a removed one. Any other drift from
    // the exact binding still fails closed below.
    if (
      reservation.outcome === "ambiguous" && reservation.settledAt !== null &&
      record.intent?.requestId !== binding.reservation
    ) return [];
    if (
      canonicalStringify(record.repository) !==
        canonicalStringify(HISTORICAL_C63.repository) ||
      canonicalStringify(reservation.repository) !==
        canonicalStringify(record.repository) ||
      record.source.kind !== "issue" ||
      record.related.issueNumber !== binding.issue ||
      record.counters.attempts !== 2 ||
      record.target.base !== HISTORICAL_C63.base ||
      record.target.head !== null || record.target.pr !== null ||
      record.target.checkpoint !== null ||
      record.target.candidateState !== undefined ||
      record.intent?.kind !== "implementation" ||
      record.intent.requestId !== binding.reservation ||
      record.intent.key !== implementationIntentKey(binding.reservation) ||
      record.intent.observedBase !== record.target.base ||
      record.intent.expectedHead !== null || record.intent.resultId !== null ||
      reservation.taskId !== record.id ||
      reservation.head !== record.target.base || reservation.attempt !== 2 ||
      reservation.purpose !== "retry" ||
      !["reserved", "ambiguous"].includes(reservation.outcome) ||
      (reservation.outcome === "reserved"
        ? reservation.settledAt !== null
        : reservation.settledAt === null)
    ) {
      throw new Error(
        "historical matrix selected reservation binding unavailable",
      );
    }
    return [{ binding, record, reservation }];
  });
  if (captured.length === 0) return { ingested: 0, deferred: false };
  const release = await deps.state.readRelease();
  // Missing or temporarily unavailable release custody defers recovery; the
  // pass must never fail because another run holds or lacks the state.
  if (!release.ok || release.value.status !== "found") {
    return { ingested: 0, deferred: true };
  }
  const current = release.value;
  const runtime = current.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  // A missing runtime or a nonterminal release defers recovery; the next
  // maintenance pass re-runs it.
  if (
    !runtime ||
    current.snapshot.hostedReleases.some((row) =>
      !isHostedReleaseTerminal(row.phase)
    )
  ) return { ingested: 0, deferred: true };
  if (runtime.execution !== null) {
    // An unsettled current execution defers recovery; the pass must never
    // fail because another run is still writing.
    if (
      !deps.transport.confirmCompletedExecution ||
      !await deps.transport.confirmCompletedExecution(runtime.execution)
    ) return { ingested: 0, deferred: true };
    const observed = await deps.readExecution(runtime.execution);
    if (
      !observed.ok || observed.value === null ||
      canonicalStringify(observed.value.execution) !==
        canonicalStringify(runtime.execution)
    ) throw new Error("historical matrix current native binding changed");
  }
  const witness = deps.historicalReleaseWitnesses?.find((row) =>
    row.executionId === HISTORICAL_C63.executionId &&
    HISTORICAL_C63.rows.every((binding) =>
      row.reservationIds.includes(binding.reservation)
    )
  );
  const historical = witness
    ? await deps.state.readReleaseAt?.({
      commit: witness.commit,
      expectedHead: current.head,
    })
    : null;
  if (
    witness &&
    (!historical?.ok || historical.value.status !== "found" ||
      historical.value.head !== witness.commit)
  ) return { ingested: 0, deferred: true };
  const saved = historical?.ok && historical.value.status === "found"
    ? historical.value.snapshot.hostedRuntimes.find((row) =>
      row.id === HOSTED_RUNTIME_ID
    )?.lastExecutionProof
    : runtime.lastExecutionProof;
  // A configured, readable witness must carry the exact C63 failed proof. A
  // missing or different proof inside a present witness commit is tampered or
  // mismatched history and fails closed; only genuinely absent custody defers.
  const execution = witness
    ? (saved?.execution.id === HISTORICAL_C63.executionId
      ? saved.execution
      : null)
    : saved?.execution.id === HISTORICAL_C63.executionId
    ? saved.execution
    : runtime.execution?.id === HISTORICAL_C63.executionId
    ? runtime.execution
    : null;
  if (witness && execution === null) {
    throw new Error("historical matrix release witness binding changed");
  }
  if (!execution) return { ingested: 0, deferred: true };
  if (
    execution.runId !== HISTORICAL_C63.run.runId ||
    execution.runAttempt !== HISTORICAL_C63.run.runAttempt ||
    execution.launcherSha !== HISTORICAL_C63.run.launcherSha ||
    execution.revision !== HISTORICAL_C63.runtimeSha ||
    execution.generation !== HISTORICAL_C63.generation ||
    execution.purpose !== "ordinary" || execution.releaseId !== null ||
    (witness &&
      (!saved || saved.outcome !== "failed" ||
        saved.logDigest !== witness.logDigest))
  ) throw new Error("historical matrix release witness binding changed");
  const custody = async () => {
    const fresh = await deps.state.readRelease();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      fresh.value.head !== current.head ||
      canonicalStringify(fresh.value.snapshot) !==
        canonicalStringify(current.snapshot)
    ) throw new Error("historical matrix current custody changed");
    if (witness) {
      const prior = await deps.state.readReleaseAt?.({
        commit: witness.commit,
        expectedHead: current.head,
      });
      if (
        !prior?.ok || prior.value.status !== "found" ||
        prior.value.head !== witness.commit ||
        canonicalStringify(prior.value.snapshot) !==
          canonicalStringify(
            historical?.ok && historical.value.status === "found"
              ? historical.value.snapshot
              : null,
          )
      ) throw new Error("historical matrix release witness binding changed");
    }
  };
  await custody();
  const pending = captured.filter((row) => row.record.nextStep === "work");
  if (pending.length === 0) return { ingested: 0, deferred: false };
  const native = await deps.readExecution(execution);
  if (
    !native.ok || native.value === null || native.value.outcome !== "failed"
  ) throw new Error("historical matrix native settlement unavailable");
  const proof = parseHostedRunProofV1(native.value);
  if (
    canonicalStringify(proof.execution) !== canonicalStringify(execution) ||
    (saved?.execution.id === execution.id &&
      canonicalStringify({ ...proof, observedAt: 0 }) !==
        canonicalStringify({ ...saved, observedAt: 0 }))
  ) throw new Error("historical matrix native custody unavailable");
  const requests = pending.map(({ record, binding }) => ({
    taskId: record.id,
    repository: record.repository,
    reservationId: binding.reservation,
    intentKey: record.intent!.key,
    expectedBase: record.target.base,
    attempt: record.counters.attempts,
  }));
  const deadlineAt = deps.clock.now() + 60_000;
  const waves = await deps.transport.recover({
    requests,
    runtimeSha: HISTORICAL_C63.runtimeSha,
    launcherSha: HISTORICAL_C63.run.launcherSha,
    currentRun: HISTORICAL_C63.run,
    deadline: deadlineAt,
  });
  if (waves.length !== 1) {
    throw new Error("historical matrix native custody unavailable");
  }
  const wave = waves[0];
  if (
    wave.plan.waveId !== HISTORICAL_C63.executionId ||
    canonicalStringify(wave.plan.run) !==
      canonicalStringify(HISTORICAL_C63.run) ||
    canonicalStringify(wave.provenance.run) !==
      canonicalStringify(HISTORICAL_C63.run) ||
    wave.planDigest !== await matrixDigestV1(wave.plan) ||
    wave.results.length !== pending.length ||
    pending.some(({ binding }) =>
      !wave.plan.cells.some((cell) =>
        cell.cellId === binding.cellId && cell.taskId === binding.id &&
        cell.reservationId === binding.reservation &&
        cell.runtimeSha === HISTORICAL_C63.runtimeSha &&
        cell.generation === HISTORICAL_C63.generation
      ) || wave.results.filter((result) =>
          result.cellId === binding.cellId && result.taskId === binding.id &&
          result.reservationId === binding.reservation &&
          result.status === "not_started" && result.receipt === null &&
          result.bundle === null
        ).length !== 1
    )
  ) throw new Error("historical matrix native custody unavailable");
  await custody();
  const freshRepair = await deps.state.readRepair();
  if (
    !freshRepair.ok || freshRepair.value.status !== "found" ||
    freshRepair.value.head !== before.head ||
    canonicalStringify(freshRepair.value.snapshot) !==
      canonicalStringify(before.snapshot)
  ) throw new Error("historical matrix captured identity changed");
  const config = {
    ...createLocalRepositoryConfig(),
    repository: HISTORICAL_C63.repository,
  };
  // Both budget settlement and work persistence retain the same current and
  // historical release custody gate before each real expected-head write.
  const state: StateReadView & RepairStateWriter = {
    readRepair: () => deps.state.readRepair(),
    readRelease: () => deps.state.readRelease(),
    writeRepair: async (next, expectedHead) => {
      await custody();
      return deps.state.writeRepair(next, expectedHead);
    },
  };
  const gate = new HostedRepairCooldownGate({
    state,
    clock: deps.clock,
  });
  const nativeQueue = deps.nativeQueueFor?.(config.repository, state);
  if (nativeQueue === undefined) return { ingested: 0, deferred: true };
  for (const { record } of pending) {
    if (
      (await nativeQueue.inspect({
        record,
        operation: "resume",
        deadline: deadlineAt,
      })).status !== "allow"
    ) {
      return { ingested: 0, deferred: true };
    }
  }
  const refused = <T>(): T =>
    new Proxy({}, {
      get: () => () =>
        Promise.reject(new Error("C63 maintenance capability refused")),
    }) as T;
  const selected = new Set<string>(
    requests.map((request) => request.reservationId),
  );
  let report;
  try {
    report = await ingestMatrixResults(
      {
        state,
        clock: deps.clock,
        configs: [config],
        controllerSha: HISTORICAL_C63.runtimeSha,
        github: maintenanceQueueOnlyPort(nativeQueue),
        githubCooldown: gate,
        incidents: refused<IncidentAdapter>(),
        replay: refused<ReplayPort>(),
        model: {
          runModel: () =>
            Promise.reject(new Error("C63 maintenance model refused")),
        },
        budget: new RollingStartBudget({
          state,
          clock: deps.clock,
          configs: [config],
        }),
        externalImplementations: true,
      },
      {
        ...wave.plan,
        cells: wave.plan.cells.filter((cell) =>
          selected.has(cell.reservationId)
        ),
      },
      wave.results,
      {
        deadline: deadlineAt,
        expectedProvider: HISTORICAL_RECOVERY_PROVIDERS,
        failoverModel: RECOVERY_ROUTE_FAILOVER_MODEL,
      },
    );
  } catch (error) {
    if (!(error instanceof MaintenanceQueueCustodyUnavailable)) throw error;
    await custody();
    return { ingested: 0, deferred: true };
  }
  if (report.ingested !== pending.length) {
    throw new Error("historical matrix settlement incomplete");
  }
  await custody();
  const readback = await deps.state.readRepair();
  if (!readback.ok || readback.value.status !== "found") {
    throw new Error("historical matrix block readback incomplete");
  }
  const after = readback.value.snapshot;
  for (const { record, reservation } of pending) {
    const changed = after.work.find((row) => row.id === record.id);
    const charge = after.reservations.find((row) => row.id === reservation.id);
    if (
      !changed || !charge || changed.nextStep !== "blocked" ||
      changed.blocker?.kind !== "other" || charge.outcome !== "ambiguous" ||
      charge.settledAt === null ||
      canonicalStringify({
          ...changed,
          nextStep: record.nextStep,
          blocker: record.blocker,
          wait: record.wait,
          updatedAt: record.updatedAt,
        }) !== canonicalStringify(record) ||
      canonicalStringify({
          ...charge,
          outcome: reservation.outcome,
          settledAt: reservation.settledAt,
        }) !== canonicalStringify(reservation)
    ) throw new Error("historical matrix block readback incomplete");
  }
  const normalized = {
    ...after,
    stateHead: before.snapshot.stateHead,
    sequence: before.snapshot.sequence,
    updatedAt: before.snapshot.updatedAt,
    work: after.work.map((row) =>
      pending.find((saved) => saved.record.id === row.id)?.record ?? row
    ),
    reservations: after.reservations.map((row) =>
      pending.find((saved) => saved.reservation.id === row.id)?.reservation ??
        row
    ),
  };
  // The durable attempt-memory and lessons sections are growth-only side
  // effects of the same normal-consumer settlement; every other section must
  // be byte-identical to the captured snapshot.
  const expected = {
    ...before.snapshot,
    attemptMemory: normalized.attemptMemory,
    lessons: normalized.lessons,
  };
  if (canonicalStringify(normalized) !== canonicalStringify(expected)) {
    throw new Error("historical matrix block readback incomplete");
  }
  return { ingested: report.ingested, deferred: false };
}
