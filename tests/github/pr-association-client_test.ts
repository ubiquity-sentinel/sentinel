import assert from "node:assert/strict";
import { portError } from "../../src/contracts/ports.ts";
import { GitHubPrAssociationsClient } from "../../src/github/client-pr-associations.ts";
import type { GitHubApiClientOptionsV1 } from "../../src/github/client-contracts.ts";
import type { HttpResponseV1 } from "../../src/github/http.ts";
import { FakeClock, SHA1, SHA2, SHA3, T0 } from "./helpers.ts";
import { QUEUE_REPO, queueClient, response } from "./merge-queue-fixtures.ts";

const repository = (overrides: Record<string, unknown> = {}) => ({
  id: "R_target",
  name: QUEUE_REPO.name,
  owner: { login: QUEUE_REPO.owner },
  ...overrides,
});
const issue = (overrides: Record<string, unknown> = {}) => ({
  id: "I_1",
  number: 1,
  repository: repository(),
  ...overrides,
});
const pull = (overrides: Record<string, unknown> = {}) => ({
  id: "PR_7",
  number: 7,
  state: "OPEN",
  repository: repository(),
  headRepository: repository(),
  baseRepository: repository(),
  headRefName: "human/issue-1",
  baseRefName: "development",
  headRefOid: SHA2,
  baseRefOid: SHA1,
  ...overrides,
});
const connection = (
  nodes: unknown[],
  total = nodes.length,
  next: string | null = null,
) => ({
  nodes,
  totalCount: total,
  pageInfo: { hasNextPage: next !== null, endCursor: next },
});
function issuePage(
  nodes: unknown[],
  total = nodes.length,
  next: string | null = null,
  overrides: Record<string, unknown> = {},
) {
  return {
    data: {
      repository: {
        ...repository(),
        issue: {
          ...issue(),
          title: "Repair source",
          body: "Exact source\nhttps://github.com/ubiquity/ai.ubq.fi/pull/999",
          state: "OPEN",
          closedByPullRequestsReferences: connection(nodes, total, next),
          ...overrides,
        },
      },
    },
  };
}
function closingPage(
  nodes: unknown[],
  total = nodes.length,
  next: string | null = null,
  overrides: Record<string, unknown> = {},
) {
  return {
    data: {
      repository: {
        ...repository(),
        pullRequest: {
          ...pull(),
          closingIssuesReferences: connection(nodes, total, next),
          ...overrides,
        },
      },
    },
  };
}
const restRepo = (overrides: Record<string, unknown> = {}) => ({
  node_id: "R_target",
  name: QUEUE_REPO.name,
  owner: { login: QUEUE_REPO.owner },
  ...overrides,
});
function restPull(overrides: Record<string, unknown> = {}) {
  return {
    node_id: "PR_7",
    number: 7,
    state: "open",
    merged: false,
    head: { repo: restRepo(), ref: "human/issue-1", sha: SHA2 },
    base: { repo: restRepo(), ref: "development", sha: SHA1 },
    user: { type: "Bot", node_id: "BOT_1", login: "ubiquity-sentinel[bot]" },
    ...overrides,
  };
}
function rig(
  replies: readonly (HttpResponseV1 | Error)[],
  overrides: Partial<GitHubApiClientOptionsV1> = {},
) {
  const base = queueClient(replies, overrides);
  return {
    ...base,
    client: new GitHubPrAssociationsClient(base.options, null),
  };
}
const UNTIL = T0 + 10_000;

