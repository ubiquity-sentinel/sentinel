/**
 * Issue #183: the trusted repair host posts one plain-language comment per
 * stage change on the source issue, idempotent by a hidden marker; an
 * unchanged record posts nothing and a comment failure never changes a record
 * or the cycle.
 */
import assert from "node:assert/strict";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import { runActionsTargetCycles } from "../../src/host/actions.ts";
import {
  postProgressComments,
  progressChanges,
  progressMarker,
  progressStage,
} from "../../src/host/progress-comments.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { REPO, SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { FakeGate } from "./actions-ci-fixture.ts";
import {
  makeTargetHostRig,
  targetCycleInput,
} from "./actions-target-fixture.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";

const CONFIG = { repository: REPO } as unknown as RepositoryConfigV1;
const BRANCH = "sentinel/repair/issue-1";

const queued = workRecord("issue-1", {
  related: { incidentId: null, issueNumber: 1 },
});
const started = workRecord("issue-1", {
  related: { incidentId: null, issueNumber: 1 },
  counters: { attempts: 1, retries: 0, reviewRounds: 0 },
  intent: {
    kind: "implementation",
    key: "implementation:issue-1",
    startedAt: T0,
    branch: BRANCH,
    expectedHead: null,
    observedBase: SHA1,
    pr: null,
    requestId: "reservation-1",
    resultId: null,
  },
});
const opened = workRecord("issue-1", {
  related: { incidentId: null, issueNumber: 1 },
  target: {
    base: SHA1,
    branch: BRANCH,
    checkpoint: null,
    head: SHA2,
    pr: 1258,
  },
  wait: { reason: "ci_pending", since: T0, until: T0 + 300_000 },
});
const parked = workRecord("issue-1", {
  related: { incidentId: null, issueNumber: 1 },
  nextStep: "blocked",
  blocker: {
    kind: "other",
    message: `candidate touches a protected path at ${SHA2}`,
    since: T0,
  },
});

Deno.test("progress: the stage table speaks plain words with short SHAs", () => {
  assert.equal(progressStage(queued), null, "a queued issue says nothing yet");
  assert.equal(
    progressStage(started)?.words,
    "Sentinel started working on this issue (attempt 1).",
  );
  assert.equal(
    progressStage(opened)?.words,
    "Sentinel opened pull request #1258 and is waiting for CI on it.",
  );
  const park = progressStage(parked)!;
  assert.match(park.words, /^Parked: candidate touches a protected path/);
  assert.match(park.words, /A person needs to fix this one\.$/);
  assert.doesNotMatch(park.words, /[0-9a-f]{11,}/);
  const closed = workRecord("issue-1", {
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "source issue is closed; the repair no longer exists",
      since: T0,
    },
  });
  assert.equal(
    progressStage(closed),
    null,
    "nothing is said on a closed issue",
  );
});

Deno.test("progress: only a changed stage of this repository reports", () => {
  assert.deepEqual(progressChanges([started], [started], REPO), []);
  assert.deepEqual(progressChanges([queued], [queued], REPO), []);
  const change = progressChanges([started], [opened], REPO);
  assert.equal(change.length, 1);
  assert.equal(change[0].issueNumber, 1);
  assert.equal(change[0].stage.key, "opened:1258:ci_pending");
  assert.equal(progressChanges([], [started], REPO).length, 1, "a new record");
  const other = { ...REPO, name: "passport.ubq.fi" };
  assert.deepEqual(progressChanges([started], [opened], other), []);
});

interface Sent {
  method: string;
  path: string;
  body: string | null;
}

function fakeHttp(comments: unknown[], postStatus = 201) {
  const sent: Sent[] = [];
  const http = (request: HttpRequestV1) => {
    const url = new URL(request.url);
    sent.push({
      method: request.method,
      path: url.pathname,
      body: request.body,
    });
    assert.equal(request.headers.get("authorization"), "Bearer target-token");
    if (request.method === "GET") {
      return Promise.resolve(
        new Response(JSON.stringify(comments), { status: 200 }),
      ).then(async (r) => ({
        status: r.status,
        headers: r.headers,
        bodyText: await r.text(),
      }));
    }
    return Promise.resolve({
      status: postStatus,
      headers: new Headers(),
      bodyText: "{}",
    });
  };
  return { http, sent };
}

