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

// Fixed literals let the unchanged source fail semantically before new exports exist.
const R2 = "da9d6b437b6cb2725deed081b50778b7dc46a9a5" as GitSha;
const R3 = "41bb853a1bedfc0422bf903dfabbe23bf714b44f" as GitSha;
const R77 = "ab3613e0224ff92266bed21dde6f40e6b0aab54a" as GitSha;

function healthyPrior(): ReleaseStateSnapshotV1 {
  const proof = healthyProof(R3, 76, 501);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: R3,
      generation: 76,
      healthyProof: proof,
      executionProof: proof,
    }),
  });
}

async function expectUnmoved(
  runtime: HostedRuntimeRecordV1,
  status: "waiting" | "no_change",
  detail?: string,
) {
  const fixture = await concurrencyInstallerFixture(
    { ...healthyPrior(), hostedRuntimes: [runtime] },
    undefined,
    R77,
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

Deno.test("owner install gen77: exact healthy76 installs R77 through the production entrypoint", async () => {
  const source = healthyPrior();
  const fixture = await concurrencyInstallerFixture(source, undefined, R77);
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, R77);
    assert.equal(runtime.generation, 77);
    assert.deepEqual(
      runtime.lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    const move = JSON.parse(
      (await fixture.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(move.action, "install");
    assert.equal(move.priorRevision, R3);
    assert.equal(move.priorGeneration, 76);
    assert.equal(move.nextRevision, R77);
    assert.equal(move.nextGeneration, 77);
    assert.equal(move.stateHead, fixture.beforeHead);
    fixture.setNow(NOW + 1);
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(
      fixture.reports.at(-1)?.detail,
      "the generation 77 healthy proof is not recorded",
    );
    assert.equal(fixture.patches(), 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("owner install gen77: missing, old, unbound or active prior proof cannot install R77", async (t) => {
  const runtime = healthyPrior().hostedRuntimes[0];
  const cases: [string, HostedRuntimeRecordV1, "waiting" | "no_change"][] = [
    ["missing healthy76", { ...runtime, lastHealthyProof: null }, "waiting"],
    ["wrong healthy revision", {
      ...runtime,
      lastHealthyProof: healthyProof(UNRELATED, 76),
    }, "waiting"],
    ["old generation75 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(R2, 75),
    }, "waiting"],
    ["wrong generation of R3 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(R3, 75),
    }, "waiting"],
    ["active R3 execution", {
      ...runtime,
      execution: executionIntent(R3, 76),
    }, "waiting"],
    ["latest R3 failed without retained75", {
      ...runtime,
      lastExecutionProof: failedProof(R3, 76),
    }, "waiting"],
    [
      "healthy76 proof on an unrelated pointer at generation 76",
      runtimeRecord({
        revision: UNRELATED,
        generation: 76,
        healthyProof: healthyProof(R3, 76),
        executionProof: healthyProof(R3, 76),
      }),
      "no_change",
    ],
    [
      "R3 pointer healthy at generation 77",
      runtimeRecord({
        revision: R3,
        generation: 77,
        healthyProof: healthyProof(R3, 77),
        executionProof: healthyProof(R3, 77),
      }),
      "no_change",
    ],
    [
      "failed R77 without retained76",
      runtimeRecord({
        revision: R77,
        generation: 77,
        executionProof: failedProof(R77, 77),
      }),
      "waiting",
    ],
    [
      "failed R77 with old75 only",
      runtimeRecord({
        revision: R77,
        generation: 77,
        healthyProof: healthyProof(R2, 75),
        executionProof: failedProof(R77, 77),
      }),
      "waiting",
    ],
    [
      "failed R77 at an unbound generation",
      runtimeRecord({
        revision: R77,
        generation: 78,
        healthyProof: healthyProof(R3, 76),
        executionProof: failedProof(R77, 78),
      }),
      "no_change",
    ],
  ];
  for (const [name, candidate, status] of cases) {
    await t.step(name, () => expectUnmoved(candidate, status));
  }
});

Deno.test("owner install gen77: a generation 76 pointer off R3 with its own healthy proof stays outside the chain", async (t) => {
  const OLD = "4baeaf67d9677a317bc37831486c075b143fe68f" as GitSha;
  for (
    const [name, revision] of [
      ["unrelated", UNRELATED],
      ["throughput prior R2", R2],
      ["stabilization rollback target", OLD],
    ] as const
  ) {
    await t.step(name, () =>
      expectUnmoved(
        runtimeRecord({
          revision,
          generation: 76,
          healthyProof: healthyProof(revision, 76),
          executionProof: healthyProof(revision, 76),
        }),
        "no_change",
        "the runtime pointer is outside the owner installation chain",
      ));
  }
});

Deno.test("owner install gen77: a failed generation 76 keeps the exact throughput outcomes", async (t) => {
  await t.step(
    "without retained75 it waits for the throughput proof",
    () =>
      expectUnmoved(
        {
          ...healthyPrior().hostedRuntimes[0],
          lastExecutionProof: failedProof(R3, 76, 502),
        },
        "waiting",
        "the exact recorded generation 75 healthy proof for the throughput rollback is unavailable",
      ),
  );
  await t.step("with retained75 it restores R2 at77, never R77", async () => {
    const prior = healthyProof(R2, 75, 401);
    const fixture = await concurrencyInstallerFixture(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: R3,
          generation: 76,
          healthyProof: prior,
          executionProof: failedProof(R3, 76, 502),
        }),
      }),
      undefined,
      R77,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(fixture.patches(), 1);
      const read = await fixture.read();
      assert.ok(read.ok && read.value.status === "found");
      const runtime = read.value.snapshot.hostedRuntimes[0];
      assert.equal(runtime.activeRevision, R2);
      assert.equal(runtime.generation, 77);
      assert.deepEqual(runtime.lastHealthyProof, prior);
    } finally {
      await fixture.close();
    }
  });
});

Deno.test("owner install gen77: connected R77 failure restores exact R3 once at78 without reinstall", async () => {
  const source = healthyPrior();
  const install = await concurrencyInstallerFixture(source, undefined, R77);
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
      lastExecutionProof: failedProof(R77, 77, 503),
    }],
  };
  const rollback = await concurrencyInstallerFixture(failure, undefined, R77);
  try {
    rollback.setNow(NOW + 1);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "rolled_back");
    assert.equal(rollback.patches(), 1);
    const read = await rollback.read();
    assert.ok(read.ok && read.value.status === "found");
    const restored = read.value.snapshot;
    assert.equal(restored.hostedRuntimes[0].activeRevision, R3);
    assert.equal(restored.hostedRuntimes[0].generation, 78);
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
    assert.equal(move.priorRevision, R77);
    assert.equal(move.priorGeneration, 77);
    assert.equal(move.nextRevision, R3);
    assert.equal(move.nextGeneration, 78);
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