Deno.test("native PR associations exhaust issue pages and keep exact native/source identities", async () => {
  const r = rig([
    response(issuePage([pull()], 2, "cursor1")),
    response(issuePage([pull({ id: "PR_8", number: 8 })], 2)),
  ]);
  const result = await r.client.readIssuePullAssociations(1, UNTIL);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.value.pulls.map((p) => p.number), [7, 8]);
  assert.equal(result.value.issue.nodeId, "I_1");
  assert.equal(result.value.issue.repository.nodeId, "R_target");
  assert.equal(
    result.value.issue.body,
    "Exact source\nhttps://github.com/ubiquity/ai.ubq.fi/pull/999",
  );
  assert.equal(result.value.pulls[0].head, SHA2);
  assert.equal(result.value.pulls[0].base, SHA1);
  assert.equal(result.value.pulls[0].headRepository?.nodeId, "R_target");
  assert.equal(r.requests.length, 2);
  assert.equal(JSON.parse(r.requests[1].body!).variables.after, "cursor1");
  assert.match(r.requests[0].body!, /closedByPullRequestsReferences/);
  assert.match(r.requests[0].body!, /includeClosedPrs:false/);
  assert.match(r.requests[0].body!, /userLinkedOnly:false/);
  assert.equal(r.auth.calls, 2);
  assert.equal(r.cooldown.beforeRequests.length, 4);
  assert.ok(
    r.requests.every((request) => request.headers.has("authorization")),
  );
});

Deno.test("native PR associations ignore ordinary URL text and preserve foreign candidate facts", async () => {
  const empty = await rig([response(issuePage([]))]).client
    .readIssuePullAssociations(1, UNTIL);
  assert.equal(empty.status, "complete");
  if (empty.status === "complete") assert.deepEqual(empty.value.pulls, []);
  const foreign = repository({ id: "R_foreign", name: "other" });
  const result = await rig([
    response(
      issuePage([
        pull({
          repository: foreign,
          baseRepository: foreign,
          headRepository: foreign,
        }),
      ]),
    ),
  ]).client.readIssuePullAssociations(1, UNTIL);
  assert.equal(result.status, "complete");
  if (result.status === "complete") {
    assert.equal(result.value.pulls[0].repository.name, "other");
  }
});

Deno.test("native PR associations read reciprocal pages bound to the exact PR head and base", async () => {
  const r = rig([
    response(closingPage([issue()], 2, "next")),
    response(closingPage([issue({ id: "I_2", number: 2 })], 2)),
  ]);
  const result = await r.client.readPullClosingIssues(7, UNTIL);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.value.issues.map((i) => i.nodeId), ["I_1", "I_2"]);
  assert.equal(result.value.pull.nodeId, "PR_7");
  assert.equal(result.value.pull.headRef, "human/issue-1");
  assert.equal(result.value.pull.baseRef, "development");
  assert.equal(result.value.pull.head, SHA2);
  assert.equal(result.value.pull.base, SHA1);
  assert.match(r.requests[0].body!, /closingIssuesReferences/);
  assert.equal(JSON.parse(r.requests[1].body!).variables.after, "next");
});

Deno.test("native PR associations REST author keeps canonical Bot suffix and complete branch/repository identities", async () => {
  const r = rig([response(restPull())]);
  const result = await r.client.readAssociationPull(7, UNTIL);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.deepEqual(result.value.author, {
    login: "ubiquity-sentinel[bot]",
    nodeId: "BOT_1",
    type: "Bot",
  });
  assert.equal(result.value.repository.nodeId, "R_target");
  assert.equal(result.value.baseRepository.owner, "ubiquity");
  assert.equal(result.value.headRepository?.name, "ai.ubq.fi");
  assert.equal(result.value.head, SHA2);
  assert.equal(result.value.base, SHA1);
  assert.equal(r.requests[0].method, "GET");
  assert.equal(
    r.requests[0].url,
    "https://api.github.com/repos/ubiquity/ai.ubq.fi/pulls/7",
  );
  const removed = await rig([
    response(restPull({ head: { repo: null, ref: "old", sha: SHA2 } })),
  ]).client.readAssociationPull(7, UNTIL);
  assert.equal(removed.status, "complete");
  if (removed.status === "complete") {
    assert.equal(removed.value.headRepository, null);
  }
});

