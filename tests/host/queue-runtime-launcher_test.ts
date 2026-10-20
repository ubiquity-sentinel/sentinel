import { DORMANT_HOSTED_SUPERVISOR_POLICY as dormant } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { runHostedRuntimeLauncher } from "../../src/host/hosted-runtime-launcher.ts";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import { buildOwnerDevelopmentInstallSnapshot } from "../../src/host/owner-install-snapshot.ts";
import { QUEUE_RUNTIME_CAPABILITY_REFUSED } from "../../src/host/queue-runtime-capability.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";
import { NOW } from "./owner-install-fixture-constants.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import {
  childLine,
  exited,
  makeRig,
  OTHER_REVISION,
  seedRelease,
} from "./hosted-runtime-fixture.ts";

// Existing exact rungs are reused only to test policy enforcement. No production
// capability pin is inferred from their healthy proofs or these fixture grants.
const historicalPolicy = {
  queueRuntimeCapability: dormant.queue,
  existingPrRuntimeCapability: dormant.custody,
  rollout: dormant.rollout,
};
const P79 = "549c7a69186b3d2070aa4e69c92ee846d183ce8f" as GitSha;
const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
const policy = (revisions: readonly GitSha[]) => ({
  proofActivated: true,
  revisions,
});

function ownerSnapshot(rollback: boolean) {
  const prior = healthyProof(P79, 79, 501);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: rollback ? R80 : P79,
      generation: rollback ? 80 : 79,
      healthyProof: prior,
      executionProof: rollback ? failedProof(R80, 80) : prior,
    }),
  });
}

Deno.test("queue runtime capability: production owner install and rollback reject either unaccepted side", async (t) => {
  for (const rollback of [false, true]) {
    for (const revisions of [[P79], [R80], []]) {
      await t.step(
        `${rollback ? "rollback" : "install"}/${revisions.join()}`,
        async () => {
          const source = ownerSnapshot(rollback);
          const fixture = await concurrencyInstallerFixture(
            source,
            undefined,
            R80,
          );
          try {
            const beforeRepair = await fixture.readRepair();
            assert.equal(
              await runOwnerDevelopmentInstallMain({
                ...historicalPolicy,
                queueRuntimeCapability: policy(revisions),
              }),
              0,
            );
            assert.equal(fixture.reports.at(-1)?.status, "waiting");
            assert.equal(
              fixture.reports.at(-1)?.detail,
              QUEUE_RUNTIME_CAPABILITY_REFUSED,
            );
            assert.equal(fixture.patches(), 0);
            assert.equal(await fixture.head(), fixture.beforeHead);
            assert.deepEqual(await fixture.readRepair(), beforeRepair);
            assert.ok(
              fixture.requests.every((request) => request.method === "GET"),
            );
          } finally {
            await fixture.close();
          }
        },
      );
    }
  }
});

Deno.test("queue runtime capability: production owner install retains existing exact CI and CAS gates", async (t) => {
  for (const refusal of [undefined, "ci", "parent"] as const) {
    await t.step(refusal ?? "accepted", async () => {
      const fixture = await concurrencyInstallerFixture(
        ownerSnapshot(false),
        refusal,
        R80,
      );
      try {
        assert.equal(
          await runOwnerDevelopmentInstallMain({
            ...historicalPolicy,
            queueRuntimeCapability: policy([P79, R80]),
          }),
          0,
        );
        if (refusal === undefined) {
          assert.equal(fixture.reports.at(-1)?.status, "installed");
          assert.equal(fixture.patches(), 1);
          const read = await fixture.read();
          assert.ok(read.ok && read.value.status === "found");
          assert.equal(
            read.value.snapshot.hostedRuntimes[0].activeRevision,
            R80,
          );
          assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 80);
        } else {
          assert.notEqual(fixture.reports.at(-1)?.status, "installed");
          assert.equal(fixture.patches(), 0);
          if (refusal === "parent") {
            assert.notEqual(await fixture.head(), fixture.beforeHead);
          } else assert.equal(await fixture.head(), fixture.beforeHead);
        }
      } finally {
        await fixture.close();
      }
    });
  }
});

Deno.test("queue runtime capability: owner snapshot builder cannot bypass the planner or turn a migration into an old-runtime grant", () => {
  const source = ownerSnapshot(false);
  const plan = planOwnerDevelopmentInstall(
    source,
    NOW,
    undefined,
    undefined,
    dormant.queue,
    dormant.custody,
    dormant.rollout,
  );
  assert.equal(plan.status, "install");
  assert.ok(plan.status === "install");
  const head = "a".repeat(40) as GitSha;
  assert.throws(() =>
    buildOwnerDevelopmentInstallSnapshot(
      source,
      head,
      plan.move,
      NOW,
      undefined,
      undefined,
      policy([R80]),
      dormant.custody,
      undefined,
      dormant.rollout,
    )
  );
  assert.equal(
    planOwnerDevelopmentInstall(
      source,
      NOW,
      undefined,
      undefined,
      policy([R80]),
      dormant.custody,
      dormant.rollout,
    ).status,
    "waiting",
  );
  const allowed = buildOwnerDevelopmentInstallSnapshot(
    source,
    head,
    plan.move,
    NOW,
    undefined,
    undefined,
    policy([P79, R80]),
    dormant.custody,
    undefined,
    dormant.rollout,
  );
  assert.equal(allowed.hostedRuntimes[0].activeRevision, R80);
  assert.deepEqual(
    allowed.hostedRuntimes[0].lastHealthyProof,
    source.hostedRuntimes[0].lastHealthyProof,
  );
});

Deno.test("queue runtime admission: exact saved ordinary execution ignores retired queue floors", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    const before = await rig.release.readRelease();
    rig.process.child = exited(childLine(rig.execution));
    const result = await runHostedRuntimeLauncher(
      {
        state: rig.release,
        clock: rig.clock,
        env: rig.env,
        launcherDir: rig.launcherDir,
        runtimeDir: rig.runtimeDir,
        denoExecutable: Deno.execPath(),
        process: rig.process,
      },
      policy([OTHER_REVISION]),
      dormant.custody,
    );
    assert.equal(result.status, "healthy", JSON.stringify(result));
    assert.equal(rig.process.childCalls().length, 1);
    assert.deepEqual(result.terminal?.execution, rig.execution);
    assert.deepEqual(await rig.release.readRelease(), before);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("queue runtime capability: exact accepted runtime runs from a different launcher SHA", async () => {
  const rig = await makeRig();
  try {
    await seedRelease(rig);
    assert.notEqual(rig.identity.launcherSha, rig.execution.revision);
    rig.process.child = exited(childLine(rig.execution));
    const result = await runHostedRuntimeLauncher(
      {
        state: rig.release,
        clock: rig.clock,
        env: rig.env,
        launcherDir: rig.launcherDir,
        runtimeDir: rig.runtimeDir,
        denoExecutable: Deno.execPath(),
        process: rig.process,
      },
      policy([rig.execution.revision]),
      dormant.custody,
    );
    assert.equal(result.status, "healthy");
    assert.equal(rig.process.childCalls().length, 1);
    assert.equal(result.terminal?.execution.revision, rig.execution.revision);
  } finally {
    await rig.cleanup();
  }
});
