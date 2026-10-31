/** Actual launcher/child authorization and frozen legacy reads over real Git state. */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  type ReleaseStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { recordFiles } from "../../src/state/state-codec.ts";
import { runHostedRuntimeLauncher } from "../../src/host/hosted-runtime-launcher.ts";
import { runHostedRollbackChild } from "../../src/host/hosted-runtime-rollback.ts";
import { needsHostedLegacyStateView } from "../../src/host/hosted-runtime-rollback-state.ts";
import { parseReleaseStateSnapshotV1 as parseLegacyRelease } from "../fixtures/runtime-1838df31/state-snapshots.ts";
import { pushRawTree, testGitEnv } from "../state/helpers.ts";
import { childLine, exited, hostedEnv } from "./hosted-runtime-fixture.ts";
import {
  requireRun,
  runProof,
  startedFailureProof,
} from "./actions-supervisor-fixture.ts";
import {
  LEGACY_RUNTIME,
  liveInstallRig,
  SUCCESSOR,
} from "./hosted-self-install-fixtures.ts";

type Rig = Awaited<ReturnType<typeof liveInstallRig>>;

/** Seed historical input only; exercised controller writes still use the real CAS. */
async function seedRelease(
  rig: Rig,
  change: (snapshot: ReleaseStateSnapshotV1) => ReleaseStateSnapshotV1,
) {
  const before = await rig.release.readRelease();
  assert.ok(before.ok && before.value.status === "found");
  const snapshot = parseReleaseStateSnapshotV1({
    ...change(before.value.snapshot),
    stateHead: before.value.head,
    sequence: before.value.snapshot.sequence + 1,
  });
  const files = Object.fromEntries(
    (await recordFiles(snapshot, "release")).map((row) => [row.path, row.text]),
  );
  files["manifest.json"] = canonicalStringify({
    version: "v1",
    kind: "release_state_manifest",
    stateHead: before.value.head,
    sequence: snapshot.sequence,
    updatedAt: snapshot.updatedAt,
  }) + "\n";
  const pushed = await pushRawTree(
    { bare: `${rig.root}/remote.git`, work: `${rig.root}/work` },
    before.value.head,
    "refs/heads/sentinel-state/release",
    files,
    testGitEnv(`${rig.root}/home`),
  );
  assert.ok(pushed.ok, pushed.stderr);
}

async function child(rig: Rig, execution: HostedExecutionIntentV1) {
  const root = `${rig.root}/runtime`;
  await Deno.mkdir(`${root}/src/host`, { recursive: true });
  const parser =
    new URL("../fixtures/runtime-1838df31/state-snapshots.ts", import.meta.url)
      .href;
  // This narrow child consumer runs the actual frozen parsers. It is not a claim
  // that the entire historical host or a model has executed.
  await Deno.writeTextFile(
    `${root}/src/host/actions.ts`,
    `
import { parseReleaseStateSnapshotV1, parseRepairStateSnapshotV1 } from ${
      JSON.stringify(parser)
    };
export async function runActionsRepairHost({ state }) {
  const release = await state.readRelease();
  const repair = await state.readRepair();
  if (!release.ok || release.value.status !== "found" || !repair.ok || repair.value.status !== "found") throw new Error("fixture state unavailable");
  parseReleaseStateSnapshotV1(release.value.snapshot);
  parseRepairStateSnapshotV1(repair.value.snapshot);
  if (Object.hasOwn(state, "writeRelease")) throw new Error("child received release authority");
}
`,
  );
  await Deno.writeTextFile(
    `${root}/src/host/matrix-actions.ts`,
    "export function runActionsMatrixAggregateCycles() { throw new Error('unexpected model work'); }\n",
  );
  const env = {
    ...hostedEnv(SUCCESSOR),
    GITHUB_RUN_ID: String(execution.runId),
    GITHUB_RUN_ATTEMPT: "1",
  };
  await runHostedRollbackChild({
    env,
    root,
    state: rig.repair,
    stdin: new Blob([]).stream(),
    runner: {
      runGit: () =>
        Promise.resolve({
          ok: true,
          code: 0,
          stdout: execution.revision,
          stderr: "",
        }),
    },
  });
}

async function launch(rig: Rig, execution: HostedExecutionIntentV1) {
  const launcherDir = `${rig.root}/launcher`,
    runtimeDir = `${rig.root}/runtime`;
  await Deno.mkdir(launcherDir, { recursive: true });
  await Deno.mkdir(runtimeDir, { recursive: true });
  await Deno.writeTextFile(
    `${runtimeDir}/sentinel.targets.json`,
    '["ubiquity-sentinel/sentinel"]',
  );
  let children = 0;
  const result = await runHostedRuntimeLauncher({
    launcherDir,
    runtimeDir,
    clock: rig.clock,
    state: rig.release,
    denoExecutable: Deno.execPath(),
    env: {
      ...hostedEnv(SUCCESSOR),
      GITHUB_RUN_ID: String(execution.runId),
      GITHUB_RUN_ATTEMPT: "1",
    },
    process: {
      run: async (command) => {
        if (command.executable === "/usr/bin/git") {
          return exited(
            command.args.includes("status")
              ? ""
              : command.cwd === launcherDir
              ? SUCCESSOR
              : execution.revision,
          );
        }
        children++;
        if (
          command.args.some((arg) =>
            arg.endsWith("/hosted-runtime-rollback.ts")
          )
        ) await child(rig, execution);
        else parseLegacyRelease(await rig.snapshot());
        return exited(childLine(execution));
      },
    },
  });
  assert.equal(children, 1);
  assert.equal(result.status, "healthy", result.detail);
}

