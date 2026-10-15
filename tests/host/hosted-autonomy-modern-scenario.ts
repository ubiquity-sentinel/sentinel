import assert from "node:assert/strict";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  type MatrixCellResultV1,
  matrixDigestV1,
} from "../../src/contracts/matrix.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { HostedRepairCooldownGate } from "../../src/host/hosted-cooldown.ts";
import {
  createGitBundleExporter,
  createGitBundleImporter,
} from "../../src/host/matrix-git.ts";
import { runHostedSupervisorFinalize } from "../../src/host/actions-supervisor.ts";
import {
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
} from "../repair/helpers.ts";
import { repositoryConfig } from "../budget/helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import {
  createHostedClosedMatrixRecovery,
  isDeferredCurrentMatrixHistoryBudget,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy.ts";
import { gitRun, makeRemoteCtx, T0 } from "../state/helpers.ts";
import { BASE, ENV, SELF_REPO } from "./hosted-autonomy-fixtures.ts";
import { historicalMalformedRig } from "./hosted-autonomy-historical-fixtures.ts";
import { prepareModernHistory } from "./hosted-autonomy-modern-history-fixtures.ts";
import { captureHostedAutonomyMain } from "./hosted-autonomy-rig.ts";

export async function modernRecoveryScenario(
  history = false,
  throughMain = false,
) {
  const targetRoot = await Deno.makeTempDir({
    prefix: "sentinel-modern-target-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  const target = await makeRemoteCtx(targetRoot, ENV);
  const checked = async (dir: string, args: string[]) => {
    const result = await gitRun(dir, args, ENV);
    assert(result.ok, result.stderr);
    return result.stdout.trim();
  };
  await Deno.writeTextFile(target.work + "/repair.txt", "original\n");
  await checked(target.work, ["add", "repair.txt"]);
  await checked(target.work, ["commit", "-q", "-m", "base"]);
  const base = await checked(target.work, ["rev-parse", "HEAD"]) as GitSha;
  if (history) {
    await checked(target.work, ["update-ref", "refs/heads/development", base]);
    await checked(target.work, ["checkout", "-q", "-b", "offline-candidate"]);
  }
  const scratch = targetRoot + "/factory";
  const mirror = history
    ? scratch + "/sources/ubiquity-sentinel"
    : targetRoot + "/target-mirror";
  if (history) await Deno.mkdir(scratch + "/sources", { recursive: true });
  await checked(targetRoot, ["clone", "-q", target.work, mirror]);
  if (history) {
    await checked(mirror, [
      "config",
      `url.file://${target.work}.insteadOf`,
      "https://github.com/ubiquity/sentinel.git",
    ]);
    await checked(mirror, ["config", "protocol.https.allow", "never"]);
  }
  await Deno.writeTextFile(target.work + "/repair.txt", "candidate\n");
  await checked(target.work, ["add", "repair.txt"]);
  await checked(target.work, ["commit", "-q", "-m", "candidate"]);
  const candidate = await checked(target.work, ["rev-parse", "HEAD"]) as GitSha;
  const f = await historicalMalformedRig(
    true,
    2,
    true,
    true,
    false,
    true,
    base,
  );
  try {
    f.plan.plannedAt = T0 + 1000;
    await f.refreshPlan();
    const bundleFile = f.cells[1].cellId + ".bundle";
    const bundles = targetRoot + "/bundles";
    const exported = await createGitBundleExporter({
      repositoryDir: target.work,
      outputDir: bundles,
    }).create({ base, head: candidate, checkpointSha: null, file: bundleFile });
    assert(exported);
    const results: MatrixCellResultV1[] = f.cells.map((cell, i) => ({
      version: "v1",
      kind: "matrix_cell_result",
      waveId: f.execution.id,
      run: f.nativeRun,
      runtimeSha: f.execution.revision,
      generation: f.execution.generation,
      cellId: cell.cellId,
      taskId: cell.taskId,
      repository: cell.repository,
      reservationId: cell.reservationId,
      intentKey: cell.intentKey,
      requestDigest: cell.requestDigest,
      status: "completed",
      receipt: {
        invocationId: "sanitized-" + cell.cellId,
        outcome: i === 0 ? "failed" : "completed",
        actual: {
          evidenceKind: "request-runtime",
          provider: "uos",
          threadId: "sanitized-thread-" + cell.cellId,
          turnId: "sanitized-turn-" + cell.cellId,
          terminalOrigin: "runtime",
          observedTerminalStatus: i === 0 ? "failed" : "completed",
          observedModel: cell.request.model,
          observedReasoning: "max",
          durationMs: 1000,
          outputChars: 1000,
        },
        candidate: i === 0 ? null : {
          head: candidate,
          checkpointSha: null,
          changedPaths: ["repair.txt"],
        },
        error: i === 0 ? "runtime_error" : null,
      },
      bundle: i === 0 ? null : {
        file: bundleFile,
        digest: exported.digest,
        head: candidate,
        checkpointSha: null,
      },
      detail: null,
      completedAt: T0 + 29_000,
    }));
    for (const [i, result] of results.entries()) {
      const writer = new ZipWriter(new Uint8ArrayWriter(), {
        useWebWorkers: false,
      });
      await writer.add(
        "result.json",
        new Uint8ArrayReader(
          new TextEncoder().encode(canonicalStringify(result)),
        ),
        { unixMode: 0o100600 },
      );
      if (result.bundle) {
        await writer.add(
          result.bundle.file,
          new Uint8ArrayReader(
            await Deno.readFile(bundles + "/" + result.bundle.file),
          ),
          { unixMode: 0o100600 },
        );
      }
      const bytes = await writer.close();
      const digest = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", bytes.slice()),
        ),
      ).map((b) => b.toString(16).padStart(2, "0")).join("");
      f.archives.set(502 + i, bytes);
      const artifact = f.artifacts.find((row) => row.id === 502 + i)!;
      artifact.size_in_bytes = bytes.length;
      artifact.digest = "sha256:" + digest;
      f.logs.set(
        402 + i,
        new Date(T0 + 29_000).toISOString() + " " + JSON.stringify({
          kind: "sentinel_matrix_cell",
          run: f.nativeRun,
          runtimeSha: f.execution.revision,
          generation: f.execution.generation,
          cellId: result.cellId,
          reservationId: result.reservationId,
          resultDigest: await matrixDigestV1(result),
          bundleDigest: result.bundle?.digest ?? null,
          status: "completed",
        }) + "\n",
      );
    }
    const release = createReleaseStateStore({
      scratchDir: f.rig.tmp + "/modern-finalize",
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
    const config = repositoryConfig(undefined, undefined, {
      repository: SELF_REPO,
      protectedPaths: [],
      adapter: { kind: "github" },
      liveStartLimits: { perHour: null, perSevenDays: null },
    });
    const model = new FakeModel();
    const github = new FakeGithub({ baseSha: base, openIssues: [] });
    const cycle = {
      state: f.rig.state,
      clock: f.clock,
      configs: [config],
      controllerSha: f.execution.revision,
      githubCooldown: new HostedRepairCooldownGate({
        state: f.rig.state,
        clock: f.clock,
      }),
      github,
      incidents: new FakeIncidents(),
      replay: new FakeReplay(),
      model,
      budget: new RollingStartBudget({
        state: f.rig.state,
        clock: f.clock,
        configs: [config],
      }),
      externalImplementations: true,
    };
    const before = await f.rig.state.readRepair();
    let releaseBefore = await f.rig.state.readRelease();
    assert(before.ok && before.value.status === "found");
    assert(releaseBefore.ok && releaseBefore.value.status === "found");
    const native = releaseBefore.value.snapshot.hostedRuntimes[0];
    assert.equal(native.execution, null);
    assert.equal(native.lastExecutionProof?.execution.id, f.execution.id);
    let recoveryHttp = f.http;
    if (history) {
      const prepared = await prepareModernHistory({
        f,
        native,
        base,
        releaseBefore,
        target,
      });
      releaseBefore = prepared.releaseBefore;
      recoveryHttp = prepared.recoveryHttp;
    }
    let expireCustody = false;
    const custodyEntered = Promise.withResolvers<void>();
    const continueCustody = Promise.withResolvers<void>();
    let nativeWriterProbe = false;
    let nativeWriterAttempted = false;
    let mainExit: number | null = null;
    const run = async (main = false): Promise<HostedAutonomyResultV1> => {
      const previous = Deno.cwd();
      Deno.chdir(f.checkout);
      try {
        const deps: HostedAutonomyDepsV1 = {
          state: f.rig.state,
          clock: f.clock,
          githubFor: f.rig.githubFor,
          historicalMatrix: f.historicalMatrix,
          closedMatrix: async (state = f.rig.state) => {
            if (history) {
              const actual = await createHostedClosedMatrixRecovery({
                state,
                clock: f.clock,
                token: "offline-native-token",
                apiToken: "offline-native-token",
                sourceDir: target.work,
                scratch,
                artifactRoot: f.rig.tmp + "/history-artifacts",
                http: recoveryHttp,
                artifactHttp: recoveryHttp,
              });
              const readExecution = actual.readExecution;
              return {
                ...actual,
                prepareTarget: async (config) => {
                  await actual.prepareTarget(config);
                  if (expireCustody) {
                    f.rig.state.readRelease = async () => {
                      const value = await originalReleaseRead();
                      custodyEntered.resolve();
                      await continueCustody.promise;
                      f.clock.now = () => T0 + 120_001;
                      return value;
                    };
                  }
                },
                readExecution: async (execution) => {
                  const result = await readExecution(execution);
                  if (nativeWriterProbe && execution.id === f.execution.id) {
                    nativeWriterAttempted = true;
                    f.rig.state.readRelease = () =>
                      Promise.resolve(
                        portError("conflict", "offline native custody drift"),
                      );
                    await actual.cycleFor(actual.configs[0]).budget
                      .settleModelStart({
                        id: f.cells[0].reservationId,
                        outcome: "ambiguous",
                        proofRef: null,
                      });
                  }
                  return result;
                },
              };
            }
            const gate = new HostedRepairCooldownGate({
              state,
              clock: f.clock,
            });
            const budget = new RollingStartBudget({
              state,
              clock: f.clock,
              configs: [config],
            });
            const client = new GitHubApiClient({
              repository: SELF_REPO,
              apiBaseUrl: "https://api.github.com",
              clock: f.clock,
              http: f.http,
              auth: {
                authorizationHeader: () =>
                  Promise.resolve(portOk("Bearer offline-native-token")),
              },
              cooldownGate: gate,
            });
            return Promise.resolve({
              state,
              clock: f.clock,
              configs: [config],
              cycleFor: () => ({
                ...cycle,
                state,
                budget,
                githubCooldown: gate,
              }),
              prepareTarget: () => Promise.resolve(),
              importerFor: (_, bundlesDir) =>
                createGitBundleImporter({ repositoryDir: mirror, bundlesDir }),
              transportFor: (readState) =>
                createActionsMatrixArtifactTransport({
                  state: readState,
                  clock: f.clock,
                  token: "offline-native-token",
                  artifactRoot: f.rig.tmp + "/modern-artifacts",
                  http: f.http,
                }),
              readExecution: async (execution) => {
                const result = await client.readHostedExecution(execution);
                if (nativeWriterProbe) {
                  nativeWriterAttempted = true;
                  f.rig.state.readRelease = () =>
                    Promise.resolve(
                      portError("conflict", "offline native custody drift"),
                    );
                  await budget.settleModelStart({
                    id: f.cells[0].reservationId,
                    outcome: "ambiguous",
                    proofRef: null,
                  });
                }
                return result;
              },
            });
          },
        };
        if (!main) return await runHostedAutonomy(deps);
        const head = await checked(f.checkout, ["rev-parse", "HEAD"]);
        const captured = await captureHostedAutonomyMain(deps, head);
        mainExit = captured.exit;
        return captured.result;
      } finally {
        Deno.chdir(previous);
      }
    };
    const originalReleaseRead = f.rig.state.readRelease;
    if (history) {
      const originalHistoryRead = f.rig.state.readReleaseAt!;
      for (
        const fault of [
          "missing",
          "wrong-head",
          "wrong-sequence",
          "cycle",
          "deadline",
        ] as const
      ) {
        f.rig.state.readReleaseAt = async (input) => {
          if (fault === "missing") {
            return portError("unavailable", "offline missing release history");
          }
          const value = await originalHistoryRead(input);
          assert(value.ok && value.value.status === "found");
          if (fault === "deadline") f.clock.now = () => T0 + 120_001;
          if (fault === "wrong-head") {
            return portOk({
              ...value.value,
              head: releaseBefore.value.status === "found"
                ? releaseBefore.value.head
                : BASE,
            });
          }
          if (fault === "wrong-sequence") {
            return portOk({
              ...value.value,
              snapshot: {
                ...value.value.snapshot,
                sequence: value.value.snapshot.sequence + 2,
              },
            });
          }
          if (fault === "cycle") {
            return portOk({
              ...value.value,
              snapshot: {
                ...value.value.snapshot,
                hostedRuntimes: [],
                stateHead: releaseBefore.value.status === "found"
                  ? releaseBefore.value.head
                  : BASE,
              },
            });
          }
          return value;
        };
        try {
          if (fault === "deadline") {
            const deferred = await run();
            assert.equal(deferred.status, "skipped");
            assert(deferred.actions.includes("matrix-history:deferred"));
          } else {
            await assert.rejects(run);
          }
        } finally {
          f.rig.state.readReleaseAt = originalHistoryRead;
          f.clock.now = () => T0 + 60_000;
        }
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
        console.log(
          JSON.stringify({
            kind: "offline_history_control",
            fault,
            verified: true,
          }),
        );
      }
      for (const fault of ["auth", "pending", "missing"] as const) {
        f.setFault(fault);
        try {
          await assert.rejects(run);
        } finally {
          f.setFault(null);
        }
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
        console.log(
          JSON.stringify({
            kind: "offline_history_native_control",
            fault,
            verified: true,
          }),
        );
      }
      const unchangedWrite = f.rig.state.writeRepair;
      let lateWrites = 0;
      f.rig.state.writeRepair = (next, head) => {
        lateWrites++;
        return unchangedWrite(next, head);
      };
      expireCustody = true;
      let lateFinished = false;
      const lateRun = run().then((value) => {
        lateFinished = true;
        return { value, error: null };
      }, (error: unknown) => {
        lateFinished = true;
        return { value: null, error };
      });
      try {
        await Promise.race([
          custodyEntered.promise,
          lateRun.then((outcome) => {
            throw new Error(
              "late custody boundary was not reached: " + String(outcome.error),
            );
          }),
        ]);
        assert.equal(lateFinished, false);
        assert.equal(lateWrites, 0);
        continueCustody.resolve();
        const outcome = await lateRun;
        assert.equal(outcome.error, null);
        assert.equal(outcome.value?.status, "skipped");
        assert(outcome.value?.actions.includes("matrix-history:deferred"));
        assert.equal(lateWrites, 0);
      } finally {
        continueCustody.resolve();
        await lateRun;
        expireCustody = false;
        f.rig.state.writeRepair = unchangedWrite;
        f.rig.state.readRelease = originalReleaseRead;
        f.clock.now = () => T0 + 60_000;
      }
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      console.log(
        JSON.stringify({
          kind: "offline_history_late_custody",
          zeroWrites: true,
          joined: true,
        }),
      );
      nativeWriterProbe = true;
      try {
        await assert.rejects(run);
      } finally {
        nativeWriterProbe = false;
        f.rig.state.readRelease = originalReleaseRead;
      }
      assert.equal(nativeWriterAttempted, true);
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      console.log(
        JSON.stringify({
          kind: "offline_history_captured_writer",
          verified: true,
        }),
      );
    }
    if (!history) {
      for (const fault of ["auth", "pending", "missing"] as const) {
        f.setFault(fault);
        await assert.rejects(run);
        f.setFault(null);
        assert.deepEqual(await f.rig.state.readRepair(), before);
        assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      }
      nativeWriterProbe = true;
      try {
        await assert.rejects(run);
      } finally {
        nativeWriterProbe = false;
        f.rig.state.readRelease = originalReleaseRead;
      }
      assert.equal(nativeWriterAttempted, true);
      assert.deepEqual(await f.rig.state.readRepair(), before);
    }
    const originalWrite = f.rig.state.writeRepair;
    let unavailableWrites = 0;
    f.rig.state.writeRepair = () => {
      unavailableWrites++;
      return Promise.resolve(
        portError("unavailable", "offline settlement unavailable"),
      );
    };
    try {
      const unavailable = await run();
      assert.equal(unavailable.status, "skipped");
      assert(unavailableWrites > 0, "real settlement consumer must be reached");
      assert.deepEqual(await f.rig.state.readRepair(), before);
      assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
      console.log(JSON.stringify({
        kind: "offline_unavailable_settlement",
        zeroWrites: true,
        chargedIntentPreserved: true,
      }));
    } finally {
      f.rig.state.writeRepair = originalWrite;
    }
    let writesBeforeDrift = 0;
    let writeAttempts = 0;
    let actualAppliedHead: GitSha | null = null;
    let actualWriteResult: unknown;
    let partialError: unknown;
    const casEntered = Promise.withResolvers<void>();
    const continueCAS = Promise.withResolvers<void>();
    let partialRun: Promise<unknown> | null = null;
    f.rig.state.writeRepair = async (next, head) => {
      writeAttempts++;
      if (history) {
        casEntered.resolve();
        await continueCAS.promise;
      }
      const written = await originalWrite(next, head);
      actualWriteResult = written;
      if (written.ok && written.value.status === "applied") {
        writesBeforeDrift++;
        actualAppliedHead = written.value.head;
        f.rig.state.readRelease = async () => {
          const current = await originalReleaseRead();
          assert(current.ok && current.value.status === "found");
          return portOk({
            ...current.value,
            snapshot: {
              ...current.value.snapshot,
              sequence: current.value.snapshot.sequence + 1,
            },
          });
        };
      }
      return written;
    };
    try {
      let finished = false;
      const pending = run(throughMain).then((result) => {
        finished = true;
        return throughMain ? result : null;
      }, (error: unknown) => {
        finished = true;
        return error;
      });
      partialRun = pending;
      if (history) {
        await Promise.race([
          casEntered.promise,
          pending.then((error) => {
            throw new Error("CAS boundary was not reached: " + String(error));
          }),
        ]);
        f.clock.now = () => T0 + 120_001;
        await Promise.resolve();
        assert.equal(
          finished,
          false,
          "maintenance must join an already-started CAS",
        );
        assert.equal(writesBeforeDrift, 0);
        continueCAS.resolve();
      }
      const rejected = await pending;
      partialError = rejected;
      if (history && writesBeforeDrift !== 1 && rejected instanceof Error) {
        console.error(
          JSON.stringify({
            kind: "offline_history_partial_exception",
            name: rejected.name,
            message: rejected.message,
            stack: rejected.stack,
          }),
        );
      }
      assert.equal(
        writesBeforeDrift,
        1,
        "older ordinary results remain unconsumed after newer healthy proof replacement",
      );
      if (!throughMain) {
        assert(
          rejected instanceof Error,
          "partial settlement must refuse after custody drift",
        );
      }
    } finally {
      continueCAS.resolve();
      if (partialRun) await partialRun;
      f.rig.state.writeRepair = originalWrite;
      f.rig.state.readRelease = originalReleaseRead;
      f.clock.now = () => T0 + 60_000;
    }
    if (history) {
      console.log(
        JSON.stringify({
          kind: "offline_history_joined_cas",
          writes: writesBeforeDrift,
          settled: true,
        }),
      );
    }
    assert.equal(writesBeforeDrift, 1);
    assert.equal(
      writeAttempts,
      1,
      "custody drift must prevent later native writes",
    );
    const partial = await f.rig.state.readRepair();
    assert(partial.ok && partial.value.status === "found");
    assert.equal(partial.value.head, actualAppliedHead);
    assert.deepEqual(partial.value.snapshot.work, before.value.snapshot.work);
    const partialCharge = partial.value.snapshot.reservations.find((row) =>
      row.id === f.cells[0].reservationId
    )!;
    assert.equal(partialCharge.outcome, "ambiguous");
    assert.notEqual(partialCharge.settledAt, null);
    const originalCharge = before.value.snapshot.reservations.find((row) =>
      row.id === partialCharge.id
    )!;
    assert.deepEqual({
      ...partialCharge,
      outcome: originalCharge.outcome,
      settledAt: originalCharge.settledAt,
    }, originalCharge);
    if (throughMain) {
      assert.equal(mainExit, 1, "applied custody failure must not exit green");
      const reported = partialError as HostedAutonomyResultV1;
      assert.equal(reported.status, "failed");
      assert.equal(reported.reason, "unexpected_failure");
      assert.equal(reported.beforeHead, before.value.head);
      assert.equal(reported.appliedHead, partial.value.head);
      assert.deepEqual(reported.actions, []);
    } else {
      assert(partialError instanceof Error);
      assert.match(
        partialError.message,
        /^current matrix (release custody|producer ancestry) changed$/,
        "joined partial CAS must reject custody drift, not clock expiry",
      );
      assert.equal(isDeferredCurrentMatrixHistoryBudget(partialError), false);
      assert("beforeHead" in partialError);
      assert("appliedHead" in partialError);
      assert("writeResult" in partialError);
      assert.equal(partialError.beforeHead, before.value.head);
      assert.equal(partialError.appliedHead, partial.value.head);
      assert.deepEqual(partialError.writeResult, actualWriteResult);
    }
    f.clock.now = () => T0 + 61_000;
    const result = await run();
    assert.equal(result.status, "applied", JSON.stringify(result));
    const after = await f.rig.state.readRepair();
    assert(after.ok && after.value.status === "found");
    const failed = after.value.snapshot.work.find((row) =>
      row.id === f.records[0].id
    )!;
    const succeeded = after.value.snapshot.work.find((row) =>
      row.id === f.records[1].id
    )!;
    assert.equal(failed.nextStep, "blocked");
    assert.deepEqual(failed.intent, f.records[0].intent);
    assert.equal(succeeded.target.head, candidate);
    assert.equal(succeeded.intent?.kind, "candidate_preservation");
    assert.equal(
      await checked(mirror, ["rev-parse", candidate + "^{commit}"]),
      candidate,
    );
    assert.deepEqual(
      after.value.snapshot.work.find((row) => row.id === f.records[2].id),
      f.records[2],
    );
    assert.deepEqual(
      after.value.snapshot.reviews,
      before.value.snapshot.reviews,
    );
    assert.deepEqual(
      after.value.snapshot.releaseRequests,
      before.value.snapshot.releaseRequests,
    );
    assert.equal(after.value.snapshot.reservations[0].outcome, "ambiguous");
    assert.equal(after.value.snapshot.reservations[1].outcome, "submitted");
    assert.deepEqual(
      after.value.snapshot.reservations.find((row) =>
        row.id === partialCharge.id
      ),
      partialCharge,
    );
    assert.deepEqual(
      after.value.snapshot.reservations[2],
      before.value.snapshot.reservations[2],
    );
    assert.equal(
      after.value.snapshot.reservations.length,
      before.value.snapshot.reservations.length,
    );
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    const replay = await run();
    const replayState = await f.rig.state.readRepair();
    assert(replayState.ok && replayState.value.status === "found");
    assert.equal(replay.status, "applied");
    assert.equal(replay.reason, "retried");
    assert.deepEqual(replay.actions, [
      `retry:${failed.id}:grant=0:other:model run did not complete with a trusted candidate`,
    ]);
    assert.equal(replay.beforeHead, after.value.head);
    assert.equal(replay.appliedHead, replayState.value.head);
    assert.notEqual(replayState.value.head, after.value.head);
    assert.notEqual(
      replayState.value.snapshot.stateHead,
      after.value.snapshot.stateHead,
    );
    assert.equal(
      replayState.value.snapshot.sequence,
      after.value.snapshot.sequence + 1,
    );
    const retried = replayState.value.snapshot.work.find((row) =>
      row.id === failed.id
    )!;
    assert.equal(retried.nextStep, "work");
    assert.equal(retried.blocker, null);
    assert.equal(retried.intent, null);
    assert.deepEqual({
      ...replayState.value.snapshot,
      stateHead: after.value.snapshot.stateHead,
      sequence: after.value.snapshot.sequence,
      work: replayState.value.snapshot.work.map((row) =>
        row.id === failed.id
          ? {
            ...row,
            nextStep: failed.nextStep,
            blocker: failed.blocker,
            intent: failed.intent,
          }
          : row
      ),
    }, after.value.snapshot);
    assert.deepEqual(await f.rig.state.readRelease(), releaseBefore);
    assert.equal(
      await checked(mirror, ["rev-parse", candidate + "^{commit}"]),
      candidate,
    );
    assert.deepEqual(model.requests, []);
    assert.equal(github.pushes.length, 0);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
    await Deno.remove(targetRoot, { recursive: true });
  }
}
