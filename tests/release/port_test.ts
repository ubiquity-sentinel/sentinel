// Scripted Deno release-port cases; original names and assertions are retained.
import assert from "node:assert/strict";
import { validateReleaseTargetConfig } from "../../src/release/config.ts";
import {
  DEP_0,
  DEP_1,
  DEP_X,
  GIT_SHA_HEADER,
  immutableUrl,
  installREST,
  MANAGED_URL,
  REVISION_HEADER,
  REVISIONS_PATH,
  ScriptedTransport,
  targetConfig,
} from "./helpers.ts";
import { client } from "./port-helpers.ts";

Deno.test("port: label-free exact receipt revision selects the candidate among two same-SHA builds", async () => {
  const other = { gitSha: DEP_1.gitSha, revisionId: "dep-0007" };
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1, other]);
  transport.health();
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn-from-the-receipt",
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.equal(found.value.status, "found");
  if (found.value.status === "found") {
    // The exact receipt revision id is the selector; the other same-SHA build
    // is never substituted and no git/transaction label is consulted.
    assert.equal(
      found.value.build.identity.revisionId,
      DEP_1.revisionId,
      JSON.stringify(found.value.build),
    );
    assert.equal(found.value.build.identity.gitSha, DEP_1.gitSha);
    assert.equal(
      found.value.build.buildTransactionId,
      "txn-from-the-receipt",
    );
    assert.equal(found.value.build.status, "succeeded");
  }
});

Deno.test("port: candidate discovery is none when the exact receipt revision is absent", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    `txn-${DEP_1.revisionId}`,
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.value.status, "none");
});

Deno.test("port: a foreign project id is rejected without any platform call", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    "another-project",
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "candidate project does not match the configured target",
    );
  }
  assert.equal(transport.calls.length, 0, "no platform call for a foreign id");
});

Deno.test("port: an invalid revision id or SHA is a typed fault, never a lookup", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = client(transport);
  const badId = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    "contains.a.dot",
  );
  assert.ok(!badId.ok);
  if (!badId.ok) assert.equal(badId.error.kind, "invalid");
  const badSha = await port.findBuiltCandidate(
    transport.config.projectId,
    "not-a-sha" as never,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!badSha.ok);
  if (!badSha.ok) assert.equal(badSha.error.kind, "invalid");
});

Deno.test("port: a duplicate exact revision id is rejected, never found or none", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.deployed = DEP_1;
  transport.route({
    method: "GET",
    pathname: REVISIONS_PATH,
    respond: () => ({
      kind: "response",
      status: 200,
      body: JSON.stringify([
        {
          id: DEP_1.revisionId,
          status: "succeeded",
          labels: {},
        },
        {
          id: DEP_1.revisionId,
          status: "succeeded",
          labels: {},
        },
      ]),
    }),
  });
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn-duplicate",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok, "duplicate exact id must fail closed");
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing contains a duplicate exact id",
    );
  }
  const current = await port.readCurrentDeployment(
    transport.config.projectId,
  );
  assert.ok(
    !current.ok,
    "duplicate exact id must fail closed for the prior too",
  );
  if (!current.ok) {
    assert.equal(current.error.kind, "invalid");
    assert.equal(
      current.error.detail,
      "revision listing contains a duplicate exact id",
    );
  }
});

Deno.test("port: a failed exact resource status is ambiguous, never found", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  transport.route({
    method: "GET",
    pathname: `/v2/revisions/${DEP_1.revisionId}`,
    respond: () => ({
      kind: "response",
      status: 200,
      body: JSON.stringify({
        id: DEP_1.revisionId,
        status: "failed",
        labels: {},
      }),
    }),
  });
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (found.ok) assert.equal(found.value.status, "ambiguous");
});

Deno.test("port: an immutable body/header identity discrepancy fails closed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  transport.immutableHealth = (identity) => {
    assert.ok(identity);
    return {
      kind: "response",
      status: 200,
      headers: {
        [GIT_SHA_HEADER]: identity!.gitSha,
        [REVISION_HEADER]: identity!.revisionId,
      },
      body: JSON.stringify({
        status: "available",
        release: {
          git_sha: DEP_X.gitSha,
          deployment_id: DEP_X.revisionId,
        },
      }),
    };
  };
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (found.ok) {
    assert.equal(
      found.value.status,
      "ambiguous",
      "a contradictory immutable deployment never yields found",
    );
  }
});

