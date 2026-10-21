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
import { HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE } from "../../src/host/matrix-actions.ts";
import { runHostedSupervisorFinalize } from "../../src/host/actions-supervisor.ts";
import { FakeGithub, FakeModel } from "../repair/helpers.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { parseHostedExecutionSettlementV1 } from "../../src/contracts/hosted-supervisor.ts";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { StateReadView } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { gitRun, pushRawTree, sha256Hex } from "../state/helpers.ts";
import { ENV, SELF_REPO } from "./hosted-autonomy-fixtures.ts";
import {
  historicalMalformedRig,
  historicalMatrixQuarantineFixture as createHostedHistoricalMatrixQuarantine,
} from "./hosted-autonomy-historical-fixtures.ts";

export async function historicalC63Scenario(
  firstPass: boolean,
  currentFactory = false,
  partial = false,
) {
  const f = await historicalMalformedRig(
    true,
    24,
    true,
    true,
    true,
    !firstPass,
  );
  if (firstPass) {
    f.plan.plannedAt = f.charges[2].createdAt;
    await f.refreshPlan();
  }
  // C63-only read-through of the real repair store: every cached read still
  // proves the current local remote head, and every real write invalidates it.
  const realReadRepair = f.rig.state.readRepair;
  const realWriteRepair = f.rig.state.writeRepair;
  let cachedRepair: {
    head: GitSha;
    value: Awaited<ReturnType<StateReadView["readRepair"]>>;
  } | null = null;
  const repairReadThrough: StateReadView["readRepair"] = async () => {
    const remoteUrl = f.rig.tmp + "/remote.git";
    const probe = await gitRun(
      remoteUrl,
      ["ls-remote", remoteUrl, "refs/heads/sentinel-state/repair"],
      ENV,
    );
    const nativeHead = probe.ok
      ? (probe.stdout.trim().split(/\s+/)[0] ?? "")
      : "";
    const proven = /^[0-9a-f]{40}$/.test(nativeHead)
      ? nativeHead as GitSha
      : null;
    if (
      proven !== null && cachedRepair !== null && cachedRepair.head === proven
    ) {
      return structuredClone(cachedRepair.value);
    }
    cachedRepair = null;
    const read = await realReadRepair();
    if (
      proven !== null && read.ok && read.value.status === "found" &&
      read.value.head === proven
    ) {
      cachedRepair = { head: proven, value: structuredClone(read) };
    }
    return read;
  };
  f.rig.state.readRepair = repairReadThrough;
  f.rig.state.writeRepair = (next, expectedHead) => {
    cachedRepair = null;
    return realWriteRepair(next, expectedHead);
  };
  const previousCwd = Deno.cwd();
  Deno.chdir(f.checkout);
  try {
    const native = await f.historicalMatrix.readExecution(f.execution);
    assert(native.ok && native.value && native.value.outcome !== "not_started");
    const oldProof = native.value;
    if (!firstPass) {
      const priorRepair = await f.rig.state.readRepair();
      const priorRelease = await f.rig.state.readRelease();
      assert.deepEqual(
        await f.historicalMatrix.transport.rejectHistorical!({
          proof: oldProof,
        }),
        [],
      );
      assert.deepEqual(await f.rig.state.readRepair(), priorRepair);
      assert.deepEqual(await f.rig.state.readRelease(), priorRelease);
    }
    const release = createReleaseStateStore({
      scratchDir: f.rig.tmp + "/c63-proof",
      remoteUrl: f.rig.tmp + "/remote.git",
    });
    assert.equal(
      (await runHostedSupervisorFinalize({
        state: release,
        clock: f.clock,
        run: f.nativeRun,
        evidence: {
          readExecution: f.historicalMatrix.readExecution,
          verifyRevision: () => Promise.resolve(portOk(true)),
          verifyRequest: () => Promise.resolve(portOk(false)),
        },
      })).status,
      "idle",
    );
    const retained = await release.readRelease();
    assert(retained.ok && retained.value.status === "found");
    const witnessed = retained.value.snapshot.hostedRuntimes[0]
      .lastExecutionProof!;
    assert(witnessed.outcome !== "not_started");
    let queueReadFailureAt = Infinity;
    let queueReads = 0;
    const nativeMaintenance = createHostedHistoricalMatrixQuarantine({
      state: f.rig.state,
      clock: f.clock,
      token: "offline-native-token",
      apiToken: "offline-target-token",
      artifactRoot: f.rig.tmp + "/c63-witness-artifacts",
      http: (request) => {
        if (
          new URL(request.url).pathname ===
            "/repos/ubiquity/ai.ubq.fi/rules/branches/development"
        ) {
          assert.equal(request.method, "GET");
          assert.equal(
            request.headers.get("authorization"),
            "Bearer offline-target-token",
          );
          return Promise.resolve({
            status: ++queueReads >= queueReadFailureAt ? 503 : 200,
            headers: new Headers(),
            bodyText: "[]",
          });
        }
        return f.http(request);
      },
      artifactHttp: f.http,
      historicalReleaseWitnesses: [{
        commit: retained.value.head,
        executionId: f.execution.id,
        logDigest: witnessed.logDigest,
        reservationIds: f.records.slice(0, 19).map((record) =>
          record.intent!.requestId!
        ),
      }],
    });
    f.historicalMatrix.historicalReleaseWitnesses =
      nativeMaintenance.historicalReleaseWitnesses;
    f.historicalMatrix.nativeQueueFor = nativeMaintenance.nativeQueueFor;
    // Sanitized native proof captured at3361797: a newer healthy confirmation
    // replaced the old singular slot. It is preserved, never rebound to C63.
    let genericTransportReads = 0;
    let latestProof = parseHostedExecutionSettlementV1({
      execution: {
        id: "37413367329:1:repair",
        runId: 37413367329,
        runAttempt: 1,
        launcherSha: "ee8a26bd2d67c8c743af2eef824d0c69b2c7e679",
        revision: f.execution.revision,
        generation: 63,
        purpose: "ordinary",
        releaseId: null,
        createdAt: 1791260688618,
      },
      repository: "ubiquity-sentinel/sentinel",
      workflowId: 357012162,
      workflowPath: ".github/workflows/supervisor.yml",
      ref: "refs/heads/sentinel-supervisor",
      jobId: 112122338866,
      startedAt: 1791264355000,
      finishedAt: 1791267156000,
      terminalAt: 1791267153273,
      startupReady: true,
      settled: true,
      outcome: "healthy",
      baseSha: "25a9e4d9fb9684e1282527a095a60700960c25ef",
      logDigest:
        "f185207f5aa46f8afa5e3c0527230c2398da92d1d4a26bff89d1f800b883ded3",
      observedAt: 1791267169689,
    });
    f.clock.now = () => 1791267171090;
    if (currentFactory) {
      assert(latestProof.outcome === "healthy");
      const currentStartedAt = latestProof.startedAt;
      const execution = latestProof.execution;
      const cell = structuredClone(f.cells[0]);
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
        if (path === "/repos/ubiquity/ai.ubq.fi") {
          return reply({
            full_name: "ubiquity/ai.ubq.fi",
            default_branch: "main",
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
            repository: { id: 123, full_name: "ubiquity-sentinel/sentinel" },
            head_repository: {
              id: 123,
              full_name: "ubiquity-sentinel/sentinel",
            },
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
      f.historicalMatrix.readExecution = (saved) =>
        client.readHostedExecution(saved);
      const currentTransportInput = {
        state: f.rig.state,
        clock: f.clock,
        token: "offline-native-token",
        artifactRoot: f.rig.tmp + "/mixed-history",
        http: currentHttp,
      };
      f.historicalMatrix.transport = createActionsMatrixArtifactTransport(
        currentTransportInput,
      );
      const sourceDir = f.rig.tmp + "/current-source";
      await Deno.mkdir(sourceDir);
      await Deno.writeTextFile(
        sourceDir + "/sentinel.targets.json",
        '["ubiquity/ai.ubq.fi"]\n',
      );
      f.runMain = async () => {
        const previous = Deno.cwd();
        Deno.chdir(f.checkout);
        try {
          await f.withHistoricalGraph(async (graph, deps) => {
            const { runHostedAutonomy } = await graph.runner();
            const { createHostedClosedMatrixRecovery } = await graph
              .matrixAdapters();
            const { createActionsMatrixArtifactTransport } = await graph
              .matrixArtifacts();
            assert(deps.historicalMatrix);
            await runHostedAutonomy({
              ...deps,
              historicalMatrix: {
                ...deps.historicalMatrix,
                transport: createActionsMatrixArtifactTransport(
                  currentTransportInput,
                ),
              },
              closedMatrix: async (state = f.rig.state) => {
                const actual = await createHostedClosedMatrixRecovery({
                  state,
                  clock: f.clock,
                  token: "offline-native-token",
                  apiToken: "offline-native-token",
                  sourceDir,
                  scratch: f.rig.tmp + "/current-scratch",
                  artifactRoot: f.rig.tmp + "/mixed-current",
                  appInstallationId: "155687488",
                  http: currentHttp,
                  artifactHttp: currentHttp,
                });
                return {
                  ...actual,
                  transportFor: () => {
                    genericTransportReads++;
                    throw new Error(
                      "offline unrelated ordinary proof has no matrix",
                    );
                  },
                };
              },
            });
          });
          return 0;
        } catch {
          return 1;
        } finally {
          Deno.chdir(previous);
        }
      };
    }
    const currentRuntime = {
      ...retained.value.snapshot.hostedRuntimes[0],
      execution: null,
      lastExecutionProof: latestProof,
      lastHealthyProof: latestProof,
      updatedAt: f.clock.now(),
    };
    const files: Record<string, string> = {
      "manifest.json": canonicalStringify({
        version: "v1",
        kind: "release_state_manifest",
        sequence: retained.value.snapshot.sequence + 1,
        updatedAt: f.clock.now(),
        stateHead: retained.value.head,
      }) + "\n",
    };
    files["hostedRuntimes/" + await sha256Hex(currentRuntime.id) + ".json"] =
      canonicalStringify(currentRuntime) + "\n";
    const restored = await pushRawTree(
      { bare: f.rig.tmp + "/remote.git", work: f.rig.tmp + "/work" },
      retained.value.head,
      "refs/heads/sentinel-state/release",
      files,
      ENV,
    );
    assert(restored.ok, restored.stderr);
    // A partially reconciled C63 state: the first row was already removed
    // while the other rows still need recovery. The pass must skip the
    // removed row and never fail on it.
    let reconciledSeed: WorkRecordV1 | null = null;
    if (partial) {
      const seed = await f.rig.state.readRepair();
      assert(seed.ok && seed.value.status === "found");
      reconciledSeed = {
        ...seed.value.snapshot.work.find((row) => row.id === f.records[0].id)!,
        nextStep: "blocked" as const,
        blocker: {
          kind: "other" as const,
          message: "historical matrix row already reconciled elsewhere",
          since: f.clock.now(),
        },
        wait: null,
        updatedAt: f.clock.now(),
      };
      const write = await f.rig.state.writeRepair({
        ...seed.value.snapshot,
        stateHead: seed.value.head,
        sequence: seed.value.snapshot.sequence + 1,
        updatedAt: f.clock.now(),
        work: seed.value.snapshot.work.map((row) =>
          row.id === reconciledSeed!.id ? reconciledSeed! : row
        ),
      }, seed.value.head);
      assert(
        write.ok && write.value.status === "applied",
        JSON.stringify(write),
      );
    }
    const before = await f.rig.state.readRepair();
    const releaseBefore = await f.rig.state.readRelease();
    assert(before.ok && before.value.status === "found");
    assert(releaseBefore.ok && releaseBefore.value.status === "found");
    assert.deepEqual(
      releaseBefore.value.snapshot.hostedRuntimes[0].lastHealthyProof,
      latestProof,
    );
    const requestedRecords = f.records.slice(partial ? 1 : 0, 3);
    if (!firstPass && !currentFactory && !partial) {
      for (
        const phase of ["missing", "unavailable", "observation_lost"] as const
      ) {
        queueReads = 0;
        queueReadFailureAt = phase === "observation_lost" ? 4 : 1;
        f.historicalMatrix.nativeQueueFor = phase === "missing"
          ? undefined
          : nativeMaintenance.nativeQueueFor;
        const held = await f.withHistoricalGraph(async (graph, deps) => {
          const { recoverHostedHistoricalC63 } = await graph
            .historicalRecovery();
          assert(deps.historicalMatrix);
          return await recoverHostedHistoricalC63(deps.historicalMatrix);
        });
        assert.deepEqual(held, { ingested: 0, deferred: true }, phase);
        assert.deepEqual(
          await f.rig.state.readRepair(),
          before,
          phase + ": original charges and intents retained",
        );
        assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      }
      f.historicalMatrix.nativeQueueFor = nativeMaintenance.nativeQueueFor;
      queueReadFailureAt = Infinity;
    }
    const selectedIds = new Set(requestedRecords.map((record) => record.id));
    const requests = requestedRecords.map((record) => ({
      taskId: record.id,
      repository: record.repository,
      reservationId: record.intent!.requestId!,
      intentKey: record.intent!.key,
      expectedBase: record.target.base,
      attempt: record.counters.attempts,
    }));
    if (!firstPass) {
      f.setFault("pending");
      assert.equal(await f.runMain(), 1);
      assert.deepEqual(await f.rig.state.readRepair(), before);
      f.setFault("auth");
      assert.equal(await f.runMain(), 1);
      assert.deepEqual(await f.rig.state.readRepair(), before);
      f.setFault(null);
    }
    const waves = await f.historicalMatrix.transport.recover({
      requests,
      runtimeSha: f.execution.revision,
      launcherSha: f.execution.launcherSha,
      currentRun: f.nativeRun,
    });
    assert.equal(waves.length, 1);
    const wave = waves[0];
    assert.deepEqual(
      wave.results.map((result) => result.taskId).sort(),
      Array.from(selectedIds).sort(),
    );
    assert(
      wave.results.every((result) =>
        result.status === "not_started" && result.receipt === null &&
        result.bundle === null
      ),
    );
    const model = new FakeModel();
    const github = new FakeGithub({
      baseSha: f.records[0].target.base,
      openIssues: [],
    });
    let firstCharge: typeof f.charges[number] | null = null;
    if (!firstPass) {
      // Drift after the first real budget settlement refuses the next work
      // write. That permitted partial charge must survive exact replay.
      const originalWrite = f.rig.state.writeRepair;
      const originalReleaseRead = f.rig.state.readRelease;
      let writesBeforeDrift = 0;
      f.rig.state.writeRepair = async (next, expectedHead) => {
        const written = await originalWrite(next, expectedHead);
        if (written.ok && written.value.status === "applied") {
          writesBeforeDrift++;
          f.rig.state.readRelease = () =>
            Promise.resolve(
              portError("conflict", "offline current custody drift"),
            );
        }
        return written;
      };
      try {
        assert.equal(await f.runMain(), 1);
      } finally {
        f.rig.state.writeRepair = originalWrite;
        f.rig.state.readRelease = originalReleaseRead;
      }
      assert.equal(writesBeforeDrift, 1);
      const drifted = await f.rig.state.readRepair();
      assert(drifted.ok && drifted.value.status === "found");
      assert.deepEqual(drifted.value.snapshot.work, before.value.snapshot.work);
      const driftCharge = drifted.value.snapshot.reservations.find((row) =>
        row.id === f.cells[0].reservationId
      )!;
      assert.equal(driftCharge.outcome, "ambiguous");
      assert.deepEqual(
        drifted.value.snapshot.reservations.filter((row) =>
          row.id !== driftCharge.id
        ),
        before.value.snapshot.reservations.filter((row) =>
          row.id !== driftCharge.id
        ),
      );
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      // Restart maintenance directly from unchanged WORK plus its already
      // settled charge; the prepass must preserve the entire charge on replay.
      firstCharge = structuredClone(driftCharge);
    }
    assert.equal(
      await f.runMain(),
      0,
      "modern evidenced C63 cells must settle before the strict legacy rejection pass",
    );
    if (currentFactory) {
      assert.equal(
        genericTransportReads,
        0,
        "dedicated C63 requests must not reach unrelated ordinary history",
      );
    }
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    if (reconciledSeed !== null) {
      assert.deepEqual(
        after.value.snapshot.work.find((row) => row.id === reconciledSeed!.id),
        reconciledSeed,
        "the already reconciled row is never touched again",
      );
      assert.equal(
        after.value.snapshot.reservations.find((row) =>
          row.id === f.records[0].intent!.requestId
        )!.outcome,
        "reserved",
        "an already reconciled row keeps its original charge untouched",
      );
    }
    for (const record of f.records.slice(partial ? 1 : 0, 3)) {
      const changed: WorkRecordV1 = after.value.snapshot.work.find((row) =>
        row.id === record.id
      )!;
      const charge: typeof f.charges[number] = after.value.snapshot.reservations
        .find((row) => row.id === record.intent!.requestId)!;
      assert.equal(changed.nextStep, "blocked");
      assert.deepEqual({
        ...changed,
        nextStep: record.nextStep,
        blocker: record.blocker,
        wait: record.wait,
        updatedAt: record.updatedAt,
      }, record);
      assert.equal(charge.outcome, "ambiguous");
      assert.deepEqual(
        { ...charge, outcome: "reserved", settledAt: null },
        before.value.snapshot.reservations.find((row) => row.id === charge.id),
      );
    }
    if (firstCharge !== null) {
      const preserved = firstCharge;
      assert.deepEqual(
        after.value.snapshot.reservations.find((row) =>
          row.id === preserved.id
        ),
        preserved,
      );
    }
    const dispositionIds = new Set(
      f.records.slice(0, firstPass ? 19 : 3).map((record) => record.id),
    );
    if (firstPass) {
      for (const record of f.records.slice(3, 19)) {
        const quarantined: WorkRecordV1 = after.value.snapshot.work.find((
          row,
        ) => row.id === record.id)!;
        assert.equal(quarantined.nextStep, "blocked");
        assert.equal(
          quarantined.blocker?.message,
          HISTORICAL_MATRIX_QUARANTINE_UNPROVABLE,
        );
        assert.deepEqual({
          ...quarantined,
          nextStep: record.nextStep,
          blocker: record.blocker,
          wait: record.wait,
          updatedAt: record.updatedAt,
        }, record);
        // Each missing-cell admission reaches a final ambiguous settlement;
        // the charge itself is retained with every other field unchanged.
        const settledCharge: typeof f.charges[number] = after.value.snapshot
          .reservations.find((row) => row.id === record.intent!.requestId)!;
        const originalCharge: typeof f.charges[number] = before.value.snapshot
          .reservations.find((row) => row.id === record.intent!.requestId)!;
        assert.equal(settledCharge.outcome, "ambiguous");
        assert.equal(settledCharge.proofRef, null);
        assert(
          settledCharge.settledAt !== null &&
            Number.isSafeInteger(settledCharge.settledAt) &&
            settledCharge.settledAt >= originalCharge.createdAt,
        );
        assert.deepEqual({
          ...settledCharge,
          outcome: originalCharge.outcome,
          settledAt: originalCharge.settledAt,
        }, originalCharge);
      }
    }
    assert.deepEqual(
      after.value.snapshot.work.filter((row) => !dispositionIds.has(row.id)),
      before.value.snapshot.work.filter((row) => !dispositionIds.has(row.id)),
    );
    // Every dispositioned admission settles; everything outside the
    // disposition set is preserved byte for byte.
    const dispositionReservations = new Set(
      f.records.slice(0, firstPass ? 19 : 3).map((record) =>
        record.intent!.requestId!
      ),
    );
    assert.deepEqual(
      after.value.snapshot.reservations.filter((row) =>
        !dispositionReservations.has(row.id)
      ),
      before.value.snapshot.reservations.filter((row) =>
        !dispositionReservations.has(row.id)
      ),
    );
    assert.equal(f.records.slice(3, 19).length, 16);
    assert.equal(f.records.slice(19, 24).length, 5);
    assert.equal(f.records.slice(24).length, 1);
    assert.deepEqual(
      after.value.snapshot.reviews,
      before.value.snapshot.reviews,
    );
    assert.deepEqual(
      after.value.snapshot.releaseRequests,
      before.value.snapshot.releaseRequests,
    );
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    const artifactReads = f.calls.filter((call) =>
      call.url.includes("/artifacts/")
    ).length;
    assert.equal(await f.runMain(), 0);
    assert.deepEqual(await f.rig.state.readRepair(), after);
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    assert.equal(
      f.calls.filter((call) => call.url.includes("/artifacts/")).length,
      artifactReads,
    );
    assert.deepEqual(model.requests, []);
    assert.equal(github.pushes.length, 0);
  } finally {
    Deno.chdir(previousCwd);
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
}
