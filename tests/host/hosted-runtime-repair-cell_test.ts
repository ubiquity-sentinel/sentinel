/**
 * The launcher's `repair_cell` child on both runtime pairings (issue #328).
 *
 * Live 2026-11-14, supervisor run 43597250279 (launcher ab84c0d888, runtime
 * 6e74557936, ordinary generation 240): under the legacy state view the
 * launcher runs every job through its rollback child, whose non-repair branch
 * called the runtime's matrix host. That host refuses a `repair_cell` job, so
 * no cell printed its marker and all six cells failed `carrier_count` 0.
 *
 * - The actual launcher and rollback child over real Git release custody, with
 *   an ordinary execution of the installed runtime under a newer launcher
 *   (the launcher-ahead pairing). The runtime tree's cell executable runs the
 *   ACTUAL repository cell pass, as the runtime's `runRepairCellHost` does:
 *   each cell settles healthy with the marker finalize authenticates, writes
 *   nothing, and its sealed delta applies through finalize's writer. A cell
 *   failing before its marker still fails, a matrix cell keeps the runtime's
 *   matrix host, and an unauthorized projection imports no runtime module.
 * - The normal pairing still runs the runtime's own cell entrypoint, accepts
 *   its one exact marker and rejects a broken cell.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import {
  portOk,
  type RepairStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import { decodeRepairDeltaArtifactV1 } from "../../src/contracts/repair-delta.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions.ts";
import { hostedCellState } from "../../src/host/hosted-repair-state.ts";
import { runHostedRuntimeLauncher } from "../../src/host/hosted-runtime-launcher.ts";
import { emitHostedRuntimeCliResult } from "../../src/host/hosted-runtime-main.ts";
import {
  isRepairCellMarker,
  REPAIR_CELL_CHILD_ENTRYPOINT,
} from "../../src/host/hosted-runtime-repair-cell.ts";
import { runHostedRollbackChild } from "../../src/host/hosted-runtime-rollback.ts";
import {
  createHostedRollbackState,
  needsHostedLegacyStateView,
} from "../../src/host/hosted-runtime-rollback-state.ts";
import type { HostedRuntimeLauncherResultV1 } from "../../src/host/hosted-runtime.ts";
import { parseCarrier } from "../../src/host/matrix-actions-shared.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-native-host.ts";
import {
  publishRepairFanoutOrNone,
  runRepairCellTargetCycles,
} from "../../src/host/repair-fanout-host.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
} from "../../src/replay/runtime.ts";
import {
  applyRepairDeltas,
  type RepairDeltaArtifactV1,
} from "../../src/repair/repair-delta-apply.ts";
import { repairFanoutPlanDigestV1 } from "../../src/repair/repair-fanout-plan.ts";
import { parseReleaseStateSnapshotV1 as parseLegacyRelease } from "../fixtures/runtime-1838df31/state-snapshots.ts";
import {
  captured,
  makeRig as makePassRig,
  MINUTE,
  pendingArtifact,
  REPOS,
  reviewing,
} from "../repair/repository-pass-rig.ts";
import { requireRun } from "./actions-supervisor-fixture.ts";
import {
  exited,
  hostedEnv,
  launch,
  makeRig,
  OTHER_REVISION,
  RUN_ATTEMPT,
  RUN_ID,
  seedRelease,
} from "./hosted-runtime-fixture.ts";
import { liveInstallRig, SUCCESSOR } from "./hosted-self-install-fixtures.ts";

type LiveRig = Awaited<ReturnType<typeof liveInstallRig>>;
type PassRig = ReturnType<typeof makePassRig>;
type Deps = Record<string, unknown> & {
  state: StateReadView & RepairStateWriter;
  carrier?: unknown;
};

const D = "d".repeat(64);
const CELL = "c".repeat(64);
const HOOKS = "sentinel.test.hosted-runtime-repair-cell";
/** The live receipt of every cell of run 43597250279. */
const LIVE_REJECTION = {
  version: "v1",
  kind: "hosted_runtime_matrix_launcher_rejection",
  condition: "carrier_count",
  outcome: "exited",
  exitCode: 1,
  settled: true,
  truncated: false,
  carrierCount: 0,
};

/**
 * The selected runtime's two modules the rollback child may import, each
 * forwarding to this test's hook (an in-process child cannot read the job
 * environment the production runtime composes itself from).
 */
