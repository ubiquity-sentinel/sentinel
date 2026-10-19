import assert from "node:assert/strict";
import { DORMANT_HOSTED_POLICIES } from "./actions-supervisor-fixture.ts";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  matrixCellIdV1,
  type MatrixCellResultV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import { runHostedSupervisorFinalize } from "../../src/host/actions-supervisor.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  candidateBranch,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { createHostedHistoricalMatrixQuarantine } from "../../ops/hosted-autonomy.ts";
import { reservation, T0, workRecord } from "../state/helpers.ts";
import { BASE, SELF_REPO } from "./hosted-autonomy-fixtures.ts";
import type { run } from "./hosted-autonomy-rig.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";

export async function historicalMultiWaveRig(
  historicalCount = 17,
  currentCount = 3,
  finalizeCurrent = true,
) {
  const f = await historicalMalformedRig(false, historicalCount, false, true);
  const release = createReleaseStateStore({
    scratchDir: `${f.rig.tmp}/multi-release`,
    remoteUrl: `${f.rig.tmp}/remote.git`,
  });
  f.clock.now = () => T0 + 30_000;
  const originalEvidence = {
    readExecution: f.client.readHostedExecution.bind(f.client),
    verifyRevision: () => Promise.resolve(portOk(true)),
    verifyRequest: () => Promise.resolve(portOk(false)),
  };
  assert.equal(
    (await runHostedSupervisorFinalize({
      ...DORMANT_HOSTED_POLICIES,
      state: release,
      clock: f.clock,
      run: f.nativeRun,
      evidence: originalEvidence,
    })).status,
    "idle",
  );
  const witness = await release.readRelease();
  assert(witness.ok && witness.value.status === "found");
  const proof = witness.value.snapshot.hostedRuntimes[0].lastExecutionProof!;
  assert(proof.outcome !== "not_started");
  const run = {
    runId: 73,
    runAttempt: 1,
    launcherSha: "4".repeat(40) as GitSha,
  };
  const execution = {
    ...f.execution,
    ...run,
    id: "73:1:repair",
    createdAt: T0 + 31_000,
  };
  f.clock.now = () => T0 + 31_000;
  const started = await release.writeRelease({
    ...witness.value.snapshot,
    stateHead: witness.value.head,
    sequence: witness.value.snapshot.sequence + 1,
    updatedAt: f.clock.now(),
    hostedRuntimes: [{
      ...witness.value.snapshot.hostedRuntimes[0],
      execution,
      updatedAt: f.clock.now(),
    }],
  }, witness.value.head);
  assert(started.ok && started.value.status === "applied");
  const records = Array.from({ length: currentCount }, (_, i) => {
    const id = `multi-current-${i}` as WorkItemId;
    const requestId = `${i + 1}`.repeat(64);
    return workRecord(id, {
      ...f.records[0],
      id,
      source: { ...f.records[0].source, id },
      related: { incidentId: null, issueNumber: 101 + i },
      target: { ...f.records[0].target, branch: candidateBranch(id) },
      intent: {
        ...f.records[0].intent!,
        branch: candidateBranch(id),
        key: implementationIntentKey(requestId),
        requestId,
        startedAt: T0 + 32_001 + i,
      },
      createdAt: T0 + 32_000,
      updatedAt: T0 + 32_001 + i,
    });
  });
  const charges = records.map((row, i) =>
    reservation(row.intent!.requestId!, {
      repository: SELF_REPO,
      taskId: row.id,
      head: BASE,
      createdAt: T0 + 32_001 + i,
    })
  );
  const repair = await f.rig.state.readRepair();
  assert(repair.ok && repair.value.status === "found");
  f.clock.now = () => T0 + 33_000;
  const added = await f.rig.state.writeRepair({
    ...repair.value.snapshot,
    stateHead: repair.value.head,
    sequence: repair.value.snapshot.sequence + 1,
    updatedAt: f.clock.now(),
    work: [...repair.value.snapshot.work, ...records],
    reservations: [...repair.value.snapshot.reservations, ...charges],
  }, repair.value.head);
  assert(added.ok && added.value.status === "applied");
  const cells = await Promise.all(records.map(async (row) => {
    const request = {
      ...f.plan.cells[0].request,
      taskId: row.id,
      issue: {
        number: row.related.issueNumber!,
        title: "sanitized",
        body: "sanitized",
      },
    };
    return {
      ...f.plan.cells[0],
      cellId: await matrixCellIdV1(
        execution.id,
        row.id,
        row.intent!.requestId!,
      ),
      taskId: row.id,
      reservationId: row.intent!.requestId!,
      intentKey: row.intent!.key,
      requestDigest: await matrixDigestV1(request),
      request,
    };
  }));
  const plan: MatrixPlanV1 = {
    ...f.plan,
    waveId: execution.id,
    run,
    plannedAt: T0 + 32_000,
    cells,
  };
  const iso = (at: number) => new Date(at).toISOString();
  const archives = new Map<number, Uint8Array>();
  const artifacts: Record<string, unknown>[] = [];
  const logs = new Map<number, string>();
  async function archived(
    id: number,
    name: string,
    filename: string,
    value: unknown,
  ) {
    const writer = new ZipWriter(new Uint8ArrayWriter(), {
      useWebWorkers: false,
    });
    await writer.add(
      filename,
      new Uint8ArrayReader(new TextEncoder().encode(canonicalStringify(value))),
      { unixMode: 0o100600 },
    );
    const bytes = await writer.close();
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
    ].map((value) => value.toString(16).padStart(2, "0")).join("");
    archives.set(id, bytes);
    artifacts.push({
      id,
      name,
      size_in_bytes: bytes.length,
      expired: false,
      digest: `sha256:${digest}`,
      workflow_run: {
        id: run.runId,
        repository_id: 123,
        head_repository_id: 123,
        head_branch: "sentinel-supervisor",
        head_sha: run.launcherSha,
      },
    });
  }
  await archived(901, "sentinel-matrix-plan-73-1", "plan.json", plan);
  logs.set(
    801,
    `${iso(T0 + 49_000)} ${
      JSON.stringify({
        kind: "sentinel_matrix_plan",
        waveId: execution.id,
        run,
        runtimeSha: execution.revision,
        generation: execution.generation,
        planDigest: await matrixDigestV1(plan),
        prepared: cells.length,
      })
    }\n`,
  );
  logs.set(899, `${iso(T0 + 50_000)} child exited before terminal\n`);
  for (const [i, cell] of cells.entries()) {
    const result: MatrixCellResultV1 = {
      version: "v1",
      kind: "matrix_cell_result",
      waveId: execution.id,
      run,
      runtimeSha: execution.revision,
      generation: execution.generation,
      cellId: cell.cellId,
      taskId: cell.taskId,
      repository: SELF_REPO,
      reservationId: cell.reservationId,
      intentKey: cell.intentKey,
      requestDigest: cell.requestDigest,
      status: "not_started",
      receipt: null,
      bundle: null,
      detail: "sanitized no start",
      completedAt: T0 + 49_000,
    };
    await archived(
      902 + i,
      `sentinel-matrix-cell-73-1-${cell.cellId}`,
      "result.json",
      result,
    );
    logs.set(
      802 + i,
      `${iso(T0 + 49_000)} ${
        JSON.stringify({
          kind: "sentinel_matrix_cell",
          run,
          runtimeSha: execution.revision,
          generation: execution.generation,
          cellId: cell.cellId,
          reservationId: cell.reservationId,
          resultDigest: await matrixDigestV1(result),
          bundleDigest: null,
          status: "not_started",
        })
      }\n`,
    );
  }
  const jobs = [
    { id: 801, name: "matrix_plan", step: "Plan isolated issue matrix" },
    { id: 899, name: "repair", step: "Run selected Sentinel runtime" },
    ...cells.map((cell, i) => ({
      id: 802 + i,
      name: `matrix_cell (${cell.cellId})`,
      step: "Run isolated issue cell",
    })),
  ].map((row) => ({
    id: row.id,
    name: row.name,
    run_id: run.runId,
    run_attempt: 1,
    head_sha: run.launcherSha,
    status: "completed",
    conclusion: row.id === 899 ? "failure" : "success",
    started_at: iso(T0 + 31_000),
    completed_at: iso(T0 + 50_000),
    steps: [{
      name: row.step,
      number: 1,
      status: "completed",
      conclusion: row.id === 899 ? "failure" : "success",
      started_at: iso(T0 + 31_000),
      completed_at: iso(T0 + 50_000),
    }],
  }));
  let missingPlan = false;
  let bootstrap:
    | { execution: HostedExecutionIntentV1; run: typeof run }
    | null = null;
  const response = (value: unknown) =>
    Promise.resolve({
      status: 200,
      headers: new Headers(),
      bodyText: typeof value === "string" ? value : JSON.stringify(value),
    });
  const http: HttpTransportV1 = (request) => {
    const url = new URL(request.url);
    if (bootstrap && url.pathname.includes(`/runs/${bootstrap.run.runId}/`)) {
      const saved = bootstrap;
      const job = {
        ...jobs[1],
        id: 999,
        run_id: saved.run.runId,
        head_sha: saved.run.launcherSha,
        conclusion: "success",
        started_at: iso(f.clock.now()),
        completed_at: iso(f.clock.now()),
        steps: [{
          ...jobs[1].steps[0],
          conclusion: "success",
          started_at: iso(f.clock.now()),
          completed_at: iso(f.clock.now()),
        }],
      };
      return response(
        url.pathname.endsWith("/jobs") ? { total_count: 1, jobs: [job] } : {
          id: saved.run.runId,
          run_attempt: 1,
          workflow_id: 357012162,
          path: ".github/workflows/supervisor.yml",
          event: "workflow_dispatch",
          head_branch: "sentinel-supervisor",
          head_sha: saved.run.launcherSha,
          repository: { id: 123, full_name: "ubiquity/sentinel" },
          head_repository: { id: 123, full_name: "ubiquity/sentinel" },
          status: "completed",
          conclusion: "success",
          run_started_at: iso(f.clock.now()),
          updated_at: iso(f.clock.now()),
        },
      );
    }
    if (bootstrap && url.pathname.endsWith("/jobs/999/logs")) {
      logs.set(
        999,
        `${iso(f.clock.now())} ${
          JSON.stringify({
            version: "v1",
            kind: "hosted_runtime_terminal",
            execution: bootstrap.execution,
            controllerSha: bootstrap.execution.revision,
            startedAt: f.clock.now(),
            finishedAt: f.clock.now(),
            outcome: "healthy",
            startupReady: true,
            settled: true,
            baseSha: BASE,
          })
        }\n`,
      );
    }
    if (url.pathname.includes("/runs/73/")) {
      assert.equal(
        request.headers.get("authorization"),
        "Bearer offline-native-token",
      );
      if (url.pathname.endsWith("/jobs")) {
        return response({ total_count: jobs.length, jobs });
      }
      if (url.pathname.endsWith("/artifacts")) {
        return response({
          total_count: missingPlan ? 0 : artifacts.length,
          artifacts: missingPlan ? [] : artifacts,
        });
      }
      return response({
        id: 73,
        run_attempt: 1,
        workflow_id: 357012162,
        path: ".github/workflows/supervisor.yml",
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: run.launcherSha,
        repository: { id: 123, full_name: "ubiquity/sentinel" },
        head_repository: { id: 123, full_name: "ubiquity/sentinel" },
        status: "completed",
        conclusion: "failure",
        run_started_at: iso(T0 + 31_000),
        updated_at: iso(T0 + 50_000),
      });
    }
    const archive = url.pathname.match(/\/artifacts\/(90[1-4])\/zip$/);
    const log = url.pathname.match(/\/jobs\/(80[1-4]|899|999)\/logs$/);
    if (archive || log) {
      return Promise.resolve({
        status: 302,
        headers: new Headers({
          location:
            `https://productionresultssa1.blob.core.windows.net/multiwave/${
              archive ? "archive" : "log"
            }/${(archive ?? log)![1]}`,
        }),
        bodyText: "",
      });
    }
    if (url.pathname.startsWith("/multiwave/")) {
      assert.equal(request.headers.size, 0);
      assert.equal(request.redirect, "error");
      const id = Number(url.pathname.split("/").at(-1));
      return url.pathname.includes("/archive/")
        ? Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: "",
          bodyBytes: archives.get(id)!,
        })
        : response(logs.get(id)!);
    }
    return f.http(request);
  };
  const client = new GitHubApiClient({
    repository: SELF_REPO,
    apiBaseUrl: "https://api.github.com",
    http,
    clock: f.clock,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk("Bearer offline-native-token")),
    },
    cooldownGate: new HostedRepairCooldownGate({
      state: f.rig.state,
      clock: f.clock,
    }),
  });
  const evidence = {
    ...originalEvidence,
    readExecution: client.readHostedExecution.bind(client),
  };
  f.clock.now = () => T0 + 60_000;
  if (finalizeCurrent) {
    assert.equal(
      (await runHostedSupervisorFinalize({
        ...DORMANT_HOSTED_POLICIES,
        state: release,
        clock: f.clock,
        run,
        evidence,
      })).status,
      "idle",
    );
  }
  Object.assign(
    f.historicalMatrix,
    createHostedHistoricalMatrixQuarantine({
      state: f.rig.state,
      clock: f.clock,
      token: "offline-native-token",
      artifactRoot: `${f.rig.tmp}/multi-artifacts`,
      http,
      artifactHttp: http,
      historicalReleaseWitnesses: [{
        commit: witness.value.head,
        executionId: proof.execution.id,
        logDigest: proof.logDigest,
        reservationIds: f.charges.slice(0, 17).map((row) => row.id),
      }],
    }),
  );
  return {
    ...f,
    release,
    records,
    charges,
    evidence,
    witness: witness.value,
    setMissing: (value: boolean) => {
      missingPlan = value;
    },
    setBootstrap: (
      value: { execution: HostedExecutionIntentV1; run: typeof run },
    ) => {
      bootstrap = value;
    },
  };
}
