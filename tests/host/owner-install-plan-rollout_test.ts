import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import {
  parseHostedRuntimeRollout,
} from "../../src/host/hosted-runtime-rollout.ts";
import type { QueueRuntimeCapability } from "../../src/host/queue-runtime-capability.ts";
import type { ExistingPrRuntimeCapability } from "../../src/host/existing-pr-runtime-capability.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";
import { NOW } from "./owner-install-fixture-constants.ts";
import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import {
  installNativeWriterFixture,
  retainedRepairHistory,
} from "./existing-pr-runtime-fixtures.ts";

const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
const PRIOR = "da98f5f49c45b57cfa97a45fe647c36b1021f302" as GitSha;
const NEXT = "f".repeat(40) as GitSha;
const THIRD = "e".repeat(40) as GitSha;
const rung = {
  fromRevision: PRIOR,
  fromGeneration: 81,
  toRevision: NEXT,
  toGeneration: 82,
  rollbackToPrior: false,
};
const rollout = (rollbackToPrior = false, successor = false) =>
  parseHostedRuntimeRollout({
    ...DORMANT_HOSTED_SUPERVISOR_POLICY.rollout,
    installs: [
      { ...rung, rollbackToPrior },
      ...(successor
        ? [{
          fromRevision: NEXT,
          fromGeneration: 82,
          toRevision: THIRD,
          toGeneration: 83,
          rollbackToPrior: false,
        }]
        : []),
    ],
  });

function source(
  revision = PRIOR,
  generation = 81,
  health = healthyProof(revision, generation, 501),
  failed = false,
) {
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision,
      generation,
      healthyProof: health,
      executionProof: failed ? failedProof(revision, generation) : health,
    }),
  });
}

function plan(
  snapshot = source(),
  pins = rollout(),
  queue: QueueRuntimeCapability = DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
  custody: ExistingPrRuntimeCapability =
    DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
) {
  return planOwnerDevelopmentInstall(
    snapshot,
    NOW,
    undefined,
    undefined,
    queue,
    custody,
    pins,
  );
}

Deno.test("future install: exact healthy predecessor, own candidate health, explicit successor and terminal restore", () => {
  const first = plan();
  assert.equal(first.status, "install");
  assert.ok(first.status === "install");
  assert.equal(first.move.nextRevision, NEXT);
  assert.equal(first.move.nextGeneration, 82);
  assert.equal(
    plan(source(PRIOR, 81, healthyProof(PRIOR, 80))).status,
    "waiting",
  );
  assert.equal(
    plan(source(PRIOR, 81, healthyProof(PRIOR, 81), true)).status,
    "waiting",
  );
  assert.equal(
    plan(source(NEXT, 82, healthyProof(PRIOR, 81))).status,
    "waiting",
  );
  assert.equal(plan(source(NEXT, 82)).status, "no_change");
  const successor = plan(source(NEXT, 82), rollout(false, true));
  assert.equal(successor.status, "install");
  assert.ok(successor.status === "install");
  assert.equal(successor.move.nextRevision, THIRD);
  assert.equal(successor.move.nextGeneration, 83);
  assert.equal(
    plan(source(PRIOR, 83, healthyProof(PRIOR, 81)), rollout(true)).status,
    "waiting",
  );
  assert.equal(plan(source(PRIOR, 83), rollout(true)).status, "no_change");
});

Deno.test("future install: failure rollback needs explicit grant, retained exact proof and both floors", () => {
  const failed = source(NEXT, 82, healthyProof(PRIOR, 81), true);
  assert.equal(plan(failed).status, "waiting");
  assert.equal(plan(failed, rollout(false, true)).status, "waiting");
  const restored = plan(failed, rollout(true));
  assert.equal(restored.status, "rollback");
  assert.ok(restored.status === "rollback");
  assert.equal(restored.move.nextRevision, PRIOR);
  assert.equal(restored.move.nextGeneration, 83);
  assert.equal(
    plan(source(NEXT, 82, healthyProof(NEXT, 82), true), rollout(true)).status,
    "waiting",
  );
  for (const revisions of [[NEXT], [PRIOR], []]) {
    assert.equal(
      plan(failed, rollout(true), {
        proofActivated: true,
        revisions,
      }).status,
      "waiting",
    );
    assert.equal(
      plan(failed, rollout(true), undefined, {
        custodyActivated: true,
        revisions,
      }).status,
      "waiting",
    );
  }
  assert.equal(
    plan(failed, rollout(true), {
      proofActivated: true,
      revisions: [NEXT, PRIOR],
    }, {
      custodyActivated: true,
      revisions: [NEXT, PRIOR],
    }).status,
    "rollback",
  );
  const historical = source(PRIOR, 81, healthyProof(R80, 80), true);
  const oldRollback = plan(historical);
  assert.equal(oldRollback.status, "rollback");
  assert.ok(oldRollback.status === "rollback");
  assert.equal(oldRollback.move.nextRevision, R80);
  assert.equal(
    plan(historical, rollout(), {
      proofActivated: true,
      revisions: [NEXT],
    }).status,
    "waiting",
  );
});

