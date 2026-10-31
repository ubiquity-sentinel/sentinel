/** Self-install replaces the retired owner-install/migration-only workflow ceremony. */
import assert from "node:assert/strict";
import {
  parseReleaseStateSnapshotV1 as parseLegacyRelease,
  parseRepairStateSnapshotV1 as parseLegacyRepair,
} from "../fixtures/runtime-1838df31/state-snapshots.ts";
import { parseHostedReleaseRecordV1 as parseLegacyRecord } from "../fixtures/runtime-1838df31/hosted-supervisor-release.ts";
import {
  requireRun,
  runProof,
  startedFailureProof,
} from "./actions-supervisor-fixture.ts";
import { childLine, exited, hostedEnv } from "./hosted-runtime-fixture.ts";
import { runHostedRuntimeLauncher } from "../../src/host/hosted-runtime-launcher.ts";
import {
  createHostedRollbackState,
  isHostedInstallationRollback,
  rollbackReleaseView,
} from "../../src/host/hosted-runtime-rollback-state.ts";
import {
  LEGACY_RUNTIME,
  liveInstallRig,
  SUCCESSOR,
} from "./hosted-self-install-fixtures.ts";
import type { HostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";

Deno.test("hosted migration workflow: CI-green launcher self-installs from live-shaped generation82 idempotently", async () => {
  const rig = await liveInstallRig();
  try {
    const repairBefore = await rig.repair.readRepair();
    const before = await rig.snapshot();
    assert.equal(before.hostedRuntimes[0].activeRevision, LEGACY_RUNTIME);
    assert.equal(before.hostedRuntimes[0].generation, 82);
    const bootstrap = requireRun(await rig.prepare(1));
    assert.equal(bootstrap.revision, SUCCESSOR);
    assert.equal(bootstrap.generation, 83);
    assert.equal(bootstrap.purpose, "bootstrap");
    const installed = await rig.snapshot();
    assert.equal(installed.hostedRuntimes[0].activeRevision, SUCCESSOR);
    assert.deepEqual(installed.hostedRuntimes[0].execution, bootstrap);
    assert.equal(installed.hostedInstallations?.length, 1);
    const journal = installed.hostedInstallations![0];
    assert.equal(journal.phase, "bootstrapping");
    assert.equal(journal.bootstrapExecutionId, bootstrap.id);
    assert.equal(journal.previousRevision, LEGACY_RUNTIME);
    assert.equal(journal.previousGeneration, 82);
    assert.deepEqual(
      journal.previousHealthyProof,
      before.hostedRuntimes[0].lastHealthyProof,
    );
    assert.deepEqual(journal.ci, { revision: SUCCESSOR, checkRunId: 91 });
    assert.equal(installed.hostedReleases[0].phase, "abandoned");
    assert.equal(
      installed.hostedReleases[0].abandonment?.reason,
      "included_in_successor",
    );
    assert.equal(
      installed.hostedReleases[0].abandonment?.successorRevision,
      SUCCESSOR,
    );
    assert.deepEqual(
      installed.hostedReleases[0].request,
      before.hostedReleases[0].request,
    );
    const saved = await rig.release.readRelease();
    assert.deepEqual(requireRun(await rig.prepare(1)), bootstrap);
    assert.deepEqual(await rig.release.readRelease(), saved);
    assert.equal((await rig.prepare(2)).status, "pending");
    assert.deepEqual(await rig.release.readRelease(), saved);
    assert.deepEqual(
      await rig.repair.readRepair(),
      repairBefore,
      "no reservation, charge or repair-state change",
    );
    assert.ok(rig.calls.some((path) => path.endsWith("/check-runs")));
    assert.ok(
      rig.calls.some((path) =>
        path.includes(`/compare/${LEGACY_RUNTIME}...${SUCCESSOR}`)
      ),
    );
  } finally {
    await rig.close();
  }
});

async function launch(
  rig: Awaited<ReturnType<typeof liveInstallRig>>,
  execution: HostedExecutionIntentV1,
) {
  const launcherDir = `${rig.root}/launcher`;
  const runtimeDir = `${rig.root}/runtime`;
  await Deno.mkdir(launcherDir, { recursive: true });
  await Deno.mkdir(runtimeDir, { recursive: true });
  await Deno.writeTextFile(
    `${runtimeDir}/sentinel.targets.json`,
    JSON.stringify(["ubiquity-sentinel/sentinel", "ubiquity/ai.ubq.fi"]),
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
        if (execution.revision === LEGACY_RUNTIME) {
          assert.ok(
            command.args.includes(
              `${launcherDir}/src/host/hosted-runtime-rollback.ts`,
            ),
          );
          const view = createHostedRollbackState(rig.repair);
          const release = await view.readRelease();
          const repair = await view.readRepair();
          assert.ok(release.ok && release.value.status === "found");
          assert.ok(repair.ok && repair.value.status === "found");
          parseLegacyRelease(release.value.snapshot);
          parseLegacyRepair(repair.value.snapshot);
          assert.equal(
            Object.hasOwn(release.value.snapshot, "hostedInstallations"),
            false,
          );
          assert.deepEqual(release.value.snapshot.hostedReleases, []);
        } else assert.ok(command.args.includes("src/host/actions.ts"));
        return exited(childLine(execution));
      },
    },
  });
  assert.equal(children, 1);
  assert.equal(result.status, "healthy");
  assert.deepEqual(result.terminal?.execution, execution);
}

