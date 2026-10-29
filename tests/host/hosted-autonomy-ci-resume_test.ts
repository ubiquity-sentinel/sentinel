/**
 * The launcher's CI resume pass: CI that GitHub never started (a billing or
 * spending-limit stop, live Passport 2026-10-24) resumes by itself once
 * billing is restored. For each foreign target with a head Sentinel waits on
 * for CI (a live `ci_pending`/`backoff` wait or a pre-review CI park), the
 * pass re-runs the failed jobs of every run of the base tip and of those
 * heads when every failed job of its latest attempt never started, at most
 * once per run per 30 minutes (the run's own completion time, no state) and
 * within per-pass bounds. During a stop (no listed run ran a job recently)
 * the wait doubles per attempt up to 12 hours, and a run at attempt 40 is
 * never asked again, so GitHub's 50 re-runs per run are not spent (stage-1
 * review, 2026-10-25). The pass writes no state.
 */
import assert from "node:assert/strict";
import {
  ciResumeActive,
  ciResumeDue,
  ciResumeInterval,
  ciResumeRuns,
  ciResumeTargets,
  HOSTED_CI_RESUME_INTERVAL_MS,
  HOSTED_CI_RESUME_MAX_ATTEMPT_MS,
  HOSTED_CI_RESUME_MAX_BACKOFF_MS,
  HOSTED_CI_RESUME_MAX_RUN_ATTEMPT,
  HOSTED_CI_RESUME_RERUNS_PER_PASS,
  runHostedCiResumePass,
} from "../../ops/hosted-autonomy-ci-resume.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadRunV1,
} from "../../ops/hosted-autonomy-types.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  GATEWAY,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  NOW,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** The never-started attempt ended 31 minutes before the pass. */
const ENDED = NOW - 31 * MINUTE;

/**
 * A completed failed run whose latest attempt took two seconds and ended at
 * `updatedAt` (default `ENDED`), as a never-started attempt does.
 */
function headRun(
  id: number,
  headSha: string,
  overrides: Partial<HostedAutonomyHeadRunV1> = {},
): HostedAutonomyHeadRunV1 {
  const ended = typeof overrides.updatedAt === "number"
    ? overrides.updatedAt
    : ENDED;
  return {
    id,
    headSha,
    status: "completed",
    conclusion: "failure",
    runAttempt: 1,
    createdAt: ENDED - 2_000,
    attemptStartedAt: ended - 2_000,
    updatedAt: ENDED,
    workflowId: 7,
    ...overrides,
  };
}

/** A live record waiting at `work` on CI for its published head. */
function waiting(issue: number, name = "ai.ubq.fi"): WorkRecordV1 {
  return liveRecord(issue, {
    nextStep: "work",
    blocker: null,
    wait: { reason: "ci_pending", since: NOW - HOUR, until: NOW + MINUTE },
  }, name);
}

Deno.test("CI resume: a run is due once its never-started attempt ended 30 minutes ago", () => {
  const run = headRun(1, TIP);
  assert.equal(ciResumeDue(run, ENDED + HOSTED_CI_RESUME_INTERVAL_MS), true);
  assert.equal(
    ciResumeDue(run, ENDED + HOSTED_CI_RESUME_INTERVAL_MS - 1),
    false,
    "asked again at most once per 30 minutes",
  );
  const notDue: Partial<HostedAutonomyHeadRunV1>[] = [
    { updatedAt: null },
    { updatedAt: undefined },
    { attemptStartedAt: null },
    { attemptStartedAt: ENDED - HOSTED_CI_RESUME_MAX_ATTEMPT_MS - 1 },
    { attemptStartedAt: ENDED + 1 },
    { status: "in_progress", conclusion: null },
    { conclusion: "success" },
    { conclusion: "cancelled" },
    { conclusion: "timed_out" },
    { createdAt: NOW - 30 * 24 * HOUR },
  ];
  for (const overrides of notDue) {
    assert.equal(
      ciResumeDue(headRun(1, TIP, overrides), NOW),
      false,
      JSON.stringify(overrides),
    );
  }
  assert.equal(ciResumeDue(run, Number.NaN), false);
});