Deno.test("future install: real installer retains exact CI, ancestry and expected-head publication gates", async (t) => {
  for (const refusal of [undefined, "ci", "ancestry", "parent"] as const) {
    await t.step(refusal ?? "install", async () => {
      const fixture = await concurrencyInstallerFixture(
        source(),
        refusal,
        NEXT,
      );
      try {
        const beforeRepair = await fixture.readRepair();
        assert.equal(
          await runOwnerDevelopmentInstallMain({
            queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
            existingPrRuntimeCapability:
              DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
            rollout: rollout(),
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
            NEXT,
          );
          assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 82);
          assert.deepEqual(
            read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
            source().hostedRuntimes[0].lastHealthyProof,
          );
          await runOwnerDevelopmentInstallMain({
            queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
            existingPrRuntimeCapability:
              DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
            rollout: rollout(),
          });
          assert.equal(fixture.reports.at(-1)?.status, "waiting");
          assert.equal(fixture.patches(), 1);
        } else {
          assert.notEqual(fixture.reports.at(-1)?.status, "installed");
          assert.equal(fixture.patches(), 0);
          if (refusal !== "parent") {
            assert.equal(await fixture.head(), fixture.beforeHead);
          }
        }
        assert.deepEqual(await fixture.readRepair(), beforeRepair);
      } finally {
        await fixture.close();
      }
    });
  }
});

Deno.test("future install: native drain and independent migration floors still gate real publication", async () => {
  const fixture = await concurrencyInstallerFixture(
    source(),
    undefined,
    NEXT,
    retainedRepairHistory(),
  );
  const native = await installNativeWriterFixture();
  const migration = {
    fromRevision: PRIOR,
    fromGeneration: 81,
    toRevision: NEXT,
    toGeneration: 82,
  };
  const input = {
    rollout: rollout(),
    queueRuntimeCapability: {
      proofActivated: true,
      revisions: [NEXT],
      ownerInstallMigrations: [migration],
    },
    existingPrRuntimeCapability: {
      custodyActivated: true,
      revisions: [NEXT],
      ownerInstallMigrations: [migration],
    },
  };
  try {
    const beforeRepair = await fixture.readRepair();
    native.peers.push({
      ...native.nativeRun,
      id: 701,
      status: "queued",
      head_sha: THIRD,
    });
    await runOwnerDevelopmentInstallMain(input);
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(fixture.patches(), 0);
    native.peers[0].head_sha = native.run.launcherSha;
    await runOwnerDevelopmentInstallMain(input);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    assert.deepEqual(await fixture.readRepair(), beforeRepair);
  } finally {
    native.close();
    await fixture.close();
  }
});

Deno.test("future install: production rollback cannot bypass explicit opt-in", async (t) => {
  for (const allowed of [false, true]) {
    await t.step(String(allowed), async () => {
      const fixture = await concurrencyInstallerFixture(
        source(NEXT, 82, healthyProof(PRIOR, 81), true),
        undefined,
        PRIOR,
      );
      try {
        await runOwnerDevelopmentInstallMain({
          queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
          existingPrRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
          rollout: rollout(allowed),
        });
        assert.equal(
          fixture.reports.at(-1)?.status,
          allowed ? "rolled_back" : "waiting",
        );
        assert.equal(fixture.patches(), allowed ? 1 : 0);
        if (allowed) {
          const read = await fixture.read();
          assert.ok(read.ok && read.value.status === "found");
          assert.equal(
            read.value.snapshot.hostedRuntimes[0].activeRevision,
            PRIOR,
          );
          assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 83);
          await runOwnerDevelopmentInstallMain({
            queueRuntimeCapability: DORMANT_HOSTED_SUPERVISOR_POLICY.queue,
            existingPrRuntimeCapability:
              DORMANT_HOSTED_SUPERVISOR_POLICY.custody,
            rollout: rollout(allowed),
          });
          assert.equal(fixture.patches(), 1);
        }
      } finally {
        await fixture.close();
      }
    });
  }
});
