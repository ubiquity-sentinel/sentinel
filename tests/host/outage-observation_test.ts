/**
 * C5.4 (2026-10-25 redesign): one deduplicated CI-outage notice per target on
 * Sentinel's own tracker while the target tip has only never-started CI; it
 * updates when the facts change, closes itself once a check starts again,
 * writes no state and is never admitted as a repair task.
 */
import assert from "node:assert/strict";
import {
  CI_OUTAGE_AUTHOR,
  ciOutageMarker,
  isCiOutageNotice,
} from "../../src/repair/ci-outage-notice.ts";
import {
  classifyTipChecks,
  createHostedOutageTracker,
  type OutageCheckRunV1,
  type OutageNoticeV1,
  type OutageTipStartV1,
  type OutageTrackerV1,
  runHostedOutageObservationPass,
} from "../../ops/hosted-autonomy-outage-observation.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy-types.ts";
import { MemoryState } from "../repair/helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "../repair/loop-rig.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const PASSPORT = {
  owner: "ubiquity",
  name: "passport.ubq.fi",
  installationId: 155_687_488,
} as const;
const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155_687_488,
} as const;
const OUTAGE: OutageTipStartV1 = { neverStarted: 4, started: 0, unknown: 0 };
const RUNNING: OutageTipStartV1 = { neverStarted: 0, started: 3, unknown: 0 };

interface FakeIssue extends OutageNoticeV1 {
  title: string;
  state: "open" | "closed";
  comments: string[];
}

class FakeTracker implements OutageTrackerV1 {
  issues: FakeIssue[] = [];
  writes = 0;
  unreadable = false;
  listOpenNotices() {
    if (this.unreadable) return Promise.resolve(null);
    return Promise.resolve(
      this.issues.filter((issue) =>
        issue.state === "open" &&
        issue.body.startsWith("<!-- sentinel:ci-outage:")
      ).map(({ number, author, body }) => ({ number, author, body })),
    );
  }
  file(input: { title: string; body: string }) {
    this.writes++;
    const number = this.issues.length + 1;
    this.issues.push({
      number,
      author: CI_OUTAGE_AUTHOR,
      title: input.title,
      body: input.body,
      state: "open",
      comments: [],
    });
    return Promise.resolve(number);
  }
  update(number: number, body: string) {
    this.writes++;
    this.issues[number - 1].body = body;
    return Promise.resolve(true);
  }
  close(number: number, comment: string) {
    this.writes++;
    this.issues[number - 1].comments.push(comment);
    this.issues[number - 1].state = "closed";
    return Promise.resolve(true);
  }
}

function harness() {
  const state = new MemoryState();
  state.repair = seededSnapshot([
    workRecord("p-1", { repository: PASSPORT }),
    workRecord("p-2", { repository: PASSPORT }),
    workRecord("p-3", {
      repository: PASSPORT,
      nextStep: "review",
      target: {
        base: SHA1,
        branch: "sentinel/repair/p-3",
        checkpoint: null,
        head: SHA2,
        pr: 13,
      },
    }),
    workRecord("p-done", {
      repository: PASSPORT,
      nextStep: "done",
    }),
    workRecord("a-1", { repository: AI }),
  ]);
  state.repairHead = SHA1;
  const tips = new Map<string, string>([
    ["ubiquity/passport.ubq.fi", "2cf5050f" + "0".repeat(32)],
    ["ubiquity/ai.ubq.fi", "a1" + "0".repeat(38)],
  ]);
  const starts = new Map<string, OutageTipStartV1 | null>([
    ["ubiquity/passport.ubq.fi", OUTAGE],
    ["ubiquity/ai.ubq.fi", RUNNING],
  ]);
  const deps = {
    state,
    clock: { now: () => T0 },
    githubFor: (repository: { owner: string; name: string }) => {
      const slug = `${repository.owner}/${repository.name}`;
      return {
        readDefaultBranch: () => Promise.resolve("main"),
        readBaseTip: (branch: string) =>
          Promise.resolve(branch === "main" ? tips.get(slug) ?? null : null),
      } as unknown as HostedAutonomyGitHubV1;
    },
  } as unknown as HostedAutonomyDepsV1;
  const tracker = new FakeTracker();
  const classified: string[] = [];
  const pass = () =>
    runHostedOutageObservationPass(deps, {
      tracker,
      classifyTip: (repository, tip) => {
        const slug = `${repository.owner}/${repository.name}`;
        classified.push(`${slug}@${tip}`);
        return Promise.resolve(starts.get(slug) ?? null);
      },
    });
  return { state, tips, starts, tracker, classified, pass };
}

