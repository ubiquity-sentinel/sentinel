/**
 * Issue #178: the finalize job reads the run attempt's completed job logs
 * through the trusted signed-log path and prints exactly one
 * `hosted_runtime_run_summary` line plus a step summary.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { HttpRequestV1 } from "../../src/github/http.ts";
import { HostedSupervisorGitHubClient } from "../../src/host/actions-supervisor-install-api.ts";
import {
  aggregateRunSummary,
  emitRunSummary,
  lastRuntimeSummary,
} from "../../src/host/run-summary.ts";
import { CONTROLLER } from "./controller-identity-fixture.ts";

const RUN = 40098864009;
const LAUNCHER = "1d056586edb33b43a2d9a021608ff2c56d25066d";
const SIGNED = "https://productionresultssa17.blob.core.windows.net/logs";

function child(overrides: Record<string, unknown> = {}) {
  return {
    version: "v1",
    kind: "hosted_runtime_summary",
    runId: RUN,
    attempt: 1,
    launcherSha: LAUNCHER,
    runtimeSha: LAUNCHER,
    generation: 102,
    purpose: "ordinary",
    targets: [{
      repository: "ubiquity/passport.ubq.fi",
      openIssues: 40,
      admitted: 1,
      skippedIssues: [],
    }],
    admittedWorkCount: 1,
    modelStarts: 1,
    prsTouched: [],
    outcome: "healthy",
    reasonCode: "healthy",
    explanation: "",
    nextAction: "",
    ...overrides,
  };
}

/** One Actions log: timestamped lines, an earlier summary superseded. */
function jobLog(...summaries: unknown[]): string {
  return [
    "2026-10-24T13:49:16.0000000Z ##[group]Run selected Sentinel runtime",
    ...summaries.map((row) =>
      `2026-10-24T13:54:29.0000000Z ${JSON.stringify(row)}`
    ),
    "2026-10-24T13:54:30.0000000Z Post job cleanup.",
  ].join("\n");
}

const JOBS = [
  { id: 11, name: "maintenance", status: "completed", conclusion: "success" },
  {
    id: 12,
    name: "matrix_cell (a)",
    status: "completed",
    conclusion: "success",
  },
  {
    id: 13,
    name: "matrix_cell (b)",
    status: "completed",
    conclusion: "success",
  },
  { id: 14, name: "repair", status: "completed", conclusion: "success" },
  { id: 15, name: "finalize", status: "in_progress", conclusion: null },
];

const LOGS: Record<number, string> = {
  11: "2026-10-24T13:36:31.0000000Z maintenance printed no runtime summary",
  12: jobLog(child({ modelStarts: 0 }), child({ modelStarts: 1 })),
  13: jobLog(child({
    targets: [{
      repository: "ubiquity/passport.ubq.fi",
      openIssues: 41,
      admitted: 2,
      skippedIssues: [{ number: 7 }],
    }],
    admittedWorkCount: 2,
    modelStarts: 2,
  })),
  14: jobLog(child({
    targets: [{
      repository: "ubiquity-sentinel/sentinel",
      openIssues: 9,
      admitted: null,
      skippedIssues: null,
    }],
    admittedWorkCount: null,
    modelStarts: null,
    prsTouched: [{
      repository: "ubiquity-sentinel/sentinel",
      number: 195,
      head: LAUNCHER,
      action: "updated",
    }],
  })),
};

function client(seen: string[]) {
  return new HostedSupervisorGitHubClient({
    repository: CONTROLLER.repository,
    apiBaseUrl: "https://api.github.com",
    clock: { now: () => Date.now() },
    auth: {
      authorizationHeader: () => Promise.resolve(portOk("Bearer synthetic")),
    },
    cooldownGate: {
      beforeRequest: () => Promise.resolve(portOk(undefined)),
      recordRateLimit: () => Promise.resolve(portOk(undefined)),
    },
    http: (request: HttpRequestV1) => {
      const url = new URL(request.url);
      seen.push(`${request.method} ${url.host}${url.pathname}`);
      assert.equal(request.method, "GET");
      if (
        url.pathname ===
          `${CONTROLLER.apiPath}/actions/runs/${RUN}/attempts/1/jobs`
      ) {
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: JSON.stringify({ total_count: JOBS.length, jobs: JOBS }),
        });
      }
      const job = /\/actions\/jobs\/(\d+)\/logs$/.exec(url.pathname);
      if (job !== null) {
        return Promise.resolve({
          status: 302,
          headers: new Headers({ location: `${SIGNED}/${job[1]}?sig=x` }),
          bodyText: "",
        });
      }
      if (url.host === "productionresultssa17.blob.core.windows.net") {
        assert.equal(request.headers.get("authorization"), undefined);
        const id = Number(url.pathname.split("/").pop());
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: LOGS[id],
        });
      }
      return Promise.reject(new Error(`unscripted ${url}`));
    },
  });
}

