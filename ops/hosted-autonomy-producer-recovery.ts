import { ingestMatrixResults } from "../src/host/matrix.ts";
import { matrixDigestV1 } from "../src/contracts/matrix.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedRunProofV1,
} from "../src/contracts/hosted-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { implementationIntentKey } from "../src/repair/keys.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../src/contracts/ports.ts";
import { CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE } from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
} from "./hosted-autonomy-types.ts";
import { HISTORICAL_RECOVERY_PROVIDERS } from "./hosted-autonomy-matrix-bindings.ts";

export async function recoverHostedMatrixProducer(
  deps: HostedAutonomyDepsV1,
  current: { head: GitSha; snapshot: ReleaseStateSnapshotV1 },
  producer: { head: GitSha; snapshot: ReleaseStateSnapshotV1 },
  deadlineAt: number,
  covered: Set<string>,
  dedicated: ReadonlySet<string>,
  onDeferred: () => void,
): Promise<{ result: HostedAutonomyResultV1 | null; deferred: boolean }> {
  const checkDeadline = () => {
    if (deps.clock.now() >= deadlineAt) {
      throw new Error(CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE);
    }
  };
  checkDeadline();
  const repair = await deps.state.readRepair();
  checkDeadline();
  if (!repair.ok || repair.value.status !== "found") {
    onDeferred();
    return { result: null, deferred: true };
  }
  const before = repair.value;
  const runtime = producer.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  );
  const saved = runtime?.lastExecutionProof;
  if (
    !runtime || !saved || saved.outcome === "not_started" ||
    saved.execution.purpose !== "ordinary"
  ) return { result: null, deferred: false };
  if (
    runtime.execution !== null || saved.execution.releaseId !== null ||
    runtime.activeRevision !== saved.execution.revision ||
    runtime.generation !== saved.execution.generation ||
    current.snapshot.hostedReleases.some((row) =>
      !["accepted", "rolled_back", "cancelled"].includes(row.phase)
    )
  ) throw new Error("current matrix producer custody unavailable");
  const custody = async () => {
    if (deps.clock.now() >= deadlineAt) {
      throw new Error(CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE);
    }
    const fresh = await deps.state.readRelease();
    checkDeadline();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      fresh.value.head !== current.head ||
      canonicalStringify(fresh.value.snapshot) !==
        canonicalStringify(current.snapshot)
    ) {
      throw new Error("current matrix release custody changed");
    }
    if (producer.head !== current.head) {
      checkDeadline();
      const prior = await deps.state.readReleaseAt?.({
        commit: producer.head,
        expectedHead: current.head,
      });
      checkDeadline();
      if (
        !prior?.ok || prior.value.status !== "found" ||
        prior.value.head !== producer.head ||
        canonicalStringify(prior.value.snapshot) !==
          canonicalStringify(producer.snapshot)
      ) throw new Error("current matrix producer ancestry changed");
    }
  };
  const state: StateReadView & RepairStateWriter = {
    readRepair: () => deps.state.readRepair(),
    readRelease: () => deps.state.readRelease(),
    writeRepair: async (next, expectedHead) => {
      await custody();
      checkDeadline();
      return await deps.state.writeRepair(next, expectedHead);
    },
  };
  // Native reads, cooldown, budget and consumer writes all use this SAME
  // composed writer; changing only cycle.state would leave captured writers.
  checkDeadline();
  const ports = await deps.closedMatrix!(state);
  checkDeadline();
  const requests = before.snapshot.work.flatMap((record) => {
    const intent = record.intent;
    if (
      record.nextStep !== "work" || !intent ||
      !["implementation", "candidate_preservation"].includes(intent.kind) ||
      dedicated.has(intent.requestId ?? "")
    ) return [];
    const charge = before.snapshot.reservations.find((row) =>
      row.id === intent.requestId
    );
    if (
      !charge || record.source.kind !== "issue" ||
      canonicalStringify(charge.repository) !==
        canonicalStringify(record.repository) ||
      charge.taskId !== record.id || charge.head !== record.target.base ||
      charge.attempt !== record.counters.attempts ||
      !["implementation", "retry"].includes(charge.purpose) ||
      charge.outcome === "confirmed_not_submitted" ||
      intent.key !== implementationIntentKey(charge.id) ||
      intent.observedBase !== record.target.base || intent.resultId !== null
    ) {
      throw new Error("current matrix request binding unavailable");
    }
    if (
      !ports.configs.some((config) =>
        canonicalStringify(config.repository) ===
          canonicalStringify(record.repository)
      )
    ) return [];
    return [{
      taskId: record.id,
      repository: record.repository,
      reservationId: charge.id,
      intentKey: intent.key,
      expectedBase: record.target.base,
      attempt: record.counters.attempts,
    }];
  });
  if (requests.length === 0) return { result: null, deferred: false };
  const producerState: StateReadView & RepairStateWriter = {
    ...state,
    readRelease: () =>
      producer.head === current.head
        ? state.readRelease()
        : deps.state.readReleaseAt!({
          commit: producer.head,
          expectedHead: current.head,
        }),
  };
  checkDeadline();
  const transport = await ports.transportFor(producerState);
  checkDeadline();
  if (
    !transport.confirmCompletedExecution ||
    !await transport.confirmCompletedExecution(saved.execution)
  ) {
    // A producer whose own native run is still in flight is not recoverable
    // yet; stop the history traversal and defer instead of failing.
    onDeferred();
    return { result: null, deferred: true };
  }
  checkDeadline();
  const native = await ports.readExecution(saved.execution);
  checkDeadline();
  if (!native.ok || native.value === null) {
    onDeferred();
    return { result: null, deferred: true };
  }
  if (native.value.outcome === "not_started") {
    throw new Error("current matrix native proof unavailable");
  }
  const proof = parseHostedRunProofV1(native.value);
  if (
    canonicalStringify({ ...proof, observedAt: 0 }) !==
      canonicalStringify({ ...saved, observedAt: 0 })
  ) {
    throw new Error("current matrix native proof changed");
  }
  await custody();
  const waves = await transport.recover({
    requests,
    runtimeSha: saved.execution.revision,
    launcherSha: saved.execution.launcherSha,
    currentRun: {
      runId: saved.execution.runId,
      runAttempt: saved.execution.runAttempt,
      launcherSha: saved.execution.launcherSha,
    },
    deadline: deadlineAt,
  });
  checkDeadline();
  if (waves.length !== 1) throw new Error("current matrix wave unavailable");
  const wave = waves[0];
  if (
    wave.plan.waveId !== saved.execution.id ||
    wave.plan.run.runId !== saved.execution.runId ||
    wave.plan.run.runAttempt !== saved.execution.runAttempt ||
    wave.plan.run.launcherSha !== saved.execution.launcherSha ||
    canonicalStringify(wave.provenance.run) !==
      canonicalStringify(wave.plan.run) ||
    wave.planDigest !== await matrixDigestV1(wave.plan) ||
    wave.plan.cells.some((cell) =>
      cell.runtimeSha !== saved.execution.revision ||
      cell.generation !== saved.execution.generation
    )
  ) {
    throw new Error("current matrix wave binding changed");
  }
  const intersection = wave.plan.cells.filter((cell) =>
    requests.some((request) => request.reservationId === cell.reservationId)
  );
  if (intersection.length === 0) {
    await custody();
    const fresh = await state.readRepair();
    if (
      !fresh.ok || fresh.value.status !== "found" ||
      fresh.value.head !== before.head ||
      canonicalStringify(fresh.value.snapshot) !==
        canonicalStringify(before.snapshot)
    ) {
      throw new Error("current matrix repair custody changed");
    }
    return { result: null, deferred: false };
  }
  const fresh = await state.readRepair();
  if (
    !fresh.ok || fresh.value.status !== "found" ||
    fresh.value.head !== before.head ||
    canonicalStringify(fresh.value.snapshot) !==
      canonicalStringify(before.snapshot)
  ) {
    throw new Error("current matrix repair custody changed");
  }
  let ingested = 0;
  const selected = new Set<string>();
  const selectedTasks = new Set<string>();
  for (const config of ports.configs) {
    const cells = wave.plan.cells.filter((cell) =>
      requests.some((request) =>
        request.reservationId === cell.reservationId
      ) &&
      canonicalStringify(cell.repository) ===
        canonicalStringify(config.repository)
    );
    if (cells.length === 0) continue;
    for (const cell of cells) {
      selected.add(cell.reservationId);
      selectedTasks.add(cell.taskId);
    }
    await custody();
    await ports.prepareTarget(config);
    checkDeadline();
    const report = await ingestMatrixResults(
      {
        ...ports.cycleFor(config),
        state,
        controllerSha: saved.execution.revision,
        externalImplementations: true,
      },
      { ...wave.plan, cells },
      wave.results.filter((result) =>
        cells.some((cell) => cell.cellId === result.cellId)
      ),
      {
        deadline: deadlineAt,
        expectedProvider: HISTORICAL_RECOVERY_PROVIDERS,
        bundleImporter: ports.importerFor(config, wave.bundlesDir),
      },
    );
    // A missing current artifact is a completed timeout disposition: the
    // normal consumer records the host timeout, clears the intent and emits
    // `missing`, so it must not fail the maintenance pass after that write.
    // "foreign", "binding_mismatch", and "absent" are expected when the owner
    // works in parallel (manual PRs, rebased branches); they are benign and
    // must not fail maintenance. Only "state_error" (repair state unavailable)
    // is a real failure.
    const benignDispositions = [
      "ingested",
      "duplicate",
      "missing",
      "foreign",
      "binding_mismatch",
      "absent",
    ];
    const badEntries = report.entries.filter(
      (entry) => !benignDispositions.includes(entry.disposition),
    );
    if (
      badEntries.length > 0 ||
      report.entries.length !== cells.length
    ) {
      const detail = badEntries.length > 0
        ? `bad dispositions: ${
          badEntries.map((e) => `${e.cellId}:${e.disposition}`).join(", ")
        }`
        : `entry count ${report.entries.length} != cell count ${cells.length}`;
      throw new Error(`current matrix ingestion incomplete (${detail})`);
    }
    // Non-silent accounting for owner-parallel disposals: tolerated
    // dispositions are still counted and reported with fixed keys only.
    const benignCounts = {
      foreign: report.entries.filter((e) => e.disposition === "foreign").length,
      binding_mismatch: report.entries.filter((e) =>
        e.disposition === "binding_mismatch"
      )
        .length,
      absent: report.entries.filter((e) => e.disposition === "absent").length,
    };
    if (
      benignCounts.foreign + benignCounts.binding_mismatch +
          benignCounts.absent > 0
    ) {
      console.log(JSON.stringify({
        kind: "sentinel_matrix_ingest_benign",
        waveId: wave.plan.waveId,
        ...benignCounts,
      }));
    }
    checkDeadline();
    ingested += report.ingested;
  }
  if (selected.size === 0) {
    throw new Error("current matrix selected evidence unavailable");
  }
  await custody();
  const after = await state.readRepair();
  if (
    !after.ok || after.value.status !== "found" ||
    canonicalStringify(after.value.snapshot.reviews) !==
      canonicalStringify(before.snapshot.reviews) ||
    canonicalStringify(after.value.snapshot.releaseRequests) !==
      canonicalStringify(before.snapshot.releaseRequests) ||
    canonicalStringify(
        after.value.snapshot.work.filter((row) => !selectedTasks.has(row.id)),
      ) !==
      canonicalStringify(
        before.snapshot.work.filter((row) => !selectedTasks.has(row.id)),
      ) ||
    canonicalStringify(
        after.value.snapshot.reservations.filter((row) =>
          !selected.has(row.id)
        ),
      ) !==
      canonicalStringify(
        before.snapshot.reservations.filter((row) => !selected.has(row.id)),
      )
  ) {
    throw new Error("current matrix readback incomplete");
  }
  for (const id of selected) covered.add(id);
  return {
    result: {
      kind: "hosted_autonomy",
      status: after.value.head === before.head ? "skipped" : "applied",
      reason: after.value.head === before.head ? "no_change" : "applied",
      beforeHead: before.head,
      appliedHead: after.value.head,
      actions: [`current-matrix:ingested:${ingested}`],
      revisions: [],
    },
    deferred: false,
  };
}