Deno.test("outage observation: one notice is filed, kept without writes, updated on new facts and closed on recovery", async () => {
  const h = harness();
  const head = h.state.repairHead;
  assert.deepEqual(await h.pass(), [
    "ci-outage:ubiquity/passport.ubq.fi:outage:filed=#1",
  ]);
  assert.equal(h.tracker.issues.length, 1);
  const notice = h.tracker.issues[0];
  const lines = notice.body.split("\n");
  assert.equal(
    lines[0],
    "<!-- sentinel:ci-outage:ubiquity/passport.ubq.fi -->",
  );
  assert.equal(lines[0], ciOutageMarker(PASSPORT));
  assert.equal(
    notice.title,
    "GitHub Actions cannot start CI on ubiquity/passport.ubq.fi",
  );
  assert.ok(
    notice.body.includes(`- Tip: ${h.tips.get("ubiquity/passport.ubq.fi")}`),
  );
  assert.ok(notice.body.includes("- Checks that never started: 4"));
  assert.ok(
    notice.body.includes("- Sentinel records waiting in this repository: 3"),
  );
  assert.ok(
    notice.body.includes(
      "Owner action: restore Actions billing or raise the spending limit for ubiquity.",
    ),
  );

  // Deduplicated: the same facts write nothing.
  assert.deepEqual(await h.pass(), [
    "ci-outage:ubiquity/passport.ubq.fi:outage:open=#1",
  ]);
  assert.equal(h.tracker.writes, 1);

  // A new tip in the same outage updates the one notice.
  h.tips.set("ubiquity/passport.ubq.fi", "95765554" + "0".repeat(32));
  assert.deepEqual(await h.pass(), [
    "ci-outage:ubiquity/passport.ubq.fi:outage:updated=#1",
  ]);
  assert.equal(h.tracker.issues.length, 1);
  assert.ok(h.tracker.issues[0].body.includes("95765554"));

  // Undetermined (a queued check) changes nothing.
  h.starts.set("ubiquity/passport.ubq.fi", {
    neverStarted: 2,
    started: 0,
    unknown: 1,
  });
  assert.deepEqual(await h.pass(), []);
  assert.equal(h.tracker.writes, 2);

  // A started check closes the notice once, with one comment.
  h.starts.set("ubiquity/passport.ubq.fi", RUNNING);
  assert.deepEqual(await h.pass(), [
    "ci-outage:ubiquity/passport.ubq.fi:recovered:closed=#1",
  ]);
  assert.equal(h.tracker.issues[0].state, "closed");
  assert.equal(h.tracker.issues[0].comments.length, 1);
  assert.deepEqual(await h.pass(), []);
  assert.equal(h.tracker.writes, 3);
  assert.equal(h.state.repairHead, head, "the pass writes no state");
});

Deno.test("outage observation: a foreign marker, an unreadable tracker or tip and an absent tracker file nothing", async () => {
  const foreign = harness();
  foreign.tracker.issues.push({
    number: 1,
    author: "someone",
    title: "copy",
    body: ciOutageMarker(PASSPORT) + "\nnot ours",
    state: "open",
    comments: [],
  });
  assert.deepEqual(await foreign.pass(), [
    "ci-outage:ubiquity/passport.ubq.fi:outage:foreign_notice=#1",
  ]);
  assert.equal(foreign.tracker.writes, 0);

  const unreadable = harness();
  unreadable.tracker.unreadable = true;
  assert.deepEqual(await unreadable.pass(), ["ci-outage:notices_unreadable"]);
  assert.deepEqual(
    unreadable.classified,
    [],
    "no tip read without the tracker",
  );

  const tip = harness();
  tip.tips.delete("ubiquity/passport.ubq.fi");
  tip.starts.set("ubiquity/ai.ubq.fi", null);
  assert.deepEqual(await tip.pass(), [
    "ci-outage:ubiquity/ai.ubq.fi:checks_unreadable",
    "ci-outage:ubiquity/passport.ubq.fi:tip_unreadable",
  ]);
  assert.equal(tip.tracker.writes, 0);

  const absent = harness();
  assert.deepEqual(
    await runHostedOutageObservationPass(
      { state: absent.state, clock: { now: () => T0 } } as never,
      { tracker: null, classifyTip: () => Promise.resolve(OUTAGE) },
    ),
    ["ci-outage:skipped:tracker_absent"],
  );
});

function run(
  status: string,
  conclusion: string | null,
  id = 1,
): OutageCheckRunV1 {
  return { id, name: `check-${id}`, status, conclusion };
}

Deno.test("outage observation: recovery closes every notice Sentinel filed for the target", async () => {
  const h = harness();
  h.starts.set("ubiquity/passport.ubq.fi", RUNNING);
  for (const author of [CI_OUTAGE_AUTHOR, "github-actions[bot]", "someone"]) {
    h.tracker.issues.push({
      number: h.tracker.issues.length + 1,
      author,
      title: "notice",
      body: ciOutageMarker(PASSPORT) + "\nold",
      state: "open",
      comments: [],
    });
  }
  assert.deepEqual(await h.pass(), [
    "ci-outage:ubiquity/passport.ubq.fi:recovered:closed=#1",
    "ci-outage:ubiquity/passport.ubq.fi:recovered:closed=#2",
  ]);
  assert.deepEqual(h.tracker.issues.map((issue) => issue.state), [
    "closed",
    "closed",
    "open",
  ]);
});

