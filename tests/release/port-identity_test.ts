// Scripted Deno release-port cases; original names and assertions are retained.
import assert from "node:assert/strict";
import { DenoReleaseRESTClient } from "../../src/release/port.ts";
import {
  asTransport,
  CUSTOM_URL,
  DEP_0,
  DEP_1,
  DEP_X,
  GIT_SHA_HEADER,
  installREST,
  MANAGED_URL,
  promoteRoute,
  REVISION_HEADER,
  ScriptedTransport,
  T0,
  TestClock,
} from "./helpers.ts";
import { client, noAuth } from "./port-helpers.ts";

Deno.test("port: readCurrentDeployment observes a stable prior without labels or timelines", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.deployed = DEP_0;
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "live");
  assert.equal(current.value.identity?.revisionId, DEP_0.revisionId);
  assert.equal(
    transport.callCount("GET", /\/timelines$/),
    0,
    "no timeline enumeration is used to infer the current revision",
  );
});

Deno.test("port: readCurrentDeployment is unknown when health identity is unverifiable", async () => {
  for (const mode of ["contradictory", "maintenance"] as const) {
    const transport = new ScriptedTransport();
    installREST(transport, [DEP_0]);
    transport.health();
    if (mode === "maintenance") {
      transport.managedBodyMissing = true;
    } else {
      transport.managedHealth = (identity) => ({
        kind: "response",
        status: 200,
        headers: {
          [GIT_SHA_HEADER]: identity.gitSha,
          [REVISION_HEADER]: identity.revisionId,
        },
        body: JSON.stringify({
          status: "available",
          release: {
            git_sha: DEP_X.gitSha,
            deployment_id: DEP_X.revisionId,
          },
        }),
      });
    }
    const port = client(transport);
    const current = await port.readCurrentDeployment(
      transport.config.projectId,
    );
    assert.ok(current.ok);
    if (!current.ok) return;
    assert.equal(
      current.value.status,
      "unknown",
      `${mode}: no identity claim from unverified health`,
    );
    assert.equal(current.value.identity, null);
  }
});

Deno.test("port: readCurrentDeployment is unknown when the observed revision is not a member", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.deployed = DEP_1;
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "unknown", "foreign revision is not live");
  assert.equal(current.value.identity, null);
});

Deno.test("port: readCurrentDeployment rejects a moved stable identity during verification", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.deployed = DEP_0;
  transport.managedIdentitySequence = [DEP_0, DEP_X];
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(
    current.value.status,
    "unknown",
    "a deployment that moved during verification is never claimed live",
  );
  assert.equal(current.value.identity, null);
});

Deno.test("port: readCurrentDeployment is unknown when the exact resource failed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  transport.route({
    method: "GET",
    pathname: `/v2/revisions/${DEP_0.revisionId}`,
    respond: () => ({
      kind: "response",
      status: 200,
      body: JSON.stringify({
        id: DEP_0.revisionId,
        status: "failed",
        labels: {},
      }),
    }),
  });
  const port = client(transport);
  const current = await port.readCurrentDeployment(transport.config.projectId);
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "unknown");
});

Deno.test("port: promote requires exactly 204 and reports the API outcome", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1]);
  promoteRoute(transport, DEP_1);
  const port = client(transport);
  const promoted = await port.promote({
    projectId: transport.config.projectId,
    identity: DEP_1,
  });
  assert.ok(promoted.ok);
  if (!promoted.ok) return;
  assert.equal(promoted.value.outcome, "promoted");
  if (promoted.value.outcome === "promoted") {
    assert.equal(promoted.value.statusCode, 204);
    // The 204 carries no identity; post-effect identity proof is the
    // controller's managed-domain observation.
    assert.equal(promoted.value.observedIdentity, null);
  }
});

Deno.test("port: a non-204 promotion response is rejected, never promoted", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.any(
    "POST",
    /^\/v2\/revisions\/dep-0001\/promote$/,
    () => ({ kind: "response", status: 200 }),
  );
  const port = client(transport);
  const outcome = await port.promote({
    projectId: transport.config.projectId,
    identity: DEP_1,
  });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.value.outcome, "rejected");
  if (outcome.value.outcome === "rejected") {
    assert.equal(outcome.value.statusCode, 200);
  }
});

Deno.test("port: a lost promotion response is ambiguous, never rejected", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0, DEP_1]);
  promoteRoute(transport, DEP_1, { reject: true });
  const port = client(transport);
  const outcome = await port.promote({
    projectId: transport.config.projectId,
    identity: DEP_1,
  });
  assert.ok(outcome.ok);
  if (!outcome.ok) return;
  assert.equal(outcome.value.outcome, "ambiguous");
  if (outcome.value.outcome === "ambiguous") {
    assert.equal(outcome.value.statusCode, null);
  }
});