function deps(
  http: ReturnType<typeof fakeHttp>["http"],
  gate = new FakeGate(),
) {
  return {
    http,
    clock: { now: () => T0 },
    gate,
    token: "target-token",
    deadline: T0 + 3_600_000,
    log: () => {},
  };
}

Deno.test("progress: a stage change posts exactly one comment with its marker", async () => {
  const { http, sent } = fakeHttp([{ body: "unrelated human comment" }]);
  const changes = progressChanges([started], [opened], REPO);
  const report = await postProgressComments(deps(http), CONFIG, changes);
  assert.equal(report.posted, 1);
  const posts = sent.filter((row) => row.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(
    posts[0].path,
    `/repos/${REPO.owner}/${REPO.name}/issues/1/comments`,
  );
  const body = JSON.parse(posts[0].body!).body as string;
  assert.ok(body.startsWith("Sentinel opened pull request #1258"));
  assert.ok(body.endsWith(progressMarker("issue-1", "opened:1258:ci_pending")));
});

Deno.test("progress: the latest same marker posts nothing; an older one does not count", async () => {
  const marker = progressMarker("issue-1", "opened:1258:ci_pending");
  const same = fakeHttp([{ body: `earlier\n\n${marker}` }]);
  const changes = progressChanges([started], [opened], REPO);
  const skipped = await postProgressComments(deps(same.http), CONFIG, changes);
  assert.equal(skipped.skipped, 1);
  assert.equal(same.sent.filter((row) => row.method === "POST").length, 0);
  // The stage moved on and back: only the LATEST marker decides.
  const moved = fakeHttp([
    { body: `x\n\n${marker}` },
    { body: `y\n\n${progressMarker("issue-1", "review:1258:1")}` },
  ]);
  const posted = await postProgressComments(deps(moved.http), CONFIG, changes);
  assert.equal(posted.posted, 1);
});

Deno.test("progress: a failed comment or a cooling gate never throws", async () => {
  const failing = fakeHttp([], 500);
  const changes = progressChanges([started], [opened], REPO);
  const failed = await postProgressComments(
    deps(failing.http),
    CONFIG,
    changes,
  );
  assert.equal(failed.failed, 1);
  assert.equal(failed.posted, 0);
  const gate = new FakeGate();
  gate.beforeRequest = () =>
    Promise.resolve({
      ok: false,
      error: { kind: "rate_limited", detail: "cooling" },
    });
  const cooled = fakeHttp([]);
  const stopped = await postProgressComments(
    deps(cooled.http, gate),
    CONFIG,
    changes,
  );
  assert.equal(stopped.stopped, "cooldown");
  assert.equal(cooled.sent.length, 0);
});

Deno.test("progress: the target cycle hands its before and after records to the reporter", async () => {
  const rig = makeTargetHostRig(["sentinel"]);
  const repo = rig.configs[0].repository;
  const before: WorkRecordV1 = { ...started, repository: repo };
  rig.state.repair = seededSnapshot([before]);
  rig.state.repairHead = SHA1;
  const seen: Array<[readonly WorkRecordV1[], readonly WorkRecordV1[]]> = [];
  const input = targetCycleInput(rig, {
    runCycle: async () => {
      const read = await rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      await rig.state.writeRepair({
        ...read.value.snapshot,
        sequence: read.value.snapshot.sequence + 1,
        work: [{ ...opened, repository: repo }],
      }, read.value.head);
      return { status: "idle" } as never;
    },
    progressComments: (_config, b, a) => {
      seen.push([b, a]);
      return Promise.reject(new Error("comment transport down"));
    },
  });
  const result = await runActionsTargetCycles(input);
  assert.equal(result.addressed.length, 1, "a reporter failure is never fatal");
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0][0].nextStep, "work");
  assert.equal(seen[0][0][0].intent?.kind, "implementation");
  assert.equal(seen[0][1][0].target.pr, 1258);
});
