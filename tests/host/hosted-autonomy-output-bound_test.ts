/**
 * Live 2026-10-17, every supervisor run since 01:25Z: maintenance failed with
 * CurrentMatrixRecoveryIntegrityFailure "current matrix ingestion incomplete".
 * Producer 38980356652 (R79, generation 79) admitted ai.ubq.fi 1127..1132 and
 * its repair job consumed none of them. Cell f057b43c for 1127 (charge
 * 4a40b61c…) returned an authenticated `completed` runtime terminal with a
 * candidate and a bundle, but 4005441 output chars against a 4000000 bound:
 * the port's `output_limit` interrupt lost the race to `turn/completed`. The
 * real consumer refuses that receipt (`receipt_rejected`, nothing written),
 * and the producer pass counted the refusal as a bad entry and threw, on the
 * same producer, deterministically, on every pass.
 *
 * These tests replay the live 1127, 1128 and 1131 records and charges byte
 * for byte (1131 as it stood before its own consumption), next to each other
 * in one producer pass of the real consumer: 1127 is the over-bound
 * completed receipt, 1128 the already consumed candidate (`duplicate`, its
 * exact objects rehydrated) and 1131 the interrupted-at-output-limit run the
 * consumer itself settles (`ingested`). The over-bound cell is now settled
 * with the runtime's own transition for exactly what it proves, the one the
 * consumer applies to 1131: the charge becomes `ambiguous` (never refunded)
 * and the record blocks with ATTEMPT_DETAIL_INTERRUPTED_BOUND; its candidate
 * is never imported or preserved. R78 and R79 parse and accept every write,
 * and every near miss of that closed class still fails maintenance.
 *
 * The #151 follow-ups: the classifier authenticates receipts against the
 * ingest's own route options (never a second copy of its constants); a
 * record or charge another writer moves between the ingest and the settle
 * defers the pass instead of failing it, while a binding already wrong when
 * the pass begins still fails; and the torn-pair re-entry finishes only a
 * pair already torn when the pass began, on a charge no audited settler but
 * this one can tear.
 */
import assert from "node:assert/strict";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  matrixBundleFileNameV1,
  type MatrixCellPlanV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  parseMatrixCellResultV1,
  parseMatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import {
  type GitHubPort,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import { ingestMatrixResults } from "../../src/host/matrix.ts";
import {
  interruptedOutputFailure,
  verifyMatrixReceiptV1,
} from "../../src/host/matrix-identity.ts";
import type {
  MatrixIngestOptionsV1,
  MatrixIngestReportV1,
} from "../../src/host/matrix-ingest.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { ATTEMPT_DETAIL_INTERRUPTED_BOUND } from "../../src/repair/attempt-policy.ts";
import { clearIntent, markBlocked } from "../../src/repair/transitions.ts";
import { recoverHostedCurrentMatrix } from "../../ops/hosted-autonomy-current-recovery.ts";
import {
  HISTORICAL_RECOVERY_PROVIDERS,
  RECOVERY_ROUTE_FAILOVER_MODEL,
} from "../../ops/hosted-autonomy-matrix-bindings.ts";
import {
  outputBoundCells,
  outputBoundOverrun,
  settleOutputBoundCells,
} from "../../ops/hosted-autonomy-output-bound.ts";
import {
  CurrentMatrixRecoveryIntegrityFailure,
  recoverHostedMatrixProducer,
} from "../../ops/hosted-autonomy-producer-recovery.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import {
  assertGen78Parses,
  assertGen79Parses,
} from "../state/gen77-contracts.ts";
import {
  gen78Available,
  GEN79_RUNTIME,
  gen79Available,
  loadGen78Modules,
  loadGen79Modules,
} from "./gen77-runtime-source.ts";
import { SHA1 } from "../state/helpers.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";
import {
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";

const ignoreRollback = !await gen78Available() || !await gen79Available();

/** The live 1127, 1128 and 1131 records and charges, and the producer. */
const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/output-bound-overrun-v1.json", import.meta.url),
  ),
) as {
  work: WorkRecordV1[];
  reservations: BudgetReservationV1[];
  runtime: { lastExecutionProof: HostedRunProofV1 };
};

const OVER = "issue-ubiquity-ai.ubq.fi-1127";
const DUPLICATE = "issue-ubiquity-ai.ubq.fi-1128";
const INTERRUPTED = "issue-ubiquity-ai.ubq.fi-1131";
const OVER_CHARGE =
  "4a40b61c3324219d1c08b27abd3a9ffb0522b21dd242a558105e6694e64dbf53";
const INTERRUPTED_CHARGE =
  "b1a2a3ba8cff6d9b92312efe85b6bbfac2bd291c6b0e7f484c27e63669a29a90";
const MAX_OUTPUT_CHARS = 4_000_000;
const MAX_DURATION_MS = 1_800_000;
const MODEL = "gpt-reserve";
const REASONING = "max";
/** The candidate 1127's cell produced; never imported or preserved. */
const OVER_HEAD = "1127".repeat(10) as GitSha;
/** The repair head the failing passes read, and the pass time. */
const REPAIR_AT = Date.parse("2026-10-17T01:27:11Z");
const NOW = Date.parse("2026-10-17T02:05:00Z");
const CLOCK = { now: () => NOW };

const SAVED = LIVE.runtime.lastExecutionProof;
const RUNTIME = SAVED.execution.revision;
const RUN = {
  runId: SAVED.execution.runId,
  runAttempt: SAVED.execution.runAttempt,
  launcherSha: SAVED.execution.launcherSha,
};
const RELEASE = parseReleaseStateSnapshotV1({
  ...releaseSnapshot(),
  hostedRuntimes: [LIVE.runtime],
});
/** TransitionState serves the release custody at SHA1. */
const CURRENT = { head: SHA1, snapshot: RELEASE };
const CONFIG = repositoryConfig(undefined, undefined, {
  repository: LIVE.work[0].repository,
  liveStartLimits: { perHour: null, perSevenDays: null },
});

/** The producer route the ingest verifies these receipts against today. */
const ROUTE = {
  expectedProvider: HISTORICAL_RECOVERY_PROVIDERS,
  failoverModel: RECOVERY_ROUTE_FAILOVER_MODEL,
};