Deno.test("port: managed health identity is exact, never approximated", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.deployed = DEP_1;
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: MANAGED_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [],
    domain: null,
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.status, "healthy");
  assert.equal(sample.value.httpStatus, 200);
  assert.equal(sample.value.identity?.gitSha, DEP_1.gitSha);
  assert.equal(sample.value.identity?.revisionId, DEP_1.revisionId);
  assert.equal(sample.value.bodyMarkerPresent, true);
  assert.equal(sample.value.headersMatch, true);
});

Deno.test("port: a contradictory body/header identity is degraded with no verified identity", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.deployed = DEP_1;
  transport.managedHealth = (identity) => ({
    kind: "response",
    status: 200,
    headers: {
      [GIT_SHA_HEADER]: identity.gitSha,
      [REVISION_HEADER]: identity.revisionId,
    },
    body: JSON.stringify({
      status: "available",
      release: {
        git_sha: DEP_X.gitSha,
        deployment_id: DEP_X.revisionId,
      },
    }),
  });
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: MANAGED_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [],
    domain: null,
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(
    sample.value.status,
    "degraded",
    "a body identity that contradicts the headers is never healthy",
  );
  assert.equal(sample.value.identity, null);
});

Deno.test("port: missing or malformed body identity is degraded with no verified identity", async () => {
  const bodies = [
    JSON.stringify({ status: "available" }),
    JSON.stringify({ status: "available", release: { git_sha: DEP_1.gitSha } }),
    JSON.stringify({
      status: "available",
      release: { deployment_id: "dep-0001" },
    }),
    JSON.stringify({ status: "available", release: "nope" }),
    JSON.stringify({
      status: "maintenance",
      release: { git_sha: DEP_1.gitSha, deployment_id: "dep-0001" },
    }),
    "not json {",
  ];
  for (const body of bodies) {
    const transport = new ScriptedTransport();
    transport.health();
    transport.deployed = DEP_1;
    transport.managedHealth = (identity) => ({
      kind: "response",
      status: 200,
      headers: {
        [GIT_SHA_HEADER]: identity.gitSha,
        [REVISION_HEADER]: identity.revisionId,
      },
      body,
    });
    const port = client(transport);
    const sample = await port.sampleHealth({
      baseUrl: MANAGED_URL,
      healthPath: "/health",
      managedBodyMarker: '"status":"available"',
      managedHeaders: [],
      domain: null,
    });
    assert.ok(sample.ok);
    if (!sample.ok) continue;
    assert.equal(
      sample.value.status,
      "degraded",
      `${body.slice(0, 40)} must be degraded`,
    );
    assert.equal(
      sample.value.identity,
      null,
      `${body.slice(0, 40)}: no identity`,
    );
  }
});

Deno.test("port: configured managed header mismatch is degraded with no verified identity", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.identityOverride = DEP_X;
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: MANAGED_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [
      { name: "x-uos-git-sha", value: DEP_0.gitSha },
      { name: "x-uos-deployment-id", value: DEP_0.revisionId },
    ],
    domain: null,
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.status, "degraded");
  assert.equal(sample.value.headersMatch, false);
  assert.equal(
    sample.value.identity,
    null,
    "a mismatched sample is not verified",
  );
});

Deno.test("port: a verified Cloudflare 403 challenge is identified in the sample", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.customStatus = 403;
  transport.customCloudflare = true;
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: CUSTOM_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [],
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.status, "degraded");
  assert.equal(sample.value.httpStatus, 403);
  assert.equal(
    sample.value.headersMatch,
    true,
    "the identified Cloudflare challenge must be reported",
  );
  assert.equal(sample.value.identity, null);
});

Deno.test("port: an unverified 403 is never reported as a Cloudflare challenge", async () => {
  const transport = new ScriptedTransport();
  transport.health();
  transport.customStatus = 403;
  transport.customCloudflare = false;
  const port = client(transport);
  const sample = await port.sampleHealth({
    baseUrl: CUSTOM_URL,
    healthPath: "/health",
    managedBodyMarker: '"status":"available"',
    managedHeaders: [],
    domain: "ai.ubq.fi",
  });
  assert.ok(sample.ok);
  if (!sample.ok) return;
  assert.equal(sample.value.httpStatus, 403);
  assert.equal(sample.value.headersMatch, false);
});

Deno.test("port: auth failure of the REST read is a typed fault, not an empty result", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  const port = new DenoReleaseRESTClient({
    transport: asTransport(transport),
    auth: noAuth(),
    config: transport.config,
    clock: new TestClock(T0),
  });
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) assert.equal(found.error.kind, "auth_failed");
});