Deno.test("port: a wrong or unreachable immutable identity never yields found", async () => {
  for (const mode of ["wrong", "unreachable"] as const) {
    const transport = new ScriptedTransport();
    installREST(transport, [DEP_1]);
    transport.health();
    if (mode === "wrong") {
      transport.immutableIdentities.set(DEP_1.revisionId, DEP_X);
    } else {
      transport.immutableHealth = () => ({ kind: "reject" });
    }
    const port = client(transport);
    const found = await port.findBuiltCandidate(
      transport.config.projectId,
      DEP_1.gitSha,
      "txn",
      DEP_1.revisionId,
    );
    assert.ok(found.ok);
    if (found.ok) assert.equal(found.value.status, "ambiguous");
  }
});

Deno.test("config: the actual two-label Deno managed host is a valid root https base", () => {
  const actual = "https://ai-ubq-fi.ubiquity-dao.deno.net";
  for (const value of [actual, `${actual}/`]) {
    const config = validateReleaseTargetConfig(targetConfig({
      managedBaseUrl: value,
    }));
    assert.equal(config.managedBaseUrl, value);
    assert.equal(
      new URL(config.managedBaseUrl).hostname,
      "ai-ubq-fi.ubiquity-dao.deno.net",
      "the organization suffix is preserved",
    );
  }
});

Deno.test("config: non-root, credential, port, query and fragment managed base URLs are rejected", () => {
  const invalid: string[] = [
    "http://ai-ubq-fi.ubiquity-dao.deno.net",
    "https://ai-ubq-fi.ubiquity-dao.deno.net.foreign.invalid",
    "https://user:public-synthetic@ai-ubq-fi.ubiquity-dao.deno.net",
    "https://ai-ubq-fi.ubiquity-dao.deno.net:8443",
    "https://ai-ubq-fi.ubiquity-dao.deno.net/path",
    "https://ai-ubq-fi.ubiquity-dao.deno.net?query=value",
    "https://ai-ubq-fi.ubiquity-dao.deno.net#fragment",
  ];
  for (const managedBaseUrl of invalid) {
    assert.throws(
      () => validateReleaseTargetConfig(targetConfig({ managedBaseUrl })),
      `expected ${managedBaseUrl} to be rejected`,
    );
  }
});

Deno.test("config: a DNS label is bounded to 63 characters, not 64", () => {
  const label63AllA = "a".repeat(63);
  const label63Mixed = `${"a".repeat(30)}-${"b".repeat(32)}`;
  const label64 = "a".repeat(64);
  for (
    const host of [
      `${label63AllA}.org.deno.net`,
      `${label63Mixed}.org.deno.net`,
    ]
  ) {
    const managedBaseUrl = `https://${host}`;
    const config = validateReleaseTargetConfig(targetConfig({
      managedBaseUrl,
    }));
    assert.equal(new URL(config.managedBaseUrl).hostname, host);
  }
  const managedBaseUrl = `https://${label64}.org.deno.net`;
  assert.throws(
    () => validateReleaseTargetConfig(targetConfig({ managedBaseUrl })),
    `expected ${managedBaseUrl} to be rejected`,
  );
});

Deno.test("config: the API base keeps the https prefix with its prior path and port acceptance", () => {
  for (
    const apiBaseUrl of [
      "https://api.deno.com",
      "https://api.deno.com/v2",
      "https://api.deno.com:8443/v2/apps/project/revisions",
    ]
  ) {
    const config = validateReleaseTargetConfig(targetConfig({ apiBaseUrl }));
    assert.equal(config.apiBaseUrl, apiBaseUrl);
  }
  assert.throws(
    () =>
      validateReleaseTargetConfig(targetConfig({
        apiBaseUrl: "http://api.deno.com",
      })),
    "expected http://api.deno.com to be rejected",
  );
});

Deno.test("config: the custom base keeps its prior URL_RE acceptance", () => {
  for (
    const customBaseUrl of [
      "https://ai.ubq.fi",
      "https://ai.ubq.fi/health",
      "http://ai.ubq.fi:8080/status",
    ]
  ) {
    const config = validateReleaseTargetConfig(targetConfig({ customBaseUrl }));
    assert.equal(config.customBaseUrl, customBaseUrl);
  }
});

Deno.test("port: the immutable probe targets the derived trusted hostname", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(found.ok && found.value.status === "found");
  const expectedHost = new URL(immutableUrl(DEP_1.revisionId)).host;
  assert.equal(
    expectedHost,
    `ai-ubq-fi-${DEP_1.revisionId}.ubiquity-dao.deno.net`,
    "the immutable host replaces the first label only and keeps the org suffix",
  );
  const managedHost = new URL(MANAGED_URL).host;
  const healthProbes = transport.calls.filter(
    (call) => call.pathname === "/health",
  );
  assert.ok(
    healthProbes.some((call) => call.host === expectedHost),
    "the immutable host is first-label + revision id, never platform-supplied",
  );
  assert.ok(
    healthProbes.every(
      (call) => call.host === expectedHost || call.host === managedHost,
    ),
    "no arbitrary platform-hostname health probe occurred",
  );
});
