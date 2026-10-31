/**
 * A GitHub Actions job that never started is not CI evidence (live Passport,
 * 2026-10-24: a failed payment stopped every Actions job from 06:40 UTC).
 * GitHub completed each check run about a second after creating it with
 * conclusion `failure`, no step and runner id 0. The runtime check read
 * (`readChecks`) now reads the job of each failed Actions check run (its id
 * is the check run's id) and marks a job with no step and no runner as
 * `neverStarted`; the gate then waits on it like running CI. Only failed
 * Actions runs are read, at most `MAX_NEVER_STARTED_JOB_READS` per read, the
 * latest run of each name first; an unreadable or mismatched job keeps the
 * run exactly as GitHub reported it. All fixtures are synthetic, over the
 * real client and a scripted transport.
 */
import assert from "node:assert/strict";
import { decideCiGate } from "../../src/repair/loop-checks.ts";
import { failedChecks } from "../../src/repair/ci-rejection.ts";
import { MAX_NEVER_STARTED_JOB_READS } from "../../src/github/never-started-job.ts";
import {
  checkRunWire,
  checksPageWire,
  FakeClock,
  httpRespond,
  makePort,
  SHA1,
  SHA2,
  statusesPageWire,
} from "./helpers.ts";

const REPO_PATH = "/repos/ubiquity-sentinel/sentinel";
const COMMIT = `${REPO_PATH}/commits/${SHA1}`;
const NOW = Date.parse("2026-09-07T02:00:00Z");
const ACTIONS = { id: 15368, slug: "github-actions" };
const JOB = 120993841213;

/** A failed Actions check run of job `id`. */
function actionsFailure(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return checkRunWire({
    id,
    name: "deno",
    conclusion: "failure",
    app: ACTIONS,
    started_at: "2026-09-07T00:00:00Z",
    completed_at: "2026-09-07T00:00:01Z",
    ...overrides,
  });
}

/** The live shape of a job GitHub never started (billing stop). */
function neverStartedJob(
  id: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    run_id: 40134771282,
    head_sha: SHA1,
    name: "deno",
    status: "completed",
    conclusion: "failure",
    started_at: "2026-09-07T00:00:00Z",
    completed_at: "2026-09-07T00:00:01Z",
    steps: [],
    runner_id: 0,
    runner_name: "",
    ...overrides,
  };
}

function jobRoute(id: number, status: number, body: unknown) {
  return httpRespond("GET", `${REPO_PATH}/actions/jobs/${id}`, status, body);
}

function script(runs: unknown[], jobs: ReturnType<typeof jobRoute>[]) {
  return [
    httpRespond(
      "GET",
      `${COMMIT}/check-runs?per_page=100&page=1`,
      200,
      checksPageWire(runs),
    ),
    ...jobs,
    httpRespond(
      "GET",
      `${COMMIT}/statuses?per_page=100&page=1`,
      200,
      statusesPageWire([]),
    ),
  ];
}

async function read(
  runs: unknown[],
  jobs: ReturnType<typeof jobRoute>[] = [],
) {
  const { port, transport } = makePort({
    clock: new FakeClock(NOW),
    script: script(runs, jobs),
  });
  const result = await port.readChecks(SHA1);
  assert.ok(result.ok, JSON.stringify(result));
  const jobReads = transport.requests.filter((request) =>
    request.url.includes("/actions/jobs/")
  ).map((request) => request.url);
  return { checks: result.value.checks, jobReads };
}

Deno.test("readChecks: a failed Actions run whose job has no step and no runner is marked never started and waits", async () => {
  const { checks, jobReads } = await read([actionsFailure(JOB)], [
    jobRoute(JOB, 200, neverStartedJob(JOB)),
  ]);
  assert.deepEqual(jobReads, [
    `https://api.github.com${REPO_PATH}/actions/jobs/${JOB}`,
  ]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].neverStarted, true);
  assert.equal(checks[0].conclusion, "failure", "the wire value is kept");
  assert.deepEqual(failedChecks(checks), [], "no failure is evidence");
  assert.equal(decideCiGate(checks), "wait");
});

Deno.test("readChecks: a null runner id with no step is never started too", async () => {
  const { checks } = await read([actionsFailure(JOB)], [
    jobRoute(JOB, 200, neverStartedJob(JOB, { runner_id: null })),
  ]);
  assert.equal(checks[0].neverStarted, true);
});

Deno.test("readChecks: a job that ran (a step, or a runner) keeps its failure", async () => {
  const ran = [
    neverStartedJob(JOB, {
      steps: [{ number: 1, name: "Set up job", status: "completed" }],
    }),
    neverStartedJob(JOB, { runner_id: 7, runner_name: "GitHub Actions 7" }),
    neverStartedJob(JOB, { runner_id: undefined }),
    neverStartedJob(JOB, { steps: undefined }),
  ];
  for (const job of ran) {
    const { checks, jobReads } = await read([actionsFailure(JOB)], [
      jobRoute(JOB, 200, job),
    ]);
    assert.equal(jobReads.length, 1);
    assert.equal(checks[0].neverStarted, undefined, JSON.stringify(job));
    assert.deepEqual(decideCiGate(checks), {
      blocked: "CI checks failed: deno(failure)",
    });
  }
});

