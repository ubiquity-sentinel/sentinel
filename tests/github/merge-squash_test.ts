// Per-target squash delivery (#331): the runtime merge port squashes where
// the trusted policy and the repository allow it, with the pull request title
// and its `Resolves #N` line as the commit, under the unchanged expected-head
// guard; a squash result is booked by its exact merge SHA, single parent and
// tree, never by a parent chain squash does not produce. An invalid policy
// refuses with its precise reason and a target that forbids squash keeps merge
// commits. All fixtures are synthetic; no real external service is contacted.
import assert from "node:assert/strict";
import {
  checkRunWire,
  FakeReviewService,
  httpRespond,
  issueWire,
  makePort,
  mergeResponseWire,
  reviewDecisionGraphqlWire,
  type ScriptEntry,
  SHA1,
  SHA2,
  SHA3,
  SHA4,
  structuredCompletedFixture,
} from "./helpers.ts";
import {
  baseTipRead,
  checksRead,
  CLEAN_OPERATION_KEY,
  CLOCK,
  commentsRead,
  commitPath,
  completedCleanReceipt,
  mergeParentsRead,
  mergeRequest,
  pullEntry,
  putCount,
  repoSettingsRead,
  reviewsRead,
  rulesRead,
} from "./merge-helpers.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { ReviewTaskAcceptanceV1 } from "../../src/contracts/review-receipt.ts";
import {
  parseTargetDeliveryPolicyV1,
  targetDeliveryPolicyV1,
} from "../../src/contracts/target-delivery.ts";
import type { GitSha } from "../../src/contracts/brands.ts";

const ISSUE = 7;
const TITLE = "Fix the merge shape";
const MERGE_PATH = "/repos/ubiquity-sentinel/sentinel/pulls/1/merge";

const acceptance: ReviewTaskAcceptanceV1 = {
  issueNumber: ISSUE,
  taskDigest: await reviewTaskStatementDigest({
    issueNumber: ISSUE,
    title: "an issue",
    body: "issue body",
  }),
  verdict: "fulfilled",
  evidence: ["the candidate implements the issue requirements"],
};
const completion = await structuredCompletedFixture({
  operationKey: CLEAN_OPERATION_KEY,
  result: {
    verdict: "clean",
    summary: "no issues found",
    findings: [],
    taskAcceptance: acceptance,
  },
});

/** The head commit's own tree, read for the squash proof. */
function headTreeRead(tree: GitSha): ScriptEntry {
  return {
    ...httpRespond("GET", commitPath(SHA1), 200, {
      sha: SHA1,
      tree: { sha: tree },
      parents: [{ sha: SHA2 }],
    }),
    repeat: true,
  };
}

interface Options {
  settings?: ScriptEntry[];
  parents?: readonly GitSha[];
  headTree?: GitSha;
  policies?: Readonly<Record<string, unknown>>;
  baseTip?: GitSha;
}

function squashPort(options: Options = {}) {
  const pull = { title: TITLE, body: `Resolves #${ISSUE}` };
  const script: ScriptEntry[] = [
    pullEntry(pull),
    pullEntry(pull),
    reviewsRead([completion.review]),
    commentsRead([]),
    ...rulesRead(),
    ...checksRead([checkRunWire()], false, []),
    {
      ...httpRespond(
        "POST",
        "/graphql",
        200,
        reviewDecisionGraphqlWire("APPROVED"),
      ),
      repeat: true,
    },
    httpRespond("GET", `/issues/${ISSUE}`, 200, issueWire()),
    ...(options.settings ?? [repoSettingsRead(true)]),
    baseTipRead(options.baseTip ?? SHA2),
    // The squash commit SHA3: tree SHA4, parents exactly [reviewed base].
    mergeParentsRead(SHA3, options.parents ?? [SHA2]),
    headTreeRead(options.headTree ?? SHA4),
    httpRespond("PUT", MERGE_PATH, 200, mergeResponseWire(SHA3)),
  ];
  const service = new FakeReviewService();
  service.readResult = completion.service;
  return makePort({
    clock: CLOCK,
    script,
    review: service,
    deliveryPolicies: options.policies,
  });
}

function call(port: ReturnType<typeof makePort>["port"]) {
  return port.mergePullRequest(mergeRequest({
    review: completedCleanReceipt({ taskAcceptance: acceptance }),
  }));
}

function putBody(transport: ReturnType<typeof makePort>["transport"]) {
  const put = transport.requests.find((request) => request.method === "PUT");
  assert.ok(put !== undefined, "one merge call");
  return JSON.parse(put.body ?? "{}");
}

