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
const P76 = "41bb853a1bedfc0422bf903dfabbe23bf714b44f" as GitSha;
const P77 = "ab3613e0224ff92266bed21dde6f40e6b0aab54a" as GitSha;
const R78 = "474f87eb639f97cd72b9bc4b9e56101488f841aa" as GitSha;

function healthyPrior(): ReleaseStateSnapshotV1 {
  const proof = healthyProof(P77, 77, 501);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: P77,
      generation: 77,
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
    R78,
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

Deno.test("owner install gen78: exact healthy77 installs R78 through the production entrypoint", async () => {
  const source = healthyPrior();
  const fixture = await concurrencyInstallerFixture(source, undefined, R78);
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, R78);
    assert.equal(runtime.generation, 78);
    assert.deepEqual(
      runtime.lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    const move = JSON.parse(
      (await fixture.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(move.action, "install");
    assert.equal(move.priorRevision, P77);
    assert.equal(move.priorGeneration, 77);
    assert.equal(move.nextRevision, R78);
    assert.equal(move.nextGeneration, 78);
    assert.equal(move.stateHead, fixture.beforeHead);
    fixture.setNow(NOW + 1);
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(
      fixture.reports.at(-1)?.detail,
      "the generation 78 healthy proof is not recorded",
    );
    assert.equal(fixture.patches(), 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("owner install gen78: missing, old, unbound or active prior proof cannot install R78", async (t) => {
  const runtime = healthyPrior().hostedRuntimes[0];
  const cases: [string, HostedRuntimeRecordV1, "waiting" | "no_change"][] = [
    ["missing healthy77", { ...runtime, lastHealthyProof: null }, "waiting"],
    ["wrong healthy revision", {
      ...runtime,
      lastHealthyProof: healthyProof(UNRELATED, 77),
    }, "waiting"],
    ["old generation76 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(P76, 76),
    }, "waiting"],
    ["wrong generation of P77 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(P77, 76),
    }, "waiting"],
    ["active P77 execution", {
      ...runtime,
      execution: executionIntent(P77, 77),
    }, "waiting"],
    ["latest P77 failed without retained76", {
      ...runtime,
      lastExecutionProof: failedProof(P77, 77),
    }, "waiting"],
    [
      "healthy77 proof on an unrelated pointer at generation 77",
      runtimeRecord({
        revision: UNRELATED,
        generation: 77,
        healthyProof: healthyProof(P77, 77),
        executionProof: healthyProof(P77, 77),
      }),
      "no_change",
    ],
    [
      "P77 pointer healthy at generation 78",
      runtimeRecord({
        revision: P77,
        generation: 78,
        healthyProof: healthyProof(P77, 78),
        executionProof: healthyProof(P77, 78),
      }),
      "no_change",
    ],
    [
      "failed R78 without retained77",
      runtimeRecord({
        revision: R78,
        generation: 78,
        executionProof: failedProof(R78, 78),
      }),
      "waiting",
    ],
    [
      "failed R78 with old76 only",
      runtimeRecord({
        revision: R78,
        generation: 78,
        healthyProof: healthyProof(P76, 76),
        executionProof: failedProof(R78, 78),
      }),
      "waiting",
    ],
    [
      "failed R78 at an unbound generation",
      runtimeRecord({
        revision: R78,
        generation: 79,
        healthyProof: healthyProof(P77, 77),
        executionProof: failedProof(R78, 79),
      }),
      "no_change",
    ],
  ];
  for (const [name, candidate, status] of cases) {
    await t.step(name, () => expectUnmoved(candidate, status));
  }
});

Deno.test("owner install gen78: a generation 77 pointer off P77 with its own healthy proof stays outside the chain", async (t) => {
  const OLD = "4baeaf67d9677a317bc37831486c075b143fe68f" as GitSha;
  for (
    const [name, revision] of [
      ["unrelated", UNRELATED],
      ["generation 76 runtime P76", P76],
      ["stabilization rollback target", OLD],
    ] as const
  ) {
    await t.step(name, () =>
      expectUnmoved(
        runtimeRecord({
          revision,
          generation: 77,
          healthyProof: healthyProof(revision, 77),
          executionProof: healthyProof(revision, 77),
        }),
        "no_change",
        "the runtime pointer is outside the owner installation chain",
      ));
  }
});

Deno.test("owner install gen78: a failed generation 77 keeps the exact generation 77 outcomes", async (t) => {
  await t.step(
    "without retained76 it waits for the generation 76 proof",
    () =>
      expectUnmoved(
        {
          ...healthyPrior().hostedRuntimes[0],
          lastExecutionProof: failedProof(P77, 77, 502),
        },
        "waiting",
        "the exact recorded generation 76 healthy proof for the generation 77 rollback is unavailable",
      ),
  );
  await t.step("with retained76 it restores P76 at78, never R78", async () => {
    const prior = healthyProof(P76, 76, 401);
    const fixture = await concurrencyInstallerFixture(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: P77,
          generation: 77,
          healthyProof: prior,
          executionProof: failedProof(P77, 77, 502),
        }),
      }),
      undefined,
      R78,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(fixture.patches(), 1);
      const read = await fixture.read();
      assert.ok(read.ok && read.value.status === "found");
      const runtime = read.value.snapshot.hostedRuntimes[0];
      assert.equal(runtime.activeRevision, P76);
      assert.equal(runtime.generation, 78);
      assert.deepEqual(runtime.lastHealthyProof, prior);
    } finally {
      await fixture.close();
    }
  });
});

Deno.test("owner install gen78: connected R78 failure restores exact P77 once at79 without reinstall", async () => {
  const source = healthyPrior();
  const install = await concurrencyInstallerFixture(source, undefined, R78);
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
      lastExecutionProof: failedProof(R78, 78, 503),
    }],
  };
  const rollback = await concurrencyInstallerFixture(failure, undefined, R78);
  try {
    rollback.setNow(NOW + 1);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "rolled_back");
    assert.equal(rollback.patches(), 1);
    const read = await rollback.read();
    assert.ok(read.ok && read.value.status === "found");
    const restored = read.value.snapshot;
    assert.equal(restored.hostedRuntimes[0].activeRevision, P77);
    assert.equal(restored.hostedRuntimes[0].generation, 79);
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
    assert.equal(move.priorRevision, R78);
    assert.equal(move.priorGeneration, 78);
    assert.equal(move.nextRevision, P77);
    assert.equal(move.nextGeneration, 79);
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

Deno.test("owner install gen78: healthy R78 is complete", () =>
  expectUnmoved(
    runtimeRecord({
      revision: R78,
      generation: 78,
      healthyProof: healthyProof(R78, 78, 504),
      executionProof: healthyProof(R78, 78, 504),
    }),
    "no_change",
    "the owner development installation is complete",
  ));

Deno.test("owner install gen78: restored P77 at79 never reinstalls R78", async (t) => {
  const retained = healthyProof(P77, 77, 501);
  const restoredHealthy = healthyProof(P77, 79, 505);
  for (
    const [name, runtime] of [
      [
        "with the retained healthy77 and the R78 failure",
        runtimeRecord({
          revision: P77,
          generation: 79,
          healthyProof: retained,
          executionProof: failedProof(R78, 78, 503),
        }),
      ],
      [
        "after its own healthy generation 79 proof",
        runtimeRecord({
          revision: P77,
          generation: 79,
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