async function writeRuntime(
  runtimeDir: string,
  hooks: {
    matrix(deps: Deps): Promise<unknown>;
    cell(deps: Deps): Promise<unknown>;
  },
): Promise<void> {
  Reflect.set(globalThis, Symbol.for(HOOKS), hooks);
  await Deno.mkdir(`${runtimeDir}/src/host`, { recursive: true });
  const shim = (name: string, hook: string) =>
    `export function ${name}(deps) {\n  return globalThis[Symbol.for(${
      JSON.stringify(HOOKS)
    })].${hook}(deps);\n}\n`;
  await Deno.writeTextFile(
    `${runtimeDir}/src/host/matrix-actions.ts`,
    shim("runActionsMatrixHost", "matrix"),
  );
  await Deno.writeTextFile(
    `${runtimeDir}/${REPAIR_CELL_CHILD_ENTRYPOINT}`,
    shim("runRepairCellHost", "cell"),
  );
}

/** The runtime's matrix host exactly as a `repair_cell` job reaches it. */
function runtimeMatrixHost(deps: Deps): Promise<unknown> {
  return runActionsMatrixHost(
    {
      ...deps,
      env: { GITHUB_JOB: "repair_cell" },
    } as Parameters<typeof runActionsMatrixHost>[0],
  );
}

/** The child process border: its stdout, and exit 1 for an uncaught error. */
async function inProcess(
  body: () => Promise<void>,
  errors: unknown[],
): Promise<ReplayCommandResultV1> {
  const out: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => out.push(args.map(String).join(" "));
  let code = 0;
  try {
    await body();
  } catch (error) {
    errors.push(error);
    code = 1;
  } finally {
    console.log = original;
  }
  return exited(out.map((line) => line + "\n").join(""), code);
}

/** Release custody from real Git; repair state from the pass rig. */
function liveState(rig: LiveRig, pass: PassRig) {
  return {
    readRelease: () => rig.release.readRelease(),
    readRepair: () => pass.state.readRepair(),
    writeRepair: (
      next: Parameters<RepairStateWriter["writeRepair"]>[0],
      head: GitSha | null,
    ) => pass.state.writeRepair(next, head),
  } as StateReadView & RepairStateWriter;
}

function cellEnv(
  execution: HostedExecutionIntentV1,
  job = "repair_cell",
): Record<string, string> {
  return {
    ...hostedEnv(SUCCESSOR),
    GITHUB_RUN_ID: String(execution.runId),
    GITHUB_RUN_ATTEMPT: String(execution.runAttempt),
    GITHUB_JOB: job,
  };
}

const runtimeHead = (execution: HostedExecutionIntentV1) => ({
  runGit: () =>
    Promise.resolve({
      ok: true,
      code: 0,
      stdout: execution.revision,
      stderr: "",
    }),
});

/** One cell job: the actual launcher, its actual rollback child. */
async function launchLegacyCell(
  rig: LiveRig,
  execution: HostedExecutionIntentV1,
  state: StateReadView & RepairStateWriter,
  carrier: string,
  job = "repair_cell",
) {
  const launcherDir = `${rig.root}/launcher`;
  const runtimeDir = `${rig.root}/runtime`;
  await Deno.mkdir(launcherDir, { recursive: true });
  await Deno.mkdir(runtimeDir, { recursive: true });
  await Deno.writeTextFile(
    `${runtimeDir}/sentinel.targets.json`,
    '["ubiquity-sentinel/sentinel"]',
  );
  const children: ReplayCommandInputV1[] = [];
  const errors: unknown[] = [];
  const result = await runHostedRuntimeLauncher({
    launcherDir,
    runtimeDir,
    clock: rig.clock,
    state: rig.release,
    denoExecutable: Deno.execPath(),
    env: cellEnv(execution, job),
    stdin: carrier,
    process: {
      run: (command) => {
        if (command.executable === "/usr/bin/git") {
          return Promise.resolve(exited(
            command.args.includes("status")
              ? ""
              : command.cwd === launcherDir
              ? SUCCESSOR
              : execution.revision,
          ));
        }
        children.push(command);
        return inProcess(
          () =>
            runHostedRollbackChild({
              env: command.env,
              root: runtimeDir,
              state,
              stdin: new Blob([carrier]).stream(),
              runner: runtimeHead(execution),
            }),
          errors,
        );
      },
    },
  });
  assert.equal(children.length, 1);
  assert.ok(
    children[0].args.includes(
      `${launcherDir}/src/host/hosted-runtime-rollback.ts`,
    ),
    "the legacy state view selects the launcher's rollback child",
  );
  assert.equal(children[0].env.GITHUB_JOB, job);
  assert.equal(children[0].stdin, carrier);
  return { result, errors };
}