/** The live cells: issue, cell id and the cell job's logged receipt facts. */
const SPECS = [
  {
    taskId: OVER,
    cellId: "f057b43c2fadb6d7a651972c346c18dde178f5733fa95af43f62527febdfe646",
    outcome: "completed",
    outputChars: 4_005_441,
    durationMs: 779_963,
  },
  {
    taskId: DUPLICATE,
    cellId: "7089566f9b3a863f024cf1f8521d35b62f55e9279c90411a10ada14e27cde94c",
    outcome: "completed",
    outputChars: 1_083_827,
    durationMs: 294_541,
  },
  {
    taskId: INTERRUPTED,
    cellId: "67ad4c264b000e38089b80f34581fd7ccf730a13ba53722ab04d4191785d28c7",
    outcome: "interrupted",
    outputChars: 4_023_138,
    durationMs: 766_587,
  },
] as const;

const live = (id: string) => LIVE.work.find((row) => row.id === id)!;

async function cellOf(spec: (typeof SPECS)[number]) {
  const record = live(spec.taskId);
  const request = {
    taskId: record.id,
    repository: record.repository,
    base: record.target.base,
    issue: {
      number: record.related.issueNumber!,
      title: `issue ${record.related.issueNumber}`,
      body: "body",
    },
    evidence: [],
    model: MODEL,
    reasoning: REASONING,
    maxDurationMs: MAX_DURATION_MS,
    maxOutputChars: MAX_OUTPUT_CHARS,
  };
  return {
    cellId: spec.cellId,
    taskId: record.id,
    repository: record.repository,
    reservationId: record.intent!.requestId!,
    intentKey: record.intent!.key,
    expectedBase: record.target.base,
    runtimeSha: RUNTIME,
    generation: SAVED.execution.generation,
    requestDigest: await matrixDigestV1(request),
    request,
  };
}

const PLAN = parseMatrixPlanV1({
  version: "v1",
  kind: "matrix_plan",
  waveId: SAVED.execution.id,
  run: RUN,
  plannedAt: Date.parse("2026-10-16T23:19:50Z"),
  cells: await Promise.all(SPECS.map(cellOf)),
});
const PLAN_DIGEST = await matrixDigestV1(PLAN);

/** A raw result artifact, before the transport's strict parse. */
type RawResult = Record<string, unknown> & {
  receipt: Record<string, unknown> & {
    actual: Record<string, unknown>;
    candidate: Record<string, unknown> | null;
  };
};

/** A near miss: one change to 1127's result, or to the repair state. */
interface VariantV1 {
  result?: (raw: RawResult) => RawResult;
  state?: (snapshot: RepairStateSnapshotV1) => RepairStateSnapshotV1;
  /**
   * The ingest's own route, changed on the very options object the producer
   * hands the ingest (every pass): one route source drifting from another.
   */
  route?: Partial<
    Pick<MatrixIngestOptionsV1, "expectedProvider" | "failoverModel">
  >;
  /**
   * Another writer's commit (the owner's, or any concurrent writer's) that
   * lands once, right after the first pass's ingest and before its settle.
   */
  midPass?: (snapshot: RepairStateSnapshotV1) => RepairStateSnapshotV1;
}

async function resultOf(
  spec: (typeof SPECS)[number],
  cell: MatrixCellPlanV1,
  mutate?: (raw: RawResult) => RawResult,
): Promise<MatrixCellResultV1> {
  const record = live(spec.taskId);
  const head = spec.taskId === OVER
    ? OVER_HEAD
    : spec.outcome === "completed"
    ? record.target.head
    : null;
  const issue = record.related.issueNumber;
  const raw: RawResult = {
    version: "v1",
    kind: "matrix_cell_result",
    waveId: PLAN.waveId,
    cellId: cell.cellId,
    taskId: cell.taskId,
    repository: cell.repository,
    run: RUN,
    runtimeSha: cell.runtimeSha,
    generation: cell.generation,
    reservationId: cell.reservationId,
    intentKey: cell.intentKey,
    requestDigest: cell.requestDigest,
    status: "completed",
    receipt: {
      invocationId: `invocation-${issue}`,
      outcome: spec.outcome,
      actual: {
        evidenceKind: "request-runtime",
        provider: "uos",
        threadId: `thread-${issue}`,
        turnId: `turn-${issue}`,
        terminalOrigin: "runtime",
        observedTerminalStatus: spec.outcome,
        observedModel: MODEL,
        observedReasoning: REASONING,
        durationMs: spec.durationMs,
        outputChars: spec.outputChars,
      },
      candidate: head === null
        ? null
        : { head, checkpointSha: null, changedPaths: ["src/app.ts"] },
      error: null,
    },
    bundle: head === null ? null : {
      file: matrixBundleFileNameV1(cell.cellId),
      digest: await matrixDigestV1(cell.cellId),
      head,
      checkpointSha: null,
    },
    detail: null,
    completedAt: Date.parse("2026-10-17T00:05:00Z"),
  };
  return parseMatrixCellResultV1(mutate ? mutate(raw) : raw);
}

/** One field of 1127's receipt `actual`, everything else as live. */
function actual(raw: RawResult, fields: Record<string, unknown>): RawResult {
  return {
    ...raw,
    receipt: { ...raw.receipt, actual: { ...raw.receipt.actual, ...fields } },
  };
}

/** A non-completed outcome over a completed terminal: no candidate. */
function nonCompleted(
  raw: RawResult,
  value: "failed" | "interrupted",
): RawResult {
  return {
    ...raw,
    receipt: { ...raw.receipt, outcome: value, candidate: null },
    bundle: null,
  };
}

const NEAR_MISSES: [string, VariantV1][] = [
  ["a provider outside the recovery routes", {
    result: (raw) => actual(raw, { provider: "openai" }),
  }],
  ["a model neither planned nor the route's failover", {
    result: (raw) => actual(raw, { observedModel: "gpt-other" }),
  }],
  ["a duration over its bound", {
    result: (raw) => actual(raw, { durationMs: MAX_DURATION_MS + 1 }),
  }],
  ["output within its bound, refused for a candidate without a head", {
    result: (raw) => {
      const within = actual(raw, { outputChars: MAX_OUTPUT_CHARS });
      return {
        ...within,
        receipt: {
          ...within.receipt,
          candidate: { head: null, checkpointSha: null, changedPaths: [] },
        },
        bundle: null,
      };
    },
  }],
  ["output over its bound with a candidate without a head", {
    result: (raw) => ({
      ...raw,
      receipt: {
        ...raw.receipt,
        candidate: { head: null, checkpointSha: null, changedPaths: [] },
      },
      bundle: null,
    }),
  }],
  ["a failed outcome", { result: (raw) => nonCompleted(raw, "failed") }],
  ["an interrupted outcome over a completed terminal", {
    result: (raw) => nonCompleted(raw, "interrupted"),
  }],
  // The settlement re-proves the exact charged binding before it writes.
  ["a charge that already settled submitted", {
    state: (snapshot) => ({
      ...snapshot,
      reservations: snapshot.reservations.map((row) =>
        row.id === OVER_CHARGE
          ? { ...row, outcome: "submitted" as const, settledAt: REPAIR_AT }
          : row
      ),
    }),
  }],
];

