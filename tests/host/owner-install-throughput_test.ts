import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { NOW, UNRELATED } from "./owner-install-fixture-constants.ts";
import {
  executionIntent,
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";

// Fixed literals let the unchanged source fail semantically before new exports exist.
const R2 = "da9d6b437b6cb2725deed081b50778b7dc46a9a5" as GitSha;
const R3 = "41bb853a1bedfc0422bf903dfabbe23bf714b44f" as GitSha;
const OLD = "4baeaf67d9677a317bc37831486c075b143fe68f" as GitSha;

function healthyPrior(): ReleaseStateSnapshotV1 {
  const proof = healthyProof(R2, 75, 401);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: R2,
      generation: 75,
      healthyProof: proof,
      executionProof: proof,
    }),
  });
}

Deno.test("owner install throughput: exact healthy75 installs R3 through the production entrypoint", async () => {
  const source = healthyPrior();
  const fixture = await concurrencyInstallerFixture(source, undefined, R3);
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, R3);
    assert.equal(runtime.generation, 76);
    assert.deepEqual(
      runtime.lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    const move = JSON.parse(
      (await fixture.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(move.priorRevision, R2);
    assert.equal(move.priorGeneration, 75);
    assert.equal(move.nextRevision, R3);
    assert.equal(move.nextGeneration, 76);
    assert.equal(move.stateHead, fixture.beforeHead);
    fixture.setNow(NOW + 1);
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(fixture.patches(), 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("owner install throughput: missing, old or active prior proof cannot install R3", async (t) => {
  const source = healthyPrior(), runtime = source.hostedRuntimes[0];
  const cases = [
    ["missing healthy75", { ...runtime, lastHealthyProof: null }],
    ["wrong healthy revision", {
      ...runtime,
      lastHealthyProof: healthyProof(UNRELATED, 75),
    }],
    ["old generation74 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(OLD, 74),
    }],
    ["wrong generation of R2 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(R2, 74),
    }],
    ["active R2 execution", { ...runtime, execution: executionIntent(R2, 75) }],
    ["latest R2 failed without retained74", {
      ...runtime,
      lastExecutionProof: failedProof(R2, 75),
    }],
    [
      "failed R3 without retained75",
      runtimeRecord({
        revision: R3,
        generation: 76,
        executionProof: failedProof(R3, 76),
      }),
    ],
    [
      "failed R3 with old74 only",
      runtimeRecord({
        revision: R3,
        generation: 76,
        healthyProof: healthyProof(OLD, 74),
        executionProof: failedProof(R3, 76),
      }),
    ],
  ] as const;
  for (const [name, candidate] of cases) {
    await t.step(name, async () => {
      const fixture = await concurrencyInstallerFixture(
        { ...source, hostedRuntimes: [candidate] },
        undefined,
        R3,
      );
      try {
        assert.equal(await fixture.run(), 0);
        assert.equal(fixture.reports.at(-1)?.status, "waiting");
        assert.equal(fixture.patches(), 0);
        assert.equal(await fixture.head(), fixture.beforeHead);
        assert.ok(
          fixture.requests.every((request) => request.method === "GET"),
        );
      } finally {
        await fixture.close();
      }
    });
  }
});

Deno.test("owner install throughput: failed R2 retains the original rollback to old runtime at76", async () => {
  const prior = healthyProof(OLD, 74, 301);
  const source = releaseSnapshot({
    runtime: runtimeRecord({
      revision: R2,
      generation: 75,
      healthyProof: prior,
      executionProof: failedProof(R2, 75, 402),
    }),
  });
  const fixture = await concurrencyInstallerFixture(source, undefined, R3);
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(read.value.snapshot.hostedRuntimes[0].activeRevision, OLD);
    assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 76);
    assert.deepEqual(
      read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
      prior,
    );
    fixture.setNow(NOW + 1);
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "no_change");
    assert.equal(fixture.patches(), 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("owner install throughput: connected R3 failure restores exact R2 once at77 without reinstall", async () => {
  const source = healthyPrior();
  const install = await concurrencyInstallerFixture(source, undefined, R3);
  let installed: ReleaseStateSnapshotV1;
  try {
    assert.equal(await install.run(), 0);
    assert.equal(install.reports.at(-1)?.status, "installed");
    const read = await install.read();
    assert.ok(read.ok && read.value.status === "found");
    installed = read.value.snapshot;
  } finally {
    await install.close();
  }
  const failure = {
    ...installed,
    hostedRuntimes: [{
      ...installed.hostedRuntimes[0],
      lastExecutionProof: failedProof(R3, 76, 403),
    }],
  };
  const rollback = await concurrencyInstallerFixture(failure, undefined, R3);
  try {
    rollback.setNow(NOW + 1);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "rolled_back");
    assert.equal(rollback.patches(), 1);
    const read = await rollback.read();
    assert.ok(read.ok && read.value.status === "found");
    const restored = read.value.snapshot;
    assert.equal(restored.hostedRuntimes[0].activeRevision, R2);
    assert.equal(restored.hostedRuntimes[0].generation, 77);
    assert.deepEqual(
      restored.hostedRuntimes[0].lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    assert.deepEqual(
      restored.hostedRuntimes[0].lastExecutionProof,
      failure.hostedRuntimes[0].lastExecutionProof,
    );
    assert.deepEqual(restored.hostedReleases, source.hostedReleases);
    assert.deepEqual(restored.githubCooldowns, source.githubCooldowns);
    const move = JSON.parse(
      (await rollback.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(move.action, "rollback");
    assert.equal(move.stateHead, rollback.beforeHead);
    assert.equal(move.priorRevision, R3);
    assert.equal(move.priorGeneration, 76);
    assert.equal(move.nextRevision, R2);
    assert.equal(move.nextGeneration, 77);
    assert.deepEqual(
      move.priorHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    const restoredHead = await rollback.head();
    rollback.setNow(NOW + 2);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "no_change");
    assert.equal(rollback.patches(), 1);
    assert.equal(await rollback.head(), restoredHead);
  } finally {
    await rollback.close();
  }
});
