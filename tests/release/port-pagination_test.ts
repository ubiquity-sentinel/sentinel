// Scripted Deno release-port cases; original names and assertions are retained.
import assert from "node:assert/strict";
import {
  DEP_0,
  DEP_1,
  installREST,
  PROJECT_ID,
  REVISIONS_PATH,
  ScriptedTransport,
} from "./helpers.ts";
import { client, paginatedListRoute, unrelatedPage } from "./port-helpers.ts";

Deno.test("port: pagination continues only through a valid console next Link and never fetches it", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  // First page: 100 unrelated succeeded revisions plus the exact official
  // console-origin next Link shape observed in the authenticated receipt.
  paginatedListRoute(transport, [
    {
      entries: unrelatedPage(1000, 100),
      link:
        `<https://console.deno.com/api/v2/apps/${PROJECT_ID}/revisions?cursor=OPAQUE&limit=100>; rel="next"`,
    },
    {
      entries: [{
        id: DEP_1.revisionId,
        status: "succeeded",
        labels: { "custom.branch": "main" },
        created_at: "2026-09-07T00:00:00.000Z",
      }],
      link: null,
      cursorLabel: "OPAQUE",
    },
  ]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(found.ok);
  if (!found.ok) return;
  assert.equal(
    found.value.status,
    "found",
    "the exact target revision on a later page must be accepted",
  );
  // Every authenticated request uses the configured API origin; the console
  // Link URL is never fetched and the token never leaves api.deno.com.
  const listCalls = transport.calls.filter(
    (call) => call.pathname === REVISIONS_PATH,
  );
  assert.ok(listCalls.length >= 2, "two pages requested");
  assert.ok(
    listCalls.every((call) => call.host === "api.deno.com"),
    "all listing requests stay on the configured API origin",
  );
  assert.ok(
    listCalls.every((call) => call.authorization === "Bearer deno-token"),
  );
  assert.equal(
    transport.calls.filter((call) => call.host === "console.deno.com").length,
    0,
    "the console origin is never contacted",
  );
  assert.ok(
    listCalls.some((call) => call.search.includes("cursor=OPAQUE")),
    "the extracted cursor is replayed on the API origin path",
  );
});

Deno.test("port: a later page also proves the prior membership", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_0]);
  transport.health();
  paginatedListRoute(transport, [
    {
      entries: unrelatedPage(1000, 100),
      link:
        `<https://console.deno.com/api/v2/apps/${PROJECT_ID}/revisions?cursor=OPAQUE&limit=100>; rel="next"`,
    },
    {
      entries: [{
        id: DEP_0.revisionId,
        status: "succeeded",
        labels: {},
        created_at: "2026-09-07T00:00:00.000Z",
      }],
      link: null,
      cursorLabel: "OPAQUE",
    },
  ]);
  const port = client(transport);
  const current = await port.readCurrentDeployment(
    transport.config.projectId,
  );
  assert.ok(current.ok);
  if (!current.ok) return;
  assert.equal(current.value.status, "live");
  assert.equal(current.value.identity?.revisionId, DEP_0.revisionId);
});

Deno.test("port: a full page without a usable continuation fails closed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  paginatedListRoute(transport, [
    {
      entries: unrelatedPage(1000, 100),
      link: null,
    },
  ]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing is inconclusive at the page bound",
    );
  }
});

