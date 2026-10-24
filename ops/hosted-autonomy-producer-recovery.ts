import { ingestMatrixResults } from "../src/host/matrix.ts";
import type { MatrixIngestOptionsV1 } from "../src/host/matrix-ingest.ts";
import { matrixDigestV1 } from "../src/contracts/matrix.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedExecutionSettlementV1,
  isHostedReleaseTerminal,
  parseHostedRunProofV1,
} from "../src/contracts/hosted-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { GitSha } from "../src/contracts/brands.ts";
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type {
  PortResultV1,
  RepairStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import { CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE } from "./hosted-autonomy-policy.ts";
import type { HostedAutonomyDepsV1 } from "./hosted-autonomy-types.ts";
import {
  HISTORICAL_RECOVERY_PROVIDERS,
  RECOVERY_ROUTE_FAILOVER_MODEL,
} from "./hosted-autonomy-matrix-bindings.ts";
import {
  blockedCandidateBinding,
  blockedImplementationBinding,
} from "../src/host/matrix-blocked-candidate.ts";
import {
  isInflightPreservation,
  restoreBlockedCandidate,
  restoreInflightCandidate,
} from "./hosted-autonomy-blocked-candidate.ts";
import {
  type HostedProducerRecoveryV1,
  type HostedProducerScopeV1,
  producerPointerConsistent,
  producerRequests,
  unrecoverablePlan,
} from "./hosted-autonomy-producer-requests.ts";
import {
  outputBoundCells,
  settleOutputBoundCells,
} from "./hosted-autonomy-output-bound.ts";

export class CurrentMatrixRecoveryIntegrityFailure extends Error {
  constructor(
    message: string,
    readonly beforeHead: GitSha,
    readonly appliedHead: GitSha | null,
    readonly writeResult: PortResultV1<StateWriteResultV1> | null,
  ) {
    super(message);
    this.name = "CurrentMatrixRecoveryIntegrityFailure";
  }
}

/** Reads one historical release snapshot of the walk's verified history. */
export type HostedProducerReaderV1 = (
  commit: GitSha,
) => ReturnType<NonNullable<HostedAutonomyDepsV1["state"]["readReleaseAt"]>>;

export async function recoverHostedMatrixProducer(
  deps: HostedAutonomyDepsV1,
  current: { head: GitSha; snapshot: ReleaseStateSnapshotV1 },
  producer: { head: GitSha; snapshot: ReleaseStateSnapshotV1 },
  deadlineAt: number,
  covered: Set<string>,
  dedicated: ReadonlySet<string>,
  onDeferred: () => void,
  readProducer?: HostedProducerReaderV1,
  scope: HostedProducerScopeV1 = "all",
): Promise<HostedProducerRecoveryV1> {
  // Every repair write of this pass (consumer, restore and cooldown) goes
  // through its one composed writer, which marks this before writing; a
  // consumer deferral marks it too.
  const writes = { attempted: false };
  try {
    const outcome = await recoverProducerWithinBudget(
      deps,
      current,
      producer,
      deadlineAt,
      covered,
      dedicated,
      onDeferred,
      readProducer,
      scope,
      writes,
    );
    return { ...outcome, mayHaveWritten: writes.attempted };
  } catch (error) {
    // Past the walk's budget every availability failure (a transport
    // refusal, a listing or operation timeout) is the bounded deferral, so
    // the later retry and delivery passes still run. Integrity stays fatal,
    // and every applied write was already custody-checked by compare-and-swap.
    if (
      !(error instanceof CurrentMatrixRecoveryIntegrityFailure) &&
      deps.clock.now() >= deadlineAt
    ) throw new Error(CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE);
    throw error;
  }
}

async function recoverProducerWithinBudget(
  deps: HostedAutonomyDepsV1,
  current: { head: GitSha; snapshot: ReleaseStateSnapshotV1 },
  producer: { head: GitSha; snapshot: ReleaseStateSnapshotV1 },
  deadlineAt: number,
  covered: Set<string>,
  dedicated: ReadonlySet<string>,
  onDeferred: () => void,
  readProducer: HostedProducerReaderV1 | undefined,
  scope: HostedProducerScopeV1,
  writes: { attempted: boolean },
): Promise<Omit<HostedProducerRecoveryV1, "mayHaveWritten">> {
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
    runtime.execution !== null ||
    current.snapshot.hostedReleases.some((row) =>
      !isHostedReleaseTerminal(row.phase)
    )
  ) throw new Error("current matrix producer custody unavailable");
  if (!producerPointerConsistent(runtime, saved.execution)) {
    throw new CurrentMatrixRecoveryIntegrityFailure(
      "current matrix producer custody unavailable",
      before.head,
      null,
      null,
    );
  }
  const custody = async (bounded = true) => {
    if (bounded) checkDeadline();
    const fresh = await deps.state.readRelease();
    if (bounded) checkDeadline();
    if (!fresh.ok || fresh.value.status !== "found") {
      throw new Error("current matrix producer custody unavailable");
    }
    if (
      fresh.value.head !== current.head ||
      canonicalStringify(fresh.value.snapshot) !==
        canonicalStringify(current.snapshot)
    ) {
      throw new CurrentMatrixRecoveryIntegrityFailure(
        "current matrix release custody changed",
        before.head,
        appliedHead,
        null,
      );
    }
    if (producer.head !== current.head) {
      if (bounded) checkDeadline();
      // The release head was just re-proved unchanged, so the walk's
      // verified history view still holds exactly this producer commit.
      const prior = readProducer
        ? await readProducer(producer.head)
        : await deps.state.readReleaseAt?.({
          commit: producer.head,
          expectedHead: current.head,
        });
      if (bounded) checkDeadline();
      if (!prior?.ok || prior.value.status !== "found") {
        throw new Error("current matrix producer custody unavailable");
      }
      if (
        prior.value.head !== producer.head ||
        canonicalStringify(prior.value.snapshot) !==
          canonicalStringify(producer.snapshot)
      ) {
        throw new CurrentMatrixRecoveryIntegrityFailure(
          "current matrix producer ancestry changed",
          before.head,
          appliedHead,
          null,
        );
      }
    }
  };
  let integrityFailure: CurrentMatrixRecoveryIntegrityFailure | null = null;
  let appliedHead: GitSha | null = null;
  const integrityFault = (message: string) =>
    new CurrentMatrixRecoveryIntegrityFailure(
      message,
      before.head,
      appliedHead,
      null,
    );
  const state: StateReadView & RepairStateWriter = {
    readRepair: () => deps.state.readRepair(),
    readRelease: () => deps.state.readRelease(),
    writeRepair: async (next, expectedHead) => {
      writes.attempted = true;
      if (integrityFailure !== null) throw integrityFailure;
      try {
        await custody();
      } catch (error) {
        if (error instanceof CurrentMatrixRecoveryIntegrityFailure) {
          integrityFailure = error;
        }
        throw error;
      }
      checkDeadline();
      let written: PortResultV1<StateWriteResultV1> | null = null;
      let writeError: unknown;
      try {
        written = await deps.state.writeRepair(next, expectedHead);
      } catch (error) {
        writeError = error;
      }
      if (written?.ok && written.value.status === "applied") {
        appliedHead = written.value.head;
      }
      try {
        await custody(false);
      } catch (error) {
        integrityFailure = new CurrentMatrixRecoveryIntegrityFailure(
          error instanceof Error &&
            /^current matrix (release custody|producer ancestry) changed$/
              .test(error.message)
            ? error.message
            : "current matrix producer custody unavailable",
          before.head,
          appliedHead,
          written,
        );
        throw integrityFailure;
      }
      if (written === null) throw writeError;
      return written;
    },
  };
  // The exact request bindings are pure facts of the repair snapshot: compute
  // them before building any matrix port, so a producer no record binds to
  // costs no target or artifact read.
  const bound = producerRequests(
    before.snapshot,
    saved.execution,
    dedicated,
    integrityFault,
    scope,
  );
  if (bound.length === 0) return { result: null, deferred: false };
  // Native reads, cooldown, budget and consumer writes all use this SAME
  // composed writer; changing only cycle.state would leave captured writers.
  checkDeadline();
  const ports = await deps.closedMatrix!(state);
  checkDeadline();
  const requests = bound.filter((request) =>
    ports.configs.some((config) =>
      canonicalStringify(config.repository) ===
        canonicalStringify(request.repository)
    )
  );
  if (requests.length === 0) return { result: null, deferred: false };
  // An expired or unlisted blocker-bound plan can never be read again: that
  // producer is unrecoverable, which is a typed skip that writes nothing,
  // never an escaping transport refusal that would starve every later pass.
  const lostPlan = async () => {
    if (!ports.readPlanArtifact) return null;
    checkDeadline();
    const kind = await unrecoverablePlan(
      () =>
        ports.readPlanArtifact!({
          runId: saved.execution.runId,
          runAttempt: saved.execution.runAttempt,
        }, deadlineAt),
      requests,
      before.snapshot.work,
    );
    checkDeadline();
    return kind === null ? null : {
      result: null,
      deferred: false,
      unrecoverable: {
        kind,
        reservations: requests.map((request) => request.reservationId),
      },
    };
  };
  // A readable native settlement must be exactly the saved proof.
  const proveNative = (value: HostedExecutionSettlementV1) => {
    if (value.outcome === "not_started") {
      throw integrityFault("current matrix native proof unavailable");
    }
    let proof;
    try {
      proof = parseHostedRunProofV1(value);
    } catch {
      throw integrityFault("current matrix native proof changed");
    }
    if (
      canonicalStringify({ ...proof, observedAt: 0 }) !==
        canonicalStringify({ ...saved, observedAt: 0 })
    ) {
      throw integrityFault("current matrix native proof changed");
    }
  };
  // The transport's completion and recovery reads take an older producer's
  // snapshot from the walk's verified history view, as custody() does, not
  // from another complete history fetch each: the commit is immutable and
  // the view applies the same ancestry and decoder refusals. custody() still
  // re-proves the live release head before the recovery, every target and
  // every write.
  const producerState: StateReadView & RepairStateWriter = {
    ...state,
    readRelease: () =>
      producer.head === current.head
        ? state.readRelease()
        : readProducer
        ? readProducer(producer.head)
        : deps.state.readReleaseAt!({
          commit: producer.head,
          expectedHead: current.head,
        }),
  };
  checkDeadline();
  const transport = await ports.transportFor(producerState);
  checkDeadline();
  // The completion read refuses (throws on) a conflicting attempt or job
  // provenance and a moved completion custody.
  const completed = async () =>
    transport.confirmCompletedExecution !== undefined &&
    await transport.confirmCompletedExecution(saved.execution);
  // A parked candidate's own producer lists its plan before the completion
  // read can defer: an expired or unlisted plan then never defers. Its
  // completion read still runs first and every refusal it applies throws;
  // an unconfirmed completion is the typed skip unproved. Its native proof
  // is then read once: a readable one passes every refusal above, and a
  // conflicting (invalid) one is refused too, before the typed skip. Only a
  // pending or unreadable one (an aged-out job log, a transient failure) is
  // skipped unproved. A failed early listing changes nothing: the pass keeps
  // its original order, the native reads (and their deferrals) first, then
  // the same listing and refusal.
  let listed = false;
  if (scope === "blocked") {
    let lost: Awaited<ReturnType<typeof lostPlan>> = null;
    try {
      lost = await lostPlan();
      listed = true;
    } catch {
      // Read again below, after the native proof, exactly as before.
    }
    if (lost !== null) {
      checkDeadline();
      if (!await completed()) return lost;
      checkDeadline();
      const native = await ports.readExecution(saved.execution);
      checkDeadline();
      if (native.ok && native.value !== null) proveNative(native.value);
      if (!native.ok && native.error.kind === "invalid") {
        throw integrityFault("current matrix native proof unavailable");
      }
      return lost;
    }
  }
  if (!await completed()) {
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
  proveNative(native.value);
  if (!listed) {
    const lost = await lostPlan();
    if (lost !== null) return lost;
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
  if (waves.length > 1) {
    throw integrityFault("current matrix wave binding changed");
  }
  if (waves.length === 0) throw new Error("current matrix wave unavailable");
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
    throw integrityFault("current matrix wave binding changed");
  }
  // A quarantined, unconsumed correction must match every original descriptor
  // field BEFORE the normal importer or accounting consumer can run.
  for (const request of requests) {
    const record = before.snapshot.work.find((row) =>
      row.id === request.taskId
    )!;
    const binding = blockedImplementationBinding(record);
    if (binding === null) continue;
    const cells = wave.plan.cells.filter((cell) =>
      cell.reservationId === request.reservationId
    );
    const results = wave.results.filter((result) =>
      result.reservationId === request.reservationId
    );
    if (
      cells.length !== 1 || results.length !== 1 ||
      binding.planDigest !== wave.planDigest ||
      binding.plannerJobId !== wave.provenance.plannerJobId ||
      binding.resultDigest !== await matrixDigestV1(results[0]) ||
      cells[0].request.checkoutBase !== record.target.head ||
      results[0].status !== "completed" ||
      results[0].receipt?.outcome !== "completed" ||
      results[0].bundle === null ||
      results[0].receipt?.candidate?.head !== results[0].bundle.head
    ) {
      throw integrityFault(
        "current matrix blocked implementation binding changed",
      );
    }
  }
  const intersection = wave.plan.cells.filter((cell) =>
    requests.some((request) => request.reservationId === cell.reservationId)
  );
  if (intersection.length === 0) {
    await custody();
    const fresh = await state.readRepair();
    if (!fresh.ok || fresh.value.status !== "found") {
      throw new Error("current matrix producer custody unavailable");
    }
    if (
      fresh.value.head !== before.head ||
      canonicalStringify(fresh.value.snapshot) !==
        canonicalStringify(before.snapshot)
    ) {
      throw integrityFault("current matrix repair custody changed");
    }
    return { result: null, deferred: false };
  }
  const fresh = await state.readRepair();
  if (!fresh.ok || fresh.value.status !== "found") {
    throw new Error("current matrix producer custody unavailable");
  }
  if (
    fresh.value.head !== before.head ||
    canonicalStringify(fresh.value.snapshot) !==
      canonicalStringify(before.snapshot)
  ) {
    throw integrityFault("current matrix repair custody changed");
  }
  let ingested = 0;
  // Exact candidates the trusted validator refused: each write is the
  // runtime's own refusal block (the owner-terminal protected-path block for
  // a protected entry verdict), reported, never a silent skip.
  let refused = 0;
  let protectedPaths = 0;
  let unfinished = 0;
  // Output-bound overruns settled as interrupted-output failures.
  let outputBound = 0;
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
    const cycle = {
      ...ports.cycleFor(config),
      state,
      controllerSha: saved.execution.revision,
      externalImplementations: true,
    };
    const cellResults = wave.results.filter((result) =>
      cells.some((cell) => cell.cellId === result.cellId)
    );
    // One options object: the output-bound classifier below authenticates
    // receipts against exactly the route this ingest verified them with.
    const options: MatrixIngestOptionsV1 = {
      deadline: deadlineAt,
      expectedProvider: HISTORICAL_RECOVERY_PROVIDERS,
      // The producer route's 429 failover, from launcher source only.
      failoverModel: RECOVERY_ROUTE_FAILOVER_MODEL,
      bundleImporter: ports.importerFor(config, wave.bundlesDir),
    };
    const report = await (ports.ingest ?? ingestMatrixResults)(
      cycle,
      { ...wave.plan, cells },
      cellResults,
      options,
    ).catch((error: unknown) => {
      throw integrityFailure ?? error;
    });
    if (integrityFailure !== null) throw integrityFailure;
    checkDeadline();
    // A missing current artifact is a completed timeout disposition: the
    // normal consumer records the host timeout, clears the intent and emits
    // `missing`, so it must not fail the maintenance pass after that write.
    // "foreign", "binding_mismatch", and "absent" are expected when the owner
    // works in parallel (manual PRs, rebased branches); they are benign and
    // must not fail maintenance. Unavailable repair settlement, or an
    // unavailable observation the receipt needs (`deferred`, nothing
    // consumed), defers the same charged intent instead of becoming a proven
    // integrity failure.
    const deferrals = ["state_error", "deferred"];
    const benignDispositions = [
      "ingested",
      "duplicate",
      "missing",
      "foreign",
      "binding_mismatch",
      "absent",
    ];
    // An authenticated completed terminal past its output bound is refused
    // (`receipt_rejected`) but settled below as the runtime's own
    // interrupted-output failure; every other refusal stays fatal.
    const overBound = outputBoundCells(report, cells, cellResults, options);
    const badEntries = report.entries.filter(
      (entry) =>
        !deferrals.includes(entry.disposition) &&
        !benignDispositions.includes(entry.disposition) &&
        !overBound.has(entry.cellId),
    );
    if (
      badEntries.length > 0 ||
      report.entries.length !== cells.length
    ) {
      throw integrityFault("current matrix ingestion incomplete");
    }
    if (report.entries.some((entry) => deferrals.includes(entry.disposition))) {
      // An earlier cell or target of this consumer may have written, through
      // whichever writer it holds: this deferral never counts as write-free.
      writes.attempted = true;
      onDeferred();
      return { result: null, deferred: true };
    }
    if (overBound.size > 0) {
      await custody();
      // Re-proved against the repair state this pass began from: a record or
      // charge that moved at any point since the pass began (an owner edit,
      // another writer, or an earlier target of this pass) defers (`false`),
      // like a consumer `state_error`; one already wrong then stays fatal.
      const bounded = await settleOutputBoundCells(
        cycle,
        cells,
        overBound,
        deadlineAt,
        before.snapshot,
      ).catch((error: unknown) => {
        throw integrityFailure ?? error;
      });
      if (integrityFailure !== null) throw integrityFailure;
      if (bounded === null) {
        throw integrityFault("current matrix ingestion incomplete");
      }
      if (!bounded) {
        writes.attempted = true;
        onDeferred();
        return { result: null, deferred: true };
      }
      outputBound += overBound.size;
      checkDeadline();
    }
    // A cell this consumer just consumed leaves its exact candidate in
    // flight: maintenance never runs the work step, and a native-carrier
    // repair job never holds this producer's objects. The ingest has just
    // imported them into the mirror under this proven wave, so the
    // preservation finishes here, in the same pass. Left in flight, every
    // late-cell group would cost a later applied run of its own, and older
    // groups would starve behind newer ones.
    const consumed = report.entries.some((entry) =>
      entry.disposition === "ingested"
    );
    let settled: typeof before.snapshot.work = [];
    if (consumed) {
      await custody();
      const read = await state.readRepair();
      if (read.ok && read.value.status === "found") {
        settled = read.value.snapshot.work;
      }
    }
    for (const cell of cells) {
      const entry = report.entries.find((row) => row.cellId === cell.cellId);
      let record: (typeof settled)[number];
      let restore: typeof restoreInflightCandidate;
      if (entry?.disposition === "ingested") {
        const fresh = settled.find((row) => row.id === cell.taskId);
        if (
          fresh === undefined || !isInflightPreservation(fresh) ||
          fresh.intent?.requestId !== cell.reservationId ||
          fresh.intent.key !== cell.intentKey
        ) continue;
        record = fresh;
        restore = restoreInflightCandidate;
      } else if (
        entry?.disposition === "duplicate" &&
        entry.detail ===
          "receipt already consumed; exact saved candidate objects rehydrated"
      ) {
        // An earlier consumer settled it and never finished the work step
        // (a repair job that failed right after its write). A parked
        // candidate binds to its blocker's producer; an in-flight one (its
        // own repair job never held these objects) to this exact cell.
        record = before.snapshot.work.find((row) => row.id === cell.taskId)!;
        const parked = blockedCandidateBinding(record) !== null;
        if (!parked && !isInflightPreservation(record)) continue;
        restore = parked ? restoreBlockedCandidate : restoreInflightCandidate;
      } else continue;
      await custody();
      const restored = await restore({
        record,
        wave,
        state,
        github: ports.cycleFor(config).github,
        clock: deps.clock,
        readbackFailure: (write) =>
          new CurrentMatrixRecoveryIntegrityFailure(
            "current matrix candidate preservation readback changed",
            before.head,
            appliedHead,
            write,
          ),
      });
      if (restored === "refused") refused++;
      if (restored === "protected") protectedPaths++;
      if (restored === null) unfinished++;
      if (restored === "preserved" && entry.disposition === "duplicate") {
        ingested++;
      }
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
    throw integrityFault("current matrix selected evidence unavailable");
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
    throw integrityFault("current matrix readback incomplete");
  }
  for (const id of selected) covered.add(id);
  return {
    result: {
      kind: "hosted_autonomy",
      status: after.value.head === before.head ? "skipped" : "applied",
      reason: after.value.head === before.head ? "no_change" : "applied",
      beforeHead: before.head,
      appliedHead: after.value.head,
      actions: [
        `current-matrix:ingested:${ingested}`,
        ...(refused > 0
          ? [`current-matrix:preservation-refused:${refused}`]
          : []),
        ...(protectedPaths > 0
          ? [`current-matrix:preservation-protected:${protectedPaths}`]
          : []),
        ...(unfinished > 0
          ? [`current-matrix:preservation-unfinished:${unfinished}`]
          : []),
        ...(outputBound > 0
          ? [`current-matrix:output-bound:${outputBound}`]
          : []),
      ],
      revisions: [],
    },
    deferred: false,
  };
}
