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
const P79 = "549c7a69186b3d2070aa4e69c92ee846d183ce8f" as GitSha;
const P80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
const R81 = "da98f5f49c45b57cfa97a45fe647c36b1021f302" as GitSha;

function healthyPrior(): ReleaseStateSnapshotV1 {
  const proof = healthyProof(P80, 80, 501);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: P80,
      generation: 80,
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
    R81,
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

Deno.test("owner install gen81: exact healthy80 installs R81 through the production entrypoint", async () => {
  const source = healthyPrior();
  const fixture = await concurrencyInstallerFixture(source, undefined, R81);
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    assert.equal(fixture.patches(), 1);
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    const runtime = read.value.snapshot.hostedRuntimes[0];
    assert.equal(runtime.activeRevision, R81);
    assert.equal(runtime.generation, 81);
    assert.deepEqual(
      runtime.lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    const move = JSON.parse(
      (await fixture.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(move.action, "install");
    assert.equal(move.priorRevision, P80);
    assert.equal(move.priorGeneration, 80);
    assert.equal(move.nextRevision, R81);
    assert.equal(move.nextGeneration, 81);
    assert.equal(move.stateHead, fixture.beforeHead);
    fixture.setNow(NOW + 1);
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "waiting");
    assert.equal(
      fixture.reports.at(-1)?.detail,
      "the generation 81 healthy proof is not recorded",
    );
    assert.equal(fixture.patches(), 1);
  } finally {
    await fixture.close();
  }
});

Deno.test("owner install gen81: missing, old, unbound or active prior proof cannot install R81", async (t) => {
  const runtime = healthyPrior().hostedRuntimes[0];
  const cases: [string, HostedRuntimeRecordV1, "waiting" | "no_change"][] = [
    ["missing healthy80", { ...runtime, lastHealthyProof: null }, "waiting"],
    ["wrong healthy revision", {
      ...runtime,
      lastHealthyProof: healthyProof(UNRELATED, 80),
    }, "waiting"],
    ["old generation79 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(P79, 79),
    }, "waiting"],
    ["wrong generation of P80 proof", {
      ...runtime,
      lastHealthyProof: healthyProof(P80, 79),
    }, "waiting"],
    ["active P80 execution", {
      ...runtime,
      execution: executionIntent(P80, 80),
    }, "waiting"],
    ["latest P80 failed without retained79", {
      ...runtime,
      lastExecutionProof: failedProof(P80, 80),
    }, "waiting"],
    [
      "healthy80 proof on an unrelated pointer at generation 80",
      runtimeRecord({
        revision: UNRELATED,
        generation: 80,
        healthyProof: healthyProof(P80, 80),
        executionProof: healthyProof(P80, 80),
      }),
      "no_change",
    ],
    [
      "P80 pointer healthy at generation 81",
      runtimeRecord({
        revision: P80,
        generation: 81,
        healthyProof: healthyProof(P80, 81),
        executionProof: healthyProof(P80, 81),
      }),
      "no_change",
    ],
    [
      "failed R81 without retained80",
      runtimeRecord({
        revision: R81,
        generation: 81,
        executionProof: failedProof(R81, 81),
      }),
      "waiting",
    ],
    [
      "failed R81 with old79 only",
      runtimeRecord({
        revision: R81,
        generation: 81,
        healthyProof: healthyProof(P79, 79),
        executionProof: failedProof(R81, 81),
      }),
      "waiting",
    ],
    [
      "failed R81 at an unbound generation",
      runtimeRecord({
        revision: R81,
        generation: 82,
        healthyProof: healthyProof(P80, 80),
        executionProof: failedProof(R81, 82),
      }),
      "no_change",
    ],
  ];
  for (const [name, candidate, status] of cases) {
    await t.step(name, () => expectUnmoved(candidate, status));
  }
});

Deno.test("owner install gen81: a generation 80 pointer off P80 with its own healthy proof stays outside the chain", async (t) => {
  const OLD = "4baeaf67d9677a317bc37831486c075b143fe68f" as GitSha;
  for (
    const [name, revision] of [
      ["unrelated", UNRELATED],
      ["generation 79 runtime P79", P79],
      ["stabilization rollback target", OLD],
    ] as const
  ) {
    await t.step(name, () =>
      expectUnmoved(
        runtimeRecord({
          revision,
          generation: 80,
          healthyProof: healthyProof(revision, 80),
          executionProof: healthyProof(revision, 80),
        }),
        "no_change",
        "the runtime pointer is outside the owner installation chain",
      ));
  }
});

Deno.test("owner install gen81: a failed generation 80 keeps the exact generation 80 outcomes", async (t) => {
  await t.step(
    "without retained79 it waits for the generation 79 proof",
    () =>
      expectUnmoved(
        {
          ...healthyPrior().hostedRuntimes[0],
          lastExecutionProof: failedProof(P80, 80, 502),
        },
        "waiting",
        "the exact recorded generation 79 healthy proof for the generation 80 rollback is unavailable",
      ),
  );
  await t.step("with retained79 it restores P79 at81, never R81", async () => {
    const prior = healthyProof(P79, 79, 401);
    const fixture = await concurrencyInstallerFixture(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: P80,
          generation: 80,
          healthyProof: prior,
          executionProof: failedProof(P80, 80, 502),
        }),
      }),
      undefined,
      R81,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "rolled_back");
      assert.equal(fixture.patches(), 1);
      const read = await fixture.read();
      assert.ok(read.ok && read.value.status === "found");
      const runtime = read.value.snapshot.hostedRuntimes[0];
      assert.equal(runtime.activeRevision, P79);
      assert.equal(runtime.generation, 81);
      assert.deepEqual(runtime.lastHealthyProof, prior);
    } finally {
      await fixture.close();
    }
  });
});