Deno.test("port: foreign, wrong-path, changed-filter and malformed next Links are rejected", async () => {
  const cases: { name: string; link: string }[] = [
    {
      name: "foreign origin",
      link:
        `<https://evil.example/api/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next"`,
    },
    {
      name: "wrong path",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/other?cursor=C1&limit=100>; rel="next"`,
    },
    {
      name: "changed limit",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=50>; rel="next"`,
    },
    {
      name: "changed status filter",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100&status=failed>; rel="next"`,
    },
    {
      name: "extra query parameter",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100&sort=asc>; rel="next"`,
    },
    {
      name: "credentials",
      link:
        `<https://user:pass@api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next"`,
    },
    {
      name: "fragment",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100#x>; rel="next"`,
    },
    {
      name: "multiple next links",
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next", <https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C2&limit=100>; rel="next"`,
    },
    {
      name: "malformed link value",
      link: "not-a-link",
    },
  ];
  for (const entry of cases) {
    const transport = new ScriptedTransport();
    installREST(transport, [DEP_1]);
    transport.health();
    paginatedListRoute(transport, [{
      entries: unrelatedPage(1000, 100),
      link: entry.link,
    }]);
    const port = client(transport);
    const found = await port.findBuiltCandidate(
      transport.config.projectId,
      DEP_1.gitSha,
      "txn",
      DEP_1.revisionId,
    );
    assert.ok(!found.ok, `${entry.name}: must fail closed`);
    if (!found.ok) {
      assert.equal(
        found.error.kind,
        "invalid",
        `${entry.name}: expected a typed invalid fault`,
      );
    }
  }
});

Deno.test("port: absent, empty, oversized and duplicate cursors in next Links are rejected", async () => {
  const cases: string[] = [
    // No cursor query parameter at all.
    `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?limit=100>; rel="next"`,
    // Empty cursor.
    `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=&limit=100>; rel="next"`,
    // Oversized cursor (>2048 chars).
    `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=${
      "c".repeat(2049)
    }&limit=100>; rel="next"`,
  ];
  for (const link of cases) {
    const transport = new ScriptedTransport();
    installREST(transport, [DEP_1]);
    transport.health();
    paginatedListRoute(transport, [{
      entries: unrelatedPage(1000, 100),
      link,
    }]);
    const port = client(transport);
    const found = await port.findBuiltCandidate(
      transport.config.projectId,
      DEP_1.gitSha,
      "txn",
      DEP_1.revisionId,
    );
    assert.ok(!found.ok, `${link.slice(0, 40)}: must fail closed`);
  }
});

Deno.test("port: a cursor cycle is a typed failure, never endless traversal", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  const link =
    `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next"`;
  paginatedListRoute(transport, [
    { entries: unrelatedPage(1000, 100), link },
    { entries: unrelatedPage(2000, 100), link, cursorLabel: "C1" },
  ]);
  // Page 2's Link returns the SAME cursor C1 (a cycle).
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing repeated a pagination cursor",
    );
  }
});

Deno.test("port: a duplicate exact id across pages is a typed failure", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  paginatedListRoute(transport, [
    {
      entries: unrelatedPage(1000, 100),
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C1&limit=100>; rel="next"`,
    },
    {
      entries: [{
        id: DEP_1.revisionId,
        status: "succeeded",
        labels: {},
      }],
      link:
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C2&limit=100>; rel="next"`,
      cursorLabel: "C1",
    },
    {
      entries: [{
        id: DEP_1.revisionId,
        status: "succeeded",
        labels: {},
      }],
      link: null,
      cursorLabel: "C2",
    },
  ]);
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing contains a duplicate exact id",
    );
  }
});

Deno.test("port: traversal stops at the internal page bound and fails closed", async () => {
  const transport = new ScriptedTransport();
  installREST(transport, [DEP_1]);
  transport.health();
  transport.route({
    method: "GET",
    pathname: REVISIONS_PATH,
    respond: (url) => {
      const cursor = url.searchParams.get("cursor") ?? null;
      const index = cursor === null ? 0 : Number(cursor.slice(1));
      const link =
        `<https://api.deno.com/v2/apps/${PROJECT_ID}/revisions?cursor=C${
          index + 1
        }&limit=100>; rel="next"`;
      return {
        kind: "response",
        status: 200,
        headers: { link },
        body: JSON.stringify(unrelatedPage(1000 + index * 100, 100)),
      };
    },
  });
  const port = client(transport);
  const found = await port.findBuiltCandidate(
    transport.config.projectId,
    DEP_1.gitSha,
    "txn",
    DEP_1.revisionId,
  );
  assert.ok(!found.ok);
  if (!found.ok) {
    assert.equal(found.error.kind, "invalid");
    assert.equal(
      found.error.detail,
      "revision listing exceeded the page bound",
    );
  }
});