Deno.test("native PR association pagination faults never become successful absence", async (t) => {
  const cases: [string, unknown[], Partial<GitHubApiClientOptionsV1>?][] = [
    ["GraphQL partial error", [{
      ...issuePage([]),
      errors: [{ message: "private token details" }],
    }]],
    ["missing issue", [{
      data: { repository: { ...repository(), issue: null } },
    }]],
    ["wrong issue number", [issuePage([], 0, null, { number: 2 })]],
    ["wrong issue repo node", [
      issuePage([], 0, null, { repository: repository({ id: "R_other" }) }),
    ]],
    ["malformed node", [issuePage([null])]],
    ["missing connection", [
      issuePage([], 0, null, { closedByPullRequestsReferences: null }),
    ]],
    ["unreadable source body", [issuePage([], 0, null, { body: null })]],
    ["closed candidate on open-only connection", [
      issuePage([pull({ state: "CLOSED" })]),
    ]],
    ["bad head SHA", [issuePage([pull({ headRefOid: "not-a-sha" })])]],
    ["partial total", [issuePage([pull()], 2)]],
    ["duplicate node", [issuePage([pull(), pull({ number: 8 })])]],
    ["duplicate number", [issuePage([pull(), pull({ id: "PR_other" })])]],
    ["cycle", [
      issuePage([pull()], 3, "loop"),
      issuePage([pull({ number: 8, id: "PR_8" })], 3, "loop"),
    ]],
    ["empty continuation", [issuePage([], 1, "next")]],
    ["changed issue node", [
      issuePage([pull()], 2, "next"),
      issuePage([pull({ number: 8, id: "PR_8" })], 2, null, { id: "I_other" }),
    ]],
    ["changed source body", [
      issuePage([pull()], 2, "next"),
      issuePage([pull({ number: 8, id: "PR_8" })], 2, null, {
        body: "changed",
      }),
    ]],
    ["changed issue state", [
      issuePage([pull()], 2, "next"),
      issuePage([pull({ number: 8, id: "PR_8" })], 2, null, {
        state: "CLOSED",
      }),
    ]],
    ["changed total", [
      issuePage([pull()], 2, "next"),
      issuePage([pull({ number: 8, id: "PR_8" })], 3),
    ]],
    ["page bound", [issuePage([pull()], 2, "next")], { maxPages: 1 }],
    ["item bound", [issuePage([pull()], 2, "next")], { maxItems: 1 }],
  ];
  for (const [name, pages, options] of cases) {
    await t.step(name, async () => {
      const result = await rig(pages.map((p) => response(p)), options).client
        .readIssuePullAssociations(1, UNTIL);
      assert.notEqual(result.status, "complete");
      assert.doesNotMatch(JSON.stringify(result), /private token/);
    });
  }
});

Deno.test("native reciprocal pagination rejects moved PR identities and partial issue connections", async (t) => {
  for (
    const [name, override] of [
      ["node", { id: "PR_other" }],
      ["head", { headRefOid: SHA3 }],
      ["base", { baseRefOid: SHA3 }],
      ["branch", { headRefName: "other" }],
      ["state", { state: "CLOSED" }],
      ["head repository", { headRepository: repository({ id: "R_other" }) }],
    ] as [string, Record<string, unknown>][]
  ) {
    await t.step(name, async () => {
      const result = await rig([
        response(closingPage([issue()], 2, "next")),
        response(
          closingPage([issue({ id: "I_2", number: 2 })], 2, null, override),
        ),
      ]).client.readPullClosingIssues(7, UNTIL);
      assert.deepEqual(result, { status: "unavailable", reason: "drift" });
    });
  }
  for (
    const pages of [
      [closingPage([issue()], 2)],
      [closingPage([issue(), issue()])],
      [{ ...closingPage([]), errors: [{ message: "private upstream" }] }],
    ]
  ) {
    assert.notEqual(
      (await rig(pages.map((p) => response(p))).client.readPullClosingIssues(
        7,
        UNTIL,
      )).status,
      "complete",
    );
  }
});

