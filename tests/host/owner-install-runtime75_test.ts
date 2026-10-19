import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  buildOwnerDevelopmentInstallSnapshot
    as productionBuildOwnerDevelopmentInstallSnapshot,
  planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall,
} from "../../src/host/owner-development-install.ts";
import {
  EARLY_FRAME_RUNTIME_REVISION,
  LAUNCHER,
  MISMATCH_DISPOSITION_RUNTIME_REVISION,
  NOW,
  STACKED_MERGE_RUNTIME_REVISION,
  STATE_HEAD,
  UNRELATED,
} from "./owner-install-fixture-constants.ts";
import {
  acceptedRelease,
  failedProof,
  healthyProof,
  hostedProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";
import { makeRig, requireRun, runProof } from "./actions-supervisor-fixture.ts";

function failedEarlyFrame(
  includeAcceptedRelease = true,
): ReleaseStateSnapshotV1 {
  const source = releaseSnapshot({
    runtime: runtimeRecord({
      revision: STACKED_MERGE_RUNTIME_REVISION,
      generation: 72,
      healthyProof: healthyProof(STACKED_MERGE_RUNTIME_REVISION, 72, 201),
    }),
    hostedReleases: includeAcceptedRelease ? [acceptedRelease()] : [],
  });
  const install = planOwnerDevelopmentInstall(source, NOW);
  assert.equal(install.status, "install");
  if (install.status !== "install") throw new Error("expected generation73");
  const installed = buildOwnerDevelopmentInstallSnapshot(
    source,
    STATE_HEAD,
    install.move,
    NOW,
  );
  return {
    ...installed,
    hostedRuntimes: [{
      ...installed.hostedRuntimes[0],
      lastExecutionProof: failedProof(EARLY_FRAME_RUNTIME_REVISION, 73, 202),
    }],
  };
}

function restoredEarlyFrame(): ReleaseStateSnapshotV1 {
  const failed = failedEarlyFrame();
  const rollback = planOwnerDevelopmentInstall(failed, NOW + 1);
  assert.equal(rollback.status, "rollback");
  if (rollback.status !== "rollback") throw new Error("expected rollback74");
  return buildOwnerDevelopmentInstallSnapshot(
    failed,
    STATE_HEAD,
    rollback.move,
    NOW + 1,
  );
}

Deno.test(
  "owner install runtime75: real failed73 rollback resumes the exact retry and restores its proven prior once",
  async () => {
    const failed = failedEarlyFrame();
    const prior = failed.hostedRuntimes[0].lastHealthyProof;
    const fixture = await concurrencyInstallerFixture(
      failed,
      undefined,
      MISMATCH_DISPOSITION_RUNTIME_REVISION,
    );
    let installed: ReleaseStateSnapshotV1;
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(fixture.patches(), 1);
      const restored = await fixture.read();
      if (!restored.ok || restored.value.status !== "found") {
        throw new Error("missing real rollback74");
      }
      const runtime = restored.value.snapshot.hostedRuntimes[0];
      assert.equal(runtime.activeRevision, STACKED_MERGE_RUNTIME_REVISION);
      assert.equal(runtime.generation, 74);
      assert.deepEqual(runtime.lastHealthyProof, prior);
      assert.deepEqual(
        runtime.lastExecutionProof,
        failed.hostedRuntimes[0].lastExecutionProof,
      );
      const rollbackHead = restored.value.head;
      fixture.setNow(NOW + 1);
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "installed");
      assert.equal(fixture.patches(), 2);
      const retry = await fixture.read();
      if (!retry.ok || retry.value.status !== "found") {
        throw new Error("missing real retry75");
      }
      installed = retry.value.snapshot;
      assert.equal(
        installed.hostedRuntimes[0].activeRevision,
        MISMATCH_DISPOSITION_RUNTIME_REVISION,
      );
      assert.equal(installed.hostedRuntimes[0].generation, 75);
      assert.deepEqual(installed.hostedRuntimes[0].lastHealthyProof, prior);
      assert.deepEqual(installed.hostedReleases, failed.hostedReleases);
      const record = JSON.parse(
        (await fixture.message()).trim().split("\n").at(-1)!,
      );
      assert.equal(record.stateHead, rollbackHead);
      assert.equal(record.priorRevision, STACKED_MERGE_RUNTIME_REVISION);
      assert.equal(record.priorGeneration, 74);
      assert.equal(record.nextRevision, MISMATCH_DISPOSITION_RUNTIME_REVISION);
      assert.equal(record.nextGeneration, 75);
      assert.deepEqual(record.priorHealthyProof, prior);
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "waiting");
      assert.equal(fixture.patches(), 2);
    } finally {
      await fixture.close();
    }
    const retryFailed = {
      ...installed,
      hostedRuntimes: [{
        ...installed.hostedRuntimes[0],
        lastExecutionProof: failedProof(
          MISMATCH_DISPOSITION_RUNTIME_REVISION,
          75,
          203,
        ),
      }],
    };
    const rollbackFixture = await concurrencyInstallerFixture(
      retryFailed,
      undefined,
      MISMATCH_DISPOSITION_RUNTIME_REVISION,
    );
    try {
      assert.equal(await rollbackFixture.run(), 0);
      assert.equal(rollbackFixture.reports.at(-1)?.status, "rolled_back");
      const restored = await rollbackFixture.read();
      if (!restored.ok || restored.value.status !== "found") {
        throw new Error("missing retry rollback76");
      }
      assert.equal(
        restored.value.snapshot.hostedRuntimes[0].activeRevision,
        STACKED_MERGE_RUNTIME_REVISION,
      );
      assert.equal(restored.value.snapshot.hostedRuntimes[0].generation, 76);
      assert.deepEqual(
        restored.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        prior,
      );
      assert.equal(await rollbackFixture.run(), 0);
      assert.equal(rollbackFixture.reports.at(-1)?.status, "no_change");
      assert.equal(rollbackFixture.patches(), 1);
      assert.ok(
        !rollbackFixture.requests.some((request) =>
          request.path.includes("/compare/") ||
          request.path.includes("/check-runs")
        ),
      );
    } finally {
      await rollbackFixture.close();
    }
  },
);

