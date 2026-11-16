/**
 * A GitHub Actions job that never started is not CI evidence, in the
 * launcher too (live Passport, 2026-10-24: a failed payment stopped every
 * Actions job from 06:40 UTC; each check run completed `failure` within a
 * second, with no step and runner id 0). The base-repair read
 * (`failedChecks`) used to list such a run as a failing check, so a billing
 * stop on a target base would have filed a code-fix issue no code change can
 * satisfy. It now reads the job of each failed Actions check run (bounded,
 * the latest run of each name) and leaves out a job with no step and no
 * runner; an unreadable job keeps the run as a failure, as before. The
 * caller names the conclusions that count (the runtime's own sets).
 *
 * The REAL surface runs over a stubbed `fetch`; the REAL base-repair pass
 * then files nothing for a base whose only failure never started.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";
import {
  CANDIDATE_CONCLUSIONS,
  RED_BASE_CONCLUSIONS,
} from "../../src/repair/ci-rejection.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { runHostedBaseRepairPass } from "../../ops/hosted-autonomy-base-repair.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  GATEWAY,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  NOW,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";
import { heldPullsIssues } from "./hosted-autonomy-base-repair-fixtures.ts";

const SCOPE = `/repos/${GATEWAY.owner}/${GATEWAY.name}`;
const ACTIONS = { id: 15368, slug: "github-actions" };
const JOB = 120993841213;
const HEAD = "1".repeat(40);
const HEAD_JOB = 120993841999;

function run(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    name: "deno",
    head_sha: TIP,
    status: "completed",
    conclusion: "failure",
    started_at: "2026-10-24T21:33:47Z",
    completed_at: "2026-10-24T21:33:48Z",
    app: ACTIONS,
    ...overrides,
  };
}

function job(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    run_id: 40134771282,
    head_sha: TIP,
    status: "completed",
    conclusion: "failure",
    steps: [],
    runner_id: 0,
    runner_name: "",
    ...overrides,
  };
}

/** A route answer: a JSON body, or a bare HTTP status. */
type Answer = unknown;

/**
 * Runs `body` with `fetch` answering the check-run listing of each commit
 * with `runs` (a bare list is TIP's) and each job read from `jobs`
 * (anything else is a 404).
 */
