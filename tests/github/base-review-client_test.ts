/** Authenticated REST boundaries for base CI and issue-only native evidence. */
import assert from "node:assert/strict";
import { GitHubApiClient } from "../../src/github/client.ts";
import { baseReviewCommentBody } from "../../src/github/base-review-comments.ts";
import {
  checkRunWire,
  checksPageWire,
  FakeAuthProvider,
  FakeClock,
  FakeCooldownGate,
  httpRespond,
  httpThrow,
  REPO,
  ScriptedHttpTransport,
  type ScriptEntry,
  SHA1,
  SHA2,
  T0,
} from "./helpers.ts";

function fixture(script: ScriptEntry[]) {
  const http = new ScriptedHttpTransport(script);
  const client = new GitHubApiClient({
    repository: REPO,
    apiBaseUrl: "https://api.github.com",
    http: http.fetch.bind(http),
    auth: new FakeAuthProvider(),
    cooldownGate: new FakeCooldownGate(),
    clock: new FakeClock(T0),
  });
  return { client, http };
}

const CHECKS = `/commits/${SHA1}/check-runs`;
const APP = { id: 15368, slug: "github-actions" };
const ISSUE =
  "https://api.github.com/repos/ubiquity-sentinel/sentinel/issues/163";
const BODY = baseReviewCommentBody({
  verdict: "clean",
  findings: [],
  summary: "Verified base task",
});
function comment(overrides: Record<string, unknown> = {}) {
  return {
    id: 71,
    body: BODY,
    user: { login: "ubiquity-sentinel[bot]" },
    issue_url: ISSUE,
    ...overrides,
  };
}

Deno.test("base CI client: selected Actions jobs survive unrelated long supervisor names", async () => {
  const { client, http } = fixture([
    httpRespond(
      "GET",
      CHECKS,
      200,
      checksPageWire([
        checkRunWire({ name: `supervisor ${"long ".repeat(20)}`, app: APP }),
        checkRunWire({ name: "test-local", app: APP }),
      ]),
    ),
  ]);
  const read = await client.readBaseReviewChecks(SHA1, ["test-local"]);
  assert.ok(read.ok);
  assert.equal(read.value.checks.length, 1);
  assert.equal(read.value.checks[0].name, "test-local");
  assert.equal(http.requests.length, 1);
});

Deno.test("base CI client: foreign commit or same-name foreign App never proves base CI", async () => {
  for (
    const overrides of [
      { head_sha: SHA2, app: APP },
      { app: { id: 99, slug: "github-actions" } },
      { app: { id: 15368, slug: "another-app" } },
      { app: null },
    ]
  ) {
    const { client } = fixture([
      httpRespond(
        "GET",
        CHECKS,
        200,
        checksPageWire([checkRunWire({ name: "test-local", ...overrides })]),
      ),
    ]);
    assert.equal(
      (await client.readBaseReviewChecks(SHA1, ["test-local"])).ok,
      false,
    );
  }
});

Deno.test("base evidence client: only exact issue comment create/read endpoints are used", async () => {
  const { client, http } = fixture([
    httpRespond("POST", "/issues/163/comments", 201, comment()),
    httpRespond("GET", "/issues/comments/71", 200, comment()),
  ]);
  const created = await client.createBaseReviewComment(163, BODY);
  assert.ok(created.ok);
  const read = await client.readBaseReviewComment(163, created.value.id);
  assert.deepEqual(read, created);
  assert.deepEqual(JSON.parse(http.requests[0].body!), { body: BODY });
  assert.ok(http.requests.every((row) => !row.url.includes("/pulls/")));
});

Deno.test("base evidence client: foreign issue comments and ambiguous writes fail without retry", async () => {
  const wrong = fixture([
    httpRespond(
      "GET",
      "/issues/comments/71",
      200,
      comment({ issue_url: ISSUE.replace("163", "164") }),
    ),
  ]);
  assert.equal((await wrong.client.readBaseReviewComment(163, 71)).ok, false);
  const lost = fixture([httpThrow("POST", "/issues/163/comments")]);
  assert.equal(
    (await lost.client.createBaseReviewComment(163, BODY)).ok,
    false,
  );
  assert.equal(lost.http.requests.length, 1);
});
