import assert from "node:assert/strict";
import { resolveQueueAwareDelivery } from "../../ops/hosted-autonomy-queue-proof.ts";
import { POLICY, queueProofFacts } from "../host/merge-queue-proof-fixtures.ts";
import { GitHubMergeQueueEvidenceClient } from "../../src/github/client-merge-queue-evidence.ts";
import type { HttpResponseV1 } from "../../src/github/http.ts";
import {
  eventsWire,
  eventWire,
  membershipWire,
  PULL,
  QUEUE_REPO,
  queueClient,
  response,
} from "./merge-queue-fixtures.ts";
import { SHA2, SHA4 } from "./helpers.ts";

function runWire(overrides: Record<string, unknown> = {}) {
  return {
    id: 83,
    run_attempt: 1,
    head_sha: SHA4,
    event: "merge_group",
    workflow_id: 84,
    path: ".github/workflows/deno-deploy.yml",
    check_suite_id: 85,
    status: "completed",
    conclusion: "success",
    repository: { name: QUEUE_REPO.name, owner: { login: QUEUE_REPO.owner } },
    ...overrides,
  };
}
function checkWire(
  name: string,
  index: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 90 + index,
    check_suite: { id: 85 },
    head_sha: SHA4,
    name,
    app: { id: 15368 },
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}
const names = [
  "validate",
  "verify-artifact",
  "darwin-native",
  "mac-containment",
];
const checks = () => names.map((name, i) => checkWire(name, i));
const runPage = (rows = [runWire()], count = rows.length) =>
  response({ total_count: count, workflow_runs: rows });
const checkPage = (rows = checks(), count = rows.length, next?: string) =>
  response(
    { total_count: count, check_runs: rows },
    200,
    next === undefined ? {} : { link: `<${next}>; rel="next"` },
  );
function client(replies: readonly (HttpResponseV1 | Error)[]) {
  const fixture = queueClient(replies);
  return {
    ...fixture,
    client: new GitHubMergeQueueEvidenceClient(fixture.options, 84),
  };
}

Deno.test("queue group evidence binds exact workflow/event/revision/suite/App and reads every check page", async () => {
  const next =
    "https://api.github.com/repos/ubiquity/ai.ubq.fi/check-suites/85/check-runs?filter=latest&per_page=100&page=2";
  const pages = [
    checkPage(checks().slice(0, 2), 4, next),
    checkPage(checks().slice(2), 4),
  ];
  const fixture = client([runPage(), ...pages, ...pages, runPage()]);
  const result = await fixture.client.readMergeGroupRuns(SHA4);
  assert.equal(result.status, "complete");
  if (result.status !== "complete") return;
  assert.equal(result.value[0].checks.length, 4);
  assert.equal(result.value[0].checks[0].appId, 15368);
  assert.equal(
    new URL(fixture.requests[0].url).searchParams.get("event"),
    "merge_group",
  );
  assert.equal(
    new URL(fixture.requests[0].url).searchParams.get("head_sha"),
    SHA4,
  );
  assert.equal(fixture.requests.length, 6);
});

Deno.test("queue Actions evidence rejects partial, foreign, changing and capped listings", async (t) => {
  const cases = [
    { name: "missing run page", replies: [runPage([], 1)] },
    { name: "search platform cap", replies: [runPage([runWire()], 1000)] },
    {
      name: "wrong event",
      replies: [runPage([runWire({ event: "pull_request" })])],
    },
    {
      name: "wrong workflow",
      replies: [runPage([runWire({ workflow_id: 999 })])],
    },
    {
      name: "wrong revision",
      replies: [runPage([runWire({ head_sha: SHA2 })])],
    },
    {
      name: "wrong repository",
      replies: [
        runPage([
          runWire({
            repository: { name: "sentinel", owner: { login: "ubiquity" } },
          }),
        ]),
      ],
    },
    {
      name: "wrong check suite",
      replies: [
        runPage(),
        checkPage([checkWire("validate", 0, { check_suite: { id: 999 } })]),
      ],
    },
    {
      name: "wrong check head",
      replies: [
        runPage(),
        checkPage([checkWire("validate", 0, { head_sha: SHA2 })]),
      ],
    },
    {
      name: "check changed",
      replies: [
        runPage(),
        checkPage(),
        checkPage([
          checkWire("validate", 0, { conclusion: "failure" }),
          ...checks().slice(1),
        ]),
      ],
    },
    {
      name: "run attempt changed",
      replies: [
        runPage(),
        checkPage(),
        checkPage(),
        runPage([
          runWire({ run_attempt: 2, status: "in_progress", conclusion: null }),
        ]),
      ],
    },
    {
      name: "foreign pagination endpoint",
      replies: [
        runPage(),
        checkPage(
          checks().slice(0, 2),
          4,
          "https://api.github.com/repos/foreign/repo/issues?filter=latest&per_page=100&page=2",
        ),
      ],
    },
    { name: "permission", replies: [response({ message: "private" }, 403)] },
  ];
  for (const test of cases) {
    await t.step(test.name, async () => {
      const result = await client(test.replies).client.readMergeGroupRuns(SHA4);
      assert.notEqual(result.status, "complete");
      assert.doesNotMatch(JSON.stringify(result), /private/);
    });
  }
});

Deno.test("full queue delivery evidence rechecks merged PR and never invents runs before merge", async () => {
  const merged = response(
    membershipWire(null, { merged: true, mergeCommit: { oid: SHA4 } }),
  );
  const events = response(eventsWire([eventWire()]));
  const fixture = client([
    merged,
    events,
    events,
    runPage(),
    checkPage(),
    checkPage(),
    runPage(),
    merged,
  ]);
  const result = await fixture.client.readPullEvidence(PULL);
  assert.equal(result.status, "complete");
  if (result.status === "complete") {
    assert.equal(result.value.added.length, 1);
    assert.equal(result.value.mergeGroupRuns[0].head, SHA4);
    const facts = await queueProofFacts();
    facts.groupRuns = {
      status: "complete",
      value: result.value.mergeGroupRuns,
    };
    if (
      facts.queue.status !== "complete" || facts.queue.value === null ||
      result.value.added[0].actor === null
    ) throw new Error("fixture");
    facts.queue.value.enqueuer = result.value.added[0].actor;
    facts.queue.value.evidenceIds = result.value.added.map((event) => event.id);
    assert.equal(
      (await resolveQueueAwareDelivery(facts, POLICY)).status,
      "verified",
    );
  }
  const open = client([response(membershipWire())]);
  assert.deepEqual(await open.client.readPullEvidence(PULL), {
    status: "unavailable",
    reason: "incomplete",
  });
  assert.equal(open.requests.length, 1);
});

Deno.test("empty group listing is an authenticated result, not direct-merge provenance", async () => {
  const fixture = client([runPage([]), runPage([])]);
  assert.deepEqual(await fixture.client.readMergeGroupRuns(SHA4), {
    status: "complete",
    value: [],
  });
  assert.equal(fixture.requests.length, 2);
});
