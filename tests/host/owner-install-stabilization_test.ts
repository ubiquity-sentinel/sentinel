import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  MISMATCH_DISPOSITION_RUNTIME_REVISION,
  NOW,
  UNRELATED,
} from "./owner-install-fixture-constants.ts";
import {
  acceptedRelease,
  cooldown,
  executionIntent,
  failedProof,
  healthyProof,
  notStartedProof,
  releaseSnapshot,
  requestedRelease,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";

// Exact literals keep the original-base RED a semantic failure, not an import failure.
const STABILIZATION = "da9d6b437b6cb2725deed081b50778b7dc46a9a5" as GitSha;
const PRIOR = MISMATCH_DISPOSITION_RUNTIME_REVISION;

function healthyPrior(): ReleaseStateSnapshotV1 {
  const proof = healthyProof(PRIOR, 74, 301);
  return releaseSnapshot({
    runtime: runtimeRecord({
      revision: PRIOR,
      generation: 74,
      healthyProof: proof,
      executionProof: proof,
    }),
    hostedReleases: [acceptedRelease()],
    cooldowns: [cooldown(NOW - 1)],
  });
}

Deno.test(
  "owner install stabilization: exact healthy74 selects the immutable candidate through the production entrypoint",
  async () => {
    const source = healthyPrior();
    const fixture = await concurrencyInstallerFixture(
      source,
      undefined,
      STABILIZATION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "installed");
      assert.equal(fixture.patches(), 1);
      const read = await fixture.read();
      assert.ok(read.ok && read.value.status === "found");
      const installed = read.value.snapshot;
      assert.equal(installed.hostedRuntimes[0].activeRevision, STABILIZATION);
      assert.equal(installed.hostedRuntimes[0].generation, 75);
      assert.deepEqual(
        installed.hostedRuntimes[0].lastHealthyProof,
        source.hostedRuntimes[0].lastHealthyProof,
      );
      assert.deepEqual(installed.hostedReleases, source.hostedReleases);
      assert.deepEqual(installed.githubCooldowns, source.githubCooldowns);
      const record = JSON.parse(
        (await fixture.message()).trim().split("\n").at(-1)!,
      );
      assert.equal(record.stateHead, fixture.beforeHead);
      assert.equal(record.priorRevision, PRIOR);
      assert.equal(record.priorGeneration, 74);
      assert.equal(record.nextRevision, STABILIZATION);
      assert.equal(record.nextGeneration, 75);
      assert.deepEqual(
        record.priorHealthyProof,
        source.hostedRuntimes[0].lastHealthyProof,
      );
      assert.ok(
        fixture.requests.some((request) =>
          request.path.endsWith(`${STABILIZATION}...development`)
        ),
      );
      assert.ok(
        fixture.requests.some((request) =>
          request.path.endsWith(`${STABILIZATION}/check-runs`)
        ),
      );
      fixture.setNow(NOW + 1);
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "waiting");
      assert.equal(fixture.patches(), 1);
    } finally {
      await fixture.close();
    }
  },
);

const guardedPrior = healthyPrior();
const priorRuntime = guardedPrior.hostedRuntimes[0];
const priorRefusals: [
  string,
  ReleaseStateSnapshotV1,
  "waiting" | "no_change",
][] = [
  ["missing prior proof", {
    ...guardedPrior,
    hostedRuntimes: [{ ...priorRuntime, lastHealthyProof: null }],
  }, "waiting"],
  ["wrong prior revision proof", {
    ...guardedPrior,
    hostedRuntimes: [{
      ...priorRuntime,
      lastHealthyProof: healthyProof(UNRELATED, 74),
    }],
  }, "waiting"],
  ["stale prior generation proof", {
    ...guardedPrior,
    hostedRuntimes: [{
      ...priorRuntime,
      lastHealthyProof: healthyProof(PRIOR, 73),
    }],
  }, "waiting"],
  ["in-flight execution", {
    ...guardedPrior,
    hostedRuntimes: [{
      ...priorRuntime,
      execution: executionIntent(PRIOR, 74),
    }],
  }, "waiting"],
  [
    "active cooldown",
    { ...guardedPrior, githubCooldowns: [cooldown(NOW + 1)] },
    "waiting",
  ],
  ["indefinite cooldown", {
    ...guardedPrior,
    githubCooldowns: [cooldown(null)],
  }, "waiting"],
  ["nonterminal release", {
    ...guardedPrior,
    hostedReleases: [requestedRelease()],
  }, "waiting"],
  ["failed prior", {
    ...guardedPrior,
    hostedRuntimes: [{
      ...priorRuntime,
      lastExecutionProof: failedProof(PRIOR, 74),
    }],
  }, "waiting"],
  ["unrelated prior revision", {
    ...guardedPrior,
    hostedRuntimes: [
      runtimeRecord({
        revision: UNRELATED,
        generation: 74,
        healthyProof: healthyProof(UNRELATED, 74),
      }),
    ],
  }, "no_change"],
  ["changed prior generation", {
    ...guardedPrior,
    hostedRuntimes: [{ ...priorRuntime, generation: 76 }],
  }, "no_change"],
];

