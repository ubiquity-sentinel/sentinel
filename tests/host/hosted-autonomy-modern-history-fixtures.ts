import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  matrixCellIdV1,
  matrixDigestV1,
  type MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { parseHostedExecutionSettlementV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { StateReadView } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import {
  type makeRemoteCtx,
  pushRawTree,
  sha256Hex,
  T0,
} from "../state/helpers.ts";
import { ENV, SELF_REPO } from "./hosted-autonomy-fixtures.ts";
import type { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";

export async function prepareModernHistory(input: {
  f: Awaited<ReturnType<typeof historicalMalformedRig>>;
  native: ReleaseStateSnapshotV1["hostedRuntimes"][number];
  base: GitSha;
  releaseBefore: Awaited<ReturnType<StateReadView["readRelease"]>>;
  target: Awaited<ReturnType<typeof makeRemoteCtx>>;
  runtimeSha?: GitSha;
}) {
  const { f, native, base, target } = input;
  let releaseBefore = input.releaseBefore;
  assert(releaseBefore.ok && releaseBefore.value.status === "found");
  let recoveryHttp = f.http;
  assert(
    native.lastExecutionProof &&
      native.lastExecutionProof.outcome !== "not_started",
  );
  let latestProof = parseHostedExecutionSettlementV1({
    ...native.lastExecutionProof,
    execution: {
      ...f.execution,
      revision: input.runtimeSha ?? f.execution.revision,
      id: "72:2:repair",
      runId: 72,
      createdAt: T0 + 31_000,
    },
    jobId: 1503,
    startedAt: T0 + 32_000,
    finishedAt: T0 + 40_000,
    terminalAt: T0 + 39_000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: base,
    observedAt: f.clock.now(),
  });
  assert(latestProof.outcome === "healthy");
  const currentStartedAt = latestProof.startedAt;
  const execution = latestProof.execution;
  const cell = structuredClone(f.cells[0]);
  cell.runtimeSha = execution.revision;
  cell.taskId = "current-plan-only" as WorkItemId;
  cell.reservationId = "e".repeat(64);
  cell.intentKey = implementationIntentKey(cell.reservationId);
  cell.request.taskId = cell.taskId;
  cell.cellId = await matrixCellIdV1(
    execution.id,
    cell.taskId,
    cell.reservationId,
  );
  cell.requestDigest = await matrixDigestV1(cell.request);
  const currentPlan: MatrixPlanV1 = {
    version: "v1",
    kind: "matrix_plan",
    waveId: execution.id,
    run: {
      runId: execution.runId,
      runAttempt: execution.runAttempt,
      launcherSha: execution.launcherSha,
    },
    plannedAt: execution.createdAt + 1000,
    cells: [cell],
  };
  const writer = new ZipWriter(new Uint8ArrayWriter(), {
    useWebWorkers: false,
  });
  await writer.add(
    "plan.json",
    new Uint8ArrayReader(
      new TextEncoder().encode(canonicalStringify(currentPlan)),
    ),
    { unixMode: 0o100600 },
  );
  const archive = await writer.close();
  const archiveDigest = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", archive.slice())),
  ).map((n) => n.toString(16).padStart(2, "0")).join("");
  const iso = (at: number) => new Date(at).toISOString();
  const terminal = iso(latestProof.terminalAt!) + " " + JSON.stringify({
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution,
    controllerSha: execution.revision,
    startedAt: latestProof.startedAt,
    finishedAt: latestProof.terminalAt!,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: latestProof.baseSha,
  }) + "\n";
  const marker = iso(latestProof.startedAt + 1000) + " " + JSON.stringify({
    kind: "sentinel_matrix_plan",
    waveId: execution.id,
    run: currentPlan.run,
    runtimeSha: execution.revision,
    generation: execution.generation,
    planDigest: await matrixDigestV1(currentPlan),
    prepared: 1,
  }) + "\n";
  const job = (id: number, name: string, step: string) => ({
    id,
    name,
    run_id: execution.runId,
    run_attempt: execution.runAttempt,
    head_sha: execution.launcherSha,
    status: "completed",
    conclusion: "success",
    started_at: iso(currentStartedAt),
    completed_at: iso(latestProof.finishedAt),
    steps: [{
      name: step,
      number: 1,
      status: "completed",
      conclusion: "success",
      started_at: iso(currentStartedAt),
      completed_at: iso(latestProof.finishedAt),
    }],
  });
  const jobs = [
    job(latestProof.jobId, "repair", "Run selected Sentinel runtime"),
    job(1502, "matrix_plan", "Plan isolated issue matrix"),
  ];
  const currentHttp: HttpTransportV1 = (request) => {
    const path = new URL(request.url).pathname;
    const reply = (value: unknown) =>
      Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(value),
      });
    if (path === "/repos/Ubiquity-Sentinel/sentinel") {
      return reply({
        full_name: "Ubiquity-Sentinel/sentinel",
        default_branch: "development",
      });
    }
    if (
      path.endsWith(
        `/runs/${execution.runId}/attempts/${execution.runAttempt}`,
      )
    ) {
      return reply({
        id: execution.runId,
        run_attempt: execution.runAttempt,
        workflow_id: 357012162,
        path: ".github/workflows/supervisor.yml",
        event: "workflow_dispatch",
        head_branch: "sentinel-supervisor",
        head_sha: execution.launcherSha,
        repository: { id: 123, full_name: "Ubiquity-Sentinel/sentinel" },
        head_repository: { id: 123, full_name: "Ubiquity-Sentinel/sentinel" },
        status: "completed",
        conclusion: "success",
        run_started_at: iso(execution.createdAt),
        updated_at: iso(latestProof.finishedAt),
      });
    }
    if (
      path.includes(`/runs/${execution.runId}/`) && path.endsWith("/jobs")
    ) return reply({ total_count: jobs.length, jobs });
    if (
      path.includes(`/runs/${execution.runId}/`) &&
      path.endsWith("/artifacts")
    ) {
      return reply({
        total_count: 1,
        artifacts: [{
          id: 1501,
          name:
            `sentinel-matrix-plan-${execution.runId}-${execution.runAttempt}`,
          size_in_bytes: archive.length,
          expired: false,
          digest: "sha256:" + archiveDigest,
          workflow_run: {
            id: execution.runId,
            repository_id: 123,
            head_repository_id: 123,
            head_branch: "sentinel-supervisor",
            head_sha: execution.launcherSha,
          },
        }],
      });
    }
    if (path.endsWith("/artifacts/1501/zip")) {
      return Promise.resolve({
        status: 302,
        headers: new Headers({
          location:
            "https://productionresultssa1.blob.core.windows.net/current/1501",
        }),
        bodyText: "",
      });
    }
    if (path.endsWith(`/jobs/${latestProof.jobId}/logs`)) {
      return Promise.resolve({
        status: 302,
        headers: new Headers({
          location:
            "https://productionresultssa1.blob.core.windows.net/current/repair",
        }),
        bodyText: "",
      });
    }
    if (path.endsWith("/jobs/1502/logs")) {
      return Promise.resolve({
        status: 302,
        headers: new Headers({
          location:
            "https://productionresultssa1.blob.core.windows.net/current/planner",
        }),
        bodyText: "",
      });
    }
    if (
      new URL(request.url).hostname.endsWith("blob.core.windows.net") &&
      path.startsWith("/current/")
    ) {
      assert.equal(request.headers.get("authorization"), undefined);
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: path.endsWith("/repair")
          ? terminal
          : path.endsWith("/planner")
          ? marker
          : "",
        bodyBytes: path.endsWith("/1501") ? archive.slice() : undefined,
      });
    }
    return f.http(request);
  };
  const client = new GitHubApiClient({
    repository: SELF_REPO,
    apiBaseUrl: "https://api.github.com",
    clock: f.clock,
    http: currentHttp,
    auth: {
      authorizationHeader: () =>
        Promise.resolve(portOk("Bearer offline-native-token")),
    },
    cooldownGate: new HostedRepairCooldownGate({
      state: f.rig.state,
      clock: f.clock,
    }),
  });
  const observed = await client.readHostedExecution(execution);
  assert(
    observed.ok && observed.value && observed.value.outcome === "healthy",
    JSON.stringify(observed),
  );
  latestProof = observed.value;

  const heldRuntime = {
    ...native,
    activeRevision: execution.revision,
    execution: latestProof.execution,
    updatedAt: f.clock.now(),
  };
  const heldFiles: Record<string, string> = {
    "manifest.json": canonicalStringify({
      version: "v1",
      kind: "release_state_manifest",
      sequence: releaseBefore.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      stateHead: releaseBefore.value.head,
    }) + "\n",
  };
  heldFiles["hostedRuntimes/" + await sha256Hex(heldRuntime.id) + ".json"] =
    canonicalStringify(heldRuntime) + "\n";
  const held = await pushRawTree(
    { bare: f.rig.tmp + "/remote.git", work: f.rig.tmp + "/work" },
    releaseBefore.value.head,
    "refs/heads/sentinel-state/release",
    heldFiles,
    ENV,
  );
  assert(held.ok, held.stderr);
  releaseBefore = await f.rig.state.readRelease();
  assert(releaseBefore.ok && releaseBefore.value.status === "found");
  assert.equal(
    releaseBefore.value.snapshot.hostedRuntimes[0].execution?.id,
    latestProof.execution.id,
  );
  assert.equal(
    releaseBefore.value.snapshot.hostedRuntimes[0].lastExecutionProof
      ?.execution.id,
    f.execution.id,
  );
  recoveryHttp = currentHttp;
  f.historicalMatrix.readExecution = (saved) =>
    client.readHostedExecution(saved);
  f.historicalMatrix.transport = createActionsMatrixArtifactTransport({
    state: f.rig.state,
    clock: f.clock,
    token: "offline-native-token",
    artifactRoot: f.rig.tmp + "/history-quarantine-artifacts",
    http: currentHttp,
  });
  const runtime = {
    ...native,
    activeRevision: execution.revision,
    execution: null,
    lastExecutionProof: latestProof,
    lastHealthyProof: latestProof,
    updatedAt: f.clock.now(),
  };
  const files: Record<string, string> = {
    "manifest.json": canonicalStringify({
      version: "v1",
      kind: "release_state_manifest",
      sequence: releaseBefore.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      stateHead: releaseBefore.value.head,
    }) + "\n",
  };
  files["hostedRuntimes/" + await sha256Hex(runtime.id) + ".json"] =
    canonicalStringify(runtime) + "\n";
  const pushed = await pushRawTree(
    { bare: f.rig.tmp + "/remote.git", work: f.rig.tmp + "/work" },
    releaseBefore.value.head,
    "refs/heads/sentinel-state/release",
    files,
    ENV,
  );
  assert(pushed.ok, pushed.stderr);
  releaseBefore = await f.rig.state.readRelease();
  assert(releaseBefore.ok && releaseBefore.value.status === "found");
  assert.equal(
    releaseBefore.value.snapshot.hostedRuntimes[0].lastExecutionProof
      ?.execution.id,
    "72:2:repair",
  );
  assert.equal(
    releaseBefore.value.snapshot.hostedRuntimes[0].lastHealthyProof
      ?.execution.id,
    "72:2:repair",
  );
  await Deno.writeTextFile(
    target.work + "/sentinel.targets.json",
    '["Ubiquity-Sentinel/sentinel"]\n',
  );

  return { releaseBefore, recoveryHttp };
}
