/**
 * Batched live-input GraphQL read (issue #326), driven through the REAL
 * `GitHubApiClient` over the scripted HTTP transport (no network, no
 * credentials): one request answers every requested issue, pull request and
 * branch; NOT_FOUND aliases are explicit absences; every other GraphQL error,
 * a missing alias or a foreign repository fails closed instead of producing a
 * partial or empty success; more items than one chunk are read exhaustively.
 */
import assert from "node:assert/strict";

import { GitHubApiClient } from "../../src/github/client.ts";
import {
  buildLiveInputsChunks,
  LIVE_INPUTS_CHUNK,
} from "../../src/github/client-live-inputs.ts";
import {
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  httpRespond,
  REPO,
  ScriptedHttpTransport,
  type ScriptEntry,
  T0,
} from "./helpers.ts";

const HEAD = "6dc35d06e757107b91eb58232bd15e5f671d79b4";
const BASE = "aafb7ee0598699bb7fb8a72ea133693ed64462da";

function makeClient(script: ScriptEntry[]) {
  const transport = new ScriptedHttpTransport(script);
  const client = new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    http: transport.fetch.bind(transport),
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock: new FakeClock(T0),
  });
  return { client, transport };
}

function pullNode(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    state: "OPEN",
    headRefOid: HEAD,
    baseRefOid: BASE,
    baseRefName: "development",
    commits: {
      nodes: [{
        commit: { oid: HEAD, statusCheckRollup: { state: "SUCCESS" } },
      }],
    },
    reviews: { nodes: [{ fullDatabaseId: "901" }] },
    ...overrides,
  };
}

const REQUEST = {
  repository: REPO,
  issues: [7, 8],
  pulls: [40],
  branches: ["development"],
};

Deno.test("live inputs: one GraphQL request answers issues, pulls and the base tip", async () => {
  const { client, transport } = makeClient([
    httpRespond("POST", "/graphql", 200, {
      data: {
        repository: {
          i0: { number: 7, state: "OPEN" },
          i1: null,
          p0: pullNode(40),
          b0: { target: { oid: BASE } },
        },
      },
      errors: [{ type: "NOT_FOUND", path: ["repository", "i1"] }],
    }),
  ]);
  const result = await client.readLiveInputs(REQUEST);
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(transport.requests.length, 1);
  const body = JSON.parse(transport.requests[0].body ?? "{}");
  assert.match(body.query, /i0: issue\(number: 7\)/);
  assert.match(body.query, /p0: pullRequest\(number: 40\)/);
  assert.deepEqual(body.variables, {
    owner: REPO.owner,
    name: REPO.name,
    b0: "refs/heads/development",
  });
  assert.deepEqual(result.value.issues, [
    { number: 7, state: "open" },
    { number: 8, state: null },
  ]);
  assert.deepEqual(result.value.pulls, [{
    number: 40,
    pull: {
      number: 40,
      state: "open",
      head: HEAD,
      base: BASE,
      baseRef: "development",
      checks: "success",
      latestReview: 901,
    },
  }]);
  assert.deepEqual(result.value.branches, [{
    branch: "development",
    tip: BASE,
  }]);
});

Deno.test("live inputs: a rollup of another commit is unbound, none is none", async () => {
  const { client } = makeClient([
    httpRespond("POST", "/graphql", 200, {
      data: {
        repository: {
          p0: pullNode(40, {
            commits: {
              nodes: [{
                commit: { oid: BASE, statusCheckRollup: { state: "FAILURE" } },
              }],
            },
            reviews: { nodes: [] },
          }),
          p1: pullNode(41, {
            state: "MERGED",
            commits: {
              nodes: [{ commit: { oid: HEAD, statusCheckRollup: null } }],
            },
          }),
        },
      },
    }),
  ]);
  const result = await client.readLiveInputs({
    repository: REPO,
    issues: [],
    pulls: [41, 40],
    branches: [],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(
    result.value.pulls.map((row) => [
      row.number,
      row.pull?.state,
      row.pull?.checks,
      row.pull?.latestReview,
    ]),
    [[40, "open", "unbound", null], [41, "merged", "none", 901]],
  );
});

Deno.test("live inputs: GraphQL errors, missing aliases and a foreign repository fail closed", async () => {
  const cases: unknown[] = [
    {
      data: { repository: { i0: null, i1: null, p0: null, b0: null } },
      errors: [{ type: "FORBIDDEN", path: ["repository", "i0"] }],
    },
    { data: { repository: { i0: { number: 7, state: "OPEN" } } } },
    {
      data: {
        repository: {
          i0: null,
          i1: { number: 8, state: "OPEN" },
          p0: pullNode(40),
          b0: null,
        },
      },
    },
    {
      data: {
        repository: {
          i0: { number: 9, state: "OPEN" },
          i1: { number: 8, state: "OPEN" },
          p0: pullNode(40),
          b0: null,
        },
      },
    },
  ];
  for (const body of cases) {
    const { client } = makeClient([httpRespond("POST", "/graphql", 200, body)]);
    const result = await client.readLiveInputs(REQUEST);
    assert.equal(result.ok, false, JSON.stringify(body));
  }
  const failed = makeClient([httpRespond("POST", "/graphql", 502, {})]);
  const transport = await failed.client.readLiveInputs(REQUEST);
  assert.equal(transport.ok, false);

  const foreign = makeClient([]);
  const refused = await foreign.client.readLiveInputs({
    ...REQUEST,
    repository: { ...REPO, name: "other" },
  });
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.error.kind, "invalid");
  assert.equal(foreign.transport.requests.length, 0);
});

Deno.test("live inputs: more items than one chunk are read exhaustively", async () => {
  const issues = Array.from(
    { length: LIVE_INPUTS_CHUNK + 5 },
    (_, index) => index + 1,
  );
  const chunks = buildLiveInputsChunks({
    repository: REPO,
    issues,
    pulls: [],
    branches: ["development"],
  });
  assert.ok(chunks !== null);
  assert.equal(chunks.length, 2);
  const script = chunks.map((chunk) => {
    const repository: Record<string, unknown> = {};
    for (const item of chunk.items) {
      repository[item.alias] = item.kind === "issue"
        ? { number: item.number, state: "CLOSED" }
        : { target: { oid: BASE } };
    }
    return httpRespond("POST", "/graphql", 200, { data: { repository } });
  });
  const { client, transport } = makeClient(script);
  const result = await client.readLiveInputs({
    repository: REPO,
    issues,
    pulls: [],
    branches: ["development"],
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(transport.requests.length, 2);
  assert.equal(result.value.issues.length, issues.length);
  assert.ok(result.value.issues.every((row) => row.state === "closed"));
  assert.deepEqual(result.value.branches, [{
    branch: "development",
    tip: BASE,
  }]);

  // The second chunk failing fails the whole read (never a partial success).
  const partial = makeClient([
    script[0],
    httpRespond("POST", "/graphql", 500, {}),
  ]);
  const cut = await partial.client.readLiveInputs({
    repository: REPO,
    issues,
    pulls: [],
    branches: ["development"],
  });
  assert.equal(cut.ok, false);
});

Deno.test("live inputs: an invalid branch or number is refused before any request", async () => {
  for (
    const request of [
      { ...REQUEST, branches: ["../main"] },
      { ...REQUEST, issues: [0] },
      { ...REQUEST, pulls: [1.5] },
    ]
  ) {
    const { client, transport } = makeClient([]);
    const result = await client.readLiveInputs(request);
    assert.equal(result.ok, false);
    assert.equal(transport.requests.length, 0);
  }
});