Deno.test("CI resume: during a stop the wait doubles per attempt and a run near GitHub's cap is never asked", () => {
  const at = (runAttempt: number, active = false) =>
    ciResumeInterval(headRun(1, TIP, { runAttempt }), active);
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7, 39].map((attempt) => at(attempt) / MINUTE),
    [30, 60, 120, 240, 480, 720, 720, 720],
  );
  assert.equal(HOSTED_CI_RESUME_MAX_BACKOFF_MS, 12 * HOUR);
  assert.equal(at(9, true), HOSTED_CI_RESUME_INTERVAL_MS, "Actions runs again");
  const third = headRun(1, TIP, { runAttempt: 3 });
  assert.equal(ciResumeDue(third, NOW), false, "ended 31 minutes ago");
  assert.equal(ciResumeDue(third, ENDED + 2 * HOUR), true);
  assert.equal(ciResumeDue(third, NOW, true), true);
  for (const runAttempt of [HOSTED_CI_RESUME_MAX_RUN_ATTEMPT, 49, 50, 60]) {
    const capped = headRun(1, TIP, { runAttempt });
    assert.equal(ciResumeDue(capped, NOW, true), false, String(runAttempt));
    assert.equal(ciResumeDue(capped, NOW + 24 * HOUR), false);
  }
  assert.equal(
    ciResumeDue(headRun(1, TIP, { runAttempt: 39 }), NOW, true),
    true,
  );
});

Deno.test("CI resume: a run that ran a job recently shows Actions running", () => {
  const ran = (startedAgo: number, endedAgo: number) =>
    headRun(1, TIP, {
      conclusion: "success",
      attemptStartedAt: NOW - startedAgo,
      updatedAt: NOW - endedAgo,
    });
  assert.equal(ciResumeActive(ran(10 * MINUTE, 5 * MINUTE), NOW), true);
  assert.equal(
    ciResumeActive(ran(3 * HOUR, 2 * HOUR), NOW),
    false,
    "a run from before the stop",
  );
  assert.equal(
    ciResumeActive(headRun(1, TIP, { updatedAt: NOW - MINUTE }), NOW),
    false,
    "a never-started attempt",
  );
  assert.equal(
    ciResumeActive(
      headRun(1, TIP, {
        status: "in_progress",
        conclusion: null,
        attemptStartedAt: NOW - 5 * MINUTE,
      }),
      NOW,
    ),
    true,
  );
  assert.equal(
    ciResumeActive(headRun(1, TIP, { attemptStartedAt: null }), NOW),
    false,
  );
});

Deno.test("CI resume: every due run of a head, by id", () => {
  const runs = [
    headRun(10, TIP),
    headRun(11, TIP),
    headRun(12, TIP, { workflowId: 8, updatedAt: NOW - 5 * MINUTE }),
    headRun(9, TIP, { workflowId: 8 }),
    headRun(13, TIP, { workflowId: null }),
    headRun(14, TIP, { workflowId: null }),
    headRun(15, "f".repeat(40)),
  ];
  assert.deepEqual(
    ciResumeRuns(runs, TIP, NOW).map((run) => run.id),
    [9, 10, 11, 13, 14],
    "run 12 was re-run five minutes ago; the other head's run is not listed",
  );
});

Deno.test("CI resume: the targets are the heads waiting on CI and pre-review CI parks", () => {
  const parked = liveRecord(618, {
    blocker: {
      kind: "other",
      message:
        "CI did not finish before review within 6 hours: deno(not_started)",
      since: NOW - HOUR,
    },
  });
  const snapshot = liveSnapshot([
    waiting(678),
    parked,
    liveRecord(879), // a delivery-gate CI park: the flake re-run's
    liveRecord(592), // waiting on something else
    waiting(79, "sentinel"), // the self scope is left out
  ], []);
  const targets = ciResumeTargets(snapshot);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].repository.name, GATEWAY.name);
  assert.deepEqual(targets[0].heads, [
    waiting(678).target.head,
    parked.target.head,
  ]);
});

interface Fake {
  surface: HostedAutonomyGitHubV1;
  listed: string[];
  judged: number[];
  reruns: number[];
}

function fakeSurface(
  runs: Record<string, HostedAutonomyHeadRunV1[]>,
  verdicts: Record<number, boolean | null>,
): Fake {
  const fake: Fake = {
    surface: liveSurface({ tip: TIP }).surface,
    listed: [],
    judged: [],
    reruns: [],
  };
  fake.surface = {
    ...fake.surface,
    listHeadRuns: (head) => {
      fake.listed.push(head);
      return Promise.resolve(runs[head] ?? []);
    },
    runNeverStarted: (id) => {
      fake.judged.push(id);
      return Promise.resolve(verdicts[id] ?? null);
    },
    rerunFailedJobs: (id) => {
      fake.reruns.push(id);
      return Promise.resolve(id !== 666);
    },
  };
  return fake;
}

