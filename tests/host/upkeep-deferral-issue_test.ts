import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { runHostedSupervisorHost } from "../../src/host/actions-supervisor-host.ts";
import {
  fallbackUpkeepNoticePort,
  issueUpkeepNoticePort,
  logUpkeepNoticePort,
  metricsUpkeepStreakStore,
  UPKEEP_DEFERRAL_ENV,
} from "../../src/host/upkeep-deferral-finalize.ts";
import { UPKEEP_DEFERRAL_DECISIONS_POINTER } from "../../src/host/upkeep-deferral-issue.ts";
import {
  decodeThroughputLedgerV1,
  EMPTY_THROUGHPUT_LEDGER,
  encodeThroughputLedgerV1,
  THROUGHPUT_UPKEEP_STREAK_PATH,
  type ThroughputMetricsLedgerV1,
} from "../../src/state/throughput-metrics-ledger.ts";
import type { ThroughputMetricsPortV1 } from "../../src/state/throughput-metrics-store.ts";
import { createHostedUpkeepIssues } from "../../ops/hosted-autonomy-upkeep-issues.ts";
import { HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR } from "../../ops/hosted-autonomy-policy.ts";
import { HOSTED_CONTROLLER_SELF } from "../../src/contracts/hosted-controller-deployment.ts";
import { LAUNCHER, makeRig, ROOT } from "./actions-supervisor-fixture.ts";
import { exited, hostedEnv } from "./hosted-runtime-fixture.ts";

const SELF = HOSTED_CONTROLLER_SELF;
const API = "https://api.github.com/repos/ubiquity-sentinel/sentinel";

/** Expected-head metrics sidecar fake over the strict file encoding. */
function fakeMetricsPort(initial?: ThroughputMetricsLedgerV1) {
  let head: GitSha | null = initial === undefined
    ? null
    : "f".repeat(40) as GitSha;
  let writes = 0;
  const port = {
    ledger: initial ?? EMPTY_THROUGHPUT_LEDGER as ThroughputMetricsLedgerV1,
    read: () => Promise.resolve(portOk({ head, ledger: port.ledger })),
    write: ({ expectedHead, ledger }: {
      expectedHead: GitSha | null;
      ledger: ThroughputMetricsLedgerV1;
    }) => {
      if (expectedHead !== head) {
        return Promise.resolve(portOk({ status: "conflict" as const, head }));
      }
      writes++;
      port.ledger = decodeThroughputLedgerV1(encodeThroughputLedgerV1(ledger));
      head = `${writes}`.padStart(40, "0") as GitSha;
      return Promise.resolve(portOk({ status: "applied" as const, head }));
    },
  };
  return port as ThroughputMetricsPortV1 & {
    ledger: ThroughputMetricsLedgerV1;
  };
}

interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
}

