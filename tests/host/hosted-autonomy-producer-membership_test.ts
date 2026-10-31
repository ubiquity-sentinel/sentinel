import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  type CurrentMatrixIndexV1,
  MAINTENANCE_INDEX_PATH,
  MAINTENANCE_INDEX_REF,
} from "../../src/contracts/maintenance-index.ts";
import {
  matrixCellIdV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import {
  portOk,
  type RepairStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { createGitBundleImporter } from "../../src/host/matrix-git.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { GitMaintenanceIndex } from "../../src/state/maintenance-index.ts";
import { createRepairStateStore, DenoGitRunner } from "../../src/state/mod.ts";
import { recoverHostedCurrentMatrix } from "../../ops/hosted-autonomy-current-recovery.ts";
import type { MatrixReleaseSnapshot } from "../../ops/hosted-autonomy-current-scan.ts";
import { isDeferredCurrentMatrixHistoryBudget } from "../../ops/hosted-autonomy-policy.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import { FakeGithub, FakeIncidents, FakeReplay } from "../repair/helpers.ts";
import { repairSnapshot } from "../state/git-state-fixtures.ts";
import { gitRun, REPO, sha256Hex, T0, testGitEnv } from "../state/helpers.ts";
import {
  captured,
  execution,
  FIRST_RUN,
  GENERATION,
  LAUNCHER,
  proof,
  releaseHistory,
  RUNTIME,
  walkRows,
  working,
} from "./hosted-autonomy-history-reach-fixtures.ts";
import { bytes, digest, zip } from "./matrix-artifact-fixtures.ts";

type Pending = ReturnType<typeof working>;
type Json = Record<string, unknown>;
const RELEASE_REF = "refs/heads/sentinel-state/release";
const iso = (at: number) => new Date(at).toISOString();

/** Real state/index Git and artifact transport; only external ports are fake. */
async function membershipRig(producers = 3, readCost = 0) {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-membership-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  const remoteUrl = await releaseHistory(root, producers);
  await Deno.mkdir(`${root}/checkout`);
  const env = testGitEnv(`${root}/home`);
  const git = async (cwd: string, args: string[]) => {
    const result = await gitRun(cwd, args, env);
    assert(result.ok, result.stderr);
    return result.stdout.trim();
  };
  const runner = new DenoGitRunner(`${root}/git-home`);
  const store = createRepairStateStore({
    remoteUrl,
    scratchDir: `${root}/setup`,
    runner,
  });
  const pending = working("pending-old");
  const created = await store.writeRepair(
    repairSnapshot({
      work: [pending.record],
      reservations: [pending.charge],
    }),
    null,
  );
  assert(created.ok && created.value.status === "applied");
  let now = T0 + 10_000_000;
  let invocation = 0;
  let sourceChecks = 0;
  const clock = { now: () => now };
  const calls: { runId: number | null; path: string }[] = [];
  const waves = new Map<number, {
    plan: MatrixPlanV1;
    artifacts: Json[];
    jobs: Json[];
    attempt: Json;
    result: MatrixCellResultV1;
  }>();
  const archives = new Map<number, Uint8Array>();
  const logs = new Map<number, string>();
  const job = (
    runId: number,
    id: number,
    name: string,
    step: string,
  ): Json => ({
    id,
    name,
    run_id: runId,
    run_attempt: 1,
    head_sha: LAUNCHER,
    status: "completed",
    conclusion: "success",
    started_at: iso(proof(runId).startedAt),
    completed_at: iso(proof(runId).finishedAt),
    steps: [{
      name: step,
      number: 1,
      status: "completed",
      conclusion: "success",
      started_at: iso(proof(runId).startedAt),
      completed_at: iso(proof(runId).finishedAt),
    }],
  });
  async function addArchive(
    runId: number,
    id: number,
    name: string,
    data: Uint8Array,
  ) {
    archives.set(id, data);
    const artifact = {
      id,
      name,
      size_in_bytes: data.length,
      expired: false,
      digest: `sha256:${await digest(data)}`,
      workflow_run: {
        id: runId,
        repository_id: 123,
        head_repository_id: 123,
        head_branch: "sentinel-supervisor",
        head_sha: LAUNCHER,
      },
    };
    const rows = waves.get(runId)!.artifacts;
    const at = rows.findIndex((row) => row.id === id);
    if (at < 0) rows.push(artifact);
    else rows[at] = artifact;
  }
  async function exposeResult(runId: number) {
    const wave = waves.get(runId)!;
    const cell = wave.plan.cells[0];
    await addArchive(
      runId,
      runId * 10 + 4,
      `sentinel-matrix-cell-${runId}-1-${cell.cellId}`,
      await zip([{ name: "result.json", content: bytes(wave.result) }]),
    );
    logs.set(
      runId * 10 + 3,
      `${iso(proof(runId).startedAt)} ${
        canonicalStringify({
          kind: "sentinel_matrix_cell",
          run: wave.plan.run,
          runtimeSha: RUNTIME,
          generation: GENERATION,
          cellId: cell.cellId,
          reservationId: cell.reservationId,
          resultDigest: await matrixDigestV1(wave.result),
          bundleDigest: null,
          status: wave.result.status,
        })
      }\n`,
    );
  }
  async function addWave(runId: number, row: Pending, visible = false) {
    const run = { runId, runAttempt: 1, launcherSha: LAUNCHER };
    const waveId = execution(runId).id;
    const request = {
      taskId: row.record.id,
      repository: REPO,
      base: row.record.target.base,
      issue: { number: 1, title: "local repair", body: "local evidence" },
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max" as const,
      maxDurationMs: 10_000,
      maxOutputChars: 1000,
    };
    const cell = {
      cellId: await matrixCellIdV1(waveId, row.record.id, row.charge.id),
      taskId: row.record.id,
      repository: REPO,
      reservationId: row.charge.id,
      intentKey: row.record.intent!.key,
      expectedBase: row.record.target.base,
      runtimeSha: RUNTIME,
      generation: GENERATION,
      requestDigest: await matrixDigestV1(request),
      request,
    };
    const plan: MatrixPlanV1 = {
      version: "v1",
      kind: "matrix_plan",
      waveId,
      run,
      plannedAt: proof(runId).startedAt,
      cells: [cell],
    };
    const result: MatrixCellResultV1 = {
      version: "v1",
      kind: "matrix_cell_result",
      waveId,
      cellId: cell.cellId,
      taskId: cell.taskId,
      repository: cell.repository,
      runtimeSha: cell.runtimeSha,
      generation: cell.generation,
      reservationId: cell.reservationId,
      intentKey: cell.intentKey,
      requestDigest: cell.requestDigest,
      run,
      status: "failed",
      receipt: null,
      bundle: null,
      detail: "local interrupted external implementation",
      completedAt: proof(runId).finishedAt,
    };
    waves.set(runId, {
      plan,
      result,
      artifacts: [],
      jobs: [
        job(runId, runId * 10 + 2, "matrix_plan", "Plan isolated issue matrix"),
        job(
          runId,
          runId * 10 + 3,
          `matrix_cell (${cell.cellId})`,
          "Run isolated issue cell",
        ),
        job(runId, runId, "repair", "Run Sentinel repair cycle"),
      ],
      attempt: {
        id: runId,
        run_attempt: 1,
        workflow_id: HOSTED_SUPERVISOR_WORKFLOW_ID,
        path: HOSTED_SUPERVISOR_WORKFLOW_PATH,
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: LAUNCHER,
        repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
        head_repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
        status: "completed",
        run_started_at: iso(execution(runId).createdAt),
        updated_at: iso(proof(runId).finishedAt),
      },
    });
    await addArchive(
      runId,
      runId * 10 + 1,
      `sentinel-matrix-plan-${runId}-1`,
      await zip([{ name: "plan.json", content: bytes(plan) }]),
    );
    logs.set(
      runId * 10 + 2,
      `${iso(proof(runId).startedAt)} ${
        canonicalStringify({
          kind: "sentinel_matrix_plan",
          waveId,
          run,
          runtimeSha: RUNTIME,
          generation: GENERATION,
          planDigest: await matrixDigestV1(plan),
          prepared: 1,
        })
      }\n`,
    );
    if (visible) await exposeResult(runId);
  }
  for (let i = 0; i < producers; i++) {
    await addWave(
      FIRST_RUN + i,
      i === 0 ? pending : working(
        `unrelated-${i}`,
        (i + 10).toString(16).padStart(64, "0"),
      ),
    );
  }
  const http: HttpTransportV1 = (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const run = path.match(/\/runs\/(\d+)/);
    calls.push({ runId: run ? Number(run[1]) : null, path });
    now += readCost;
    const response = (body: unknown, headers = new Headers()) =>
      Promise.resolve({
        status: 200,
        headers,
        bodyText: canonicalStringify(body),
      });
    if (url.hostname === "productionresultssa1.blob.core.windows.net") {
      assert.equal(request.headers.has("authorization"), false);
      const id = Number(path.split("/").at(-1));
      if (path.startsWith("/archive/")) {
        const data = archives.get(id);
        assert(data);
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: "",
          bodyBytes: data,
        });
      }
      assert(logs.has(id), `unexpected fake log ${id}`);
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: logs.get(id)!,
      });
    }
    assert.equal(url.hostname, "api.github.com");
    assert.equal(
      request.headers.get("authorization"),
      "Bearer local-test-token",
    );
    if (run) {
      const wave = waves.get(Number(run[1]));
      assert(wave, `unexpected fake run ${run[1]}`);
      if (path.endsWith("/jobs")) {
        return response({ total_count: wave.jobs.length, jobs: wave.jobs });
      }
      if (path.endsWith("/artifacts")) {
        return response({
          total_count: wave.artifacts.length,
          artifacts: wave.artifacts,
        });
      }
      assert(path.endsWith("/attempts/1"), path);
      return response(wave.attempt);
    }
    const archive = path.match(/\/artifacts\/(\d+)\/zip$/);
    const log = path.match(/\/jobs\/(\d+)\/logs$/);
    assert(archive || log, path);
    return Promise.resolve({
      status: 302,
      headers: new Headers([[
        "location",
        `https://productionresultssa1.blob.core.windows.net/${
          archive ? "archive" : "log"
        }/${(archive ?? log)![1]}`,
      ]]),
      bodyText: "",
    });
  };
  const index = () =>
    new GitMaintenanceIndex({
      remoteUrl,
      scratchDir: `${root}/index-${++invocation}`,
      runner,
    });
  const hooks: {
    source?: (row: MatrixReleaseSnapshot) => MatrixReleaseSnapshot;
    custodyMoved?: boolean;
  } = {};
  async function run() {
    sourceChecks = 0;
    const reader = createRepairStateStore({
      remoteUrl,
      scratchDir: `${root}/invocation-${++invocation}`,
      runner,
    });
    assert(reader.readReleaseAt && reader.openReleaseHistory);
    let releaseReads = 0;
    const state: StateReadView & RepairStateWriter = {
      readRepair: () => reader.readRepair(),
      writeRepair: (next, expected) => reader.writeRepair(next, expected),
      readRelease: async () => {
        const read = await reader.readRelease();
        releaseReads++;
        return hooks.custodyMoved && releaseReads > 1 && read.ok &&
            read.value.status === "found"
          ? portOk({ ...read.value, head: "f".repeat(40) as GitSha })
          : read;
      },
      readReleaseAt: (input) => {
        sourceChecks++;
        return reader.readReleaseAt!(input);
      },
      openReleaseHistory: async (input) => {
        const opened = await reader.openReleaseHistory!(input);
        if (!opened.ok) return opened;
        const view = opened.value;
        return portOk({
          ...view,
          readAt: async (head: GitSha) => {
            sourceChecks++;
            const read = await view.readAt(head);
            return hooks.source && read.ok && read.value.status === "found"
              ? portOk(hooks.source(read.value))
              : read;
          },
        });
      },
    };
    const config = repositoryConfig();
    const closedMatrix: NonNullable<HostedAutonomyDepsV1["closedMatrix"]> = (
      guarded = state,
    ) =>
      Promise.resolve({
        state: guarded,
        clock,
        configs: [config],
        cycleFor: () => ({
          state: guarded,
          clock,
          configs: [config],
          controllerSha: RUNTIME,
          github: new FakeGithub(),
          githubCooldown: new HostedRepairCooldownGate({
            state: guarded,
            clock,
          }),
          incidents: new FakeIncidents(),
          replay: new FakeReplay(),
          model: {
            modelId: "gpt-reserve",
            runModel: () => {
              throw new Error("no model call belongs in recovery");
            },
          },
          budget: new RollingStartBudget({
            state: guarded,
            clock,
            configs: [config],
          }),
          externalImplementations: true,
        }),
        prepareTarget: () => Promise.resolve(),
        importerFor: (_, bundlesDir) =>
          createGitBundleImporter({
            repositoryDir: `${root}/unused-target`,
            bundlesDir,
          }),
        transportFor: (producerState) =>
          createActionsMatrixArtifactTransport({
            state: producerState,
            clock,
            token: "local-test-token",
            artifactRoot: `${root}/artifacts`,
            http,
          }),
        // Native settlement is an injected external port; the real artifact
        // transport independently authenticates native attempt/jobs/markers.
        readExecution: (saved) => Promise.resolve(portOk(proof(saved.runId))),
      });
    // The artifact directory must be outside the consumer checkout. Both
    // remain inside the existing read permission's task-owned temporary root.
    const originalCwd = Deno.cwd();
    Deno.chdir(`${root}/checkout`);
    try {
      return await recoverHostedCurrentMatrix(
        {
          state,
          clock,
          closedMatrix,
          currentMatrixIndex: index(),
          githubFor: () => null,
        } as HostedAutonomyDepsV1,
        CLOSED_C_WAVE,
        () => {},
      );
    } finally {
      Deno.chdir(originalCwd);
    }
  }
  async function snapshot() {
    const read = await store.readRepair();
    assert(read.ok && read.value.status === "found");
    return read.value;
  }
  async function addPending(row: Pending) {
    const before = await snapshot();
    const saved = await store.writeRepair({
      ...before.snapshot,
      stateHead: before.head,
      sequence: before.snapshot.sequence + 1,
      updatedAt: now,
      work: [...before.snapshot.work, row.record],
      reservations: [...before.snapshot.reservations, row.charge],
    }, before.head);
    assert(saved.ok && saved.value.status === "applied");
  }
  async function append(row: Pending, runId: number) {
    await addPending(row);
    const work = `${root}/history-work`;
    const parent = await git(work, ["rev-parse", "HEAD"]);
    const manifest = JSON.parse(
      await Deno.readTextFile(`${work}/manifest.json`),
    );
    const runtimePath = `${work}/hostedRuntimes/${await sha256Hex(
      HOSTED_RUNTIME_ID,
    )}.json`;
    const runtime = JSON.parse(await Deno.readTextFile(runtimePath));
    manifest.stateHead = parent;
    manifest.sequence++;
    manifest.updatedAt = now;
    runtime.lastExecutionProof = proof(runId);
    runtime.updatedAt = now;
    await Deno.writeTextFile(runtimePath, `${canonicalStringify(runtime)}\n`);
    await Deno.writeTextFile(
      `${work}/manifest.json`,
      `${canonicalStringify(manifest)}\n`,
    );
    await git(work, ["add", "-A"]);
    await git(work, ["commit", "-q", "-m", "new settled producer"]);
    await git(work, ["push", "-q", remoteUrl, `HEAD:${RELEASE_REF}`]);
    await addWave(runId, row, true);
  }
  async function corruptIndex() {
    const work = `${root}/index-edit`;
    await git(root, [
      "clone",
      "-q",
      "--branch",
      MAINTENANCE_INDEX_REF.slice("refs/heads/".length),
      remoteUrl,
      work,
    ]);
    const path = `${work}/${MAINTENANCE_INDEX_PATH}`;
    const body = JSON.parse(await Deno.readTextFile(path));
    body.producers.find((row: { plan?: unknown }) => row.plan).plan
      .unavailable = true;
    await Deno.writeTextFile(path, `${canonicalStringify(body)}\n`);
    await git(work, ["add", MAINTENANCE_INDEX_PATH]);
    await git(work, ["commit", "-q", "-m", "corrupt acceleration descriptor"]);
    await git(work, ["push", "-q", remoteUrl, `HEAD:${MAINTENANCE_INDEX_REF}`]);
    return await git(work, ["rev-parse", "HEAD"]);
  }
  return {
    pending,
    calls,
    hooks,
    run,
    index,
    snapshot,
    exposeResult,
    addPending,
    append,
    corruptIndex,
    indexHead: () => git(root, ["ls-remote", remoteUrl, MAINTENANCE_INDEX_REF]),
    cleanup: () => Deno.remove(root, { recursive: true }),
    elapsed: () => now - T0 - 10_000_000,
    sourceChecks: () => sourceChecks,
  };
}

