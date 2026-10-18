import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
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

// Fixed literals exercise unchanged production code before its new exports exist.
const P81 = "da98f5f49c45b57cfa97a45fe647c36b1021f302" as GitSha;
const R82 = "9f7cdcc0e7d4206730a25c2e51cf216d93d41f29" as GitSha;

function healthyPrior(): ReleaseStateSnapshotV1 {
  const proof = healthyProof(P81, 81, 601);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: P81,
      generation: 81,
      healthyProof: proof,
      executionProof: proof,
    }),
  });
}

Deno.test("owner install gen82: exact healthy81 installs R82 through the production entrypoint", async () => {
  const source = healthyPrior();
  const fixture = await concurrencyInstallerFixture(source, undefined, R82);
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, R82);
    assert.equal(runtime.generation, 82);
    assert.deepEqual(
      runtime.lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    const move = JSON.parse(
      (await fixture.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(move.action, "install");
    assert.equal(move.priorRevision, P81);
    assert.equal(move.priorGeneration, 81);
    assert.equal(move.nextRevision, R82);
    assert.equal(move.nextGeneration, 82);
    assert.equal(move.stateHead, fixture.beforeHead);
    fixture.setNow(NOW + 1);
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(fixture.patches(), 1);
  } finally {
    await fixture.close();
  }
});

async function expectUnmoved(
  runtime: HostedRuntimeRecordV1,
  status: "waiting" | "no_change",
  detail?: string,
) {
  const fixture = await concurrencyInstallerFixture(
    { ...healthyPrior(), hostedRuntimes: [runtime] },
    undefined,
    R82,
  );
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, status);
    if (detail !== undefined) {
      assert.equal(fixture.reports.at(-1)?.detail, detail);
    }
    assert.equal(fixture.patches(), 0);
    assert.equal(await fixture.head(), fixture.beforeHead);
    assert.ok(fixture.requests.every((request) => request.method === "GET"));
  } finally {
    await fixture.close();
  }
}

Deno.test("owner install gen82: missing, stale, unbound or active R81 proof never installs", async (t) => {
  const prior = healthyPrior().hostedRuntimes[0];
  const cases: [string, HostedRuntimeRecordV1, "waiting" | "no_change"][] = [
    ["missing proof", { ...prior, lastHealthyProof: null }, "waiting"],
    ["wrong revision", {
      ...prior,
      lastHealthyProof: healthyProof(UNRELATED, 81),
    }, "waiting"],
    [
      "stale generation",
      { ...prior, lastHealthyProof: healthyProof(P81, 80) },
      "waiting",
    ],
    [
      "active execution",
      { ...prior, execution: executionIntent(P81, 81) },
      "waiting",
    ],
    ["latest R81 failed", {
      ...prior,
      lastExecutionProof: failedProof(P81, 81, 602),
    }, "waiting"],
    [
      "unrelated healthy pointer",
      runtimeRecord({
        revision: UNRELATED,
        generation: 81,
        healthyProof: healthyProof(UNRELATED, 81),
        executionProof: healthyProof(UNRELATED, 81),
      }),
      "no_change",
    ],
    [
      "R81 at an unbound generation",
      runtimeRecord({
        revision: P81,
        generation: 82,
        healthyProof: healthyProof(P81, 82),
        executionProof: healthyProof(P81, 82),
      }),
      "no_change",
    ],
  ];
  for (const [name, runtime, status] of cases) {
    await t.step(name, () => expectUnmoved(runtime, status));
  }
});

Deno.test("owner install gen82: exact ancestry and successful native CI gate installation", async (t) => {
  for (const refusal of ["ancestry", "ci"] as const) {
    await t.step(refusal, async () => {
      const fixture = await concurrencyInstallerFixture(
        healthyPrior(),
        refusal,
        R82,
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

Deno.test("owner install gen82: connected R82 failure restores exact R81 once at83", async () => {
  const source = healthyPrior();
  const install = await concurrencyInstallerFixture(source, undefined, R82);
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
      lastExecutionProof: failedProof(R82, 82, 603),
    }],
  };
  const rollback = await concurrencyInstallerFixture(failure, undefined, R82);
  try {
    rollback.setNow(NOW + 1);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "rolled_back");
    assert.equal(rollback.patches(), 1);
    const read = await rollback.read();
    assert.ok(read.ok && read.value.status === "found");
    const restored = read.value.snapshot;
    assert.equal(restored.hostedRuntimes[0].activeRevision, P81);
    assert.equal(restored.hostedRuntimes[0].generation, 83);
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
    assert.equal(move.priorRevision, R82);
    assert.equal(move.priorGeneration, 82);
    assert.equal(move.nextRevision, P81);
    assert.equal(move.nextGeneration, 83);
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
    assert.ok(
      !rollback.requests.some((request) =>
        request.path.includes("/compare/") ||
        request.path.includes("/check-runs")
      ),
    );
  } finally {
    await rollback.close();
  }
});

Deno.test("owner install gen82: rollback requires the exact retained R81 generation81 proof", async (t) => {
  for (
    const prior of [null, healthyProof(UNRELATED, 81), healthyProof(P81, 80)]
  ) {
    await t.step(
      prior === null
        ? "missing"
        : prior.execution.revision + ":" + prior.execution.generation,
      () =>
        expectUnmoved(
          runtimeRecord({
            revision: R82,
            generation: 82,
            healthyProof: prior,
            executionProof: failedProof(R82, 82, 603),
          }),
          "waiting",
          "the exact recorded generation 81 healthy proof for the generation 82 rollback is unavailable",
        ),
    );
  }
});

Deno.test("owner install gen82: healthy R82 completes the fixed transition", () =>
  expectUnmoved(
    runtimeRecord({
      revision: R82,
      generation: 82,
      healthyProof: healthyProof(R82, 82, 604),
      executionProof: healthyProof(R82, 82, 604),
    }),
    "no_change",
    "the owner development installation is complete",
  ));

Deno.test("owner install gen82: restored R81 at83 never reinstalls or repeats its old rollback", async (t) => {
  const retained = healthyProof(P81, 81, 601);
  const restored = healthyProof(P81, 83, 605);
  for (
    const [name, healthy, execution] of [
      ["retained prior proof", retained, failedProof(R82, 82, 603)],
      ["own restored health", restored, restored],
    ] as const
  ) {
    await t.step(name, () =>
      expectUnmoved(
        runtimeRecord({
          revision: P81,
          generation: 83,
          healthyProof: healthy,
          executionProof: execution,
        }),
        "no_change",
        "the runtime pointer is outside the owner installation chain",
      ));
  }
});