/** Fake GitHub issues API for the self repository (App-authored rows). */
function fakeGitHub() {
  const issues: FakeIssue[] = [];
  const calls: string[] = [];
  let fail = false;
  const wire = (row: FakeIssue) => ({
    number: row.number,
    title: row.title,
    body: row.body,
    state: row.state,
    user: { login: HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR },
    created_at: "2026-11-05T00:00:00Z",
    repository_url: API,
  });
  const request = (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> => {
    calls.push(`${method} ${path.split("?")[0]}`);
    if (fail) return Promise.reject(new Error("issue API unavailable"));
    const one = /^\/repos\/ubiquity-sentinel\/sentinel\/issues\/(\d+)$/.exec(
      path,
    );
    if (method === "GET" && path.includes("/issues?")) {
      return Promise.resolve(
        issues.filter((row) => row.state === "open").map(wire),
      );
    }
    if (method === "GET" && one !== null) {
      const row = issues.find((item) => item.number === Number(one[1]));
      return Promise.resolve(row === undefined ? null : wire(row));
    }
    if (method === "POST") {
      const row: FakeIssue = {
        number: 500 + issues.length,
        title: String(body!.title),
        body: String(body!.body),
        state: "open",
      };
      issues.push(row);
      return Promise.resolve({ ...wire(row), labels: [] });
    }
    if (method === "PATCH" && one !== null) {
      const row = issues.find((item) => item.number === Number(one[1]))!;
      row.title = String(body!.title);
      row.body = String(body!.body);
      return Promise.resolve(wire(row));
    }
    return Promise.reject(new Error(`unexpected ${method} ${path}`));
  };
  return {
    issues,
    calls,
    request,
    setFail: (value: boolean) => {
      fail = value;
    },
    writes: () => calls.filter((call) => !call.startsWith("GET")),
  };
}

async function finalizeRig(initial?: ThroughputMetricsLedgerV1) {
  const rig = await makeRig();
  const port = fakeMetricsPort(initial);
  const github = fakeGitHub();
  const logs: string[] = [];
  const summary: string[] = [];
  const log = (line: string) => logs.push(line);
  const appendSummary = (line: string) => {
    summary.push(line);
    return Promise.resolve();
  };
  const finalize = async (runId: number, observation: string | undefined) => {
    const env: Record<string, string> = {
      ...hostedEnv(LAUNCHER),
      GITHUB_RUN_ID: String(runId),
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "finalize",
      GITHUB_TOKEN: "synthetic-native-token-for-test",
    };
    if (observation !== undefined) env[UPKEEP_DEFERRAL_ENV] = observation;
    return await runHostedSupervisorHost({
      env,
      sourceDir: ROOT,
      clock: rig.clock,
      state: rig.release,
      http: () => Promise.reject(new Error("finalize test needs no API")),
      process: {
        run: (command) =>
          Promise.resolve(
            exited(command.args.includes("status") ? "" : LAUNCHER),
          ),
      },
      throughputMetrics: { port, log },
      upkeepDeferral: {
        store: metricsUpkeepStreakStore(port),
        notice: fallbackUpkeepNoticePort({
          issue: issueUpkeepNoticePort(
            createHostedUpkeepIssues(github.request, SELF),
          ),
          log: logUpkeepNoticePort({ log, appendSummary }),
          appendSummary,
          budgetMs: 2_000,
        }),
        log,
      },
    });
  };
  const streakLines = () =>
    logs.map((line) => JSON.parse(line)).filter((line) =>
      line.kind === "sentinel_upkeep_deferral_streak"
    );
  const logNotices = () =>
    logs.map((line) => JSON.parse(line)).filter((line) =>
      line.kind === "sentinel_upkeep_deferral_notice"
    );
  return {
    rig,
    port,
    github,
    summary,
    finalize,
    streakLines,
    logNotices,
  };
}

const DEFER = "deferred_historical_quarantine";

Deno.test("upkeep owner issue: third deferral opens one issue, sixth edits once, a new streak reuses or reopens", async () => {
  const f = await finalizeRig();
  try {
    const startedAt = f.rig.clock.now();
    for (const runId of [801, 802]) await f.finalize(runId, DEFER);
    assert.deepEqual(f.github.writes(), []);

    await f.finalize(803, DEFER);
    assert.deepEqual(f.github.writes(), [
      "POST /repos/ubiquity-sentinel/sentinel/issues",
    ]);
    assert.equal(f.github.issues.length, 1);
    const [issue] = f.github.issues;
    assert.equal(
      issue.title,
      "Upkeep deferred for 3 consecutive supervisor cycles",
    );
    const lines = issue.body.split("\n");
    assert.equal(lines[0], "<!-- sentinel:skip -->");
    assert.equal(lines[1], "<!-- sentinel:upkeep-deferral -->");
    assert.match(issue.body, /Reason codes: `deferred_historical_quarantine`/);
    assert.match(issue.body, /Supervisor run ids: 801, 802, 803/);
    assert.ok(
      issue.body.includes(
        `Streak started: ${new Date(startedAt).toISOString()}`,
      ),
    );
    assert.ok(issue.body.includes(UPKEEP_DEFERRAL_DECISIONS_POINTER));
    assert.doesNotMatch(issue.body, /https?:|token|secret/i);
    // The issue number is recorded on the streak; no log notice was needed.
    assert.equal(f.port.ledger.upkeepStreak?.issueNumber, issue.number);
    assert.equal(f.logNotices().length, 0);
    assert.equal(f.streakLines().at(-1).adapter, "issue");
    assert.match(f.summary.at(-1)!, /issue adapter to owner issue #500/);
    const record = (runId: number) =>
      f.port.ledger.records.find((row) => row.cycle.runId === runId)!;
    assert.equal(record(803).counts.ownerNoticesSent, 1);

    // The fourth and fifth deferrals neither edit nor create.
    await f.finalize(804, DEFER);
    await f.finalize(805, DEFER);
    assert.equal(f.github.writes().length, 1);
    assert.equal(record(805).counts.ownerNoticesSent, null);

    // The sixth deferral edits the same issue exactly once.
    await f.finalize(806, "deferred_matrix_history_budget");
    assert.deepEqual(f.github.writes().slice(1), [
      "PATCH /repos/ubiquity-sentinel/sentinel/issues/500",
    ]);
    assert.equal(
      issue.title,
      "Upkeep deferred for 6 consecutive supervisor cycles",
    );
    assert.match(
      issue.body,
      /Reason codes: `deferred_historical_quarantine`, `deferred_matrix_history_budget`/,
    );
    assert.match(issue.body, /run ids: 801, 802, 803, 804, 805, 806/);
    // A rerun of the sixth finalize writes nothing more.
    await f.finalize(806, "deferred_matrix_history_budget");
    assert.equal(f.github.writes().length, 2);

    // A reset never closes the issue and keeps the recorded number.
    await f.finalize(807, "none");
    assert.equal(issue.state, "open");
    assert.equal(f.port.ledger.upkeepStreak?.count, 0);
    assert.equal(f.port.ledger.upkeepStreak?.issueNumber, 500);
    assert.equal(f.github.writes().length, 2);

    // A new streak reuses the recorded issue while it is open.
    for (const runId of [808, 809, 810]) await f.finalize(runId, DEFER);
    assert.deepEqual(f.github.writes().slice(2), [
      "PATCH /repos/ubiquity-sentinel/sentinel/issues/500",
    ]);
    assert.equal(f.github.issues.length, 1);
    assert.match(issue.body, /run ids: 808, 809, 810\n/);

    // The owner closes it; the next streak opens a fresh issue.
    await f.finalize(811, "none");
    issue.state = "closed";
    for (const runId of [812, 813, 814]) await f.finalize(runId, DEFER);
    assert.deepEqual(f.github.writes().slice(3), [
      "POST /repos/ubiquity-sentinel/sentinel/issues",
    ]);
    assert.equal(f.github.issues.length, 2);
    assert.equal(f.port.ledger.upkeepStreak?.issueNumber, 501);
    assert.equal(f.logNotices().length, 0);
  } finally {
    await f.rig.cleanup();
  }
});

Deno.test("upkeep owner issue: a failed issue port falls back to the log line and the run is unaffected", async () => {
  const f = await finalizeRig();
  try {
    f.github.setFail(true);
    const results = [];
    for (const runId of [901, 902, 903]) {
      results.push(await f.finalize(runId, DEFER));
    }
    assert.deepEqual(new Set(results.map((row) => row.status)).size, 1);
    assert.equal(f.github.issues.length, 0);
    assert.deepEqual(f.logNotices(), [{
      kind: "sentinel_upkeep_deferral_notice",
      title: "Upkeep deferred for 3 consecutive supervisor cycles",
      reason: DEFER,
      runId: 903,
    }]);
    assert.equal(f.streakLines().at(-1).adapter, "log");
    assert.match(f.summary.at(-1)!, /delivered by the log adapter/);
    assert.equal(f.port.ledger.upkeepStreak?.issueNumber, null);
    assert.equal(
      f.port.ledger.records.find((row) => row.cycle.runId === 903)!.counts
        .ownerNoticesSent,
      1,
    );
    // A recovered port reaches the issue on the next claim, by marker.
    f.github.setFail(false);
    for (const runId of [904, 905, 906]) await f.finalize(runId, DEFER);
    assert.equal(f.github.issues.length, 1);
    assert.equal(f.port.ledger.upkeepStreak?.issueNumber, 500);
  } finally {
    await f.rig.cleanup();
  }
});

Deno.test("upkeep owner issue: the live version 1 streak file is read, and the issue number round-trips", async () => {
  const live = new Map([[
    THROUGHPUT_UPKEEP_STREAK_PATH,
    '{"count":2,"lastRunId":1002,"notified":false,"version":1}\n',
  ]]);
  const lifted = decodeThroughputLedgerV1(live);
  assert.deepEqual(lifted.upkeepStreak, {
    version: 2,
    count: 2,
    lastRunId: 1002,
    noticeCount: null,
    runIds: [1002],
    reasons: [],
    startedAtMs: null,
    issueNumber: null,
  });
  const f = await finalizeRig(lifted);
  try {
    // An open marker issue from an earlier streak is found and reused.
    f.github.issues.push({
      number: 77,
      title: "Upkeep deferred for 3 consecutive supervisor cycles",
      body: "<!-- sentinel:skip -->\n<!-- sentinel:upkeep-deferral -->\nold",
      state: "open",
    });
    await f.finalize(1003, DEFER);
    assert.deepEqual(f.github.writes(), [
      "PATCH /repos/ubiquity-sentinel/sentinel/issues/77",
    ]);
    assert.match(f.github.issues[0].body, /Streak started: not recorded/);
    assert.match(
      f.github.issues[0].body,
      /run ids \(2 of 3 recorded\): 1002, 1003\n/,
    );
    const file = encodeThroughputLedgerV1(f.port.ledger).get(
      THROUGHPUT_UPKEEP_STREAK_PATH,
    )!;
    assert.equal(
      file,
      '{"count":3,"issueNumber":77,"lastRunId":1003,"noticeCount":3,"reasons":["deferred_historical_quarantine"],"runIds":[1002,1003],"startedAtMs":null,"version":2}\n',
    );
    assert.deepEqual(
      decodeThroughputLedgerV1(new Map([[THROUGHPUT_UPKEEP_STREAK_PATH, file]]))
        .upkeepStreak?.issueNumber,
      77,
    );
  } finally {
    await f.rig.cleanup();
  }
});