/** The CLI exit and printed lines of one launcher result. */
async function cli(result: HostedRuntimeLauncherResultV1) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await captured(() =>
      Promise.resolve(emitHostedRuntimeCliResult(result))
    );
  } finally {
    console.error = originalError;
  }
}

/** An ordinary run of the installed runtime under a newer launcher. */
async function launcherAhead(rig: LiveRig) {
  // The launcher's CI is not green yet, so prepare keeps the installed
  // runtime in an ordinary run: the live pairing.
  rig.evidence.verifyLauncherCi = () => Promise.resolve(portOk(null));
  const execution = requireRun(await rig.prepare(1));
  assert.equal(execution.purpose, "ordinary");
  assert.notEqual(execution.revision, execution.launcherSha);
  assert.equal(
    needsHostedLegacyStateView(await rig.snapshot(), execution),
    true,
  );
  return execution;
}

Deno.test("legacy repair cell: a launcher-ahead ordinary run's cells settle healthy and their deltas apply", async () => {
  const rig = await liveInstallRig();
  try {
    const execution = await launcherAhead(rig);
    // The frozen legacy reader rejects the raw release state.
    const raw = await rig.snapshot();
    assert.throws(() => parseLegacyRelease(raw));
    const [ALPHA, BETA] = REPOS;
    const pass = makePassRig([
      reviewing(ALPHA, 0),
      pendingArtifact(ALPHA, 9),
      reviewing(BETA, 100),
    ]);
    // The authoritative store holds parsed snapshots, as the Git store does.
    pass.state.repair = parseRepairStateSnapshotV1(pass.state.repair!);
    const state = liveState(rig, pass);
    const run = {
      runId: execution.runId,
      runAttempt: execution.runAttempt,
      launcherSha: execution.launcherSha,
    };
    const artifactRoot = `${rig.root}/.sentinel-matrix`;
    await Deno.writeTextFile(`${rig.root}/github-output`, "");
    // This run's planner, which also ran under the projection, delegated
    // both repositories' observed records.
    const fanout = await publishRepairFanoutOrNone({
      state: createHostedRollbackState(state),
      configs: pass.configs,
      run,
      artifactRoot,
      output: `${rig.root}/github-output`,
    });
    assert.equal(fanout?.cells.length, 2);
    const repairPlanDigest = await repairFanoutPlanDigestV1(fanout!);
    let matrixCalls = 0;
    let cellCalls = 0;
    await writeRuntime(`${rig.root}/runtime`, {
      matrix: (deps) => {
        matrixCalls++;
        return runtimeMatrixHost(deps);
      },
      // What the runtime's `runRepairCellHost` does for its job: the native
      // carrier, a cell job's refusing writer over the state it was handed,
      // and the repository cell pass.
      cell: async (deps) => {
        cellCalls++;
        const carrier = parseCarrier(deps.carrier, true);
        const release = await deps.state.readRelease();
        assert.ok(release.ok && release.value.status === "found");
        // The launcher's projection: the frozen legacy reader accepts it.
        parseLegacyRelease(release.value.snapshot);
        assert.equal(Object.hasOwn(deps.state, "writeRelease"), false);
        return await runRepairCellTargetCycles({
          ...pass.deps,
          state: hostedCellState(deps.state),
          controllerSha: execution.revision,
          deadline: pass.clock.now() + 90 * MINUTE,
          stepLimit: 1_000,
          modelStartsEnabled: true,
          runOrigin: pass.clock.now(),
          composeGithub: () => pass.github,
          host: { execution, run, artifactRoot },
        } as unknown as ActionsTargetCyclesInputV1, carrier);
      },
    });
    const artifacts: RepairDeltaArtifactV1[] = [];
    for (const cell of fanout!.cells) {
      const { result, errors } = await launchLegacyCell(
        rig,
        execution,
        state,
        JSON.stringify({
          planDigest: D,
          repairPlanDigest,
          cellId: cell.cellId,
        }),
      );
      assert.equal(
        result.status,
        "healthy",
        JSON.stringify(result.launcherRejection) + " " + String(errors[0]),
      );
      assert.deepEqual(errors, []);
      const marker = result.matrixCarrier!;
      // Finalize's marker check: this run, the saved runtime revision and
      // generation, and this cell.
      assert.ok(isRepairCellMarker(marker, execution, cell.cellId));
      assert.equal(marker.runtimeSha, execution.revision);
      const printed = await cli(result);
      assert.equal(printed.value, 0);
      assert.ok(
        printed.lines.some((line) =>
          line.kind === "sentinel_repair_cell" && line.cellId === cell.cellId
        ),
      );
      const envelope = decodeRepairDeltaArtifactV1(
        await Deno.readFile(`${rig.root}/.sentinel-repair/result.json`),
      ) as { digest: string };
      assert.equal(envelope.digest, marker.deltaDigest);
      artifacts.push({ cellId: cell.cellId, envelope });
    }
    assert.equal(cellCalls, 2, "the runtime's own cell executable ran");
    assert.equal(matrixCalls, 0, "the matrix host never sees a cell job");
    assert.equal(pass.state.repairWrites, 0, "a cell writes no shared state");

    // Finalize's single trusted write applies both deltas to the records the
    // cells stepped; the serial-owned record is untouched.
    const before = structuredClone(pass.state.repair!);
    const { value: applied } = await captured(() =>
      applyRepairDeltas({ state: pass.state, clock: pass.clock }, {
        plan: fanout!,
        artifacts,
        deadline: pass.clock.now() + 60 * MINUTE,
      })
    );
    assert.equal(applied.status, "applied");
    assert.deepEqual(applied.rejected, []);
    assert.deepEqual(
      applied.applied.map((entry) => entry.repository.name).sort(),
      ["alpha", "beta"],
    );
    assert.equal(pass.state.repairWrites, 1);
    for (const id of ["issue-alpha-0", "issue-beta-100"]) {
      assert.equal(
        pass.state.repair!.work.find((row) => row.id === id)?.wait?.reason,
        "review_pending",
        id,
      );
    }
    assert.deepEqual(
      pass.state.repair!.work.find((row) => row.id === "issue-alpha-9"),
      before.work.find((row) => row.id === "issue-alpha-9"),
    );
  } finally {
    Reflect.deleteProperty(globalThis, Symbol.for(HOOKS));
    await rig.close();
  }
});