/** Records every applied write as the exact (prior, next) pair. */
function recordWrites(state: TransitionState) {
  const writes: {
    prior: RepairStateSnapshotV1;
    next: RepairStateSnapshotV1;
  }[] = [];
  const write = state.writeRepair.bind(state);
  state.writeRepair = async (next, head) => {
    const prior = structuredClone(state.snapshot);
    const written = await write(next, head);
    if (written.ok && written.value.status === "applied") {
      writes.push({ prior, next: structuredClone(state.snapshot) });
    }
    return written;
  };
  return writes;
}

/** The live repair state at the failing passes' pass time. */
function liveSnapshot(): RepairStateSnapshotV1 {
  return {
    ...snapshotOf(
      structuredClone(LIVE.work),
      structuredClone(LIVE.reservations),
    ),
    updatedAt: REPAIR_AT,
  };
}

/**
 * One producer pass of 38980356652 through the real consumer. Only the
 * remote seams are fakes: the authenticated wave, the bundle importer (every
 * bundle verifies) and the trusted preserver (every preservation lands).
 */
async function producerRig(variant: VariantV1 = {}) {
  const results = await Promise.all(
    SPECS.map((spec, index) =>
      resultOf(
        spec,
        PLAN.cells[index],
        spec.taskId === OVER ? variant.result : undefined,
      )
    ),
  );
  const wave = {
    plan: PLAN,
    planDigest: PLAN_DIGEST,
    results,
    bundlesDir: "/nonexistent/bundles",
    provenance: { run: RUN, plannerJobId: 117240416754, cellJobIds: [] },
  };
  const initial = variant.state
    ? variant.state(liveSnapshot())
    : liveSnapshot();
  const state = new TransitionState(initial, RELEASE);
  const before = structuredClone(state.snapshot);
  const beforeHead = state.head;
  // A repair store that refuses (unavailable) the writes `refuse` names.
  const refuse = {
    write: null as null | ((next: RepairStateSnapshotV1) => boolean),
  };
  const store = state.writeRepair.bind(state);
  state.writeRepair = (next, head) =>
    refuse.write?.(next)
      ? Promise.resolve(portError("unavailable", "repair store unavailable"))
      : store(next, head);
  const writes = recordWrites(state);
  const calls = {
    imported: [] as string[],
    preserved: [] as string[],
    reports: [] as MatrixIngestReportV1[],
    routes: [] as unknown[],
    deferred: 0,
  };
  // The snapshot the concurrent writer committed, once it landed.
  const edit = {
    pending: variant.midPass,
    landed: null as RepairStateSnapshotV1 | null,
  };
  const refs = new Map<string, string>();
  const github = {
    nativeQueue: inactiveNativeQueueFixture(),
    preserveCandidate: (
      request: { candidate: { ref: string; head: string } },
    ) => {
      calls.preserved.push(request.candidate.head);
      refs.set(request.candidate.ref, request.candidate.head);
      return Promise.resolve(portOk(undefined));
    },
    readRef: (name: string) =>
      Promise.resolve(
        portOk(refs.has(name) ? { ref: name, sha: refs.get(name)! } : null),
      ),
  } as unknown as GitHubPort;
  const ports = (passState: TransitionState) => ({
    state: passState,
    clock: CLOCK,
    configs: [CONFIG],
    cycleFor: () => ({
      state: passState,
      clock: CLOCK,
      configs: [CONFIG],
      controllerSha: RUNTIME,
      github,
      githubCooldown: new HostedRepairCooldownGate({
        state: passState,
        clock: CLOCK,
      }),
      incidents: {},
      replay: {},
      model: {},
      budget: new RollingStartBudget({
        state: passState,
        clock: CLOCK,
        configs: [CONFIG],
      }),
      externalImplementations: true,
    }),
    prepareTarget: () => Promise.resolve(),
    importerFor: () => ({
      import: (request: { head: string }) => {
        calls.imported.push(request.head);
        return Promise.resolve(true);
      },
    }),
    transportFor: () => ({
      confirmCompletedExecution: () => Promise.resolve(true),
      recover: () => Promise.resolve([wave]),
    }),
    readExecution: () => Promise.resolve(portOk(SAVED)),
    // The production consumer itself; only its report is recorded.
    ingest: async (...args: Parameters<typeof ingestMatrixResults>) => {
      if (variant.route) Object.assign(args[3], variant.route);
      const report = await ingestMatrixResults(...args);
      calls.reports.push(report);
      calls.routes.push({
        expectedProvider: args[3].expectedProvider,
        failoverModel: args[3].failoverModel,
      });
      const change = edit.pending;
      if (change) {
        edit.pending = undefined;
        edit.landed = await concurrentWrite(state, change);
      }
      return report;
    },
  });
  const deps = {
    state,
    clock: CLOCK,
    githubFor: () => null,
    closedMatrix: (passState: TransitionState = state) =>
      Promise.resolve(ports(passState)),
  };
  const pass = () =>
    recoverHostedMatrixProducer(
      deps as never,
      CURRENT,
      CURRENT,
      NOW + 300_000,
      new Set(),
      new Set(),
      () => calls.deferred++,
      undefined,
      "all",
    );
  const walk = () =>
    recoverHostedCurrentMatrix(
      deps as never,
      CLOSED_C_WAVE,
      () => calls.deferred++,
    );
  const row = (id: string) =>
    state.snapshot.work.find((item) => item.id === id)!;
  const charge = (id: string) =>
    state.snapshot.reservations.find((item) => item.id === id)!;
  return {
    state,
    github,
    ports,
    before,
    beforeHead,
    refuse,
    writes,
    calls,
    edit,
    results,
    pass,
    walk,
    row,
    charge,
  };
}

/**
 * Another writer's commit to the same repair store, outside this pass's
 * composed writer: the store's own compare-and-swap and transition rules
 * (this tree's, R80's) still apply.
 */
async function concurrentWrite(
  state: TransitionState,
  change: (snapshot: RepairStateSnapshotV1) => RepairStateSnapshotV1,
): Promise<RepairStateSnapshotV1> {
  const next = {
    ...change(structuredClone(state.snapshot)),
    stateHead: state.head,
    sequence: state.snapshot.sequence + 1,
    updatedAt: NOW,
  };
  const written = await TransitionState.prototype.writeRepair.call(
    state,
    next,
    state.head,
  );
  assert(written.ok && written.value.status === "applied");
  return structuredClone(state.snapshot);
}

