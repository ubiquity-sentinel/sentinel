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
const P77 = "ab3613e0224ff92266bed21dde6f40e6b0aab54a" as GitSha;
const P78 = "474f87eb639f97cd72b9bc4b9e56101488f841aa" as GitSha;
const R79 = "549c7a69186b3d2070aa4e69c92ee846d183ce8f" as GitSha;

function healthyPrior(): ReleaseStateSnapshotV1 {
  const proof = healthyProof(P78, 78, 501);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: P78,
      generation: 78,
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
    R79,
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

Deno.test("owner install gen79: exact healthy78 installs R79 through the production entrypoint", async () => {
  const source = healthyPrior();
  const fixture = await concurrencyInstallerFixture(source, undefined, R79);
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, R79);
    assert.equal(runtime.generation, 79);
    assert.deepEqual(
      runtime.lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    const move = JSON.parse(
      (await fixture.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(move.action, "install");
    assert.equal(move.priorRevision, P78);
    assert.equal(move.priorGeneration, 78);
    assert.equal(move.nextRevision, R79);
    assert.equal(move.nextGeneration, 79);
    assert.equal(move.stateHead, fixture.beforeHead);
    fixture.setNow(NOW + 1);
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(
      fixture.reports.at(-1)?.detail,
      "the generation 79 healthy proof is not recorded",
    );
    assert.equal(fixture.patches(), 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("owner install gen79: missing, old, unbound or active prior proof cannot install R79", async (t) => {
  const runtime = healthyPrior().hostedRuntimes[0];
  const cases: [string, HostedRuntimeRecordV1, "waiting" | "no_change"][] = [
    ["missing healthy78", { ...runtime, lastHealthyProof: null }, "waiting"],
    ["wrong healthy revision", {
      ...runtime,
      lastHealthyProof: healthyProof(UNRELATED, 78),
    }, "waiting"],
    ["old generation77 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(P77, 77),
    }, "waiting"],
    ["wrong generation of P78 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(P78, 77),
    }, "waiting"],
    ["active P78 execution", {
      ...runtime,
      execution: executionIntent(P78, 78),
    }, "waiting"],
    ["latest P78 failed without retained77", {
      ...runtime,
      lastExecutionProof: failedProof(P78, 78),
    }, "waiting"],
    [
      "healthy78 proof on an unrelated pointer at generation 78",
      runtimeRecord({
        revision: UNRELATED,
        generation: 78,
        healthyProof: healthyProof(P78, 78),
        executionProof: healthyProof(P78, 78),
      }),
      "no_change",
    ],
    [
      "P78 pointer healthy at generation 79",
      runtimeRecord({
        revision: P78,
        generation: 79,
        healthyProof: healthyProof(P78, 79),
        executionProof: healthyProof(P78, 79),
      }),
      "no_change",
    ],
    [
      "failed R79 without retained78",
      runtimeRecord({
        revision: R79,
        generation: 79,
        executionProof: failedProof(R79, 79),
      }),
      "waiting",
    ],
    [
      "failed R79 with old77 only",
      runtimeRecord({
        revision: R79,
        generation: 79,
        healthyProof: healthyProof(P77, 77),
        executionProof: failedProof(R79, 79),
      }),
      "waiting",
    ],
    [
      "failed R79 at an unbound generation",
      runtimeRecord({
        revision: R79,
        generation: 80,
        healthyProof: healthyProof(P78, 78),
        executionProof: failedProof(R79, 80),
      }),
      "no_change",
    ],
  ];
  for (const [name, candidate, status] of cases) {
    await t.step(name, () => expectUnmoved(candidate, status));
  }
});

Deno.test("owner install gen79: a generation 78 pointer off P78 with its own healthy proof stays outside the chain", async (t) => {
  const OLD = "4baeaf67d9677a317bc37831486c075b143fe68f" as GitSha;
  for (
    const [name, revision] of [
      ["unrelated", UNRELATED],
      ["generation 77 runtime P77", P77],
      ["stabilization rollback target", OLD],
    ] as const
  ) {
    await t.step(name, () =>
      expectUnmoved(
        runtimeRecord({
          revision,
          generation: 78,
          healthyProof: healthyProof(revision, 78),
          executionProof: healthyProof(revision, 78),
        }),
        "no_change",
        "the runtime pointer is outside the owner installation chain",
      ));
  }
});

Deno.test("owner install gen79: a failed generation 78 keeps the exact generation 78 outcomes", async (t) => {
  await t.step(
    "without retained77 it waits for the generation 77 proof",
    () =>
      expectUnmoved(
        {
          ...healthyPrior().hostedRuntimes[0],
          lastExecutionProof: failedProof(P78, 78, 502),
        },
        "waiting",
        "the exact recorded generation 77 healthy proof for the generation 78 rollback is unavailable",
      ),
  );
  await t.step("with retained77 it restores P77 at79, never R79", async () => {
    const prior = healthyProof(P77, 77, 401);
    const fixture = await concurrencyInstallerFixture(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: P78,
          generation: 78,
          healthyProof: prior,
          executionProof: failedProof(P78, 78, 502),
        }),
      }),
      undefined,
      R79,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(fixture.patches(), 1);
      const read = await fixture.read();
      assert.ok(read.ok && read.value.status === "found");
      const runtime = read.value.snapshot.hostedRuntimes[0];
      assert.equal(runtime.activeRevision, P77);
      assert.equal(runtime.generation, 79);
      assert.deepEqual(runtime.lastHealthyProof, prior);
    } finally {
      await fixture.close();
    }
  });
});

Deno.test("owner install gen79: connected R79 failure restores exact P78 once at80 without reinstall", async () => {
  const source = healthyPrior();
  const install = await concurrencyInstallerFixture(source, undefined, R79);
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
      lastExecutionProof: failedProof(R79, 79, 503),
    }],
  };
  const rollback = await concurrencyInstallerFixture(failure, undefined, R79);
  try {
    rollback.setNow(NOW + 1);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "rolled_back");
    assert.equal(rollback.patches(), 1);
    const read = await rollback.read();
    assert.ok(read.ok && read.value.status === "found");
    const restored = read.value.snapshot;
    assert.equal(restored.hostedRuntimes[0].activeRevision, P78);
    assert.equal(restored.hostedRuntimes[0].generation, 80);
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
    assert.equal(move.priorRevision, R79);
    assert.equal(move.priorGeneration, 79);
    assert.equal(move.nextRevision, P78);
    assert.equal(move.nextGeneration, 80);
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

Deno.test("owner install gen79: healthy R79 is complete", () =>
  expectUnmoved(
    runtimeRecord({
      revision: R79,
      generation: 79,
      healthyProof: healthyProof(R79, 79, 504),
      executionProof: healthyProof(R79, 79, 504),
    }),
    "no_change",
    "the owner development installation is complete",
  ));

Deno.test("owner install gen79: restored P78 at80 never reinstalls R79", async (t) => {
  const retained = healthyProof(P78, 78, 501);
  const restoredHealthy = healthyProof(P78, 80, 505);
  for (
    const [name, runtime] of [
      [
        "with the retained healthy78 and the R79 failure",
        runtimeRecord({
          revision: P78,
          generation: 80,
          healthyProof: retained,
          executionProof: failedProof(R79, 79, 503),
        }),
      ],
      [
        "after its own healthy generation 80 proof",
        runtimeRecord({
          revision: P78,
          generation: 80,
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