async function withFetch<T>(
  runs: Record<string, unknown>[] | Record<string, Record<string, unknown>[]>,
  jobs: Record<number, Answer>,
  body: () => Promise<T>,
  requested: string[] = [],
): Promise<T> {
  const byCommit = Array.isArray(runs) ? { [TIP]: runs } : runs;
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    let answer: Answer = 404;
    for (const [commit, listed] of Object.entries(byCommit)) {
      if (url.includes(`${SCOPE}/commits/${commit}/check-runs?`)) {
        answer = { total_count: listed.length, check_runs: listed };
      }
    }
    const match = /\/actions\/jobs\/(\d+)$/.exec(url);
    if (match !== null) answer = jobs[Number(match[1])] ?? 404;
    return Promise.resolve(
      typeof answer === "number"
        ? new Response("{}", { status: answer })
        : new Response(JSON.stringify(answer), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

const surface = () => createHostedAutonomyGitHub("token", GATEWAY);
const tipFailures = () => surface().failedChecks!(TIP, RED_BASE_CONCLUSIONS);

Deno.test("launcher failedChecks: a never-started Actions failure is no failing check", async () => {
  const requested: string[] = [];
  const failed = await withFetch(
    [run(JOB)],
    { [JOB]: job(JOB) },
    tipFailures,
    requested,
  );
  assert.deepEqual(failed, []);
  assert.deepEqual(
    requested.filter((url) => url.includes("/actions/jobs/")),
    [`https://api.github.com${SCOPE}/actions/jobs/${JOB}`],
  );
});

Deno.test("launcher failedChecks: a job that ran, an unreadable job and another app keep their failure", async () => {
  const cases: [Record<string, unknown>[], Record<number, Answer>, string[]][] =
    [
      [[run(JOB)], {
        [JOB]: job(JOB, { steps: [{ number: 1, name: "Set up job" }] }),
      }, ["deno"]],
      [[run(JOB)], { [JOB]: job(JOB, { runner_id: 3 }) }, ["deno"]],
      [[run(JOB)], { [JOB]: 404 }, ["deno"]],
      [[run(JOB)], { [JOB]: job(JOB, { head_sha: "f".repeat(40) }) }, [
        "deno",
      ]],
      [[run(JOB, { name: "lint", app: { id: 9, slug: "ci-bot" } })], {}, [
        "lint",
      ]],
      [[run(JOB, { conclusion: "timed_out" })], {}, ["deno"]],
    ];
  for (const [runs, jobs, expected] of cases) {
    const requested: string[] = [];
    const failed = await withFetch(runs, jobs, tipFailures, requested);
    assert.deepEqual(failed, expected, JSON.stringify(runs));
    if (Object.keys(jobs).length === 0) {
      assert.ok(
        !requested.some((url) => url.includes("/actions/jobs/")),
        "no job read for a run that is not a failed Actions run",
      );
    }
  }
});

Deno.test("launcher failedChecks: the strict filing read is unreadable when a failed job goes unjudged", async () => {
  const strict = () =>
    surface().failedChecks!(TIP, RED_BASE_CONCLUSIONS, { strict: true });
  // Refused, missing, foreign or unfinished job reads, and a ninth failed
  // job past the read bound.
  const nine = Array.from(
    { length: 9 },
    (_, index) => run(JOB + index, { name: `check-${index}` }),
  );
  const cases: [Record<string, unknown>[], Record<number, Answer>][] = [
    [[run(JOB)], { [JOB]: 403 }],
    [[run(JOB)], { [JOB]: 502 }],
    [[run(JOB)], {}],
    [[run(JOB)], { [JOB]: job(JOB, { head_sha: "f".repeat(40) }) }],
    [[run(JOB)], { [JOB]: job(JOB, { status: "in_progress" }) }],
    [
      nine,
      Object.fromEntries(nine.map((row) => [row.id, job(row.id as number)])),
    ],
  ];
  for (const [runs, jobs] of cases) {
    assert.equal(
      await withFetch(runs, jobs, strict),
      null,
      JSON.stringify(jobs),
    );
    // The ordinary read (the delivery train's) keeps the failure as before.
    assert.notEqual(await withFetch(runs, jobs, tipFailures), null);
  }
  // Every failed job judged: the strict read answers as the ordinary one.
  assert.deepEqual(
    await withFetch([run(JOB)], { [JOB]: job(JOB) }, strict),
    [],
  );
  assert.deepEqual(
    await withFetch(
      [run(JOB)],
      { [JOB]: job(JOB, { steps: [{ number: 1, name: "test" }] }) },
      strict,
    ),
    ["deno"],
  );
});

Deno.test("launcher failedChecks: a strict read says when a failed job lay past the job-read bound", async () => {
  let told = 0;
  const strict = () =>
    surface().failedChecks!(TIP, RED_BASE_CONCLUSIONS, {
      strict: true,
      onOverBound: () => told++,
    });
  // More failed Actions jobs than the read judges: a condition of the commit.
  const nine = Array.from(
    { length: 9 },
    (_, index) => run(JOB + index, { name: `check-${index}` }),
  );
  const jobs = Object.fromEntries(
    nine.map((row) => [row.id, job(row.id as number)]),
  );
  assert.equal(await withFetch(nine, jobs, strict), null);
  assert.equal(told, 1);
  // A refused job read is a read fault: unreadable, and not over the bound.
  assert.equal(await withFetch([run(JOB)], { [JOB]: 403 }, strict), null);
  assert.equal(told, 1);
  // The ordinary read never calls it.
  assert.notEqual(
    await withFetch(
      nine,
      jobs,
      () =>
        surface().failedChecks!(TIP, RED_BASE_CONCLUSIONS, {
          onOverBound: () => told++,
        }),
    ),
    null,
  );
  assert.equal(told, 1);
});

Deno.test("launcher failedChecks: the caller's conclusions count, the runtime's own sets", async () => {
  const runs = [
    run(JOB, { name: "approve", conclusion: "action_required", app: {} }),
    run(JOB + 1, { name: "boot", conclusion: "startup_failure", app: {} }),
    run(JOB + 2, { name: "slow", conclusion: "timed_out", app: {} }),
    run(JOB + 3, { name: "stopped", conclusion: "cancelled", app: {} }),
  ];
  // The tip: the runtime's red-base set (a startup failure is not red there).
  assert.deepEqual(await withFetch(runs, {}, tipFailures), ["approve", "slow"]);
  // A held head: only the head failures a red base can hold.
  assert.deepEqual(
    await withFetch(
      runs,
      {},
      () => surface().failedChecks!(TIP, CANDIDATE_CONCLUSIONS),
    ),
    ["slow"],
  );
});

Deno.test("launcher failedChecks: only the latest run of a name decides it", async () => {
  // The push run failed for real an hour ago; its re-run never started.
  const failed = await withFetch(
    [
      run(JOB - 1, {
        started_at: "2026-10-24T20:00:00Z",
        completed_at: "2026-10-24T20:05:00Z",
      }),
      run(JOB),
    ],
    { [JOB]: job(JOB) },
    tipFailures,
  );
  assert.deepEqual(failed, []);
});

Deno.test("base repair pass: a base whose only failure never started files nothing", async () => {
  // Held as the CI-first red-base hold leaves it, on the tip, its head
  // failing `deno` for real (the pass reads only held heads on the tip).
  const { branch, pr } = liveRecord(618).target;
  const record = liveRecord(618, {
    nextStep: "work",
    blocker: null,
    wait: { reason: "backoff", since: NOW - 60_000, until: NOW + 1_740_000 },
    target: { base: TIP, branch, checkpoint: null, head: HEAD, pr },
  });
  const filed: { title: string; body: string }[] = [];
  const { surface: base } = liveSurface({ tip: TIP });
  const real = surface();
  const combined: HostedAutonomyGitHubV1 = {
    ...base,
    failedChecks: real.failedChecks,
    // GitHub lists the held record's own App pull request.
    baseRepairIssues: heldPullsIssues([pr!], NOW, filed),
    // The rig routes the Sentinel repository here too: the installed
    // runtime descends from the CI-fix cap's commit.
    isAncestor: () => Promise.resolve(true),
  };
  const rig = await liveRig(
    "never-started-base",
    liveSnapshot([record], []),
    combined,
  );
  const headRuns = [run(HEAD_JOB, { head_sha: HEAD })];
  const headJob = job(HEAD_JOB, {
    head_sha: HEAD,
    steps: [{ number: 1, name: "test" }],
  });
  // Each pass is its own maintenance run (a fresh resolver, as the hosted
  // main builds one per run), so the in-run brake never answers for it.
  const runPass = () =>
    runHostedBaseRepairPass({
      ciMinutes: INACTIVE_CI_MINUTES,
      state: rig.state,
      githubFor: (repository) => rig.githubFor(repository),
      clock: { now: () => NOW },
    });
  try {
    const actions = await withFetch(
      { [TIP]: [run(JOB)], [HEAD]: headRuns },
      { [JOB]: job(JOB), [HEAD_JOB]: headJob },
      runPass,
    );
    assert.deepEqual(actions, []);
    assert.deepEqual(filed, [], "a billing stop is no code-fix issue");
    // The same base with a job that ran still files its issue.
    const ran = await withFetch(
      { [TIP]: [run(JOB)], [HEAD]: headRuns },
      {
        [JOB]: job(JOB, { steps: [{ number: 1, name: "test" }] }),
        [HEAD_JOB]: headJob,
      },
      runPass,
    );
    assert.deepEqual(ran, ["base-repair:ubiquity/ai.ubq.fi:filed=#4242"]);
    assert.equal(filed.length, 1);
    // A failed job the read could not judge is unreadable, never red: a
    // refused job read (403 or 502) on the tip or on a held head files
    // nothing (the review filed an issue naming jobs that never ran).
    const ranJob = job(JOB, { steps: [{ number: 1, name: "test" }] });
    for (const status of [403, 502]) {
      const tipRefused = await withFetch(
        { [TIP]: [run(JOB)], [HEAD]: headRuns },
        { [JOB]: status, [HEAD_JOB]: headJob },
        runPass,
      );
      assert.deepEqual(tipRefused, [
        "base-repair:ubiquity/ai.ubq.fi:checks_unreadable",
      ], `${status}`);
      const headRefused = await withFetch(
        { [TIP]: [run(JOB)], [HEAD]: headRuns },
        { [JOB]: ranJob, [HEAD_JOB]: status },
        runPass,
      );
      assert.deepEqual(headRefused, [
        "base-repair:ubiquity/ai.ubq.fi:head_checks_unreadable",
      ], `${status}`);
    }
    // Nine never-started jobs on the tip and on the held head: the read
    // judges eight, so the ninth would have stayed red on both. More failed
    // jobs than the read judges is that commit's own condition, not a read
    // fault, so it has its own code.
    const nine = (head: string, first: number) =>
      Array.from(
        { length: 9 },
        (_, index) =>
          run(first + index, { name: `check-${index}`, head_sha: head }),
      );
    const unstarted = (head: string, first: number) =>
      Object.fromEntries(
        nine(head, first).map((row) => [
          row.id,
          job(row.id as number, { head_sha: head }),
        ]),
      );
    const bounded = await withFetch(
      { [TIP]: nine(TIP, JOB), [HEAD]: nine(HEAD, HEAD_JOB) },
      { ...unstarted(TIP, JOB), ...unstarted(HEAD, HEAD_JOB) },
      runPass,
    );
    assert.deepEqual(bounded, [
      "base-repair:ubiquity/ai.ubq.fi:checks_over_bound",
    ]);
    assert.equal(filed.length, 1, "no issue names a job that never ran");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