/** The consumer's dispositions by task, in plan order. */
function dispositions(report: MatrixIngestReportV1) {
  return report.entries.map((entry) => ({
    task: PLAN.cells.find((cell) => cell.cellId === entry.cellId)!.taskId,
    disposition: entry.disposition,
    detail: entry.detail,
  }));
}

/**
 * The runtime's own settlement of an authenticated interrupted-output
 * failure (`settleFailedImplementation`): the charge settles `ambiguous`,
 * the record blocks with the interrupted-bound detail (intent, target and
 * counters kept), and one attempt-memory entry records it.
 */
function assertInterruptedBound(
  rig: Awaited<ReturnType<typeof producerRig>>,
  taskId: string,
  chargeId: string,
) {
  const prior = rig.before.work.find((row) => row.id === taskId)!;
  assert.deepEqual(rig.row(taskId), {
    ...prior,
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: ATTEMPT_DETAIL_INTERRUPTED_BOUND,
      since: NOW,
    },
    wait: null,
    updatedAt: NOW,
  });
  const priorCharge = rig.before.reservations.find((row) =>
    row.id === chargeId
  )!;
  assert.equal(priorCharge.outcome, "reserved");
  // Charged, never refunded: no proof ref, no `confirmed_not_submitted`.
  assert.deepEqual(rig.charge(chargeId), {
    ...priorCharge,
    outcome: "ambiguous",
    settledAt: NOW,
    proofRef: null,
  });
  const memory = rig.state.snapshot.attemptMemory.filter((row) =>
    row.taskId === taskId
  );
  assert.equal(memory.length, 1, taskId);
  assert.equal(memory[0].purpose, "implementation");
  assert.equal(memory[0].base, prior.target.base);
  assert.deepEqual(
    memory[0].entries.map((entry) => ({
      stage: entry.stage,
      failureClass: entry.failureClass,
      detail: entry.detail,
      controllerSha: entry.controllerSha,
      count: entry.count,
      firstAtMs: entry.firstAtMs,
      lastAtMs: entry.lastAtMs,
    })),
    [{
      stage: "model",
      failureClass: "transient_infrastructure",
      detail: ATTEMPT_DETAIL_INTERRUPTED_BOUND,
      controllerSha: RUNTIME,
      count: 1,
      firstAtMs: NOW,
      lastAtMs: NOW,
    }],
  );
}

Deno.test("output bound: the live fixture is producer 38980356652's R79 pass with 1127 over its output bound", async () => {
  assert.equal(RUNTIME, GEN79_RUNTIME);
  assert.equal(SAVED.execution.runId, 38980356652);
  assert.equal(SAVED.execution.generation, 79);
  assert.equal(RELEASE.hostedRuntimes[0].id, HOSTED_RUNTIME_ID);
  const rig = await producerRig();
  const over = rig.results[0];
  assert.equal(over.receipt?.outcome, "completed");
  assert.equal(over.receipt?.actual.observedTerminalStatus, "completed");
  assert.equal(over.receipt?.candidate?.head, OVER_HEAD);
  assert.notEqual(over.bundle, null);
  assert(over.receipt!.actual.outputChars > MAX_OUTPUT_CHARS);
  assert(over.receipt!.actual.durationMs <= MAX_DURATION_MS);
  // The consumer refuses it: no consumer can ever verify this receipt.
  assert.equal(
    verifyMatrixReceiptV1(
      over.receipt!,
      PLAN.cells[0].request,
      HISTORICAL_RECOVERY_PROVIDERS,
      RECOVERY_ROUTE_FAILOVER_MODEL,
    ),
    false,
  );
  // 1131 is the interrupted shape the consumer itself settles.
  assert.equal(
    interruptedOutputFailure(
      rig.results[2],
      PLAN.cells[2],
      HISTORICAL_RECOVERY_PROVIDERS,
      RECOVERY_ROUTE_FAILOVER_MODEL,
    ),
    true,
  );
  assert.equal(live(OVER).intent?.kind, "implementation");
  assert.equal(live(DUPLICATE).intent?.kind, "candidate_preservation");
  assert.equal(live(INTERRUPTED).intent?.kind, "implementation");
  assert.equal(rig.charge(OVER_CHARGE).outcome, "reserved");
  assert.equal(rig.charge(INTERRUPTED_CHARGE).outcome, "reserved");
});

Deno.test("output bound: the closed class is exactly a completed authenticated runtime terminal past its output bound", async () => {
  const cell = PLAN.cells[0];
  assert.notEqual(RECOVERY_ROUTE_FAILOVER_MODEL, MODEL);
  const at = (mutate?: (raw: RawResult) => RawResult) =>
    resultOf(SPECS[0], cell, mutate);
  assert.equal(outputBoundOverrun(await at(), cell, ROUTE), true);
  // The failover model is the same route's receipt, and a deepseek route is
  // a documented recovery provider.
  assert.equal(
    outputBoundOverrun(
      await at((raw) =>
        actual(raw, { observedModel: RECOVERY_ROUTE_FAILOVER_MODEL })
      ),
      cell,
      ROUTE,
    ),
    true,
  );
  assert.equal(
    outputBoundOverrun(
      await at((raw) => actual(raw, { provider: "deepseek" })),
      cell,
      ROUTE,
    ),
    true,
  );
  for (const [name, variant] of NEAR_MISSES) {
    if (!variant.result) continue;
    assert.equal(
      outputBoundOverrun(await at(variant.result), cell, ROUTE),
      false,
      name,
    );
  }
  // The consumer's own interrupted class is not this one.
  assert.equal(
    outputBoundOverrun((await producerRig()).results[2], PLAN.cells[2], ROUTE),
    false,
  );
});

/**
 * The ingest's route drifting from the historical constants (#151 finding
 * 1), each on a 1127 receipt that is over its bound either way: `true` when
 * the drifted route authenticates it (a real overrun the fixed constants
 * would miss), `false` when the drifted route refuses its identity (a
 * provider or model rejection the fixed constants would take for an
 * overrun).
 */
const ROUTE_DRIFTS: [string, VariantV1, boolean][] = [
  ["a route that also admits openai", {
    route: { expectedProvider: [...HISTORICAL_RECOVERY_PROVIDERS, "openai"] },
    result: (raw) => actual(raw, { provider: "openai" }),
  }, true],
  ["a route that no longer admits deepseek", {
    route: { expectedProvider: ["uos"] },
    result: (raw) => actual(raw, { provider: "deepseek" }),
  }, false],
  ["a route that fails over to another model", {
    route: { failoverModel: "gpt-other" },
    result: (raw) => actual(raw, { observedModel: "gpt-other" }),
  }, true],
  ["a route without a failover model", {
    route: { failoverModel: undefined },
    result: (raw) =>
      actual(raw, { observedModel: RECOVERY_ROUTE_FAILOVER_MODEL }),
  }, false],
];