Deno.test("current matrix positive plan membership resumes past unrelated producers and retains late results", async () => {
  const rig = await membershipRig(45, 1000);
  try {
    const original = await rig.snapshot();
    const first = await captured(rig.run);
    assert(
      first.error !== null &&
        isDeferredCurrentMatrixHistoryBudget(first.error),
    );
    assert.equal(rig.calls.some((call) => call.runId === FIRST_RUN), false);
    const saved = await rig.index().read();
    assert(saved.ok && saved.value.index !== null);
    const learned = saved.value.index.producers.filter((row) =>
      row.plan !== undefined
    );
    assert.deepEqual(await rig.snapshot(), original);
    const firstCost = rig.elapsed();
    const firstRequests = rig.calls.length;
    const firstProducers = new Set(
      rig.calls.filter((call) => call.runId !== null).map((call) => call.runId),
    ).size;
    rig.calls.length = 0;
    const resumed = await captured(rig.run);
    console.log(JSON.stringify({
      kind: "sentinel_membership_restart_benchmark",
      firstRequests,
      firstProducers,
      firstInjectedMs: firstCost,
      resumedRequests: rig.calls.length,
      resumedProducers: new Set(
        rig.calls.filter((call) => call.runId !== null).map((call) =>
          call.runId
        ),
      ).size,
      resumedInjectedMs: rig.elapsed() - firstCost,
      learnedPlans: learned.length,
    }));
    assert.equal(resumed.error, null);
    const [metrics] = walkRows(resumed.lines);
    assert.equal(walkRows(resumed.lines).length, 1);
    assert.equal(metrics.outcome, "completed");
    assert.equal(metrics.membershipHits, learned.length);
    assert.equal(metrics.membershipSkips, learned.length);
    assert.equal(metrics.producers, 45 - learned.length);
    assert.equal(metrics.sourceChecks, rig.sourceChecks());
    assert(metrics.sourceChecks > metrics.producers);
    console.log(JSON.stringify(metrics));
    assert(rig.calls.some((call) => call.runId === FIRST_RUN));
    assert(learned.length > 0 && learned.length < 44);
    for (const row of learned) {
      assert.equal(
        rig.calls.some((call) => call.runId === row.execution.runId),
        false,
      );
    }
    const stillPending = await rig.snapshot();
    assert.deepEqual(
      stillPending,
      original,
      "an absent result stays charged and requestable",
    );
    const warm = await rig.index().read();
    assert(warm.ok && warm.value.index !== null);
    assert.equal(
      warm.value.index.producers.find((row) =>
        row.execution.runId === FIRST_RUN
      )?.plan,
      undefined,
    );
    await rig.exposeResult(FIRST_RUN);
    const consumed = await captured(rig.run);
    assert.equal(consumed.error, null);
    assert.equal(consumed.value?.status, "applied");
    assert.deepEqual(walkRows(consumed.lines), []);
    const after = await rig.snapshot();
    assert.equal(after.snapshot.work[0].nextStep, "blocked");
    assert.deepEqual(after.snapshot.work[0].intent, rig.pending.record.intent);
    assert.equal(after.snapshot.reservations[0].outcome, "ambiguous");
    assert.notEqual(after.snapshot.reservations[0].settledAt, null);
    // A plan learned while unrelated becomes relevant to a restored exact
    // charged intent. Its positive membership must admit every later read.
    const cached = learned[0];
    const cachedRow = working(
      `unrelated-${cached.execution.runId - FIRST_RUN}`,
      cached.plan!.reservationIds[0],
    );
    await rig.addPending(cachedRow);
    rig.calls.length = 0;
    const absent = await captured(rig.run);
    assert.equal(absent.error, null);
    assert(rig.calls.some((call) => call.runId === cached.execution.runId));
    const unconsumed = await rig.snapshot();
    assert.deepEqual(
      unconsumed.snapshot.work.find((row) => row.id === cachedRow.record.id),
      cachedRow.record,
    );
    assert.deepEqual(
      unconsumed.snapshot.reservations.find((row) =>
        row.id === cachedRow.charge.id
      ),
      cachedRow.charge,
    );
    await rig.exposeResult(cached.execution.runId);
    const late = await captured(rig.run);
    assert.equal(late.error, null);
    assert.equal(late.value?.status, "applied");
    const settled = await rig.snapshot();
    assert.equal(
      settled.snapshot.work.find((row) => row.id === cachedRow.record.id)
        ?.nextStep,
      "blocked",
    );
    assert.deepEqual(
      settled.snapshot.work.find((row) => row.id === cachedRow.record.id)
        ?.intent,
      cachedRow.record.intent,
    );
    assert.equal(
      settled.snapshot.reservations.find((row) =>
        row.id === cachedRow.charge.id
      )
        ?.outcome,
      "ambiguous",
    );
    const newer = working("pending-new", "a".repeat(64));
    await rig.append(newer, FIRST_RUN + 100);
    rig.calls.length = 0;
    const next = await captured(rig.run);
    assert.equal(next.error, null);
    assert.equal(next.value?.status, "applied");
    assert(rig.calls.some((call) => call.runId === FIRST_RUN + 100));
    const final = await rig.snapshot();
    assert.equal(
      final.snapshot.work.find((row) => row.id === newer.record.id)?.nextStep,
      "blocked",
    );
    assert.deepEqual(
      final.snapshot.work.find((row) => row.id === newer.record.id)?.intent,
      newer.record.intent,
    );
    assert.equal(
      final.snapshot.reservations.find((row) => row.id === newer.charge.id)
        ?.outcome,
      "ambiguous",
    );
    console.log(JSON.stringify({
      firstInjectedMs: firstCost,
      learnedPlans: learned.length,
      laterInjectedMs: rig.elapsed() - firstCost,
    }));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("current matrix older discovery sidecars retain the complete unknown-plan recovery path", async () => {
  const rig = await membershipRig();
  try {
    assert.equal((await captured(rig.run)).error, null);
    const sidecar = rig.index();
    const read = await sidecar.read();
    assert(read.ok && read.value.index !== null && read.value.head !== null);
    const legacy: CurrentMatrixIndexV1 = {
      ...read.value.index,
      producers: read.value.index.producers.map((row) => ({
        head: row.head,
        sequence: row.sequence,
        execution: row.execution,
        proofFingerprint: row.proofFingerprint,
      })),
    };
    const saved = await sidecar.write({
      expectedHead: read.value.head,
      index: legacy,
    });
    assert(saved.ok && saved.value.status === "applied");
    const old = await rig.index().read();
    assert(old.ok && old.value.index !== null);
    assert.deepEqual(old.value.index, legacy);
    rig.calls.length = 0;
    assert.equal((await captured(rig.run)).error, null);
    for (let i = 0; i < 3; i++) {
      assert(rig.calls.some((call) => call.runId === FIRST_RUN + i));
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("current matrix corrupt positive membership falls back without replacing unknown sidecar or charges", async () => {
  const rig = await membershipRig();
  try {
    assert.equal((await captured(rig.run)).error, null);
    const before = await rig.snapshot();
    const corruptHead = await rig.corruptIndex();
    const invalid = await rig.index().read();
    assert.equal(invalid.ok, false);
    rig.calls.length = 0;
    assert.equal((await captured(rig.run)).error, null);
    assert(rig.calls.some((call) => call.runId === FIRST_RUN + 2));
    assert(rig.calls.some((call) => call.runId === FIRST_RUN));
    assert((await rig.indexHead()).startsWith(`${corruptHead}\t`));
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("current matrix contradictory positive metadata cannot fail a verified consumer or replace the sidecar", async () => {
  const rig = await membershipRig();
  try {
    assert.equal((await captured(rig.run)).error, null);
    const sidecar = rig.index();
    const read = await sidecar.read();
    assert(read.ok && read.value.index !== null && read.value.head !== null);
    const changed = structuredClone(read.value.index);
    const producer = changed.producers.find((row) =>
      row.execution.runId === FIRST_RUN + 2
    )!;
    assert(producer.plan);
    producer.plan.planDigest = "f".repeat(64);
    const written = await sidecar.write({
      expectedHead: read.value.head,
      index: changed,
    });
    assert(written.ok && written.value.status === "applied");
    const untouched = await rig.snapshot();
    const row = working("unrelated-2", producer.plan.reservationIds[0]);
    await rig.addPending(row);
    await rig.exposeResult(FIRST_RUN + 2);
    const result = await captured(rig.run);
    assert.equal(result.error, null);
    assert.equal(result.value?.status, "applied");
    const after = await rig.snapshot();
    assert.equal(
      after.snapshot.work.find((work) => work.id === row.record.id)?.nextStep,
      "blocked",
    );
    assert.deepEqual(
      after.snapshot.work.find((work) => work.id === row.record.id)?.intent,
      row.record.intent,
    );
    assert.deepEqual(
      after.snapshot.work.find((work) => work.id === rig.pending.record.id),
      untouched.snapshot.work.find((work) => work.id === rig.pending.record.id),
    );
    assert.deepEqual(
      after.snapshot.reservations.find((charge) =>
        charge.id === rig.pending.charge.id
      ),
      untouched.snapshot.reservations.find((charge) =>
        charge.id === rig.pending.charge.id
      ),
    );
    assert((await rig.indexHead()).startsWith(`${written.value.head}\t`));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("current matrix positive membership retains fresh source and write custody refusals", async () => {
  const rig = await membershipRig();
  try {
    assert.equal((await captured(rig.run)).error, null);
    const before = await rig.snapshot();
    rig.hooks.source = (row) => {
      const runtime = row.snapshot.hostedRuntimes.find((r) =>
        r.id === HOSTED_RUNTIME_ID
      )!;
      if (runtime.lastExecutionProof?.execution.runId !== FIRST_RUN + 1) {
        return row;
      }
      const changed = structuredClone(row);
      const saved = changed.snapshot.hostedRuntimes[0].lastExecutionProof;
      assert(saved && saved.outcome !== "not_started");
      saved.logDigest = "f".repeat(64);
      return changed;
    };
    const source = await captured(rig.run);
    assert(source.error instanceof CurrentMatrixRecoveryIntegrityFailure);
    assert.match(source.error.message, /producer ancestry changed/);
    delete rig.hooks.source;
    rig.hooks.custodyMoved = true;
    const custody = await captured(rig.run);
    assert(custody.error instanceof CurrentMatrixRecoveryIntegrityFailure);
    assert.match(custody.error.message, /release custody changed/);
    assert.deepEqual(await rig.snapshot(), before);
  } finally {
    await rig.cleanup();
  }
});
