import assert from "node:assert/strict";
import { RESPONSE_LIMIT_BYTES } from "../../src/host/owner-install-api.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_STABILIZATION_REVISION as CANDIDATE,
} from "../../src/host/owner-install-runtime-pins.ts";
import {
  MISMATCH_DISPOSITION_RUNTIME_REVISION as PRIOR,
  UNRELATED,
} from "./owner-install-fixture-constants.ts";
import {
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import { concurrencyInstallerFixture } from "./owner-install-fixture.ts";

const ancestry = {
  status: "ahead",
  base_commit: { sha: CANDIDATE },
  merge_base_commit: { sha: CANDIDATE },
  ahead_by: 84,
  behind_by: 0,
  total_commits: 84,
  commits: [],
};

async function verifyComparison(
  overrides: Record<string, unknown>,
  expected: "installed" | "waiting",
  oversizedPage = false,
) {
  const priorProof = healthyProof(PRIOR, 74, 301);
  const fixture = await concurrencyInstallerFixture(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: PRIOR,
        generation: 74,
        healthyProof: priorProof,
        executionProof: priorProof,
      }),
    }),
    undefined,
    CANDIDATE,
  );
  const transport = globalThis.fetch;
  const comparison = { ...ancestry, ...overrides };
  const oversized = JSON.stringify({
    ...comparison,
    files: [{ patch: "x".repeat(RESPONSE_LIMIT_BYTES) }],
  });
  assert.ok(new TextEncoder().encode(oversized).length > RESPONSE_LIMIT_BYTES);
  const compact = JSON.stringify(comparison);
  assert.ok(new TextEncoder().encode(compact).length < RESPONSE_LIMIT_BYTES);
  const queries: string[] = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.includes("/compare/")) {
      assert.equal(
        url.pathname,
        `/repos/Ubiquity-Sentinel/sentinel/compare/${CANDIDATE}...development`,
      );
      queries.push(url.search);
      const metadataPage = url.search === "?per_page=1&page=2";
      return Promise.resolve(
        new Response(metadataPage && !oversizedPage ? compact : oversized),
      );
    }
    return transport(input, init);
  };
  try {
    assert.equal(await fixture.run(), 0);
    assert.equal(fixture.reports.at(-1)?.status, expected);
    assert.deepEqual(queries, ["?per_page=1&page=2"]);
    assert.equal(fixture.patches(), expected === "installed" ? 1 : 0);
    if (expected === "installed") {
      const read = await fixture.read();
      assert.ok(read.ok && read.value.status === "found");
      assert.equal(
        read.value.snapshot.hostedRuntimes[0].activeRevision,
        CANDIDATE,
      );
      assert.equal(read.value.snapshot.hostedRuntimes[0].generation, 75);
      assert.deepEqual(
        read.value.snapshot.hostedRuntimes[0].lastHealthyProof,
        priorProof,
      );
      assert.ok(
        fixture.requests.some((request) =>
          request.path.endsWith(`${CANDIDATE}/check-runs`)
        ),
      );
    } else {
      assert.equal(await fixture.head(), fixture.beforeHead);
      assert.ok(
        !fixture.requests.some((request) =>
          request.path.includes("/check-runs")
        ),
      );
    }
  } finally {
    await fixture.close();
  }
}

Deno.test("owner install ancestry: large comparison uses bounded metadata before exact native CI and installation", async () => {
  await verifyComparison({}, "installed");
});

Deno.test("owner install ancestry: empty metadata pages retain identical and one-commit proofs", async () => {
  await verifyComparison({
    status: "identical",
    ahead_by: 0,
    total_commits: 0,
  }, "installed");
  await verifyComparison({ ahead_by: 1, total_commits: 1 }, "installed");
});

Deno.test("owner install ancestry: metadata pagination preserves identity, divergence, counters and byte refusals", async () => {
  for (
    const fault of [
      { base_commit: { sha: UNRELATED } },
      { merge_base_commit: { sha: UNRELATED } },
      { status: "diverged", behind_by: 1, total_commits: 85 },
      { status: "behind", ahead_by: 0, behind_by: 1, total_commits: 1 },
      { total_commits: 83 },
    ]
  ) {
    await verifyComparison(fault, "waiting");
  }
  await verifyComparison({}, "waiting", true);
});
