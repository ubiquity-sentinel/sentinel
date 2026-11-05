/**
 * Producer-pass settlement of a lost conflict-resolution cell through the real
 * producer pass and consumer (`ingestMatrixResults`). Only the remote seams
 * are fakes: the producer's native completion, its authenticated wave and the
 * native queue. The record is the `issue-ubiquity-ai.ubq.fi-1176` shape: a
 * published, preserved head with its open PR, a marked implementation intent
 * and its `reserved` retry charge, four days after admission.
 */
import assert from "node:assert/strict";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import {
  deriveReservationId,
  RollingStartBudget,
} from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { HostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  matrixCellIdV1,
  matrixDigestV1,
  parseMatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import { ingestMatrixResults } from "../../src/host/matrix.ts";
import type { MatrixIngestReportV1 } from "../../src/host/matrix-ingest.ts";
import {
  conflictMarker,
  conflictMarkerBase,
  conflictResolutionAdmissible,
} from "../../src/repair/conflict-resolution.ts";
import { lostCellLine } from "../../src/repair/conflict-lost-cell.ts";
import {
  baseRefreshIntentKey,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { missingCells } from "../../ops/hosted-autonomy-lost-cell.ts";
import { recoverHostedMatrixProducer } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { REPO, SHA1 } from "../state/helpers.ts";
import {
  PR,
  publishedCandidate,
  TASK,
} from "../repair/conflict-resolution-rig.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";
import {
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/output-bound-overrun-v1.json", import.meta.url),
  ),
) as { runtime: { lastExecutionProof: HostedRunProofV1 } };
const SAVED = LIVE.runtime.lastExecutionProof;
const RUN = {
  runId: SAVED.execution.runId,
  runAttempt: SAVED.execution.runAttempt,
  launcherSha: SAVED.execution.launcherSha,
};
const RELEASE = parseReleaseStateSnapshotV1({
  ...releaseSnapshot(),
  hostedRuntimes: [LIVE.runtime],
});
const CURRENT = { head: SHA1, snapshot: RELEASE };
const CONFIG = repositoryConfig(undefined, undefined, {
  repository: REPO,
  liveStartLimits: { perHour: null, perSevenDays: null },
});

const DAY = 24 * 60 * 60_000;
const ADMITTED = SAVED.execution.createdAt;
const NOW = ADMITTED + 4 * DAY;
const CLOCK = { now: () => NOW };
const B0 = "b0".repeat(20) as GitSha;
const HEAD = "ab".repeat(20) as GitSha;
const BASE = "db".repeat(20) as GitSha;

async function inFlight() {
  const record = await publishedCandidate(
    { b0: B0, head: HEAD, base: BASE } as never,
  );
  const attempt = record.counters.attempts + 1;
  const id = await deriveReservationId({
    repository: REPO,
    taskId: TASK,
    head: B0,
    attempt,
    purpose: "retry",
  });
  const work: WorkRecordV1 = {
    ...record,
    counters: { ...record.counters, attempts: attempt },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(id),
      startedAt: ADMITTED,
      branch: record.target.branch,
      expectedHead: null,
      observedBase: B0,
      pr: null,
      requestId: id,
      resultId: null,
      failure: conflictMarker(BASE, ADMITTED),
    },
    createdAt: ADMITTED - 2000,
    firstSeenAt: ADMITTED - 3000,
    updatedAt: ADMITTED,
  };
  const charge: BudgetReservationV1 = {
    version: "v1",
    kind: "budget_reservation",
    repository: REPO,
    id,
    taskId: TASK,
    attempt,
    head: B0,
    purpose: "retry",
    createdAt: ADMITTED,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
  };
  return { work, charge };
}

async function planFor(work: WorkRecordV1) {
  const request = {
    taskId: work.id,
    repository: work.repository,
    base: B0,
    issue: { number: 1, title: "issue 1", body: "body" },
    evidence: [],
    model: "gpt-reserve",
    reasoning: "max",
    maxDurationMs: 1_800_000,
    maxOutputChars: 4_000_000,
    checkoutBase: HEAD,
    mergeBase: BASE,
  };
  return parseMatrixPlanV1({
    version: "v1",
    kind: "matrix_plan",
    waveId: SAVED.execution.id,
    run: RUN,
    plannedAt: ADMITTED,
    cells: [{
      cellId: await matrixCellIdV1(
        SAVED.execution.id,
        work.id,
        work.intent!.requestId!,
      ),
      taskId: work.id,
      repository: work.repository,
      reservationId: work.intent!.requestId!,
      intentKey: work.intent!.key,
      expectedBase: B0,
      runtimeSha: SAVED.execution.revision,
      generation: SAVED.execution.generation,
      requestDigest: await matrixDigestV1(request),
      request,
    }],
  });
}