Deno.test("legacy repair cell: a cell failing before its marker still fails, a matrix cell keeps its host and an unauthorized projection runs no cell", async () => {
  const rig = await liveInstallRig();
  try {
    const execution = await launcherAhead(rig);
    const state = liveState(rig, makePassRig([reviewing(REPOS[0], 0)]));
    let cellCalls = 0;
    const matrixCarriers: unknown[] = [];
    await writeRuntime(`${rig.root}/runtime`, {
      // The runtime's matrix cell settles and prints its one marker.
      matrix: (deps) => {
        matrixCarriers.push(deps.carrier);
        console.log(JSON.stringify({
          kind: "sentinel_matrix_cell",
          run: {
            runId: execution.runId,
            runAttempt: execution.runAttempt,
            launcherSha: execution.launcherSha,
          },
          runtimeSha: execution.revision,
          generation: execution.generation,
          cellId: CELL,
          reservationId: "reservation-1",
          resultDigest: D,
          bundleDigest: null,
          status: "not_started",
        }));
        return Promise.resolve();
      },
      cell: () => {
        cellCalls++;
        return Promise.reject(new Error("runtime cell composition failed"));
      },
    });
    const carrier = JSON.stringify({
      planDigest: D,
      repairPlanDigest: D,
      cellId: CELL,
    });
    const { result: failed, errors } = await launchLegacyCell(
      rig,
      execution,
      state,
      carrier,
    );
    assert.equal(cellCalls, 1, String(errors[0]));
    assert.match(String(errors[0]), /runtime cell composition failed/);
    assert.equal(failed.status, "unavailable");
    assert.equal(failed.matrixCarrier, undefined);
    assert.deepEqual({ ...failed.launcherRejection }, LIVE_REJECTION);
    assert.equal((await cli(failed)).value, 1);
    assert.deepEqual(matrixCarriers, [], "a cell job never reaches it");

    // A matrix cell under the same projection keeps the runtime's matrix
    // host and the launcher's carrier.
    const matrix = await launchLegacyCell(
      rig,
      execution,
      state,
      JSON.stringify({ planDigest: D, cellId: CELL }),
      "matrix_cell",
    );
    assert.deepEqual(matrix.errors, []);
    assert.equal(
      matrix.result.status,
      "healthy",
      JSON.stringify(matrix.result.launcherRejection),
    );
    assert.deepEqual(matrixCarriers, [{ planDigest: D, cellId: CELL }]);
    assert.equal(cellCalls, 1);

    // A degraded admission is no authorized projection: the child refuses
    // before it imports any runtime module.
    const raw = await rig.snapshot();
    const degraded = parseReleaseStateSnapshotV1({
      ...raw,
      hostedRuntimes: raw.hostedRuntimes.map((runtime) => ({
        ...runtime,
        lastHealthyProof: null,
        verificationFailures: 2,
        failedVerificationIds: ["3997:1:repair", "3998:1:repair"],
        ordinaryAdmission: {
          ...runtime.ordinaryAdmission!,
          mode: "degraded",
          failedVerificationIds: ["3997:1:repair", "3998:1:repair"],
        },
      })),
    });
    assert.equal(needsHostedLegacyStateView(degraded, execution), false);
    const head = await rig.release.readRelease();
    assert.ok(head.ok && head.value.status === "found");
    await assert.rejects(
      runHostedRollbackChild({
        env: cellEnv(execution),
        root: `${rig.root}/runtime`,
        state: {
          ...state,
          readRelease: () =>
            Promise.resolve(portOk({ ...head.value, snapshot: degraded })),
        },
        stdin: new Blob([carrier]).stream(),
        runner: runtimeHead(execution),
      }),
      /projection is not authorized/,
    );
    assert.equal(cellCalls, 1, "no runtime cell ran");
  } finally {
    Reflect.deleteProperty(globalThis, Symbol.for(HOOKS));
    await rig.close();
  }
});