// A healthy R77 now installs generation 78 (owner-install-gen78_test.ts).
Deno.test("owner install gen77: a generation 77 pointer off R77 with its own healthy proof stays outside the chain", () =>
  expectUnmoved(
    runtimeRecord({
      revision: UNRELATED,
      generation: 77,
      healthyProof: healthyProof(UNRELATED, 77, 504),
      executionProof: healthyProof(UNRELATED, 77, 504),
    }),
    "no_change",
    "the runtime pointer is outside the owner installation chain",
  ));

Deno.test("owner install gen77: restored R3 at78 never reinstalls R77", async (t) => {
  const retained = healthyProof(R3, 76, 501);
  const restoredHealthy = healthyProof(R3, 78, 505);
  for (
    const [name, runtime] of [
      [
        "with the retained healthy76 and the R77 failure",
        runtimeRecord({
          revision: R3,
          generation: 78,
          healthyProof: retained,
          executionProof: failedProof(R77, 77, 503),
        }),
      ],
      [
        "after its own healthy generation 78 proof",
        runtimeRecord({
          revision: R3,
          generation: 78,
          healthyProof: restoredHealthy,
          executionProof: restoredHealthy,
        }),
      ],
    ] as const
  ) {
    await t.step(name, () =>
      expectUnmoved(
        runtime,
        "no_change",
        "the runtime pointer is outside the owner installation chain",
      ));
  }
});