Deno.test("run summary: two cell summaries, the repair summary and a silent job aggregate into one line", async () => {
  const seen: string[] = [];
  const reader = client(seen);
  const lines: string[] = [];
  const appended: string[] = [];
  const summary = await emitRunSummary({
    readJobs: (runId, attempt, select) =>
      reader.readRunJobSummaries(runId, attempt, select),
    log: (line) => lines.push(line),
    stepSummaryPath: "/summary.md",
    appendFile: (path, body) => {
      appended.push(`${path}\n${body}`);
      return Promise.resolve();
    },
  }, { runId: RUN, runAttempt: 1 });
  assert.ok(summary !== null);
  assert.equal(lines.length, 1, "exactly one run summary line");
  assert.deepEqual(JSON.parse(lines[0]), summary);
  assert.equal(summary.kind, "hosted_runtime_run_summary");
  assert.equal(summary.launcherSha, LAUNCHER);
  assert.equal(summary.generation, 102);
  assert.equal(summary.purpose, "ordinary");
  assert.deepEqual(summary.jobs.map((job) => [job.name, job.outcome]), [
    ["maintenance", null],
    ["matrix_cell (a)", "healthy"],
    ["matrix_cell (b)", "healthy"],
    ["repair", "healthy"],
  ], "the in-progress finalize job is not read");
  assert.deepEqual(summary.targets, [
    {
      repository: "ubiquity-sentinel/sentinel",
      openIssues: 9,
      admitted: null,
      skipped: null,
    },
    {
      repository: "ubiquity/passport.ubq.fi",
      openIssues: 41,
      admitted: 3,
      skipped: 1,
    },
  ]);
  assert.equal(summary.admittedWorkCount, 3, "unknown counts are not zero");
  assert.equal(summary.modelStarts, 3, "the last line of a cell wins");
  assert.deepEqual(summary.prsTouched, [{
    repository: "ubiquity-sentinel/sentinel",
    number: 195,
    action: "updated",
  }]);
  assert.equal(summary.outcome, "healthy");
  assert.match(
    summary.explanation,
    /: 3 runtime summaries read on generation 102 \(ordinary\); 3 admitted, 3 model starts, 1 pull request touched; healthy\./,
  );
  assert.equal(appended.length, 1);
  assert.match(appended[0], /^\/summary\.md\n### Sentinel run summary/);
  assert.match(
    appended[0],
    /\| ubiquity\/passport\.ubq\.fi \| 41 \| 3 \| 1 \|/,
  );
  assert.ok(
    !seen.some((line) => line.includes("/actions/jobs/15/")),
    "no log read for the running finalize job",
  );
});

Deno.test("run summary: a failed job names itself, and an unreadable list stays advisory", async () => {
  const failed = aggregateRunSummary({ runId: RUN, runAttempt: 2 }, [
    { name: "repair", conclusion: "failure", summary: null },
    {
      name: "matrix_cell (a)",
      conclusion: "success",
      summary: lastRuntimeSummary(jobLog(child())),
    },
  ]);
  assert.equal(failed.outcome, "failed");
  assert.match(failed.nextAction, /^Open the repair job log/);
  const lines: string[] = [];
  const unread = await emitRunSummary({
    readJobs: () =>
      Promise.resolve({
        ok: false,
        error: { kind: "unavailable", detail: "down" },
      }),
    log: (line) => lines.push(line),
  }, { runId: RUN, runAttempt: 1 });
  assert.equal(lines.length, 1);
  assert.equal(unread?.outcome, "unavailable");
  assert.equal(unread?.admittedWorkCount, null);
  assert.match(unread!.nextAction, /job list was unreadable/);
  assert.equal(
    await emitRunSummary({
      readJobs: () => Promise.reject(new Error("transport down")),
      log: () => {},
    }, { runId: RUN, runAttempt: 1 }),
    null,
    "a thrown reader never escapes",
  );
});

Deno.test("run summary: foreign and truncated lines are not summaries", () => {
  assert.equal(lastRuntimeSummary("no json here"), null);
  assert.equal(
    lastRuntimeSummary('2026Z {"kind":"hosted_runtime_summary","targets":[{'),
    null,
  );
  const prior = lastRuntimeSummary(
    `${
      jobLog(child({ generation: 101 }))
    }\n2026Z {"kind":"hosted_runtime_summary"`,
  );
  assert.equal(prior?.generation, 101, "a truncated last line falls back");
});
