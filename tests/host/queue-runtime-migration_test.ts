import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import { buildOwnerDevelopmentInstallSnapshot } from "../../src/host/owner-install-snapshot.ts";
import {
  allowsQueueRuntime,
  allowsQueueRuntimeMove,
  QUEUE_RUNTIME_CAPABILITY_REFUSED,
} from "../../src/host/queue-runtime-capability.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";
import { NOW } from "./owner-install-fixture-constants.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";

// Exercise an existing fixed rung; these fixture grants make no production claim.
const PRIOR = "549c7a69186b3d2070aa4e69c92ee846d183ce8f" as GitSha;
const NEXT = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
const OTHER = "f".repeat(40) as GitSha;
const migration = {
  fromRevision: PRIOR,
  fromGeneration: 79,
  toRevision: NEXT,
  toGeneration: 80,
};
const capability = {
  proofActivated: true,
  revisions: [NEXT],
  ownerInstallMigrations: [migration],
};

function source(rollback = false) {
  const prior = healthyProof(PRIOR, 79, 501);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: rollback ? NEXT : PRIOR,
      generation: rollback ? 80 : 79,
      healthyProof: prior,
      executionProof: rollback ? failedProof(NEXT, 80) : prior,
    }),
  });
}

Deno.test("queue runtime migration: exact owner tuple installs without granting old execution or rollback", async () => {
  const before = source();
  const fixture = await concurrencyInstallerFixture(before, undefined, NEXT);
  try {
    const repairBefore = await fixture.readRepair();
    assert.equal(
      await runOwnerDevelopmentInstallMain({
        existingPrRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
        rollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
        queueRuntimeCapability: capability,
      }),
      0,
    );
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(read.value.snapshot.hostedRuntimes[0].activeRevision, NEXT);
    assert.deepEqual(
      read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
      before.hostedRuntimes[0].lastHealthyProof,
    );
    assert.deepEqual(await fixture.readRepair(), repairBefore);
    assert.equal(allowsQueueRuntime(PRIOR, capability), false);
    assert.equal(allowsQueueRuntimeMove(PRIOR, NEXT, capability), false);
    assert.equal(allowsQueueRuntimeMove(NEXT, PRIOR, capability), false);
  } finally {
    await fixture.close();
  }
  const failed = await concurrencyInstallerFixture(
    source(true),
    undefined,
    NEXT,
  );
  try {
    assert.equal(
      await runOwnerDevelopmentInstallMain({
        existingPrRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
        rollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
        queueRuntimeCapability: capability,
      }),
      0,
    );
    assert.equal(failed.reports.at(-1)?.status, "waiting");
    assert.equal(
      failed.reports.at(-1)?.detail,
      QUEUE_RUNTIME_CAPABILITY_REFUSED,
    );
    assert.equal(failed.patches(), 0);
    assert.equal(await failed.head(), failed.beforeHead);
  } finally {
    await failed.close();
  }
});

Deno.test("queue runtime migration: every tuple mismatch and unaccepted destination refuses", async (t) => {
  const cases = [
    { ...migration, fromRevision: OTHER },
    { ...migration, fromGeneration: 78 },
    { ...migration, toRevision: OTHER },
    { ...migration, toGeneration: 81 },
    { ...migration, fromGeneration: Number.NaN },
  ];
  for (let index = 0; index <= cases.length; index++) {
    await t.step(String(index), async () => {
      const policy = {
        ...capability,
        revisions: index === cases.length ? [] : [NEXT],
        ownerInstallMigrations: [cases[index] ?? migration],
      };
      const before = source();
      const fixture = await concurrencyInstallerFixture(
        before,
        undefined,
        NEXT,
      );
      try {
        assert.equal(
          await runOwnerDevelopmentInstallMain({
            existingPrRuntimeCapability:
              DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
            rollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
            queueRuntimeCapability: policy,
          }),
          0,
        );
        assert.equal(fixture.reports.at(-1)?.status, "waiting");
        assert.equal(fixture.patches(), 0);
        assert.equal(await fixture.head(), fixture.beforeHead);
        const plan = planOwnerDevelopmentInstall(
          before,
          NOW,
          undefined,
          undefined,
          DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
          DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
          DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
        );
        assert.ok(plan.status === "install");
        assert.throws(() =>
          buildOwnerDevelopmentInstallSnapshot(
            before,
            fixture.beforeHead as GitSha,
            plan.move,
            NOW,
            undefined,
            undefined,
            policy,
            DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
            undefined,
            DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
          )
        );
      } finally {
        await fixture.close();
      }
    });
  }
});

Deno.test("queue runtime migration: exact tuple still requires native CI ancestry and unchanged parent", async (t) => {
  for (const refusal of ["ci", "ancestry", "parent"] as const) {
    await t.step(refusal, async () => {
      const fixture = await concurrencyInstallerFixture(
        source(),
        refusal,
        NEXT,
      );
      try {
        assert.equal(
          await runOwnerDevelopmentInstallMain({
            existingPrRuntimeCapability:
              DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
            rollout: DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
            queueRuntimeCapability: capability,
          }),
          0,
        );
        assert.notEqual(fixture.reports.at(-1)?.status, "installed");
        assert.equal(fixture.patches(), 0);
        if (refusal !== "parent") {
          assert.equal(await fixture.head(), fixture.beforeHead);
        }
      } finally {
        await fixture.close();
      }
    });
  }
});