Deno.test("outage observation: only completed failures ask the injected never-started predicate", async () => {
  const asked: number[] = [];
  const never = (r: OutageCheckRunV1) => {
    asked.push(r.id);
    return Promise.resolve("not_started" as const);
  };
  // The billing shape: failed jobs that never started, their dependents skipped.
  assert.deepEqual(
    await classifyTipChecks([
      run("completed", "failure", 1),
      run("completed", "startup_failure", 2),
      run("completed", "skipped", 3),
      run("completed", "cancelled", 4),
    ], never),
    { neverStarted: 2, started: 0, unknown: 0 },
  );
  assert.deepEqual(asked, [1, 2]);
  assert.deepEqual(
    await classifyTipChecks([
      run("completed", "failure", 1),
      run("completed", "success", 2),
      run("in_progress", null, 3),
      run("queued", null, 4),
    ], never),
    { neverStarted: 1, started: 2, unknown: 1 },
  );
  assert.deepEqual(
    await classifyTipChecks(
      [run("completed", "failure", 1), run("completed", "timed_out", 2)],
      (r) =>
        r.id === 1
          ? Promise.resolve("started" as const)
          : Promise.reject(new Error("job read failed")),
    ),
    { neverStarted: 0, started: 1, unknown: 1 },
  );
});

Deno.test("outage observation: the tracker adapter binds every answer to Sentinel's own repository", async () => {
  const url = "https://api.github.com/repos/ubiquity-sentinel/sentinel";
  const item = (number: number, body: string, extra = {}) => ({
    number,
    body,
    repository_url: url,
    user: { login: CI_OUTAGE_AUTHOR },
    title: "t",
    ...extra,
  });
  const calls: string[] = [];
  const bodies: unknown[] = [];
  let closeAnswer: unknown = { number: 1, state: "closed" };
  let listing: unknown = [
    item(1, ciOutageMarker(PASSPORT) + "\nbody"),
    item(2, "ordinary issue"),
    item(3, ciOutageMarker(AI), { pull_request: {} }),
  ];
  const tracker = createHostedOutageTracker(
    (method, path, body) => {
      calls.push(`${method} ${path}`);
      bodies.push(body);
      if (method === "GET") return Promise.resolve(listing);
      if (method === "POST" && path.endsWith("/issues")) {
        return Promise.resolve(
          item(9, String(body?.body), { title: body?.title }),
        );
      }
      if (method === "PATCH") return Promise.resolve(closeAnswer);
      return Promise.resolve({});
    },
    { owner: "ubiquity-sentinel", name: "sentinel" },
  );
  assert.deepEqual(
    (await tracker.listOpenNotices())?.map((notice) => notice.number),
    [1],
  );
  listing = [
    item(1, "x", { repository_url: "https://api.github.com/repos/x/y" }),
  ];
  assert.equal(
    await tracker.listOpenNotices(),
    null,
    "a foreign item is unproven",
  );
  assert.equal(await tracker.file({ title: "t", body: "b" }), 9);
  // Filed with the skip label every runtime's intake honours.
  assert.deepEqual(bodies.at(-1), {
    title: "t",
    body: "b",
    labels: ["sentinel:skip"],
  });
  // A close that fails adds no comment; a confirmed close comments after.
  calls.length = 0;
  closeAnswer = { number: 1, state: "open" };
  assert.equal(await tracker.close(1, "recovered"), false);
  assert.deepEqual(calls, ["PATCH /repos/ubiquity-sentinel/sentinel/issues/1"]);
  calls.length = 0;
  closeAnswer = { number: 1, state: "closed" };
  assert.equal(await tracker.close(1, "recovered"), true);
  assert.deepEqual(calls, [
    "PATCH /repos/ubiquity-sentinel/sentinel/issues/1",
    "POST /repos/ubiquity-sentinel/sentinel/issues/1/comments",
  ]);
});

Deno.test("outage observation: intake never admits the App's notice as a task", async () => {
  const notice = ciOutageMarker(PASSPORT) + "\nrestore billing";
  assert.equal(
    isCiOutageNotice({ body: notice, author: CI_OUTAGE_AUTHOR }),
    true,
  );
  assert.equal(isCiOutageNotice({ body: notice, author: "someone" }), false);
  assert.equal(
    isCiOutageNotice({ body: notice, author: "github-actions[bot]" }),
    true,
    "the maintenance job's native-token fallback is Sentinel's own too",
  );
  assert.equal(
    isCiOutageNotice({
      body: "<!-- sentinel:ci-outage:bad -->",
      author: CI_OUTAGE_AUTHOR,
    }),
    false,
  );
  const github = new RelationsFakeGithub({ baseSha: SHA1 });
  github.listed = [
    issueRecord(1),
    issueRecord(2, { body: notice, author: CI_OUTAGE_AUTHOR }),
    issueRecord(3, { body: notice, author: "someone" }),
  ];
  for (const issue of github.listed) github.latest.set(issue.number, issue);
  const rig = makeMemoryRig(github);
  const original = console.log;
  console.log = () => {};
  try {
    await rig.run(1);
  } finally {
    console.log = original;
  }
  assert.deepEqual(
    (await rig.snapshot()).work.map((row) => row.related.issueNumber),
    [1, 3],
  );
});
