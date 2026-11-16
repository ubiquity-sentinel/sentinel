/**
 * CI that never started is not red for base-repair filing, through the real
 * maintenance pass (`runHostedAutonomy`) with the REAL launcher check read
 * (`failedChecks` over a stubbed `fetch`) on ai.ubq.fi. The read judges at
 * most eight failed Actions jobs per commit and keeps no cache; the review
 * filed an issue naming jobs that never ran when a tip and a held head had
 * nine or more never-started jobs, or when a job read was refused (403 or
 * 502). Such an unjudged failed job now makes the commit unreadable, which
 * files nothing; a tip and a held head red on jobs that ran still file.
 */
import assert from "node:assert/strict";
import { MAX_NEVER_STARTED_JOB_READS } from "../../src/github/never-started-job.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import {
  AI,
  H1,
  LIVE,
  maintain,
  NOW,
  redTargets,
  TAG,
  TIPS,
} from "./hosted-autonomy-base-repair-fixtures.ts";

const SCOPE = "/repos/ubiquity/ai.ubq.fi";
const ACTIONS = { id: 15368, slug: "github-actions" };
const TIP = TIPS[AI];

/** A failed Actions check run `name` (its job id `id`) on `head`. */
function run(id: number, head: string, name: string): Record<string, unknown> {
  return {
    id,
    name,
    head_sha: head,
    status: "completed",
    conclusion: "failure",
    started_at: "2026-11-15T21:33:47Z",
    completed_at: "2026-11-15T21:33:48Z",
    app: ACTIONS,
  };
}

/** Job `id` on `head`: it ran (a step and a runner) or never started. */
function job(id: number, head: string, ran: boolean): Record<string, unknown> {
  return {
    id,
    run_id: 40134771282,
    head_sha: head,
    status: "completed",
    conclusion: "failure",
    steps: ran ? [{ number: 1, name: "test" }] : [],
    runner_id: ran ? 7 : 0,
    runner_name: ran ? "runner" : "",
  };
}

/** `count` failed runs per commit, job ids from `first`, and their jobs. */
function failing(
  head: string,
  first: number,
  count: number,
  ran: boolean,
): { runs: Record<string, unknown>[]; jobs: Record<number, unknown> } {
  const runs = Array.from(
    { length: count },
    (_, index) => run(first + index, head, `check-${index + 1}`),
  );
  const jobs = Object.fromEntries(
    runs.map((row) => [row.id as number, job(row.id as number, head, ran)]),
  );
  return { runs, jobs };
}

/**
 * One maintenance pass with ai.ubq.fi's failed checks read by the real
 * surface: `fetch` answers each commit's check runs from `runs` and each job
 * read from `jobs` (a number is that HTTP status; anything else a 404).
 */
async function pass(
  runs: Record<string, Record<string, unknown>[]>,
  jobs: Record<number, unknown>,
) {
  const targets = redTargets();
  const real = createHostedAutonomyGitHub("token", {
    owner: "ubiquity",
    name: AI,
    installationId: 7,
  });
  const ai = targets[AI];
  const surface = { ...ai.surface, failedChecks: real.failedChecks };
  const routed = { ...targets, [AI]: { ...ai, surface } };
  const jobReads: number[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    let answer: unknown = 404;
    for (const [commit, listed] of Object.entries(runs)) {
      if (url.includes(`${SCOPE}/commits/${commit}/check-runs?`)) {
        answer = { total_count: listed.length, check_runs: listed };
      }
    }
    const match = /\/actions\/jobs\/(\d+)$/.exec(url);
    if (match !== null) {
      jobReads.push(Number(match[1]));
      answer = jobs[Number(match[1])] ?? 404;
    }
    return Promise.resolve(
      typeof answer === "number"
        ? new Response("{}", { status: answer })
        : new Response(JSON.stringify(answer), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    const result = await maintain(LIVE(), routed, NOW);
    return { ...result, created: ai.created, jobReads };
  } finally {
    globalThis.fetch = original;
  }
}

Deno.test("base repair jobs: nine never-started jobs on the tip and a held head file nothing", async () => {
  const count = MAX_NEVER_STARTED_JOB_READS + 1;
  const tip = failing(TIP, 1000, count, false);
  const head = failing(H1, 2000, count, false);
  const { baseRepair, created, jobReads } = await pass(
    { [TIP]: tip.runs, [H1]: head.runs },
    { ...tip.jobs, ...head.jobs },
  );
  // More failed jobs than the read judges: the commit's own condition, with
  // its own code (it was `checks_unreadable`, a read fault's).
  assert.deepEqual(baseRepair, [`${TAG}:checks_over_bound`]);
  assert.equal(created.length, 0, "no issue names a job that never ran");
  assert.equal(jobReads.length, MAX_NEVER_STARTED_JOB_READS, "bounded");
});

Deno.test("base repair jobs: more failed jobs on a held head than the read judges is head_checks_over_bound", async () => {
  // The tip is red on one job that ran; the held head on nine that never
  // started.
  const tip = failing(TIP, 1000, 1, true);
  const head = failing(H1, 2000, MAX_NEVER_STARTED_JOB_READS + 1, false);
  const { baseRepair, created } = await pass(
    { [TIP]: tip.runs, [H1]: head.runs },
    { ...tip.jobs, ...head.jobs },
  );
  assert.deepEqual(baseRepair, [`${TAG}:head_checks_over_bound`]);
  assert.equal(created.length, 0);
});

Deno.test("base repair jobs: a refused job read files nothing, on the tip or on a held head", async () => {
  for (const status of [403, 502]) {
    // The tip's job read is refused; the head's job ran.
    const tip = failing(TIP, 1000, 1, true);
    const head = failing(H1, 2000, 1, true);
    const onTip = await pass(
      { [TIP]: tip.runs, [H1]: head.runs },
      { 1000: status, ...head.jobs },
    );
    assert.deepEqual(
      onTip.baseRepair,
      [`${TAG}:checks_unreadable`],
      `${status}`,
    );
    assert.equal(onTip.created.length, 0);
    // The tip's job ran; the head's read is refused.
    const onHead = await pass(
      { [TIP]: tip.runs, [H1]: head.runs },
      { ...tip.jobs, 2000: status },
    );
    assert.deepEqual(onHead.baseRepair, [`${TAG}:head_checks_unreadable`]);
    assert.equal(onHead.created.length, 0);
  }
});

Deno.test("base repair jobs: a tip and a held head red on jobs that ran file their issue", async () => {
  const tip = failing(TIP, 1000, 2, true);
  const head = failing(H1, 2000, 2, true);
  const { baseRepair, created } = await pass(
    { [TIP]: tip.runs, [H1]: head.runs },
    { ...tip.jobs, ...head.jobs },
  );
  assert.deepEqual(baseRepair, [`${TAG}:filed=#9000`]);
  assert.equal(created.length, 1);
  assert.ok(created[0].body.includes("- `check-1`\n- `check-2`\n"));
  // One job never started on each: it is no failing check, the other is.
  const mixed = failing(TIP, 1000, 2, true);
  mixed.jobs[1001] = job(1001, TIP, false);
  const held = failing(H1, 2000, 2, true);
  held.jobs[2001] = job(2001, H1, false);
  const some = await pass(
    { [TIP]: mixed.runs, [H1]: held.runs },
    { ...mixed.jobs, ...held.jobs },
  );
  assert.deepEqual(some.baseRepair, [`${TAG}:filed=#9000`]);
  assert.ok(some.created[0].body.includes("Failing checks:\n- `check-1`\n\n"));
});
