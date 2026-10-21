import assert from "node:assert/strict";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import { runHostedSupervisorFinalize } from "../../src/host/actions-supervisor.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { T0 } from "../state/helpers.ts";
import { BASE, SELF_REPO } from "./hosted-autonomy-fixtures.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";

export async function historicalWithNewerCurrent(
  mode = "settled",
  overwritten = false,
) {
  const f = await historicalMalformedRig();
  const release = createReleaseStateStore({
    scratchDir: `${f.rig.tmp}/newer-release`,
    remoteUrl: `${f.rig.tmp}/remote.git`,
  });
  const evidence = {
    readExecution: f.client.readHostedExecution.bind(f.client),
    verifyRevision: () => Promise.resolve(portOk(true)),
    verifyRequest: () => Promise.resolve(portOk(false)),
  };
  assert.equal(
    (await runHostedSupervisorFinalize({
      state: release,
      clock: f.clock,
      run: f.nativeRun,
      evidence,
    })).status,
    "idle",
  );
  const saved = await release.readRelease();
  assert(saved.ok && saved.value.status === "found");
  f.clock.now = () => T0 + 70_000;
  let current = {
    ...f.execution,
    id: "73:1:repair",
    runId: 73,
    runAttempt: 1,
    launcherSha: "4".repeat(40) as GitSha,
    createdAt: T0 + 61_000,
  };
  const seeded = await release.writeRelease({
    ...saved.value.snapshot,
    stateHead: saved.value.head,
    sequence: saved.value.snapshot.sequence + 1,
    updatedAt: f.clock.now(),
    hostedRuntimes: [{
      ...saved.value.snapshot.hostedRuntimes[0],
      execution: current,
      updatedAt: f.clock.now(),
    }],
  }, saved.value.head);
  assert(seeded.ok && seeded.value.status === "applied");
  if (overwritten) {
    const latest = await release.readRelease();
    assert(latest.ok && latest.value.status === "found");
    const old = saved.value.snapshot.hostedRuntimes[0].lastExecutionProof!;
    assert(old.outcome !== "not_started");
    const settled = await release.writeRelease({
      ...latest.value.snapshot,
      stateHead: latest.value.head,
      sequence: latest.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      hostedRuntimes: [{
        ...latest.value.snapshot.hostedRuntimes[0],
        execution: null,
        lastExecutionProof: {
          ...old,
          execution: current,
          startedAt: T0 + 62_000,
          finishedAt: T0 + 65_000,
          observedAt: f.clock.now(),
          terminalAt: old.terminalAt === null ? null : T0 + 65_000,
          logDigest: "9".repeat(64),
        },
      }],
    }, latest.value.head);
    assert(
      settled.ok && settled.value.status === "applied",
      JSON.stringify(settled),
    );
    const idle = await release.readRelease();
    assert(idle.ok && idle.value.status === "found");
    current = {
      ...current,
      id: "75:1:repair",
      runId: 75,
      createdAt: T0 + 66_000,
    };
    const started = await release.writeRelease({
      ...idle.value.snapshot,
      stateHead: idle.value.head,
      sequence: idle.value.snapshot.sequence + 1,
      updatedAt: f.clock.now(),
      hostedRuntimes: [{
        ...idle.value.snapshot.hostedRuntimes[0],
        execution: current,
      }],
    }, idle.value.head);
    assert(started.ok && started.value.status === "applied");
  }
  const iso = (at: number) => new Date(at).toISOString();
  const jobs = ["maintenance", "prepare", "matrix_plan"].map((name, i) => ({
    id: 2401 + i,
    name,
    run_id: mode === "wrong-job" && i === 2 ? 99 : current.runId,
    run_attempt: 1,
    head_sha: current.launcherSha,
    status: mode === "pending" && i === 2 ? "in_progress" : "completed",
    conclusion: mode === "pending" && i === 2
      ? null
      : i === 2
      ? "cancelled"
      : "success",
    started_at: iso(T0 + (overwritten ? 67_000 : 62_000)),
    completed_at: mode === "pending" && i === 2
      ? null
      : iso(T0 + (overwritten ? 68_000 : 65_000)),
    steps: [],
  }));
  const currentHttp: HttpTransportV1 = (request) => {
    const url = new URL(request.url);
    if (url.pathname.includes(`/runs/${current.runId}/`)) {
      assert.equal(
        request.headers.get("authorization"),
        "Bearer offline-native-token",
      );
      if (mode === "unavailable") {
        return Promise.resolve({
          status: 503,
          headers: new Headers(),
          bodyText: "",
        });
      }
      const value = url.pathname.endsWith("/jobs")
        ? {
          total_count: mode === "truncated" ? jobs.length + 1 : jobs.length,
          jobs: mode === "duplicate" ? [jobs[0], jobs[1], jobs[0]] : jobs,
        }
        : {
          id: current.runId,
          run_attempt: 1,
          workflow_id: 357012162,
          path: ".github/workflows/supervisor.yml",
          event: "workflow_dispatch",
          head_branch: "sentinel-supervisor",
          head_sha: mode === "foreign" ? BASE : current.launcherSha,
          repository: { id: 123, full_name: "Ubiquity-Sentinel/sentinel" },
          head_repository: { id: 123, full_name: "Ubiquity-Sentinel/sentinel" },
          status: mode === "pending" ? "in_progress" : "completed",
          conclusion: mode === "pending" ? null : "cancelled",
          run_started_at: iso(current.createdAt),
          updated_at: iso(T0 + (overwritten ? 68_000 : 65_000)),
        };
      return Promise.resolve({
        status: 200,
        headers: new Headers(),
        bodyText: JSON.stringify(value),
      });
    }
    return f.http(request);
  };
  const reader = new GitHubApiClient({
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
  const observed: number[] = [];
  f.historicalMatrix.readExecution = async (execution) => {
    observed.push(execution.runId);
    const result = await reader.readHostedExecution(execution);
    if (
      execution.runId === current.runId && mode === "wrong-binding" &&
      result.ok &&
      result.value !== null
    ) {
      return portOk({ ...result.value, execution: f.execution });
    }
    if (execution.runId === current.runId && mode === "custody") {
      f.rig.state.readRelease = () =>
        Promise.resolve(
          portError("unavailable", "injected current custody drift"),
        );
    }
    if (execution.runId === current.runId && mode === "old-proof-missing") {
      f.rig.state.readRelease = async () => {
        const read = await release.readRelease();
        if (!read.ok || read.value.status !== "found") return read;
        return portOk({
          ...read.value,
          snapshot: {
            ...read.value.snapshot,
            hostedRuntimes: read.value.snapshot.hostedRuntimes.map((row) => ({
              ...row,
              lastExecutionProof: null,
            })),
          },
        });
      };
    }
    return result;
  };
  f.historicalMatrix.transport = createActionsMatrixArtifactTransport({
    state: f.rig.state,
    clock: f.clock,
    token: "offline-native-token",
    artifactRoot: `${f.rig.tmp}/artifacts`,
    http: currentHttp,
  });
  return {
    ...f,
    release,
    reader,
    current,
    currentHttp,
    observed,
    evidence,
    witness: saved.value,
  };
}
