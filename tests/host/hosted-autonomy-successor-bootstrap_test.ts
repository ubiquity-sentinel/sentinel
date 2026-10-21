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
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-actions.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import {
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
} from "../repair/helpers.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { BASE, SELF_REPO } from "./hosted-autonomy-fixtures.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";

Deno.test("historical malformed wave: successor bootstrap overwrites proof and aggregate excludes old rows", async () => {
  const f = await historicalMalformedRig();
  try {
    await f.run();
    const quarantined = await f.rig.state.readRepair();
    assert(quarantined.ok && quarantined.value.status === "found");
    const release = createReleaseStateStore({
      scratchDir: `${f.rig.tmp}/successor-release`,
      remoteUrl: `${f.rig.tmp}/remote.git`,
    });
    const evidence = {
      readExecution: f.client.readHostedExecution.bind(f.client),
      verifyRevision: () => Promise.resolve(portOk(true)),
      verifyRequest: () => Promise.resolve(portOk(false)),
    };
    const settled = await runHostedSupervisorFinalize({
      ...DORMANT_HOSTED_POLICIES,
      state: release,
      clock: f.clock,
      run: f.nativeRun,
      evidence,
    });
    assert.equal(settled.status, "idle");
    const successorRun = {
      runId: 72,
      runAttempt: 1,
      launcherSha: "3".repeat(40) as GitSha,
    };
    const prepared = await runHostedSupervisorPrepare({
      ...DORMANT_HOSTED_POLICIES,
      state: release,
      clock: f.clock,
      run: successorRun,
      evidence,
    });
    assert(prepared.status === "run", JSON.stringify(prepared));
    assert.equal(prepared.execution.purpose, "bootstrap");
    assert.notEqual(prepared.execution.launcherSha, f.execution.launcherSha);
    await assert.rejects(f.run);
    const sibling = f.records[17];
    const request = {
      taskId: sibling.id,
      repository: sibling.repository,
      base: BASE,
      issue: { number: 18, title: "sanitized", body: "sanitized" },
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max" as const,
      maxDurationMs: 10_000,
      maxOutputChars: 10_000,
    };
    const cell = {
      cellId: await matrixCellIdV1(
        prepared.execution.id,
        sibling.id,
        sibling.intent!.requestId!,
      ),
      taskId: sibling.id,
      repository: sibling.repository,
      reservationId: sibling.intent!.requestId!,
      intentKey: sibling.intent!.key,
      expectedBase: BASE,
      runtimeSha: prepared.execution.revision,
      generation: prepared.execution.generation,
      requestDigest: await matrixDigestV1(request),
      request,
    };
    const plan: MatrixPlanV1 = {
      version: "v1",
      kind: "matrix_plan",
      waveId: prepared.execution.id,
      run: successorRun,
      plannedAt: f.clock.now(),
      cells: [cell],
    };
    const result: MatrixCellResultV1 = {
      version: "v1",
      kind: "matrix_cell_result",
      waveId: plan.waveId,
      run: successorRun,
      runtimeSha: cell.runtimeSha,
      generation: cell.generation,
      cellId: cell.cellId,
      taskId: cell.taskId,
      repository: cell.repository,
      reservationId: cell.reservationId,
      intentKey: cell.intentKey,
      requestDigest: cell.requestDigest,
      status: "not_started",
      receipt: null,
      bundle: null,
      detail: "deterministic bootstrap",
      completedAt: f.clock.now(),
    };
    const archives = new Map<number, Uint8Array>();
    const rows: Record<string, unknown>[] = [];
    for (
      const [id, name, filename, value] of [
        [1501, "sentinel-matrix-plan-72-1", "plan.json", plan],
        [
          1502,
          `sentinel-matrix-cell-72-1-${cell.cellId}`,
          "result.json",
          result,
        ],
      ] as const
    ) {
      const writer = new ZipWriter(new Uint8ArrayWriter(), {
        useWebWorkers: false,
      });
      await writer.add(
        filename,
        new Uint8ArrayReader(
          new TextEncoder().encode(canonicalStringify(value)),
        ),
        { unixMode: 0o100600 },
      );
      const bytes = await writer.close();
      archives.set(id, bytes);
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice())),
      )
        .map((byte) => byte.toString(16).padStart(2, "0")).join("");
      rows.push({
        id,
        name,
        expired: false,
        size_in_bytes: bytes.length,
        digest: `sha256:${hash}`,
        workflow_run: {
          id: 72,
          repository_id: 123,
          head_repository_id: 123,
          head_branch: "sentinel-supervisor",
          head_sha: successorRun.launcherSha,
        },
      });
    }
    const iso = new Date(f.clock.now()).toISOString();
    const job = (id: number, name: string, step: string) => ({
      id,
      name,
      run_id: 72,
      run_attempt: 1,
      head_sha: successorRun.launcherSha,
      status: "completed",
      conclusion: "success",
      started_at: iso,
      completed_at: iso,
      steps: [{
        name: step,
        number: 1,
        status: "completed",
        conclusion: "success",
        started_at: iso,
        completed_at: iso,
      }],
    });
    const jobs = [
      job(1401, "matrix_plan", "Plan isolated issue matrix"),
      job(1402, `matrix_cell (${cell.cellId})`, "Run isolated issue cell"),
      job(1499, "repair", "Run selected Sentinel runtime"),
    ];
    const logs = new Map([
      [
        1401,
        `${iso} ${
          JSON.stringify({
            kind: "sentinel_matrix_plan",
            waveId: plan.waveId,
            run: successorRun,
            runtimeSha: cell.runtimeSha,
            generation: cell.generation,
            planDigest: await matrixDigestV1(plan),
            prepared: 1,
          })
        }\n`,
      ],
      [
        1402,
        `${iso} ${
          JSON.stringify({
            kind: "sentinel_matrix_cell",
            run: successorRun,
            runtimeSha: cell.runtimeSha,
            generation: cell.generation,
            cellId: cell.cellId,
            reservationId: cell.reservationId,
            resultDigest: await matrixDigestV1(result),
            bundleDigest: null,
            status: "not_started",
          })
        }\n`,
      ],
      [
        1499,
        `${iso} ${
          JSON.stringify({
            version: "v1",
            kind: "hosted_runtime_terminal",
            execution: prepared.execution,
            controllerSha: cell.runtimeSha,
            startedAt: f.clock.now(),
            finishedAt: f.clock.now(),
            outcome: "healthy",
            startupReady: true,
            settled: true,
            baseSha: BASE,
          })
        }\n`,
      ],
    ]);
    let successorPlanReads = 0;
    const currentHttp: HttpTransportV1 = (request) => {
      const url = new URL(request.url);
      const response = (value: unknown) =>
        Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: typeof value === "string" ? value : JSON.stringify(value),
        });
      if (url.pathname.endsWith("/runs/72/attempts/1")) {
        return response({
          id: 72,
          run_attempt: 1,
          workflow_id: 357012162,
          path: ".github/workflows/supervisor.yml",
          event: "workflow_dispatch",
          head_branch: "sentinel-supervisor",
          head_sha: successorRun.launcherSha,
          repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
          head_repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
          status: "completed",
          conclusion: "success",
          run_started_at: iso,
          updated_at: iso,
        });
      }
      if (url.pathname.endsWith("/runs/72/attempts/1/jobs")) {
        return response({ total_count: jobs.length, jobs });
      }
      if (url.pathname.endsWith("/artifacts")) {
        return response({
          total_count: rows.length + f.artifacts.length,
          artifacts: [...f.artifacts, ...rows],
        });
      }
      const archive = url.pathname.match(/\/artifacts\/(150[12])\/zip$/);
      const log = url.pathname.match(/\/jobs\/(1401|1402|1499)\/logs$/);
      if (archive?.[1] === "1501") successorPlanReads += 1;
      if (archive || log) {
        return Promise.resolve({
          status: 302,
          headers: new Headers({
            location:
              `https://productionresultssa1.blob.core.windows.net/successor/${
                archive ? "archive" : "log"
              }/${(archive ?? log)![1]}`,
          }),
          bodyText: "",
        });
      }
      if (url.pathname.startsWith("/successor/")) {
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
    const transport = createActionsMatrixArtifactTransport({
      state: f.rig.state,
      clock: f.clock,
      token: "offline-native-token",
      artifactRoot: `${f.rig.tmp}/current-artifacts`,
      http: currentHttp,
    });
    const config = repositoryConfig(undefined, undefined, {
      repository: SELF_REPO,
      adapter: { kind: "github" },
      liveStartLimits: { perHour: null, perSevenDays: null },
    });
    const model = new FakeModel();
    const github = new FakeGithub({ baseSha: BASE, openIssues: [] });
    const oldPlanReads = f.calls.filter((call) =>
      call.url.endsWith("/artifacts/501/zip")
    ).length;
    const prior = Deno.cwd();
    Deno.chdir(f.checkout);
    try {
      const aggregate = await runActionsMatrixAggregateCycles(
        {
          clock: f.clock,
          state: f.rig.state,
          configs: [config],
          controllerSha: cell.runtimeSha,
          githubCooldown: new HostedRepairCooldownGate({
            state: f.rig.state,
            clock: f.clock,
          }),
          incidents: new FakeIncidents(),
          replay: new FakeReplay(),
          model,
          budget: f.historicalMatrix.budget,
          deadline: f.clock.now() + 60_000,
          stepLimit: 1,
          modelStartsEnabled: false,
          composeGithub: () => github,
          host: {
            execution: prepared.execution,
            run: successorRun,
            artifactRoot: `${f.rig.tmp}/current-artifacts`,
            sourcePathFor: () => f.checkout,
            expectedProvider: "test",
            createArtifactTransport: () => Promise.resolve(transport),
          },
        },
        transport,
        { planDigest: await matrixDigestV1(plan) },
      );
      assert.deepEqual(aggregate.failed, []);
      assert.equal(
        successorPlanReads,
        1,
        "the initial authenticated scan must run inside the remaining run budget even after the polling margin",
      );
    } finally {
      Deno.chdir(prior);
    }
    assert.deepEqual(model.requests, []);
    assert.equal(github.pushes.length, 0);
    assert.equal(
      f.calls.filter((call) => call.url.endsWith("/artifacts/501/zip")).length,
      oldPlanReads,
    );
    const currentClient = new GitHubApiClient({
      repository: SELF_REPO,
      apiBaseUrl: "https://api.github.com",
      http: currentHttp,
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
    const finalized = await runHostedSupervisorFinalize({
      ...DORMANT_HOSTED_POLICIES,
      state: release,
      clock: f.clock,
      run: successorRun,
      evidence: {
        ...evidence,
        readExecution: currentClient.readHostedExecution.bind(currentClient),
      },
    });
    assert.equal(finalized.status, "idle");
    const freshRelease = await release.readRelease();
    assert(freshRelease.ok && freshRelease.value.status === "found");
    assert.equal(
      freshRelease.value.snapshot.hostedRuntimes[0].lastExecutionProof
        ?.execution.id,
      "72:1:repair",
    );
    assert.equal(
      freshRelease.value.snapshot.hostedRuntimes[0].lastHealthyProof?.execution
        .id,
      "72:1:repair",
    );
    await f.run();
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    assert.deepEqual(
      after.value.snapshot.work.filter((row) => row.id !== sibling.id),
      quarantined.value.snapshot.work.filter((row) => row.id !== sibling.id),
    );
    assert.deepEqual(
      after.value.snapshot.reservations.slice(0, 17),
      quarantined.value.snapshot.reservations.slice(0, 17),
    );
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});