Deno.test("owner install gen81: connected R81 failure restores exact P80 once at82 without reinstall", async () => {
  const source = healthyPrior();
  const install = await concurrencyInstallerFixture(source, undefined, R81);
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
      lastExecutionProof: failedProof(R81, 81, 503),
    }],
  };
  const rollback = await concurrencyInstallerFixture(failure, undefined, R81);
  try {
    rollback.setNow(NOW + 1);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "rolled_back");
    assert.equal(rollback.patches(), 1);
    const read = await rollback.read();
    assert.ok(read.ok && read.value.status === "found");
    const restored = read.value.snapshot;
    assert.equal(restored.hostedRuntimes[0].activeRevision, P80);
    assert.equal(restored.hostedRuntimes[0].generation, 82);
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
    assert.equal(move.priorRevision, R81);
    assert.equal(move.priorGeneration, 81);
    assert.equal(move.nextRevision, P80);
    assert.equal(move.nextGeneration, 82);
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

Deno.test("owner install gen81: healthy R81 needs the exact successor native proof", () =>
  expectUnmoved(
    runtimeRecord({
      revision: R81,
      generation: 81,
      healthyProof: healthyProof(R81, 81, 504),
      executionProof: healthyProof(R81, 81, 504),
    }),
    "waiting",
  ));

Deno.test("owner install gen81: restored P80 at82 never reinstalls R81", async (t) => {
  const retained = healthyProof(P80, 80, 501);
  const restoredHealthy = healthyProof(P80, 82, 505);
  for (
    const [name, runtime] of [
      [
        "with the retained healthy80 and the R81 failure",
        runtimeRecord({
          revision: P80,
          generation: 82,
          healthyProof: retained,
          executionProof: failedProof(R81, 81, 503),
        }),
      ],
      [
        "after its own healthy generation 82 proof",
        runtimeRecord({
          revision: P80,
          generation: 82,
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

Deno.test("owner install gen81: exact runtime ancestry and current native CI gate every forward move", async (t) => {
  for (const refusal of ["ancestry", "ci"] as const) {
    await t.step(refusal, async () => {
      const fixture = await concurrencyInstallerFixture(
        healthyPrior(),
        refusal,
        R81,
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