Deno.test(
  "owner install runtime75: real rollback74 bootstrap authorizes the exact retry with its settled prior proof",
  async () => {
    const rollbackFixture = await concurrencyInstallerFixture(
      failedEarlyFrame(false),
      undefined,
      MISMATCH_DISPOSITION_RUNTIME_REVISION,
    );
    let restored: ReleaseStateSnapshotV1;
    try {
      assert.equal(await rollbackFixture.run(), 0);
      assert.equal(rollbackFixture.reports.at(-1)?.status, "rolled_back");
      const read = await rollbackFixture.read();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing real rollback74");
      }
      restored = read.value.snapshot;
    } finally {
      await rollbackFixture.close();
    }
    const rig = await makeRig();
    let settled: ReleaseStateSnapshotV1;
    let now: number;
    try {
      // The installer fixture keeps a release tree at the repair ref; this
      // real supervisor rig supplies a genuinely absent repair source.
      await rig.seedCapturedRelease({
        ...restored,
        stateHead: null,
        sequence: 1,
      });
      rig.clock.advance(NOW + 1 - rig.clock.now());
      rig.evidence.revisions.add(LAUNCHER);
      rig.evidence.revisions.add(STACKED_MERGE_RUNTIME_REVISION);
      const identity = { runId: 204, runAttempt: 1, launcherSha: LAUNCHER };
      const bootstrap = requireRun(await rig.prepare(identity));
      assert.equal(bootstrap.purpose, "bootstrap");
      assert.equal(bootstrap.revision, STACKED_MERGE_RUNTIME_REVISION);
      assert.equal(bootstrap.generation, 74);
      const prior = runProof(bootstrap, "healthy");
      rig.evidence.settlements.set(bootstrap.id, prior);
      rig.clock.advance(3_000);
      assert.equal((await rig.finalize(identity)).status, "idle");
      settled = await rig.snapshot();
      now = rig.clock.now();
      const runtime = settled.hostedRuntimes[0];
      assert.deepEqual(runtime.lastHealthyProof, prior);
      assert.deepEqual(runtime.lastExecutionProof, prior);
    } finally {
      await rig.cleanup();
    }
    const fixture = await concurrencyInstallerFixture(
      settled,
      undefined,
      MISMATCH_DISPOSITION_RUNTIME_REVISION,
    );
    let failedBootstrapRetry: ReleaseStateSnapshotV1;
    try {
      const prior = settled.hostedRuntimes[0].lastHealthyProof;
      fixture.setNow(now);
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "installed");
      assert.equal(fixture.patches(), 1);
      const retry = await fixture.read();
      if (!retry.ok || retry.value.status !== "found") {
        throw new Error("missing bootstrapped retry75");
      }
      assert.equal(
        retry.value.snapshot.hostedRuntimes[0].activeRevision,
        MISMATCH_DISPOSITION_RUNTIME_REVISION,
      );
      assert.equal(retry.value.snapshot.hostedRuntimes[0].generation, 75);
      assert.deepEqual(
        retry.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        prior,
      );
      const record = JSON.parse(
        (await fixture.message()).trim().split("\n").at(-1)!,
      );
      assert.equal(record.stateHead, fixture.beforeHead);
      assert.deepEqual(record.priorHealthyProof, prior);
      const failed = {
        ...retry.value.snapshot,
        hostedRuntimes: [{
          ...retry.value.snapshot.hostedRuntimes[0],
          lastExecutionProof: failedProof(
            MISMATCH_DISPOSITION_RUNTIME_REVISION,
            75,
            205,
          ),
        }],
      };
      failedBootstrapRetry = failed;
      const rollback = planOwnerDevelopmentInstall(failed, now + 1);
      assert.equal(rollback.status, "rollback");
      if (rollback.status !== "rollback") {
        throw new Error("expected saved bootstrap rollback");
      }
      assert.equal(rollback.move.nextRevision, STACKED_MERGE_RUNTIME_REVISION);
      assert.equal(rollback.move.nextGeneration, 76);
      assert.deepEqual(rollback.move.priorHealthyProof, prior);
    } finally {
      await fixture.close();
    }
    const retryRollbackFixture = await concurrencyInstallerFixture(
      failedBootstrapRetry,
      undefined,
      MISMATCH_DISPOSITION_RUNTIME_REVISION,
    );
    try {
      retryRollbackFixture.setNow(now + 1);
      assert.equal(await retryRollbackFixture.run(), 0);
      assert.equal(retryRollbackFixture.reports.at(-1)?.status, "rolled_back");
      const read = await retryRollbackFixture.read();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing bootstrapped retry rollback76");
      }
      assert.equal(
        read.value.snapshot.hostedRuntimes[0].activeRevision,
        STACKED_MERGE_RUNTIME_REVISION,
      );
      assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 76);
      assert.deepEqual(
        read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        settled.hostedRuntimes[0].lastHealthyProof,
      );
      assert.equal(await retryRollbackFixture.run(), 0);
      assert.equal(retryRollbackFixture.reports.at(-1)?.status, "no_change");
      assert.equal(retryRollbackFixture.patches(), 1);
    } finally {
      await retryRollbackFixture.close();
    }
  },
);