async function rig(options: {
  completed?: boolean;
  ingest?: (
    ...args: Parameters<typeof ingestMatrixResults>
  ) => Promise<MatrixIngestReportV1>;
} = {}) {
  const { work, charge } = await inFlight();
  const plan = await planFor(work);
  const state = new TransitionState(
    { ...snapshotOf([work], [charge]), updatedAt: ADMITTED },
    RELEASE,
  );
  const calls = { deferred: 0, ingests: 0, recovers: 0 };
  // The completed run's authenticated listing holds no cell artifact: the
  // wave carries the authenticated plan with that cell's result omitted.
  const wave = {
    plan,
    planDigest: await matrixDigestV1(plan),
    results: [],
    bundlesDir: "/nonexistent/bundles",
    provenance: { run: RUN, plannerJobId: 1, cellJobIds: [] },
  };
  const github = {
    nativeQueue: inactiveNativeQueueFixture(),
  } as unknown as GitHubPort;
  const ports = (passState: TransitionState) => ({
    state: passState,
    clock: CLOCK,
    configs: [CONFIG],
    cycleFor: () => ({
      state: passState,
      clock: CLOCK,
      configs: [CONFIG],
      controllerSha: SAVED.execution.revision,
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
    importerFor: () => ({ import: () => Promise.resolve(true) }),
    transportFor: () => ({
      confirmCompletedExecution: () =>
        Promise.resolve(options.completed ?? true),
      recover: () => {
        calls.recovers++;
        return Promise.resolve([wave]);
      },
    }),
    readExecution: () => Promise.resolve({ ok: true as const, value: SAVED }),
    ingest: (...args: Parameters<typeof ingestMatrixResults>) => {
      calls.ingests++;
      return (options.ingest ?? ingestMatrixResults)(...args);
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
  return { state, work, charge, plan, calls, pass };
}

Deno.test("lost cell: a completed run with no artifact for the cell settles it charged and re-pends the resolution", async () => {
  const run = await rig();
  const outcome = await run.pass();
  assert.equal(outcome.deferred, false);
  assert.equal(outcome.result?.status, "applied");
  const line = lostCellLine(TASK, run.charge.id, { runId: RUN.runId });
  assert.ok(outcome.result?.actions.includes(line), JSON.stringify(outcome));
  const charge = run.state.snapshot.reservations[0];
  assert.equal(charge.outcome, "ambiguous", "charged, never refunded");
  assert.equal(charge.settledAt, NOW);
  assert.equal(run.state.snapshot.reservations.length, 1);
  const record = run.state.snapshot.work[0];
  assert.equal(record.nextStep, "work");
  assert.equal(record.intent?.kind, "base_refresh");
  assert.equal(record.intent?.key, baseRefreshIntentKey(PR, HEAD, BASE));
  assert.equal(record.intent?.resultId, null);
  assert.equal(conflictMarkerBase(record.intent), BASE, "marker kept");
  assert.deepEqual(record.target, run.work.target);
  assert.deepEqual(record.counters, run.work.counters);
  // The next cycle's planner admits a fresh resolution of the same conflict.
  assert.equal(
    conflictResolutionAdmissible(true, run.state.snapshot, record),
    BASE,
  );
  // A repeated pass finds nothing left to request and writes nothing.
  const head = run.state.head;
  const again = await run.pass();
  assert.equal(again.result, null);
  assert.equal(run.state.head, head);
});

Deno.test("lost cell: a producer run still in progress leaves the cell untouched", async () => {
  const run = await rig({ completed: false });
  const before = structuredClone(run.state.snapshot);
  const outcome = await run.pass();
  assert.equal(outcome.deferred, true);
  assert.equal(run.calls.recovers, 0, "no wave is read before completion");
  assert.deepEqual(run.state.snapshot, before);
});

Deno.test("lost cell: a cell whose artifact is present is the consumer's, never a lost cell", async () => {
  const run = await rig({
    // The consumer owns a present result; its disposition is recorded and
    // nothing here settles it (`missingCells` only takes resultless cells).
    ingest: (_deps, plan) =>
      Promise.resolve({
        waveId: plan.waveId,
        entries: plan.cells.map((cell) => ({
          cellId: cell.cellId,
          disposition: "duplicate" as const,
          detail: "receipt already consumed",
        })),
        ingested: 0,
      }),
  });
  const before = structuredClone(run.state.snapshot);
  const outcome = await run.pass();
  assert.equal(run.calls.ingests, 1);
  assert.ok(
    !outcome.result?.actions.some((action) => action.startsWith("lost-cell:")),
  );
  assert.deepEqual(run.state.snapshot, before);
  const cellId = run.plan.cells[0].cellId;
  const report = {
    waveId: run.plan.waveId,
    entries: [{ cellId, disposition: "missing" as const, detail: null }],
    ingested: 0,
  };
  assert.deepEqual([...missingCells(report, [])], [cellId]);
  assert.deepEqual(
    [...missingCells(report, [{ cellId } as never])],
    [],
    "a present result is never a lost cell",
  );
});