async function resume(work: WorkRecordV1[], fake: Fake) {
  const rig = await liveRig("ci-resume", liveSnapshot(work, []), fake.surface);
  try {
    const actions = await runHostedCiResumePass({
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => NOW },
    });
    return { actions, writes: rig.writes };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("CI resume pass: re-runs the never-started runs of the base tip and a waiting head, nothing else", async () => {
  const record = waiting(678);
  const head = record.target.head!;
  const fake = fakeSurface({
    [TIP]: [headRun(10, TIP)],
    [head]: [
      headRun(20, head),
      headRun(21, head),
      headRun(30, head, { workflowId: 9, updatedAt: NOW - 10 * MINUTE }),
      headRun(40, head, { workflowId: 10 }),
      headRun(50, head, { workflowId: 11 }),
      headRun(666, head, { workflowId: 12 }),
      // A latest attempt that ran for ten minutes ran something: not read.
      headRun(70, head, { workflowId: 13, attemptStartedAt: ENDED - HOUR / 6 }),
    ],
  }, { 10: true, 21: true, 40: false, 50: null, 666: true, 70: true });
  const { actions, writes } = await resume([record, liveRecord(592)], fake);
  assert.deepEqual(fake.listed, [TIP, head], "the tip first, waiting heads");
  assert.deepEqual(fake.judged, [10, 20, 21, 40, 50, 666]);
  assert.deepEqual(fake.reruns, [10, 21, 666]);
  assert.deepEqual(actions, [
    "ci-resume:ubiquity/ai.ubq.fi:run=10:sent",
    "ci-resume:ubiquity/ai.ubq.fi:run=21:sent",
    "ci-resume:ubiquity/ai.ubq.fi:run=666:refused",
  ]);
  assert.equal(writes, 0, "the pass writes no state");
});

Deno.test("CI resume pass: a run re-run less than 30 minutes ago is not asked again", async () => {
  const record = waiting(678);
  const fake = fakeSurface({
    [TIP]: [headRun(10, TIP, { updatedAt: NOW - 29 * MINUTE })],
  }, { 10: true });
  const { actions } = await resume([record], fake);
  assert.deepEqual(actions, []);
  assert.deepEqual(fake.judged, [], "not even read");
  assert.deepEqual(fake.reruns, []);
});

Deno.test("CI resume pass: re-run requests are bounded per pass", async () => {
  // Every waiting record's head has two due never-started runs.
  const issues = [592, 600, 618, 678, 698, 879, 112, 137, 263, 421, 595];
  const records = issues.map((issue) => waiting(issue));
  const runs: Record<string, HostedAutonomyHeadRunV1[]> = {};
  const verdicts: Record<number, boolean> = {};
  records.forEach((record, index) => {
    const head = record.target.head!;
    runs[head] = [
      headRun(100 + 2 * index, head),
      headRun(101 + 2 * index, head),
    ];
    verdicts[100 + 2 * index] = true;
    verdicts[101 + 2 * index] = true;
  });
  assert.ok(2 * records.length > HOSTED_CI_RESUME_RERUNS_PER_PASS);
  const fake = fakeSurface(runs, verdicts);
  const { actions } = await resume(records, fake);
  assert.equal(fake.reruns.length, HOSTED_CI_RESUME_RERUNS_PER_PASS);
  assert.equal(actions.length, HOSTED_CI_RESUME_RERUNS_PER_PASS);
});

Deno.test("CI resume pass: no waiting head, or a surface that cannot judge runs, re-runs nothing", async () => {
  const fake = fakeSurface({ [TIP]: [headRun(10, TIP)] }, { 10: true });
  assert.deepEqual((await resume([liveRecord(592)], fake)).actions, []);
  assert.deepEqual(fake.listed, []);
  const blind = fakeSurface({ [TIP]: [headRun(10, TIP)] }, { 10: true });
  delete blind.surface.runNeverStarted;
  assert.deepEqual((await resume([waiting(678)], blind)).actions, []);
  assert.deepEqual(blind.reruns, []);
});

/**
 * Runs `body` with `fetch` answering the job listing of run 40134771282 with
 * `answer` (a JSON body, or a bare HTTP status); anything else is a 404.
 */
async function withJobs<T>(
  answer: unknown,
  body: () => Promise<T>,
  requested: string[] = [],
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const hit = url.includes("/actions/runs/40134771282/jobs?");
    const value = hit ? answer : 404;
    return Promise.resolve(
      typeof value === "number"
        ? new Response("{}", { status: value })
        : new Response(JSON.stringify(value), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const RUN = 40134771282;

function job(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    run_id: RUN,
    head_sha: TIP,
    status: "completed",
    conclusion: "failure",
    steps: [],
    runner_id: 0,
    ...overrides,
  };
}

function jobs(list: Record<string, unknown>[]) {
  return { total_count: list.length, jobs: list };
}

Deno.test("CI resume surface: runNeverStarted reads the run's latest-attempt jobs", async () => {
  const surface = createHostedAutonomyGitHub("token", GATEWAY);
  const requested: string[] = [];
  const cases: [unknown, boolean | null][] = [
    [jobs([job(1), job(2, { conclusion: "skipped", steps: [] })]), true],
    [jobs([job(1), job(2, { steps: [{ number: 1 }], runner_id: 4 })]), false],
    [jobs([job(1, { conclusion: "success", steps: [{ number: 1 }] })]), false],
    [jobs([]), false],
    [jobs([job(1, { run_id: RUN + 1 })]), null],
    [jobs([job(1, { head_sha: "f".repeat(40) })]), null],
    [{ total_count: 2, jobs: [job(1)] }, null],
    [404, null],
  ];
  for (const [answer, expected] of cases) {
    assert.equal(
      await withJobs(
        answer,
        () => surface.runNeverStarted!(RUN, TIP),
        requested,
      ),
      expected,
      JSON.stringify(answer),
    );
  }
  assert.ok(
    requested[0].endsWith(
      `/repos/ubiquity/ai.ubq.fi/actions/runs/${RUN}/jobs?filter=latest&per_page=100`,
    ),
    requested[0],
  );
});

Deno.test("CI resume surface: listHeadRuns reports the attempt times and workflow it needs", async () => {
  const surface = createHostedAutonomyGitHub("token", GATEWAY);
  const row = (id: number, overrides: Record<string, unknown> = {}) => ({
    id,
    head_sha: TIP,
    status: "completed",
    conclusion: "failure",
    run_attempt: 2,
    workflow_id: 77,
    created_at: "2026-10-24T06:40:00Z",
    run_started_at: "2026-10-24T21:33:47Z",
    updated_at: "2026-10-24T21:33:48Z",
    ...overrides,
  });
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const list = [
      row(1),
      row(2, { updated_at: "yesterday", run_started_at: null }),
      row(3, { workflow_id: "77" }),
    ];
    return Promise.resolve(
      url.includes(`/actions/runs?head_sha=${TIP}`)
        ? new Response(
          JSON.stringify({ total_count: list.length, workflow_runs: list }),
          { status: 200 },
        )
        : new Response("{}", { status: 404 }),
    );
  }) as typeof fetch;
  try {
    const runs = await surface.listHeadRuns!(TIP);
    assert.ok(runs !== null);
    assert.deepEqual(
      runs.map((run) => [run.attemptStartedAt, run.updatedAt, run.workflowId]),
      [
        [
          Date.parse("2026-10-24T21:33:47Z"),
          Date.parse("2026-10-24T21:33:48Z"),
          77,
        ],
        [undefined, undefined, 77],
        [
          Date.parse("2026-10-24T21:33:47Z"),
          Date.parse("2026-10-24T21:33:48Z"),
          undefined,
        ],
      ],
    );
    assert.equal("updatedAt" in runs[1], false, "unknown is absent");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("CI resume pass: the base tip is the canary; once its re-run ran, waiting heads are asked at the plain interval", async () => {
  const record = waiting(678);
  const head = record.target.head!;
  // The head's run is at attempt 3 and ended 31 minutes ago: not due during
  // the stop (its wait is two hours).
  const headRuns = [headRun(20, head, { runAttempt: 3 })];
  const stopped = fakeSurface({
    [TIP]: [headRun(10, TIP, { runAttempt: 3 })],
    [head]: headRuns,
  }, { 10: true, 20: true });
  assert.deepEqual((await resume([record], stopped)).actions, []);
  // The tip's re-run started and ran for ten minutes: billing is back.
  const restored = fakeSurface({
    [TIP]: [
      headRun(10, TIP, {
        runAttempt: 4,
        conclusion: "success",
        attemptStartedAt: NOW - 15 * MINUTE,
        updatedAt: NOW - 5 * MINUTE,
      }),
    ],
    [head]: headRuns,
  }, { 20: true });
  assert.deepEqual((await resume([record], restored)).actions, [
    "ci-resume:ubiquity/ai.ubq.fi:run=20:sent",
  ]);
});