Deno.test(
  "owner install runtime75: retry refuses unavailable, wrong and foreign prior or producer proofs",
  () => {
    const restored = restoredEarlyFrame();
    const runtime = restored.hostedRuntimes[0];
    for (
      const proof of [
        null,
        healthyProof(UNRELATED, 72),
        healthyProof(STACKED_MERGE_RUNTIME_REVISION, 71),
        healthyProof(STACKED_MERGE_RUNTIME_REVISION, 74),
        healthyProof(EARLY_FRAME_RUNTIME_REVISION, 73),
        healthyProof(MISMATCH_DISPOSITION_RUNTIME_REVISION, 74),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall({
          ...restored,
          hostedRuntimes: [{ ...runtime, lastHealthyProof: proof }],
        }, NOW + 2).status,
        "waiting",
      );
    }
    const bootstrap = hostedProof({
      runId: 206,
      purpose: "bootstrap",
      releaseId: null,
      revision: STACKED_MERGE_RUNTIME_REVISION,
      generation: 74,
      outcome: "healthy",
    });
    for (
      const settlement of [
        null,
        runtime.lastExecutionProof,
        { ...bootstrap, jobId: bootstrap.jobId + 1 },
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall({
          ...restored,
          hostedRuntimes: [{
            ...runtime,
            lastHealthyProof: bootstrap,
            lastExecutionProof: settlement,
          }],
        }, NOW + 2).status,
        "waiting",
      );
    }
    for (
      const proof of [
        null,
        failedProof(UNRELATED, 73),
        failedProof(EARLY_FRAME_RUNTIME_REVISION, 72),
        healthyProof(EARLY_FRAME_RUNTIME_REVISION, 73),
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall({
          ...restored,
          hostedRuntimes: [{ ...runtime, lastExecutionProof: proof }],
        }, NOW + 2).status,
        "waiting",
      );
    }
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: UNRELATED,
            generation: 74,
            healthyProof: runtime.lastHealthyProof,
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    const stabilizationInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MISMATCH_DISPOSITION_RUNTIME_REVISION,
          generation: 74,
          healthyProof: healthyProof(
            MISMATCH_DISPOSITION_RUNTIME_REVISION,
            74,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(stabilizationInstall.status, "install");
    if (stabilizationInstall.status !== "install") {
      throw new Error("expected stabilization install");
    }
    assert.equal(
      stabilizationInstall.move.nextRevision,
      // The installed generation-75 revision, spelled out so a pin edit
      // cannot silently move the expectation with it.
      "da9d6b437b6cb2725deed081b50778b7dc46a9a5",
    );
    assert.equal(stabilizationInstall.move.nextGeneration, 75);
  },
);

/** Keep explicit policy/refusal inputs; only historical omissions use fixture policy. */
function planOwnerDevelopmentInstall(
  ...args: Parameters<typeof productionPlanOwnerDevelopmentInstall>
): ReturnType<typeof productionPlanOwnerDevelopmentInstall> {
  return productionPlanOwnerDevelopmentInstall(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.queue : args[4],
    args[5] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.custody : args[5],
    args[6] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.rollout : args[6],
    args[7],
    args[8],
  );
}

/** Snapshot validation uses the same historical policy as its real planner. */
function buildOwnerDevelopmentInstallSnapshot(
  ...args: Parameters<typeof productionBuildOwnerDevelopmentInstallSnapshot>
): ReturnType<typeof productionBuildOwnerDevelopmentInstallSnapshot> {
  return productionBuildOwnerDevelopmentInstallSnapshot(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.queue : args[6],
    args[7] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.custody : args[7],
    args[8],
    args[9] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.rollout : args[9],
    args[10],
  );
}