for (const [name, snapshot, status] of priorRefusals) {
  Deno.test(`owner install stabilization: ${name} cannot select the candidate`, async () => {
    const fixture = await concurrencyInstallerFixture(
      snapshot,
      undefined,
      STABILIZATION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, status);
      assert.equal(fixture.patches(), 0);
      assert.equal(await fixture.head(), fixture.beforeHead);
      assert.ok(fixture.requests.every((request) => request.method === "GET"));
      assert.ok(
        !fixture.requests.some((request) =>
          request.path.includes("/compare/") ||
          request.path.includes("/check-runs")
        ),
      );
    } finally {
      await fixture.close();
    }
  });
}

for (const refusal of ["ancestry", "ci", "parent", "readback"] as const) {
  Deno.test(`owner install stabilization: existing ${refusal} gate refuses publication acceptance`, async () => {
    const fixture = await concurrencyInstallerFixture(
      healthyPrior(),
      refusal,
      STABILIZATION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(
        fixture.reports.at(-1)?.status,
        refusal === "ancestry" || refusal === "ci" ? "waiting" : "failed",
      );
      assert.equal(fixture.patches(), refusal === "readback" ? 1 : 0);
      if (refusal === "parent") {
        assert.notEqual(await fixture.head(), fixture.beforeHead);
      }
      if (refusal === "ancestry" || refusal === "ci") {
        assert.equal(await fixture.head(), fixture.beforeHead);
      }
    } finally {
      await fixture.close();
    }
  });
}

for (
  const fault of [
    "missing CI",
    "pending CI",
    "wrong-head CI",
    "wrong-name CI",
    "truncated CI",
    "wrong ancestry base",
    "wrong ancestry merge-base",
  ] as const
) {
  Deno.test(`owner install stabilization: ${fault} refuses the exact candidate`, async () => {
    const fixture = await concurrencyInstallerFixture(
      healthyPrior(),
      undefined,
      STABILIZATION,
    );
    const transport = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const response = await transport(input, init);
      const path = new URL(String(input)).pathname;
      if (path.includes("/check-runs") && fault.includes("CI")) {
        const body = await response.json();
        if (fault === "missing CI") {
          body.check_runs = [];
          body.total_count = 0;
        }
        if (fault === "pending CI") body.check_runs[0].status = "in_progress";
        if (fault === "wrong-head CI") body.check_runs[0].head_sha = UNRELATED;
        if (fault === "wrong-name CI") {
          body.check_runs[0].name = "unrelated-check";
        }
        if (fault === "truncated CI") body.total_count = 2;
        return new Response(JSON.stringify(body));
      }
      if (path.includes("/compare/") && fault.includes("ancestry")) {
        const body = await response.json();
        if (fault === "wrong ancestry base") body.base_commit.sha = UNRELATED;
        if (fault === "wrong ancestry merge-base") {
          body.merge_base_commit.sha = UNRELATED;
        }
        return new Response(JSON.stringify(body));
      }
      return response;
    };
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "waiting");
      assert.equal(fixture.patches(), 0);
      assert.equal(await fixture.head(), fixture.beforeHead);
      assert.ok(fixture.requests.every((request) => request.method === "GET"));
    } finally {
      await fixture.close();
    }
  });
}

for (
  const fault of [
    "ambiguous confirmed",
    "ambiguous unpublished",
    "ambiguous unconfirmed",
  ] as const
) {
  Deno.test(`owner install stabilization: ${fault} publication is observed once without a retry`, async () => {
    const fixture = await concurrencyInstallerFixture(
      healthyPrior(),
      undefined,
      STABILIZATION,
    );
    const transport = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (init?.method === "PATCH") {
        attempts++;
        if (fault !== "ambiguous unpublished") await transport(input, init);
        return new Response("{}", { status: 503 });
      }
      const response = await transport(input, init);
      if (
        fault === "ambiguous unconfirmed" && attempts > 0 &&
        path.includes("/git/ref/")
      ) {
        return new Response(
          JSON.stringify({ object: { sha: fixture.beforeHead } }),
        );
      }
      return response;
    };
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(
        fixture.reports.at(-1)?.status,
        fault === "ambiguous confirmed" ? "installed" : "failed",
      );
      assert.equal(attempts, 1);
      assert.equal(
        fixture.patches(),
        fault === "ambiguous unpublished" ? 0 : 1,
      );
      if (fault === "ambiguous unpublished") {
        assert.equal(await fixture.head(), fixture.beforeHead);
      }
      if (fault === "ambiguous confirmed") {
        const read = await fixture.read();
        assert.ok(read.ok && read.value.status === "found");
        assert.equal(
          read.value.snapshot.hostedRuntimes[0].activeRevision,
          STABILIZATION,
        );
        assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 75);
      }
    } finally {
      await fixture.close();
    }
  });
}

function failedCandidate(): ReleaseStateSnapshotV1 {
  const source = healthyPrior();
  return {
    ...source,
    hostedRuntimes: [runtimeRecord({
      revision: STABILIZATION,
      generation: 75,
      healthyProof: source.hostedRuntimes[0].lastHealthyProof,
      executionProof: failedProof(STABILIZATION, 75, 302),
    })],
  };
}