Deno.test("output bound: the classifier verifies identity against the route it is handed, never a fixed one", async () => {
  const cell = PLAN.cells[0];
  for (const [name, variant, overrun] of ROUTE_DRIFTS) {
    const route = { ...ROUTE, ...variant.route };
    const result = await resultOf(SPECS[0], cell, variant.result);
    assert.equal(outputBoundOverrun(result, cell, route), overrun, name);
    // The fixed historical route decides the opposite: exactly the drift.
    assert.equal(outputBoundOverrun(result, cell, ROUTE), !overrun, name);
    const report: MatrixIngestReportV1 = {
      waveId: PLAN.waveId,
      ingested: 0,
      entries: [{
        cellId: cell.cellId,
        disposition: "receipt_rejected",
        detail: null,
      }],
    };
    assert.deepEqual(
      [...outputBoundCells(report, [cell], [result], route)],
      overrun ? [cell.cellId] : [],
      name,
    );
  }
});

for (const [name, variant, overrun] of ROUTE_DRIFTS) {
  Deno.test(
    `output bound: the producer classifies with the ingest's own route: ${name} ${
      overrun ? "settles 1127" : "still fails maintenance"
    }`,
    async () => {
      const rig = await producerRig(variant);
      const outcome = await rig.pass().then(
        (value) => value,
        (error: unknown) => error,
      );
      // The ingest verified against the drifted route and refused 1127.
      assert.deepEqual(rig.calls.routes, [{ ...ROUTE, ...variant.route }]);
      assert.deepEqual(
        dispositions(rig.calls.reports[0]).map((row) => row.disposition),
        ["receipt_rejected", "duplicate", "ingested"],
      );
      if (overrun) {
        assert(!(outcome instanceof Error), String(outcome));
        assert.deepEqual(
          (outcome as Awaited<ReturnType<typeof rig.pass>>).result?.actions,
          ["current-matrix:ingested:2", "current-matrix:output-bound:1"],
        );
        assertInterruptedBound(rig, OVER, OVER_CHARGE);
        return;
      }
      assert(
        outcome instanceof CurrentMatrixRecoveryIntegrityFailure,
        String(outcome),
      );
      assert.equal(outcome.message, "current matrix ingestion incomplete");
      assert.deepEqual(
        rig.row(OVER),
        rig.before.work.find((row) => row.id === OVER),
      );
      assert.deepEqual(
        rig.charge(OVER_CHARGE),
        rig.before.reservations.find((row) => row.id === OVER_CHARGE),
      );
    },
  );
}

Deno.test("output bound: the live producer pass settles 1127 as the runtime's interrupted-output failure instead of failing maintenance", async () => {
  const rig = await producerRig();
  const outcome = await rig.pass();
  assert.equal(outcome.deferred, false);
  assert.equal(outcome.mayHaveWritten, true);
  assert.equal(outcome.result?.status, "applied", JSON.stringify(outcome));
  assert.deepEqual(outcome.result?.actions, [
    "current-matrix:ingested:2",
    "current-matrix:output-bound:1",
  ]);
  assert.equal(outcome.result?.beforeHead, rig.beforeHead);
  assert.equal(outcome.result?.appliedHead, rig.state.head);
  assert.equal(rig.calls.deferred, 0);
  // The ingest verified against the historical producer route.
  assert.deepEqual(rig.calls.routes, [ROUTE]);
  // The real consumer's verdicts are unchanged: 1127 is still refused.
  assert.equal(rig.calls.reports.length, 1);
  assert.deepEqual(dispositions(rig.calls.reports[0]), [
    {
      task: OVER,
      disposition: "receipt_rejected",
      detail: "receipt does not verify against the exact planned request",
    },
    {
      task: DUPLICATE,
      disposition: "duplicate",
      detail:
        "receipt already consumed; exact saved candidate objects rehydrated",
    },
    { task: INTERRUPTED, disposition: "ingested", detail: null },
  ]);
  // 1127 settles exactly as the consumer settled 1131 in the same pass.
  assertInterruptedBound(rig, INTERRUPTED, INTERRUPTED_CHARGE);
  assertInterruptedBound(rig, OVER, OVER_CHARGE);
  // Its candidate is never imported, preserved or published.
  assert.deepEqual(rig.calls.imported, [live(DUPLICATE).target.head]);
  assert.deepEqual(rig.calls.preserved, [live(DUPLICATE).target.head]);
  assert.equal(rig.row(OVER).target.head, null);
  assert(!JSON.stringify(rig.state.snapshot).includes(OVER_HEAD));
  // The duplicate's exact candidate finishes its preservation in this pass.
  const duplicate = rig.row(DUPLICATE);
  assert.equal(duplicate.nextStep, "work");
  assert.equal(duplicate.intent, null);
  assert.equal(
    duplicate.target.candidateState?.preserved?.head,
    live(DUPLICATE).target.head,
  );
  // Nothing else moved; no charge was added, refunded or dropped.
  assert.equal(
    rig.state.snapshot.reservations.length,
    rig.before.reservations.length,
  );
  const settled = [OVER_CHARGE, INTERRUPTED_CHARGE];
  assert.equal(
    canonicalStringify(
      rig.state.snapshot.reservations.filter((row) =>
        !settled.includes(row.id)
      ),
    ),
    canonicalStringify(
      rig.before.reservations.filter((row) => !settled.includes(row.id)),
    ),
  );
  // 1131: two settlement writes; 1127: the same two; 1128: its preservation.
  assert.equal(rig.writes.length, 5);

  // The next pass has nothing left to request from this producer.
  const head = rig.state.head;
  const again = await rig.pass();
  assert.deepEqual(again, {
    result: null,
    deferred: false,
    mayHaveWritten: false,
  });
  assert.equal(rig.state.head, head);
  assert.equal(rig.writes.length, 5);
});