Deno.test("readChecks: an unreadable or mismatched job keeps the run exactly as reported", async () => {
  const unreadable: ReturnType<typeof jobRoute>[] = [
    jobRoute(JOB, 404, { message: "Not Found" }),
    jobRoute(JOB, 500, { message: "boom" }),
    jobRoute(JOB, 200, "{not json"),
    jobRoute(JOB, 200, neverStartedJob(JOB + 1)),
    jobRoute(JOB, 200, neverStartedJob(JOB, { head_sha: SHA2 })),
    jobRoute(JOB, 200, neverStartedJob(JOB, { status: "in_progress" })),
    jobRoute(JOB, 200, neverStartedJob(JOB, { conclusion: "cancelled" })),
  ];
  for (const [index, route] of unreadable.entries()) {
    const { checks, jobReads } = await read([actionsFailure(JOB)], [route]);
    const label = `case ${index}`;
    assert.equal(jobReads.length, 1, label);
    assert.equal(checks.length, 1, label);
    assert.equal(checks[0].neverStarted, undefined, label);
    assert.equal(failedChecks(checks).length, 1, label);
  }
  // A lost request is unreadable too; the check read itself still succeeds.
  const { port } = makePort({
    clock: new FakeClock(NOW),
    script: script([actionsFailure(JOB)], []),
  });
  const lost = await port.readChecks(SHA1);
  assert.ok(lost.ok, JSON.stringify(lost));
  assert.equal(lost.value.checks[0].neverStarted, undefined);
});

Deno.test("readChecks: only failed Actions check runs cost a job read", async () => {
  const { checks, jobReads } = await read([
    actionsFailure(11, { name: "green", conclusion: "success" }),
    actionsFailure(12, { name: "cancelled", conclusion: "cancelled" }),
    actionsFailure(13, { name: "timed", conclusion: "timed_out" }),
    actionsFailure(14, {
      name: "running",
      status: "in_progress",
      conclusion: null,
      completed_at: null,
    }),
    actionsFailure(15, { name: "other-app", app: { id: 1, slug: "ci-bot" } }),
    actionsFailure(16, { name: "no-app", app: undefined }),
  ]);
  assert.deepEqual(jobReads, []);
  assert.ok(checks.every((check) => check.neverStarted === undefined));
});

Deno.test("readChecks: job reads are bounded per read, the latest run of each name first", async () => {
  // A superseded never-started `deno` run is not read: its newer re-run
  // decides the name. Past the bound a failed run stays as reported.
  const names = Array.from(
    { length: MAX_NEVER_STARTED_JOB_READS + 2 },
    (_, index) => `job-${index}`,
  );
  const runs = [
    actionsFailure(900, {
      started_at: "2026-09-06T00:00:00Z",
      completed_at: "2026-09-06T00:00:01Z",
    }),
    actionsFailure(901),
    ...names.map((name, index) => actionsFailure(1000 + index, { name })),
  ];
  const jobs = [
    jobRoute(900, 200, neverStartedJob(900)),
    jobRoute(901, 200, neverStartedJob(901)),
    ...names.map((_, index) =>
      jobRoute(1000 + index, 200, neverStartedJob(1000 + index))
    ),
  ];
  const { checks, jobReads } = await read(runs, jobs);
  assert.equal(jobReads.length, MAX_NEVER_STARTED_JOB_READS);
  assert.ok(!jobReads.some((url) => url.endsWith("/actions/jobs/900")));
  assert.ok(jobReads.some((url) => url.endsWith("/actions/jobs/901")));
  const marked = checks.filter((check) => check.neverStarted === true);
  assert.equal(marked.length, MAX_NEVER_STARTED_JOB_READS);
  assert.equal(
    failedChecks(checks).length,
    names.length + 1 - MAX_NEVER_STARTED_JOB_READS,
    "every run past the bound keeps its failure",
  );
});

Deno.test("readChecks: a completed job's verdict is read once per client", async () => {
  const { port, transport } = makePort({
    clock: new FakeClock(NOW),
    script: [
      ...script([actionsFailure(JOB)], [
        jobRoute(JOB, 200, neverStartedJob(JOB)),
      ]),
      ...script([actionsFailure(JOB)], []),
    ],
  });
  for (let pass = 0; pass < 2; pass++) {
    const result = await port.readChecks(SHA1);
    assert.ok(result.ok, JSON.stringify(result));
    assert.equal(result.value.checks[0].neverStarted, true);
  }
  assert.equal(
    transport.requests.filter((request) =>
      request.url.includes("/actions/jobs/")
    ).length,
    1,
  );
});

Deno.test("readChecks: a name-filtered base read marks a never-started run the same way", async () => {
  const { port } = makePort({
    clock: new FakeClock(NOW),
    script: script([
      actionsFailure(JOB),
      actionsFailure(JOB + 5, { name: "unrelated" }),
    ], [jobRoute(JOB, 200, neverStartedJob(JOB))]),
  });
  const result = await port.readChecks(SHA1, new Set(["deno"]));
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    result.value.checks.map((check) => [check.name, check.neverStarted]),
    [["deno", true]],
  );
});
