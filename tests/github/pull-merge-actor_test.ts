import assert from "node:assert/strict";
import { httpRespond, makePort, pullWire, SHA3 } from "./helpers.ts";

const PULLS = "/repos/ubiquity-sentinel/sentinel/pulls";
const ACTOR = "human-merger";

function mergedPull(overrides: Record<string, unknown> = {}) {
  return pullWire({
    number: 7,
    state: "closed",
    merged_at: "2026-09-07T02:00:00Z",
    merge_commit_sha: SHA3,
    ...overrides,
  });
}

async function readPull(overrides: Record<string, unknown>) {
  const { client } = makePort({
    script: [httpRespond("GET", `${PULLS}/7`, 200, mergedPull(overrides))],
  });
  return await client.readPullRequest(7);
}

Deno.test("readPullRequest: preserves the merge actor separately from the author", async () => {
  const result = await readPull({ merged_by: { login: ACTOR } });
  assert.ok(result.ok && result.value !== null);
  assert.equal(result.value.mergedBy, ACTOR);
  assert.notEqual(result.value.mergedBy, result.value.author);
});

Deno.test("listPullRequestsByHeadRef: preserves the merge actor", async () => {
  const { client } = makePort({
    script: [
      httpRespond("GET", PULLS, 200, [
        mergedPull({ merged_by: { login: ACTOR } }),
      ]),
    ],
  });
  const result = await client.listPullRequestsByHeadRef("sentinel/fix-1");
  assert.ok(result.ok);
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].mergedBy, ACTOR);
});

Deno.test("readPullRequest: unavailable merge actors stay null, never the author", async () => {
  for (const mergedBy of [undefined, null, { login: null }]) {
    const result = await readPull({ merged_by: mergedBy });
    assert.ok(result.ok && result.value !== null);
    assert.equal(result.value.mergedBy, null);
    assert.notEqual(result.value.author, null);
  }
});

Deno.test("readPullRequest: malformed merge actors fail closed", async () => {
  for (const mergedBy of [ACTOR, {}, { login: 42 }, { login: "" }]) {
    const result = await readPull({ merged_by: mergedBy });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.kind, "invalid");
  }
});