Deno.test("squash delivery: the default policy squashes the reviewed head with the exact title and Resolves line", async () => {
  const { port, transport } = squashPort();
  const result = await call(port);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  // Booked by the exact merge response SHA on [reviewed base] with the
  // reviewed head's tree.
  assert.deepEqual(result.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.equal(putCount(transport), 1);
  // The expected-head guard is the reviewed head SHA, unchanged.
  assert.deepEqual(putBody(transport), {
    sha: SHA1,
    merge_method: "squash",
    commit_title: TITLE,
    commit_message: `Resolves #${ISSUE}`,
  });
  // The settings read precedes the base re-read, which stays the last read
  // before the merge call.
  const urls = transport.requests.map((r) => `${r.method} ${r.url}`);
  const put = urls.findIndex((u) => u.startsWith("PUT "));
  assert.ok(
    urls[put - 1].endsWith("/git/ref/heads/development"),
    urls[put - 1],
  );
  assert.ok(
    urls.findIndex((u) => u.endsWith("/repos/ubiquity-sentinel/sentinel")) <
      put - 1,
  );
});

Deno.test("squash delivery: a squash whose tree is not the reviewed head's tree is off-tip", async () => {
  const { port } = squashPort({ headTree: SHA2 });
  const result = await call(port);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "merged_off_tip",
    head: SHA1,
    mergeSha: SHA3,
    parents: [SHA2],
  });
});

Deno.test("squash delivery: a squash onto another parent is off-tip without a tree claim", async () => {
  const { port } = squashPort({ parents: [SHA4] });
  const result = await call(port);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.outcome, "merged_off_tip");
});

Deno.test("squash delivery: a moved base is still refused before any merge call", async () => {
  const { port, transport } = squashPort({ baseTip: SHA4 });
  const result = await call(port);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.equal(result.value.outcome, "blocked");
  assert.equal(putCount(transport), 0);
});

Deno.test("squash delivery: a target that forbids squash keeps the merge commit", async () => {
  const { port, transport } = squashPort({
    settings: [repoSettingsRead(false)],
    parents: [SHA2, SHA1],
  });
  const result = await call(port);
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    outcome: "merged",
    head: SHA1,
    mergeSha: SHA3,
  });
  assert.deepEqual(putBody(transport), { sha: SHA1, merge_method: "merge" });
});

Deno.test("squash delivery: an explicit merge policy needs no repository setting", async () => {
  const { port, transport } = squashPort({
    settings: [],
    parents: [SHA2, SHA1],
    policies: { "ubiquity-sentinel/sentinel": { mergeMethod: "merge" } },
  });
  const result = await call(port);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(putBody(transport), { sha: SHA1, merge_method: "merge" });
  assert.ok(
    !transport.requests.some((r) =>
      r.url.endsWith("/repos/ubiquity-sentinel/sentinel")
    ),
  );
});

Deno.test("squash delivery: an invalid policy value refuses the merge with its precise reason", async () => {
  for (
    const row of [
      { mergeMethod: "rebase" },
      { mergeMethod: "SQUASH" },
      { mergeMethod: "squash", extra: true },
      "squash",
      null,
    ]
  ) {
    const { port, transport } = squashPort({
      policies: { "ubiquity-sentinel/sentinel": row },
    });
    const result = await call(port);
    assert.equal(result.ok, false, JSON.stringify(result));
    if (result.ok) return;
    assert.equal(result.error.kind, "invalid");
    assert.match(result.error.detail, /^target delivery policy /);
    assert.equal(putCount(transport), 0, "never falls back to another method");
  }
});

Deno.test("squash delivery: an unreadable repository setting never merges", async () => {
  const { port, transport } = squashPort({
    settings: [{
      ...httpRespond("GET", "/repos/ubiquity-sentinel/sentinel", 500, {}),
      repeat: true,
    }],
  });
  const result = await call(port);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(putCount(transport), 0);
});

Deno.test("target delivery policy: default squash, strict rows, case-insensitive identity", () => {
  assert.deepEqual(targetDeliveryPolicyV1({ owner: "ubiquity", name: "x" }), {
    ok: true,
    policy: { mergeMethod: "squash" },
  });
  assert.deepEqual(
    targetDeliveryPolicyV1({ owner: "Ubiquity", name: "Passport.ubq.fi" }, {
      "ubiquity/passport.ubq.fi": { mergeMethod: "merge" },
    }),
    { ok: true, policy: { mergeMethod: "merge" } },
  );
  assert.equal(parseTargetDeliveryPolicyV1({}).ok, false);
  assert.equal(parseTargetDeliveryPolicyV1([]).ok, false);
});
