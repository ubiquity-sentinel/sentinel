import assert from "node:assert/strict";
import { runMintFixture, syntheticToken } from "./hosted-app-mint-fixtures.ts";

Deno.test("hosted App mint: actual main emits same-mint metadata and post revokes the same token", async () => {
  const result = await runMintFixture();
  assert.deepEqual(result.main.code, 0);
  assert.deepEqual(result.post.code, 0);
  assert.deepEqual(result.output.token, syntheticToken);
  assert.deepEqual(result.state.token, syntheticToken);
  assert.deepEqual(result.state.expiresAt, result.expiresAt);
  assert.deepEqual(result.output["installation-id"], "155687488");
  assert.deepEqual(result.output["app-slug"], "ubiquity-sentinel");
  const mint = result.trace.find((row) => row.kind === "mint");
  assert.deepEqual(mint.body, { repositories: ["ai.ubq.fi"] });
  assert.deepEqual(
    result.trace.filter((row) => row.kind === "installation").length,
    1,
  );
  assert.deepEqual(result.trace.filter((row) => row.kind === "revoke"), [
    { kind: "revoke", sameToken: true },
  ]);
  assert(typeof result.output["mint-grant"] === "string");
  const grant = JSON.parse(result.output["mint-grant"]);
  assert.deepEqual(grant.appId, 4682172);
  assert.deepEqual(grant.installationId, 155687488);
  assert.deepEqual(grant.appSlug, "ubiquity-sentinel");
  assert.deepEqual(grant.expiresAt, result.expiresAt);
  assert.deepEqual(grant.permissions.contents, "write");
  assert.deepEqual(grant.permissions.merge_queues, "write");
  assert.deepEqual(grant.repositoryIds, [102]);
  assert.deepEqual(grant.repositoryNames, ["ai.ubq.fi"]);
  assert(!result.output["mint-grant"].includes(syntheticToken));
  assert(!("deployments" in grant.permissions));
});

const malformedCases = [
  { name: "absent native App identity", installation: { app_id: null } },
  {
    name: "malformed native App slug",
    installation: { app_slug: "bad\nslug" },
  },
  { name: "missing Contents", response: { permissions: { issues: "write" } } },
  {
    name: "invalid permission value",
    response: { permissions: { contents: "administrator" } },
  },
  { name: "permission array", response: { permissions: ["contents"] } },
  { name: "invalid expiry", response: { expires_at: "not-a-date" } },
  {
    name: "normalized impossible date",
    response: {
      expires_at: `${new Date().getUTCFullYear() + 1}-02-30T12:00:00Z`,
    },
  },
  {
    name: "duplicate repository identity",
    response: {
      repositories: [{ id: 101, name: "sentinel" }, { id: 101, name: "other" }],
    },
  },
  {
    name: "duplicate case-folded repository name",
    response: {
      repositories: [{ id: 101, name: "sentinel" }, {
        id: 102,
        name: "Sentinel",
      }],
    },
  },
  {
    name: "unsafe repository ID",
    response: {
      repositories: [{ id: Number.MAX_SAFE_INTEGER + 1, name: "sentinel" }],
    },
  },
  {
    name: "oversized repository output",
    response: {
      repositories: Array.from(
        { length: 1000 },
        (_, index) => ({
          id: index + 1,
          name: `repo-${index}-${"a".repeat(80)}`,
        }),
      ),
    },
  },
  {
    name: "too many repositories",
    response: {
      repositories: Array.from(
        { length: 1001 },
        (_, index) => ({ id: index + 1, name: `repo-${index}` }),
      ),
    },
  },
];
for (const value of malformedCases) {
  Deno.test(`hosted App mint: ${value.name} preserves actual token and post cleanup`, async () => {
    const result = await runMintFixture(value);
    assert.deepEqual(result.main.code, 0);
    assert.deepEqual(result.post.code, 0);
    assert.deepEqual(result.output.token, syntheticToken);
    assert.deepEqual(result.state.token, syntheticToken);
    assert(!("mint-grant" in result.output));
    assert.deepEqual(
      result.trace.filter((row) => row.kind === "revoke").length,
      1,
    );
  });
}

