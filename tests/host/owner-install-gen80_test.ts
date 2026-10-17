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
const P78 = "474f87eb639f97cd72b9bc4b9e56101488f841aa" as GitSha;
const P79 = "549c7a69186b3d2070aa4e69c92ee846d183ce8f" as GitSha;
const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;

function healthyPrior(): ReleaseStateSnapshotV1 {
  const proof = healthyProof(P79, 79, 501);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: P79,
      generation: 79,
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
    R80,
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

Deno.test("owner install gen80: exact healthy79 installs R80 through the production entrypoint", async () => {
  const source = healthyPrior();
  const fixture = await concurrencyInstallerFixture(source, undefined, R80);
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, R80);
    assert.equal(runtime.generation, 80);
    assert.deepEqual(
      runtime.lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    const move = JSON.parse(
      (await fixture.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(move.action, "install");
    assert.equal(move.priorRevision, P79);
    assert.equal(move.priorGeneration, 79);
    assert.equal(move.nextRevision, R80);
    assert.equal(move.nextGeneration, 80);
    assert.equal(move.stateHead, fixture.beforeHead);
    fixture.setNow(NOW + 1);
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(
      fixture.reports.at(-1)?.detail,
      "the generation 80 healthy proof is not recorded",
    );
    assert.equal(fixture.patches(), 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("owner install gen80: missing, old, unbound or active prior proof cannot install R80", async (t) => {
  const runtime = healthyPrior().hostedRuntimes[0];
  const cases: [string, HostedRuntimeRecordV1, "waiting" | "no_change"][] = [
    ["missing healthy79", { ...runtime, lastHealthyProof: null }, "waiting"],
    ["wrong healthy revision", {
      ...runtime,
      lastHealthyProof: healthyProof(UNRELATED, 79),
    }, "waiting"],
    ["old generation78 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(P78, 78),
    }, "waiting"],
    ["wrong generation of P79 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(P79, 78),
    }, "waiting"],
    ["active P79 execution", {
      ...runtime,
      execution: executionIntent(P79, 79),
    }, "waiting"],
    ["latest P79 failed without retained78", {
      ...runtime,
      lastExecutionProof: failedProof(P79, 79),
    }, "waiting"],
    [
      "healthy79 proof on an unrelated pointer at generation 79",
      runtimeRecord({
        revision: UNRELATED,
        generation: 79,
        healthyProof: healthyProof(P79, 79),
        executionProof: healthyProof(P79, 79),
      }),
      "no_change",
    ],
    [
      "P79 pointer healthy at generation 80",
      runtimeRecord({
        revision: P79,
        generation: 80,
        healthyProof: healthyProof(P79, 80),
        executionProof: healthyProof(P79, 80),
      }),
      "no_change",
    ],
    [
      "failed R80 without retained79",
      runtimeRecord({
        revision: R80,
        generation: 80,
        executionProof: failedProof(R80, 80),
      }),
      "waiting",
    ],
    [
      "failed R80 with old78 only",
      runtimeRecord({
        revision: R80,
        generation: 80,
        healthyProof: healthyProof(P78, 78),
        executionProof: failedProof(R80, 80),
      }),
      "waiting",
    ],
    [
      "failed R80 at an unbound generation",
      runtimeRecord({
        revision: R80,
        generation: 81,
        healthyProof: healthyProof(P79, 79),
        executionProof: failedProof(R80, 81),
      }),
      "no_change",
    ],
  ];
  for (const [name, candidate, status] of cases) {
    await t.step(name, () => expectUnmoved(candidate, status));
  }
});

Deno.test("owner install gen80: a generation 79 pointer off P79 with its own healthy proof stays outside the chain", async (t) => {
  const OLD = "4baeaf67d9677a317bc37831486c075b143fe68f" as GitSha;
  for (
    const [name, revision] of [
      ["unrelated", UNRELATED],
      ["generation 78 runtime P78", P78],
      ["stabilization rollback target", OLD],
    ] as const
  ) {
    await t.step(name, () =>
      expectUnmoved(
        runtimeRecord({
          revision,
          generation: 79,
          healthyProof: healthyProof(revision, 79),
          executionProof: healthyProof(revision, 79),
        }),
        "no_change",
        "the runtime pointer is outside the owner installation chain",
      ));
  }
});

Deno.test("owner install gen80: a failed generation 79 keeps the exact generation 79 outcomes", async (t) => {
  await t.step(
    "without retained78 it waits for the generation 78 proof",
    () =>
      expectUnmoved(
        {
          ...healthyPrior().hostedRuntimes[0],
          lastExecutionProof: failedProof(P79, 79, 502),
        },
        "waiting",
        "the exact recorded generation 78 healthy proof for the generation 79 rollback is unavailable",
      ),
  );
  await t.step("with retained78 it restores P78 at80, never R80", async () => {
    const prior = healthyProof(P78, 78, 401);
    const fixture = await concurrencyInstallerFixture(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: P79,
          generation: 79,
          healthyProof: prior,
          executionProof: failedProof(P79, 79, 502),
        }),
      }),
      undefined,
      R80,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(fixture.patches(), 1);
      const read = await fixture.read();
      assert.ok(read.ok && read.value.status === "found");
      const runtime = read.value.snapshot.hostedRuntimes[0];
      assert.equal(runtime.activeRevision, P78);
      assert.equal(runtime.generation, 80);
      assert.deepEqual(runtime.lastHealthyProof, prior);
    } finally {
      await fixture.close();
    }
  });
});

Deno.test("owner install gen80: connected R80 failure restores exact P79 once at81 without reinstall", async () => {
  const source = healthyPrior();
  const install = await concurrencyInstallerFixture(source, undefined, R80);
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
      lastExecutionProof: failedProof(R80, 80, 503),
    }],
  };
  const rollback = await concurrencyInstallerFixture(failure, undefined, R80);
  try {
    rollback.setNow(NOW + 1);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "rolled_back");
    assert.equal(rollback.patches(), 1);
    const read = await rollback.read();
    assert.ok(read.ok && read.value.status === "found");
    const restored = read.value.snapshot;
    assert.equal(restored.hostedRuntimes[0].activeRevision, P79);
    assert.equal(restored.hostedRuntimes[0].generation, 81);
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
    assert.equal(move.priorRevision, R80);
    assert.equal(move.priorGeneration, 80);
    assert.equal(move.nextRevision, P79);
    assert.equal(move.nextGeneration, 81);
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

Deno.test("owner install gen80: healthy R80 is complete", () =>
  expectUnmoved(
    runtimeRecord({
      revision: R80,
      generation: 80,
      healthyProof: healthyProof(R80, 80, 504),
      executionProof: healthyProof(R80, 80, 504),
    }),
    "no_change",
    "the owner development installation is complete",
  ));

Deno.test("owner install gen80: restored P79 at81 never reinstalls R80", async (t) => {
  const retained = healthyProof(P79, 79, 501);
  const restoredHealthy = healthyProof(P79, 81, 505);
  for (
    const [name, runtime] of [
      [
        "with the retained healthy79 and the R80 failure",
        runtimeRecord({
          revision: P79,
          generation: 81,
          healthyProof: retained,
          executionProof: failedProof(R80, 80, 503),
        }),
      ],
      [
        "after its own healthy generation 81 proof",
        runtimeRecord({
          revision: P79,
          generation: 81,
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