Deno.test("native PR REST reads refuse incomplete identities and mismatched scope", async (t) => {
  const cases: [string, Record<string, unknown>][] = [
    ["wrong number", { number: 9 }],
    ["missing node", { node_id: null }],
    ["missing author", { user: null }],
    ["missing author node", { user: { type: "Bot", login: "bot[bot]" } }],
    ["unsupported actor", {
      user: { type: "Organization", node_id: "O", login: "org" },
    }],
    ["foreign base", {
      base: {
        repo: restRepo({ name: "foreign" }),
        ref: "development",
        sha: SHA1,
      },
    }],
    ["missing head repo", { head: { ref: "branch", sha: SHA2 } }],
    ["incoherent merged state", { merged: true }],
  ];
  for (const [name, override] of cases) {
    await t.step(name, async () => {
      assert.notEqual(
        (await rig([response(restPull(override))]).client.readAssociationPull(
          7,
          UNTIL,
        )).status,
        "complete",
      );
    });
  }
});

Deno.test("native association reads share auth/cooldown and reject errors and deadlines on every path", async (t) => {
  for (
    const method of [
      "readIssuePullAssociations",
      "readPullClosingIssues",
      "readAssociationPull",
    ] as const
  ) {
    await t.step(method, async () => {
      const number = method === "readIssuePullAssociations" ? 1 : 7;
      const good = method === "readIssuePullAssociations"
        ? issuePage([])
        : method === "readPullClosingIssues"
        ? closingPage([])
        : restPull();
      for (
        const reply of [
          response({ message: "private" }, 403),
          response({}, 404),
          new Error("private"),
          { ...response({}), bodyText: "invalid" },
        ]
      ) {
        const result = await rig([reply]).client[method](number, UNTIL);
        assert.notEqual(result.status, "complete");
        assert.doesNotMatch(JSON.stringify(result), /private/);
      }
      const expired = rig([]);
      assert.deepEqual(await expired.client[method](number, T0), {
        status: "unavailable",
        reason: "deadline",
      });
      assert.equal(expired.requests.length, 0);
      assert.equal((await expired.client[method](0, UNTIL)).status, "invalid");
      const gated = rig([]);
      gated.cooldown.beforeRequest = () =>
        Promise.resolve(portError(
          "unavailable",
          "synthetic unavailable",
        ));
      assert.notEqual(
        (await gated.client[method](number, UNTIL)).status,
        "complete",
      );
      assert.equal(gated.requests.length, 0);
      const clock = new FakeClock();
      const source = rig([], { clock });
      let calls = 0;
      const client = new GitHubPrAssociationsClient({
        ...source.options,
        http: () => {
          calls++;
          clock.advance(10_000);
          return Promise.resolve(response(good));
        },
      }, null);
      assert.deepEqual(await client[method](number, UNTIL), {
        status: "unavailable",
        reason: "deadline",
      });
      assert.equal(calls, 1);
    });
  }
});

Deno.test("native association deadlines stop between pages without treating the partial list as empty", async () => {
  const clock = new FakeClock();
  const source = rig([], { clock });
  let calls = 0;
  const client = new GitHubPrAssociationsClient({
    ...source.options,
    http: () => {
      calls++;
      clock.advance(10_000);
      return Promise.resolve(response(issuePage([pull()], 2, "next")));
    },
  }, null);
  assert.deepEqual(await client.readIssuePullAssociations(1, UNTIL), {
    status: "unavailable",
    reason: "deadline",
  });
  assert.equal(calls, 1);
});

Deno.test("native association late page failures and stalled authentication never yield a partial success", async () => {
  const partial = rig([
    response(issuePage([pull()], 2, "next")),
    response({ message: "private permission detail" }, 403),
  ]);
  assert.deepEqual(await partial.client.readIssuePullAssociations(1, UNTIL), {
    status: "unavailable",
    reason: "permission",
  });
  assert.equal(partial.requests.length, 2);
  const stalled = rig([], {
    requestDeadlineMs: 5,
    auth: { authorizationHeader: () => new Promise(() => {}) },
  });
  assert.notEqual(
    (await stalled.client.readAssociationPull(7, UNTIL)).status,
    "complete",
  );
  assert.equal(stalled.requests.length, 0);
});
