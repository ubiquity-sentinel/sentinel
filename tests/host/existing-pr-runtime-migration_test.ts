import { DORMANT_HOSTED_SUPERVISOR_POLICY as dormant } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { runOwnerDevelopmentInstallMain } from "../../src/host/owner-install-run.ts";
import { planOwnerDevelopmentInstall } from "../../src/host/owner-install-plan.ts";
import { buildOwnerDevelopmentInstallSnapshot } from "../../src/host/owner-install-snapshot.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";
import { NOW } from "./owner-install-fixture-constants.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import {
  installNativeWriterFixture,
  retainedRepairHistory,
} from "./existing-pr-runtime-fixtures.ts";
const historicalPolicy = {
  queueRuntimeCapability: dormant.queue,
  existingPrRuntimeCapability: dormant.custody,
  rollout: dormant.rollout,
};
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
  custodyActivated: true,
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

Deno.test("existing PR runtime migration: old queued writer blocks, same-source dispatch permits exact drained install", async () => {
  const fixture = await concurrencyInstallerFixture(
    source(),
    undefined,
    NEXT,
    retainedRepairHistory(),
  );
  const native = await installNativeWriterFixture();
  try {
    const beforeRepair = await fixture.readRepair();
    native.peers.push({
      ...native.nativeRun,
      id: 701,
      status: "queued",
      head_sha: OTHER,
    });
    await runOwnerDevelopmentInstallMain({
      ...historicalPolicy,
      existingPrRuntimeCapability: capability,
    });
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(fixture.patches(), 0);
    native.peers[0].head_sha = native.run.launcherSha;
    await runOwnerDevelopmentInstallMain({
      ...historicalPolicy,
      existingPrRuntimeCapability: capability,
    });
    assert.equal(
      fixture.reports.at(-1)?.status,
      "installed",
      JSON.stringify(fixture.reports.at(-1)),
    );
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(read.value.snapshot.hostedRuntimes[0].activeRevision, NEXT);
    assert.deepEqual(
      read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
      source().hostedRuntimes[0].lastHealthyProof,
    );
    assert.deepEqual(await fixture.readRepair(), beforeRepair);
    await runOwnerDevelopmentInstallMain({
      ...historicalPolicy,
      existingPrRuntimeCapability: capability,
    });
    assert.equal(
      fixture.patches(),
      1,
      "settled pointer cannot replay migration",
    );
  } finally {
    native.close();
    await fixture.close();
  }
});

Deno.test("existing PR runtime migration: actual installer preserves CI ancestry and compare-and-swap refusal", async (t) => {
  for (const refusal of ["ci", "ancestry", "parent"] as const) {
    await t.step(refusal, async () => {
      const fixture = await concurrencyInstallerFixture(
        source(),
        refusal,
        NEXT,
        retainedRepairHistory(),
      );
      const native = await installNativeWriterFixture();
      try {
        await runOwnerDevelopmentInstallMain({
          ...historicalPolicy,
          existingPrRuntimeCapability: capability,
        });
        assert.notEqual(fixture.reports.at(-1)?.status, "installed");
        assert.ok(
          fixture.requests.some((request) =>
            request.path.includes("/compare/")
          ),
          "real CI/ancestry boundary reached",
        );
        if (refusal === "ci") {
          assert.ok(
            fixture.requests.some((request) =>
              request.path.includes("/check-runs")
            ),
          );
        }
        assert.equal(fixture.patches(), 0);
      } finally {
        native.close();
        await fixture.close();
      }
    });
  }
});

Deno.test("existing PR runtime migration: direct builder and rollback cannot turn migration into old-runtime authority", () => {
  const before = source();
  const plan = planOwnerDevelopmentInstall(
    before,
    NOW,
    undefined,
    undefined,
    dormant.queue,
    dormant.custody,
    dormant.rollout,
  );
  assert.ok(plan.status === "install");
  for (
    const bad of [
      { ...capability, ownerInstallMigrations: [] },
      {
        ...capability,
        ownerInstallMigrations: [{ ...migration, fromGeneration: 78 }],
      },
      { ...capability, revisions: [] },
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        before,
        NOW,
        undefined,
        undefined,
        dormant.queue,
        bad,
        dormant.rollout,
      ).status,
      "waiting",
    );
    assert.throws(() =>
      buildOwnerDevelopmentInstallSnapshot(
        before,
        OTHER,
        plan.move,
        NOW,
        undefined,
        undefined,
        dormant.queue,
        bad,
        undefined,
        dormant.rollout,
      )
    );
  }
  assert.equal(
    planOwnerDevelopmentInstall(
      source(true),
      NOW,
      undefined,
      undefined,
      dormant.queue,
      capability,
      dormant.rollout,
    ).status,
    "waiting",
  );
  assert.equal(
    planOwnerDevelopmentInstall(
      before,
      NOW,
      undefined,
      undefined,
      {
        proofActivated: true,
        revisions: [],
      },
      capability,
      dormant.rollout,
    ).status,
    "waiting",
  );
});

Deno.test("existing PR runtime migration: writer appearing after CI is refused at the final publication boundary", async () => {
  const fixture = await concurrencyInstallerFixture(
    source(),
    undefined,
    NEXT,
    retainedRepairHistory(),
  );
  const native = await installNativeWriterFixture();
  const fetch = globalThis.fetch;
  try {
    const repairBefore = await fixture.readRepair();
    globalThis.fetch = async (request, init) => {
      const response = await fetch(request, init);
      const path =
        new URL(request instanceof Request ? request.url : String(request))
          .pathname;
      if (init?.method === "POST" && path.endsWith("/git/commits")) {
        native.peers.push({
          ...native.nativeRun,
          id: 701,
          status: "queued",
          head_sha: OTHER,
        });
      }
      return response;
    };
    await runOwnerDevelopmentInstallMain({
      ...historicalPolicy,
      existingPrRuntimeCapability: capability,
    });
    assert.equal(fixture.patches(), 0);
    assert.equal(await fixture.head(), fixture.beforeHead);
    assert.deepEqual(await fixture.readRepair(), repairBefore);
    assert.ok(
      fixture.requests.some((request) =>
        request.method === "POST" && request.path.endsWith("/git/commits")
      ),
    );
    assert.equal(fixture.reports.at(-1)?.status, "failed");
  } finally {
    globalThis.fetch = fetch;
    native.close();
    await fixture.close();
  }
});