const candidateFailure = failedCandidate();
const candidateRuntime = candidateFailure.hostedRuntimes[0];
for (
  const [name, runtime] of [
    ["missing recorded prior", { ...candidateRuntime, lastHealthyProof: null }],
    ["wrong recorded prior", {
      ...candidateRuntime,
      lastHealthyProof: healthyProof(UNRELATED, 74),
    }],
    ["stale recorded prior", {
      ...candidateRuntime,
      lastHealthyProof: healthyProof(PRIOR, 73),
    }],
    ["wrong failure revision", {
      ...candidateRuntime,
      lastExecutionProof: failedProof(UNRELATED, 75),
    }],
    ["wrong failure generation", {
      ...candidateRuntime,
      lastExecutionProof: failedProof(STABILIZATION, 74),
    }],
    ["not-started settlement", {
      ...candidateRuntime,
      lastExecutionProof: notStartedProof(STABILIZATION, 75),
    }],
  ] as const
) {
  Deno.test(`owner install stabilization: ${name} cannot authorize rollback`, async () => {
    const fixture = await concurrencyInstallerFixture(
      { ...candidateFailure, hostedRuntimes: [runtime] },
      undefined,
      STABILIZATION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "waiting");
      assert.equal(fixture.patches(), 0);
      assert.equal(await fixture.head(), fixture.beforeHead);
      assert.ok(fixture.requests.every((request) => request.method === "GET"));
    } finally {
      await fixture.close();
    }
  });
}

Deno.test("owner install stabilization: connected install failure restores the exact recorded prior once at monotonic76", async () => {
  const source = healthyPrior();
  const fixture = await concurrencyInstallerFixture(
    source,
    undefined,
    STABILIZATION,
  );
  let installed: ReleaseStateSnapshotV1;
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, "installed");
    const read = await fixture.read();
    assert.ok(read.ok && read.value.status === "found");
    installed = read.value.snapshot;
  } finally {
    await fixture.close();
  }
  const failure = {
    ...installed,
    hostedRuntimes: [{
      ...installed.hostedRuntimes[0],
      lastExecutionProof: failedProof(STABILIZATION, 75, 302),
    }],
  };
  const rollback = await concurrencyInstallerFixture(
    failure,
    undefined,
    STABILIZATION,
  );
  try {
    rollback.setNow(NOW + 1);
    assert.equal(await rollback.run(), 0);
    assert.equal(rollback.reports.at(-1)?.status, "rolled_back");
    assert.equal(rollback.patches(), 1);
    const read = await rollback.read();
    assert.ok(read.ok && read.value.status === "found");
    assert.equal(read.value.snapshot.hostedRuntimes[0].activeRevision, PRIOR);
    assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 76);
    assert.deepEqual(
      read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
      source.hostedRuntimes[0].lastHealthyProof,
    );
    assert.deepEqual(
      read.value.snapshot.hostedRuntimes[0].lastExecutionProof,
      failure.hostedRuntimes[0].lastExecutionProof,
    );
    assert.deepEqual(read.value.snapshot.hostedReleases, source.hostedReleases);
    assert.deepEqual(
      read.value.snapshot.githubCooldowns,
      source.githubCooldowns,
    );
    const record = JSON.parse(
      (await rollback.message()).trim().split("\n").at(-1)!,
    );
    assert.equal(record.action, "rollback");
    assert.equal(record.stateHead, rollback.beforeHead);
    assert.equal(record.priorRevision, STABILIZATION);
    assert.equal(record.priorGeneration, 75);
    assert.equal(record.nextRevision, PRIOR);
    assert.equal(record.nextGeneration, 76);
    assert.deepEqual(
      record.priorHealthyProof,
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

for (
  const [name, runtime] of [
    [
      "unrelated revision",
      runtimeRecord({
        revision: UNRELATED,
        generation: 75,
        healthyProof: healthyProof(PRIOR, 74),
        executionProof: failedProof(UNRELATED, 75),
      }),
    ],
    ["unrelated generation", {
      ...candidateRuntime,
      generation: 76,
      lastExecutionProof: failedProof(STABILIZATION, 76),
    }],
    [
      "healthy candidate",
      runtimeRecord({
        revision: STABILIZATION,
        generation: 75,
        healthyProof: healthyProof(STABILIZATION, 75),
        executionProof: healthyProof(STABILIZATION, 75),
      }),
    ],
  ] as const
) {
  Deno.test(`owner install stabilization: ${name} never restores the prior`, async () => {
    const fixture = await concurrencyInstallerFixture(
      { ...candidateFailure, hostedRuntimes: [runtime] },
      undefined,
      STABILIZATION,
    );
    try {
      assert.equal(await fixture.run(), 0);
      assert.equal(fixture.reports.at(-1)?.status, "no_change");
      assert.equal(fixture.patches(), 0);
      assert.equal(await fixture.head(), fixture.beforeHead);
      assert.ok(fixture.requests.every((request) => request.method === "GET"));
    } finally {
      await fixture.close();
    }
  });
}