Deno.test("hosted App mint: optional output failure cannot suppress native post revocation or expose its exception", async () => {
  const result = await runMintFixture({ rejectGrantOutput: true });
  assert.deepEqual(result.main.code, 0);
  assert.deepEqual(result.post.code, 0);
  assert.deepEqual(result.state.token, syntheticToken);
  assert(!("mint-grant" in result.output));
  assert.deepEqual(
    result.trace.filter((row) => row.kind === "grantWriteRefused").length,
    1,
  );
  assert.deepEqual(
    result.trace.filter((row) => row.kind === "revoke").length,
    1,
  );
  assert(
    result.main.stdout.includes("Optional App mint metadata is unavailable"),
  );
  assert(!result.main.stdout.includes("sensitive-fixture-exception"));
  assert(!result.main.stderr.includes("sensitive-fixture-exception"));
});

Deno.test("hosted App mint: metadata retains actual native identity and read-only Contents without inventing authority", async () => {
  const result = await runMintFixture({
    installation: { app_id: 42, app_slug: "other-app" },
    response: {
      permissions: { contents: "read", metadata: "read" },
      repositories: null,
    },
  });
  assert.deepEqual(result.main.code, 0);
  const grant = JSON.parse(result.output["mint-grant"]);
  assert.deepEqual(grant.appId, 42);
  assert.deepEqual(grant.appSlug, "other-app");
  assert.deepEqual(grant.permissions.contents, "read");
  assert(!("repositoryIds" in grant));
  assert(!("repositoryNames" in grant));
  assert.deepEqual(
    result.trace.filter((row) => row.kind === "revoke").length,
    1,
  );
});

Deno.test("hosted App mint: unknown response and permission fields never reach metadata", async () => {
  const marker = "private-fixture-marker-must-not-be-copied";
  const result = await runMintFixture({
    response: {
      private_key: marker,
      request: { headers: { authorization: marker } },
      permissions: {
        contents: "write",
        metadata: "read",
        private_key: marker,
        token: marker,
      },
    },
  });
  assert.deepEqual(result.main.code, 0);
  assert.deepEqual(JSON.parse(result.output["mint-grant"]).permissions, {
    contents: "write",
    metadata: "read",
  });
  assert(!result.output["mint-grant"].includes(marker));
  assert(!result.main.stdout.includes(marker));
  assert(!result.main.stderr.includes(marker));
  assert.deepEqual(
    result.trace.filter((row) => row.kind === "revoke").length,
    1,
  );
});

for (const failRequest of ["installation", "mint", "revoke"] as const) {
  Deno.test(`hosted App mint: actual ${failRequest} HTTP failure retains cleanup behavior and static diagnostics`, async () => {
    const result = await runMintFixture({ failRequest });
    assert.deepEqual(result.main.code, failRequest === "revoke" ? 0 : 1);
    assert.deepEqual(result.post.code, 0);
    if (failRequest === "revoke") {
      assert.deepEqual(result.state.token, syntheticToken);
      assert(result.post.stdout.includes("Token revocation failed"));
    } else {
      assert.deepEqual(result.state, {});
      assert(result.main.stdout.includes("Sentinel App token mint failed"));
    }
    for (
      const text of [
        result.main.stdout,
        result.main.stderr,
        result.post.stdout,
        result.post.stderr,
      ]
    ) {
      assert(!text.includes("sensitive-fixture-api-error"));
      assert(!text.includes("authorization"));
      assert(!text.includes("PRIVATE KEY"));
    }
    assert.deepEqual(
      result.trace.filter((row) =>
        row.kind === "refusedRequest" && row.requestKind === failRequest
      ).length,
      1,
    );
  });
}