Deno.test("output bound: native queue holds remain unconsumed until a no-rule observation settles the original charge", async (t) => {
  for (
    const reason of ["member", "inactive_observation_unavailable"] as const
  ) {
    await t.step(reason, async () => {
      const rig = await producerRig();
      const cell = PLAN.cells.find((item) => item.taskId === OVER)!;
      let absent = false;
      const cycle = {
        ...rig.ports(rig.state).cycleFor(),
        github: {
          ...rig.github,
          nativeQueue: {
            ...inactiveNativeQueueFixture(),
            inspect: () =>
              Promise.resolve(
                absent
                  ? {
                    status: "allow" as const,
                    basis: "inactive_no_rule" as const,
                  }
                  : { status: "hold" as const, reason, pull: null },
              ),
          },
        },
      } as unknown as Parameters<typeof settleOutputBoundCells>[0];
      const settle = () =>
        settleOutputBoundCells(
          cycle,
          [cell],
          new Set([cell.cellId]),
          NOW + 300_000,
          structuredClone(rig.state.snapshot),
        );
      const originalCharge = structuredClone(rig.charge(OVER_CHARGE));
      const originalIntent = structuredClone(rig.row(OVER).intent);
      assert.equal(
        await settle(),
        false,
        "fresh custody hold is not settlement",
      );
      assert.equal(
        await settle(),
        false,
        "retained custody hold is not settlement",
      );
      assert.deepEqual(rig.charge(OVER_CHARGE), originalCharge);
      assert.deepEqual(rig.row(OVER).intent, originalIntent);
      assert.equal(rig.row(OVER).nextStep, "work");
      assert.deepEqual(rig.calls.imported, []);
      assert.deepEqual(rig.calls.preserved, []);
      absent = true;
      assert.equal(await settle(), true);
      assertInterruptedBound(rig, OVER, OVER_CHARGE);
    });
  }
});

Deno.test("output bound: the current-matrix walk applies the live pass once, then finds nothing pending", async () => {
  const rig = await producerRig();
  const first = await rig.walk();
  assert.equal(first?.status, "applied", JSON.stringify(first));
  assert.deepEqual(first?.actions, [
    "current-matrix:ingested:2",
    "current-matrix:output-bound:1",
  ]);
  assertInterruptedBound(rig, OVER, OVER_CHARGE);
  const writes = rig.writes.length;
  assert.equal(await rig.walk(), null);
  assert.equal(rig.writes.length, writes);
  assert.equal(rig.calls.reports.length, 1);
  assert.equal(rig.calls.deferred, 0);
});

Deno.test("output bound: a terminal abandoned or superseded release never defers the walk", async (t) => {
  // Live 2026-10-24: release f42d04c7, abandoned as included_in_successor,
  // deferred every current-matrix walk since 09:24 and orphaned that wave.
  for (const phase of ["abandoned", "owner_superseded", "requested"]) {
    await t.step(phase, async () => {
      const rig = await producerRig();
      const read = rig.state.readRelease.bind(rig.state);
      rig.state.readRelease = async () => {
        const r = await read();
        if (!r.ok || r.value.status !== "found") return r;
        const snapshot = { ...r.value.snapshot, hostedReleases: [{ phase }] };
        return { ...r, value: { ...r.value, snapshot } } as typeof r;
      };
      const walked = await rig.walk();
      if (phase === "requested") {
        assert.equal(walked, null);
        assert.equal(rig.calls.deferred, 1);
      } else {
        assert.equal(walked?.status, "applied", JSON.stringify(walked));
        assert.equal(rig.calls.deferred, 0);
      }
    });
  }
});

for (const [name, variant] of NEAR_MISSES) {
  Deno.test(`output bound near miss: ${name} still fails maintenance`, async () => {
    const rig = await producerRig(variant);
    const failure = await rig.pass().then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      failure instanceof CurrentMatrixRecoveryIntegrityFailure,
      String(failure),
    );
    assert.equal(failure.message, "current matrix ingestion incomplete");
    assert.equal(failure.beforeHead, rig.beforeHead);
    // The consumer refused 1127 and settled 1131 before the refusal, exactly
    // as the live failing passes did; 1127 and its charge are untouched.
    assert.equal(rig.calls.reports.length, 1);
    assert.deepEqual(
      dispositions(rig.calls.reports[0]).map((row) => row.disposition),
      ["receipt_rejected", "duplicate", "ingested"],
    );
    assert.deepEqual(
      rig.row(OVER),
      rig.before.work.find((row) => row.id === OVER),
    );
    assert.deepEqual(
      rig.charge(OVER_CHARGE),
      rig.before.reservations.find((row) => row.id === OVER_CHARGE),
    );
    assert.equal(
      rig.state.snapshot.attemptMemory.some((row) => row.taskId === OVER),
      false,
    );
    assert.deepEqual(rig.calls.preserved, []);
    assert(!rig.calls.imported.includes(OVER_HEAD));
    // Deterministic: the next pass on the same producer fails the same way.
    const head = rig.state.head;
    await assert.rejects(
      () => rig.pass(),
      CurrentMatrixRecoveryIntegrityFailure,
      "current matrix ingestion incomplete",
    );
    assert.equal(rig.state.head, head);
    assert.deepEqual(
      dispositions(rig.calls.reports[1]).map((row) => row.disposition),
      ["receipt_rejected", "duplicate"],
    );
  });
}

Deno.test("output bound: an unavailable settlement defers the pass with 1127 still charged, and the next pass settles it", async () => {
  const rig = await producerRig();
  // The store refuses exactly the write that would settle 1127's charge.
  rig.refuse.write = (next) =>
    next.reservations.find((row) => row.id === OVER_CHARGE)?.outcome !==
      "reserved";
  const deferred = await rig.pass();
  assert.deepEqual(deferred, {
    result: null,
    deferred: true,
    mayHaveWritten: true,
  });
  assert.equal(rig.calls.deferred, 1);
  assert.deepEqual(
    rig.row(OVER),
    rig.before.work.find((row) => row.id === OVER),
  );
  assert.deepEqual(
    rig.charge(OVER_CHARGE),
    rig.before.reservations.find((row) => row.id === OVER_CHARGE),
  );
  // The consumer's own 1131 settlement had already landed.
  assertInterruptedBound(rig, INTERRUPTED, INTERRUPTED_CHARGE);
  rig.refuse.write = null;
  const settled = await rig.pass();
  assert.equal(settled.result?.status, "applied", JSON.stringify(settled));
  assert.deepEqual(settled.result?.actions, [
    "current-matrix:ingested:1",
    "current-matrix:output-bound:1",
  ]);
  assert.deepEqual(
    dispositions(rig.calls.reports[1]).map((row) => row.disposition),
    ["receipt_rejected", "duplicate"],
  );
  assertInterruptedBound(rig, OVER, OVER_CHARGE);
  assert.equal(rig.calls.deferred, 1);
});