Deno.test("hosted migration workflow: failed self-install restores the exact legacy child with compatible reads and native settlement", async () => {
  const rig = await liveInstallRig();
  try {
    const repairBefore = await rig.repair.readRepair();
    const bootstrap = requireRun(await rig.prepare(1));
    rig.clock.advance(5_000);
    rig.evidence.settlements.set(bootstrap.id, startedFailureProof(bootstrap));
    assert.equal((await rig.finalize(1)).status, "idle");
    const rollback = requireRun(await rig.prepare(2));
    assert.equal(rollback.revision, LEGACY_RUNTIME);
    assert.equal(rollback.generation, 84);
    assert.equal(rollback.purpose, "bootstrap");
    const beforeChild = await rig.release.readRelease();
    const raw = await rig.snapshot();
    assert.equal(isHostedInstallationRollback(raw, rollback), true);
    assert.equal(
      isHostedInstallationRollback(raw, {
        ...rollback,
        id: "999:1:repair",
        runId: 999,
      }),
      false,
    );
    assert.throws(() => parseLegacyRelease(raw));
    assert.throws(() => parseLegacyRecord(raw.hostedReleases[0]));
    assert.throws(() =>
      parseLegacyRelease({
        ...rollbackReleaseView(raw),
        hostedRuntimes: raw.hostedRuntimes,
      })
    );
    await launch(rig, rollback);
    assert.deepEqual(
      await rig.release.readRelease(),
      beforeChild,
      "projection cannot rewrite the journal",
    );
    rig.clock.advance(5_000);
    rig.evidence.settlements.set(rollback.id, runProof(rollback, "healthy"));
    assert.equal((await rig.finalize(2)).status, "idle");
    const restored = await rig.snapshot();
    assert.equal(restored.hostedInstallations![0].phase, "rolled_back");
    assert.equal(
      restored.hostedInstallations![0].bootstrapProof?.outcome,
      "failed",
    );
    assert.equal(
      restored.hostedInstallations![0].rollbackProof?.execution.id,
      rollback.id,
    );
    assert.equal(
      restored.hostedRuntimes[0].lastHealthyProof?.execution.generation,
      84,
    );
    const ordinary = requireRun(await rig.prepare(3));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LEGACY_RUNTIME);
    await launch(rig, ordinary);
    assert.deepEqual(await rig.repair.readRepair(), repairBefore);
  } finally {
    await rig.close();
  }
});