Deno.test("repair cell launcher: the normal pairing runs the runtime's cell entrypoint and still rejects a broken cell", async () => {
  // Identical checkouts commit to one SHA: launcher and runtime are equal.
  // The default rig is a launcher-ahead pairing without a healthy admission.
  for (
    const files of [
      { "README.md": "launcher\n", ".gitignore": ".sentinel/\n" },
      undefined,
    ]
  ) {
    const rig = await makeRig(
      files === undefined ? {} : { runtimeFiles: files },
    );
    try {
      await seedRelease(rig);
      assert.equal(
        rig.execution.revision === rig.identity.launcherSha,
        files !== undefined,
      );
      const read = await rig.release.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      assert.equal(
        needsHostedLegacyStateView(read.value.snapshot, rig.execution),
        false,
      );
      const stdin = JSON.stringify({
        planDigest: D,
        repairPlanDigest: D,
        cellId: CELL,
      });
      const marker = {
        kind: "sentinel_repair_cell",
        run: {
          runId: RUN_ID,
          runAttempt: RUN_ATTEMPT,
          launcherSha: rig.identity.launcherSha,
        },
        runtimeSha: rig.execution.revision,
        generation: rig.execution.generation,
        cellId: CELL,
        deltaDigest: D,
        transitions: 3,
      };
      const children: ReplayCommandInputV1[] = [];
      const cell = (child: ReplayCommandResultV1) =>
        launch(rig, {
          env: { ...rig.env, GITHUB_JOB: "repair_cell" },
          stdin,
          process: {
            run: (command) => {
              if (!command.args.includes(REPAIR_CELL_CHILD_ENTRYPOINT)) {
                return rig.process.run(command);
              }
              children.push(command);
              return Promise.resolve(child);
            },
          },
        });

      const healthy = await cell(exited(JSON.stringify(marker) + "\n"));
      assert.equal(healthy.status, "healthy", JSON.stringify(healthy));
      assert.deepEqual(healthy.matrixCarrier, marker);
      assert.deepEqual(children[0].args, [
        "run",
        "-A",
        REPAIR_CELL_CHILD_ENTRYPOINT,
      ]);
      assert.equal(children[0].cwd, await Deno.realPath(rig.runtimeDir));
      assert.equal(children[0].stdin, stdin);
      assert.equal((await cli(healthy)).value, 0);

      // A cell that crashed before its marker: the live receipt, exit 1.
      const broken = await cell(exited("", 1));
      assert.equal(broken.status, "unavailable");
      assert.deepEqual({ ...broken.launcherRejection }, LIVE_REJECTION);
      assert.equal((await cli(broken)).value, 1);
      // A marker bound to another runtime revision is no carrier.
      const foreign = await cell(
        exited(
          JSON.stringify({ ...marker, runtimeSha: OTHER_REVISION }) + "\n",
        ),
      );
      assert.equal(foreign.status, "unavailable");
      assert.equal(foreign.launcherRejection?.condition, "carrier_field");
      assert.equal(foreign.launcherRejection?.field, "cell");
      assert.equal(children.length, 3);
    } finally {
      await rig.cleanup();
    }
  }
});