Deno.test("output bound: a settlement whose record write was lost finishes on the next pass instead of failing maintenance", async () => {
  const rig = await producerRig();
  // The charge write lands; the store refuses exactly 1127's record write.
  rig.refuse.write = (next) =>
    next.work.find((row) => row.id === OVER)?.nextStep === "blocked";
  const deferred = await rig.pass();
  assert.deepEqual(deferred, {
    result: null,
    deferred: true,
    mayHaveWritten: true,
  });
  assert.equal(rig.calls.deferred, 1);
  // The torn pair: charged `ambiguous`, the record still works its intent.
  assert.deepEqual(
    rig.row(OVER),
    rig.before.work.find((row) => row.id === OVER),
  );
  const torn = rig.charge(OVER_CHARGE);
  assert.equal(torn.outcome, "ambiguous");
  assert.equal(torn.settledAt, NOW);
  assert.equal(
    rig.state.snapshot.attemptMemory.some((row) => row.taskId === OVER),
    false,
  );
  rig.refuse.write = null;
  const writes = rig.writes.length;
  const settled = await rig.pass();
  assert.equal(settled.result?.status, "applied", JSON.stringify(settled));
  assert.deepEqual(settled.result?.actions, [
    "current-matrix:ingested:1",
    "current-matrix:output-bound:1",
  ]);
  // The consumer still refuses the receipt; only the record write remained.
  assert.deepEqual(
    dispositions(rig.calls.reports[1]).map((row) => row.disposition),
    ["receipt_rejected", "duplicate"],
  );
  assertInterruptedBound(rig, OVER, OVER_CHARGE);
  assert.equal(
    rig.writes.slice(writes).filter(({ prior, next }) =>
      canonicalStringify(prior.work.find((row) => row.id === OVER)) !==
        canonicalStringify(next.work.find((row) => row.id === OVER)) ||
      canonicalStringify(
          prior.reservations.find((row) => row.id === OVER_CHARGE),
        ) !==
        canonicalStringify(
          next.reservations.find((row) => row.id === OVER_CHARGE),
        )
    ).length,
    1,
  );
  assert.equal(rig.calls.deferred, 1);
  const head = rig.state.head;
  assert.deepEqual(await rig.pass(), {
    result: null,
    deferred: false,
    mayHaveWritten: false,
  });
  assert.equal(rig.state.head, head);
});

/** 1127's record, changed by another writer. */
function overRecord(
  snapshot: RepairStateSnapshotV1,
  change: (row: WorkRecordV1) => WorkRecordV1,
): RepairStateSnapshotV1 {
  return {
    ...snapshot,
    work: snapshot.work.map((row) => row.id === OVER ? change(row) : row),
  };
}

/** 1127's charge, settled by another writer. */
function overCharge(
  snapshot: RepairStateSnapshotV1,
  outcome: "ambiguous" | "submitted",
): RepairStateSnapshotV1 {
  return {
    ...snapshot,
    reservations: snapshot.reservations.map((row) =>
      row.id === OVER_CHARGE ? { ...row, outcome, settledAt: NOW } : row
    ),
  };
}

/**
 * A commit that lands between the ingest and the settle of one pass (#151
 * findings 2 and 3), and what the NEXT pass then does with 1127: `benign`
 * with the dispositions its ingest reports (1127 left as the writer left
 * it, its charge never refunded), `settled` (a pair the writer tore is
 * finished only once a pass begins with it torn), or `refused` (a binding
 * that is genuinely wrong when the pass begins stays an integrity fault).
 */
const MID_PASS: [
  string,
  (snapshot: RepairStateSnapshotV1) => RepairStateSnapshotV1,
  "benign" | "settled" | "refused",
  string[],
][] = [
  [
    "the owner closes 1127's issue",
    (snapshot) =>
      overRecord(
        snapshot,
        (row) =>
          markBlocked(clearIntent(row, NOW), "other", "issue closed", NOW),
      ),
    "benign",
    ["duplicate"],
  ],
  [
    "the owner blocks 1127, its intent and charge kept",
    (snapshot) =>
      overRecord(
        snapshot,
        (row) => markBlocked(row, "other", "held by its owner", NOW),
      ),
    "benign",
    ["duplicate"],
  ],
  [
    "1127's record is rebound to another issue",
    (snapshot) =>
      overRecord(snapshot, (row) => ({
        ...row,
        related: { ...row.related, issueNumber: 9999 },
        updatedAt: NOW,
      })),
    "benign",
    ["binding_mismatch", "duplicate"],
  ],
  [
    "another writer settles 1127's charge ambiguous",
    (snapshot) => overCharge(snapshot, "ambiguous"),
    "settled",
    ["receipt_rejected", "duplicate"],
  ],
  [
    "another writer settles 1127's charge submitted",
    (snapshot) => overCharge(snapshot, "submitted"),
    "refused",
    ["receipt_rejected", "duplicate"],
  ],
];

for (const [name, midPass, next, nextDispositions] of MID_PASS) {
  Deno.test(`output bound: ${name} between the ingest and the settle defers the pass; the next pass is ${next}`, async () => {
    const rig = await producerRig({ midPass });
    const deferred = await rig.pass();
    assert.deepEqual(deferred, {
      result: null,
      deferred: true,
      mayHaveWritten: true,
    });
    assert.equal(rig.calls.deferred, 1);
    // The settler wrote nothing for 1127: its record and charge are exactly
    // what the other writer committed, and it has no attempt memory.
    const landed = rig.edit.landed!;
    assert.notEqual(landed, null);
    assert.deepEqual(rig.row(OVER), landed.work.find((row) => row.id === OVER));
    assert.deepEqual(
      rig.charge(OVER_CHARGE),
      landed.reservations.find((row) => row.id === OVER_CHARGE),
    );
    assert.notEqual(rig.charge(OVER_CHARGE).outcome, "confirmed_not_submitted");
    assert.equal(
      rig.state.snapshot.attemptMemory.some((row) => row.taskId === OVER),
      false,
    );
    // The consumer's own 1131 settlement had already landed.
    assertInterruptedBound(rig, INTERRUPTED, INTERRUPTED_CHARGE);

    const second = await rig.pass().then(
      (value) => value,
      (error: unknown) => error,
    );
    assert.deepEqual(
      dispositions(rig.calls.reports[1]).map((row) => row.disposition),
      nextDispositions,
    );
    if (next === "refused") {
      assert(
        second instanceof CurrentMatrixRecoveryIntegrityFailure,
        String(second),
      );
      assert.equal(second.message, "current matrix ingestion incomplete");
      assert.deepEqual(
        rig.row(OVER),
        landed.work.find((row) => row.id === OVER),
      );
      return;
    }
    assert(!(second instanceof Error), String(second));
    const outcome = second as Awaited<ReturnType<typeof rig.pass>>;
    assert.equal(outcome.result?.status, "applied", JSON.stringify(outcome));
    if (next === "settled") {
      assert.deepEqual(outcome.result?.actions, [
        "current-matrix:ingested:1",
        "current-matrix:output-bound:1",
      ]);
      assertInterruptedBound(rig, OVER, OVER_CHARGE);
    } else {
      assert.deepEqual(outcome.result?.actions, ["current-matrix:ingested:1"]);
      assert.deepEqual(
        rig.row(OVER),
        landed.work.find((row) => row.id === OVER),
      );
      assert.equal(rig.charge(OVER_CHARGE).outcome, "reserved");
    }
    assert.equal(rig.calls.deferred, 1);
  });
}