Deno.test("legacy execution recovery: CI or ancestry refusal preserves ordinary execution through the real child guard", async (t) => {
  for (const reason of ["CI", "ancestry"] as const) {
    await t.step(reason, async () => {
      const rig = await liveInstallRig();
      try {
        if (reason === "CI") {
          rig.evidence.verifyLauncherCi = () => Promise.resolve(portOk(null));
        } else {rig.evidence.verifyAncestor = () =>
            Promise.resolve(portOk(false));}
        const repairBefore = await rig.repair.readRepair();
        const execution = requireRun(await rig.prepare(1));
        assert.equal(execution.purpose, "ordinary");
        assert.equal(execution.revision, LEGACY_RUNTIME);
        const releaseBefore = await rig.release.readRelease();
        assert.equal((await rig.snapshot()).hostedInstallations, undefined);
        const raw = await rig.snapshot();
        assert.throws(() => parseLegacyRelease(raw));
        await launch(rig, execution);
        assert.deepEqual(await rig.release.readRelease(), releaseBefore);
        assert.deepEqual(await rig.repair.readRepair(), repairBefore);
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
        assert.equal(
          needsHostedLegacyStateView(degraded, execution),
          false,
          "an unjournaled capable degraded runtime keeps its native reader",
        );
        const runtime = raw.hostedRuntimes[0];
        for (
          const admission of [
            { ...runtime.ordinaryAdmission!, executionId: "999:1:repair" },
            { ...runtime.ordinaryAdmission!, revision: SUCCESSOR },
            {
              ...runtime.ordinaryAdmission!,
              generation: runtime.generation + 1,
            },
          ]
        ) {
          assert.equal(
            needsHostedLegacyStateView({
              ...raw,
              hostedRuntimes: [{ ...runtime, ordinaryAdmission: admission }],
            }, execution),
            false,
            "healthy history cannot substitute for the current exact admission",
          );
        }
      } finally {
        await rig.close();
      }
    });
  }
});

Deno.test("legacy execution recovery: historical degraded admission cannot veto model-disabled exact rollback bootstrap", async () => {
  const rig = await liveInstallRig();
  try {
    await seedRelease(
      rig,
      (snapshot) => ({
        ...snapshot,
        hostedRuntimes: snapshot.hostedRuntimes.map((runtime) => ({
          ...runtime,
          ordinaryAdmission: {
            mode: "degraded",
            executionId: "3999:1:repair",
            revision: LEGACY_RUNTIME,
            generation: 82,
            failedVerificationIds: ["3997:1:repair", "3998:1:repair"],
          },
        })),
      }),
    );
    const repairBefore = await rig.repair.readRepair();
    const bootstrap = requireRun(await rig.prepare(1));
    rig.clock.advance(5000);
    rig.evidence.settlements.set(bootstrap.id, startedFailureProof(bootstrap));
    assert.equal((await rig.finalize(1)).status, "idle");
    const rollback = requireRun(await rig.prepare(2));
    assert.equal(rollback.purpose, "bootstrap");
    assert.equal(rollback.revision, LEGACY_RUNTIME);
    assert.equal(rollback.generation, 84);
    const before = await rig.release.readRelease();
    await child(rig, rollback);
    assert.deepEqual(await rig.release.readRelease(), before);
    rig.clock.advance(5000);
    rig.evidence.settlements.set(rollback.id, runProof(rollback, "healthy"));
    assert.equal((await rig.finalize(2)).status, "idle");
    assert.equal(
      (await rig.snapshot()).hostedInstallations?.[0].phase,
      "rolled_back",
    );
    const ordinary = requireRun(await rig.prepare(3));
    await launch(rig, ordinary);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);

    await seedRelease(
      rig,
      (snapshot) => ({
        ...snapshot,
        hostedRuntimes: snapshot.hostedRuntimes.map((runtime) => ({
          ...runtime,
          ordinaryAdmission: {
            mode: "degraded",
            executionId: ordinary.id,
            revision: ordinary.revision,
            generation: ordinary.generation,
            failedVerificationIds: ["3997:1:repair", "3998:1:repair"],
          },
        })),
      }),
    );
    await assert.rejects(child(rig, ordinary), /projection is not authorized/);
    await assert.rejects(
      child(rig, { ...ordinary, runId: 999, id: "999:1:repair" }),
      /saved execution is unavailable/,
    );
  } finally {
    await rig.close();
  }
});