/**
 * Every production call of a charge settlement that writes the charge apart
 * from its record, by file: the audit behind the torn-pair re-entry (#151
 * finding 3, `settleOutputBoundCells`). Each one is either this settler, or
 * one that can never reach an output-bound cell's charge: the consumer's
 * own (it refuses this receipt), the serial work step (never with external
 * implementations), the review settlements (review charges only, including
 * three exact-base review admission settlements and the owner-successor
 * review, whose newly reserved review_request charge cannot alias this
 * implementation/retry charge), the
 * historical quarantine (dedicated charges, never requested here) and the
 * uncertainty quarantine (its fixed generation-63 charges, only while
 * generation 63 is active). A new or moved one changes this table: before
 * updating it, prove it cannot tear an output-bound cell's charge, or tag
 * that settler's first write so the re-entry can tell whose pair it is.
 */
const AUDITED_SETTLERS = {
  "ops/hosted-autonomy-output-bound.ts": 1,
  "src/host/matrix-ingest.ts": 2,
  "src/host/matrix-quarantine-state.ts": 1,
  "src/host/matrix-uncertainty-maintenance.ts": 1,
  "src/host/owner-successor-acceptance.ts": 1,
  "src/repair/loop-accounting.ts": 2,
  "src/repair/loop-base-satisfaction.ts": 3,
  "src/repair/loop-conflict-resolution.ts": 1,
  "src/repair/loop-implementation-result.ts": 5,
  "src/repair/loop-implementation.ts": 2,
  "src/repair/loop-publication.ts": 1,
  "src/repair/loop-review-recovery.ts": 1,
  "src/repair/loop-review-request.ts": 5,
  "src/repair/loop-work.ts": 2,
};

const SETTLER_CALL =
  /(?<!function )\b(?:settleFailedImplementation|settleAndBlock|handleImplementationUncertainty|settleReviewCharge)\(|\.settleModelStart\(/g;

Deno.test("output bound: every settler that could tear a charge from its record is the audited one", async () => {
  const root = new URL("../../", import.meta.url);
  const found: Record<string, number> = {};
  const walk = async (dir: string): Promise<void> => {
    const entries = [];
    for await (const entry of Deno.readDir(new URL(dir, root))) {
      entries.push(entry);
    }
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = `${dir}${entry.name}`;
      if (entry.isDirectory) await walk(`${path}/`);
      else if (entry.isFile && path.endsWith(".ts")) {
        const text = await Deno.readTextFile(new URL(path, root));
        const calls = text.match(SETTLER_CALL)?.length ?? 0;
        if (calls > 0) found[path] = calls;
      }
    }
  };
  await walk("src/");
  await walk("ops/");
  assert.deepEqual(found, AUDITED_SETTLERS);
});

/** R78 and R79: their transition rules and R79's own repair loop. */
async function rollbackRuntimes() {
  const r78 = await loadGen78Modules(["src/state/state-repair-transition.ts"]);
  const r79 = await loadGen79Modules([
    "src/state/state-repair-transition.ts",
    "src/repair/loop.ts",
    "src/budget/mod.ts",
    "src/repair/attempt-policy.ts",
  ]);
  return {
    // deno-lint-ignore no-explicit-any
    r78: r78.modules as any[],
    // deno-lint-ignore no-explicit-any
    r79: r79.modules as any[],
    dispose: () => Promise.all([r78.dispose(), r79.dispose()]),
  };
}

Deno.test({
  name:
    "output bound: R78 and R79 parse and accept every write, and R79's own settlement writes the same 1127 row, charge and attempt memory",
  ignore: ignoreRollback,
  fn: async () => {
    const loaded = await rollbackRuntimes();
    try {
      const rig = await producerRig();
      const outcome = await rig.pass();
      assert.equal(outcome.result?.status, "applied");
      assert.equal(rig.writes.length, 5);
      for (const { prior, next } of rig.writes) {
        await assertGen78Parses(next);
        await assertGen79Parses(next);
        for (
          const [name, [transition]] of [
            ["R78", loaded.r78],
            ["R79", loaded.r79],
          ] as const
        ) {
          assert.equal(
            transition.validateRepairTransition(prior, next),
            null,
            name,
          );
        }
      }
      // R79's own loop settles the same live record from the same state.
      const [, loop, budget, policy] = loaded.r79;
      assert.equal(
        policy.ATTEMPT_DETAIL_INTERRUPTED_BOUND,
        ATTEMPT_DETAIL_INTERRUPTED_BOUND,
      );
      const own = new TransitionState(liveSnapshot(), RELEASE);
      const deps = {
        state: own,
        clock: CLOCK,
        configs: [CONFIG],
        controllerSha: RUNTIME,
        budget: new budget.RollingStartBudget({
          state: own,
          clock: CLOCK,
          configs: [CONFIG],
        }),
      };
      const context = await loop.loadRepairContext(
        deps,
        loop.createRunBounds(deps, { deadline: NOW + 300_000 }),
      );
      const step = await loop.settleFailedImplementation(
        deps,
        context,
        context.snapshot.work.find((row: WorkRecordV1) => row.id === OVER),
        OVER_CHARGE,
        policy.ATTEMPT_DETAIL_INTERRUPTED_BOUND,
        { stage: "model", failureClass: "transient_infrastructure" },
      );
      assert.notEqual(step.kind, "state_error", JSON.stringify(step));
      assertInterruptedBound(rig, OVER, OVER_CHARGE);
      assert.equal(
        own.snapshot.work.find((row) => row.id === OVER)?.nextStep,
        "blocked",
      );
      const of = (snapshot: RepairStateSnapshotV1) =>
        canonicalStringify({
          work: snapshot.work.find((row) => row.id === OVER),
          charge: snapshot.reservations.find((row) => row.id === OVER_CHARGE),
          memory: snapshot.attemptMemory.filter((row) => row.taskId === OVER),
        });
      assert.equal(of(rig.state.snapshot), of(own.snapshot));
    } finally {
      await loaded.dispose();
    }
  },
});
