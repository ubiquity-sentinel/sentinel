/**
 * Finalize-level throughput watchdog: fake metrics sidecar (with the store's
 * CAS semantics) and a fake self-repository issue tracker. Proves the exact
 * filed issues, adoption, the kill switch, that it never throws, the
 * `watchdogIssuesFiled` counter on the cycle's own record and the state
 * file. The guardrails are in `throughput-watchdog-guardrails_test.ts`.
 */
import assert from "node:assert/strict";
import {
  runFinalizeMetricsTailV1,
  runFinalizeThroughputWatchdogV1,
  selfImproveEnabled,
  watchdogRuntimeOfV1,
} from "../../src/host/throughput-watchdog-finalize.ts";
import {
  appendThroughputRecordV1,
  decodeThroughputLedgerV1,
  EMPTY_THROUGHPUT_LEDGER,
  encodeThroughputLedgerV1,
  THROUGHPUT_WATCHDOG_PATH,
  type ThroughputMetricsLedgerV1,
} from "../../src/state/throughput-metrics-ledger.ts";
import { cycleRecord, cycles, NOW } from "./throughput-watchdog-helpers.ts";
import {
  APP,
  DAY,
  fakeMetrics,
  fakeTracker,
  run,
  slow,
} from "./throughput-watchdog-fakes.ts";
import { createHostedWatchdogIssues } from "../../ops/hosted-autonomy-watchdog-issues.ts";

Deno.test("watchdog finalize files one issue per missed threshold with the marker, title and body shape", async () => {
  // Two thresholds missed at once: maintenance+repair and repair (>= 60 live).
  const records = cycles(30, () => ({
    maintenanceMin: 8,
    repairMin: 4,
    recordsRead: 70,
  }));
  records.forEach((record) => (record.phaseMs.repair = 6 * 60_000));
  const metrics = fakeMetrics(records);
  const issues = fakeTracker();
  const { result, lines } = await run(metrics, issues, 501);
  assert.equal(result.status, "evaluated");
  assert.equal(result.filed, 2);
  assert.deepEqual(result.missed, [
    "maintenance_repair_median",
    "repair_median",
  ]);
  assert.equal(result.createBlocked, null);
  assert.equal(issues.creates.length, 2, "both thresholds in one cycle");
  const [issue, second] = issues.creates;
  assert.equal(
    issue.title,
    "Throughput: maintenance+repair phase median missed (14.0 min vs <= 8.0 min)",
  );
  assert.equal(
    second.body.split("\n")[1],
    "<!-- sentinel:throughput-watchdog:repair_median -->",
  );
  assert.deepEqual(issue.labels, ["priority:2"]);
  const body = issue.body.split("\n");
  assert.equal(
    body[0],
    "Sentinel throughput watchdog: `maintenance_repair_median` is missed.",
  );
  assert.equal(
    body[1],
    "<!-- sentinel:throughput-watchdog:maintenance_repair_median -->",
  );
  assert(!issue.body.includes("sentinel:skip"), "the intake must admit it");
  for (
    const part of [
      "## Measurement",
      "from the #340 child #324",
      "- Measured: 14.0 min (median); limit: <= 8.0 min.",
      "- Window: latest 30 cycles, 2026-11-05 09:25 .. 2026-11-05 12:00 UTC; cycles evaluated: 30.",
      "`phaseMs.maintenance`, `phaseMs.repair`",
      "Evaluated by finalize of run 501 attempt 1",
      "## What to investigate",
      "`ops/hosted-autonomy-maintenance.ts`",
      "## Done when",
      "this issue is re-evaluated after 10 cycles on a newer runtime",
    ]
  ) assert(issue.body.includes(part), part);
  assert(!issue.body.includes("7 days"), "the cooldown is retired");
  assert(!/https?:\/\//.test(issue.body));
  assert(issue.body.length < 16_384);
  const state = metrics.ledger.watchdog!;
  assert.equal(state.version, 2);
  assert.deepEqual(state.lastCycle, { runId: 501, attempt: 1 });
  assert.deepEqual(state.daily, { date: "2026-11-05", filed: 2 });
  assert.deepEqual(state.thresholds.maintenance_repair_median, {
    issue: 100,
    measuredMilli: 14_000,
    filedAtMs: NOW,
    cyclesSinceText: 0,
    closed: null,
  });
  assert.equal(state.thresholds.repair_median.issue, 101);
  const log = JSON.parse(lines[0]);
  assert.equal(log.kind, "sentinel_throughput_watchdog");
  assert.equal(log.filed, 2);
  assert.deepEqual(log.issues, [100, 101]);
  assert.deepEqual(log.blocked, {});
  // The records were preserved by the watchdog's write.
  assert.equal(metrics.ledger.records.length, 30);
});

Deno.test("watchdog finalize adopts an issue whose recording write was lost", async () => {
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker([{
    number: 77,
    title:
      "Throughput: maintenance+repair phase median missed (9.0 min vs <= 8.0 min)",
    body:
      "Sentinel throughput watchdog.\n<!-- sentinel:throughput-watchdog:maintenance_repair_median -->\n",
    labels: ["priority:2"],
    state: "open",
    author: APP,
    pull: false,
  }]);
  const { result } = await run(metrics, issues, 1);
  assert.equal(result.filed, 0);
  assert.equal(result.createBlocked, "open_watchdog_issue");
  // Unknown stored measurement: the adopted issue is refreshed once.
  assert.equal(result.edited, 1);
  assert.equal(
    metrics.ledger.watchdog!.thresholds.maintenance_repair_median.issue,
    77,
  );
  // A human copy of the marker also blocks, but is never edited.
  const human = fakeTracker([{
    ...issues.items[0],
    number: 5,
    author: "someone",
  }]);
  const other = await run(fakeMetrics(slow(10)), human, 1);
  assert.equal(other.result.createBlocked, "open_watchdog_issue");
  assert.equal(human.updates.length, 0);
});

Deno.test("watchdog finalize is off when SENTINEL_SELF_IMPROVE is off", async () => {
  assert.equal(selfImproveEnabled(undefined), true);
  assert.equal(selfImproveEnabled("on"), true);
  assert.equal(selfImproveEnabled(""), true);
  assert.equal(selfImproveEnabled("off"), false);
  assert.equal(selfImproveEnabled(" OFF "), false);
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  const { result, lines } = await run(metrics, issues, 1, NOW, false);
  assert.equal(result.status, "off");
  assert.equal(result.filed, null);
  assert.equal(issues.lists, 0);
  assert.equal(metrics.writes, 0);
  assert.equal(JSON.parse(lines[0]).status, "off");
});

Deno.test("watchdog finalize never throws and leaves the run unaffected", async () => {
  const throwing = fakeTracker();
  throwing.throwOnList = true;
  const failed = await run(fakeMetrics(slow(10)), throwing, 1);
  assert.equal(failed.result.status, "failed");
  assert.equal(JSON.parse(failed.lines[0]).status, "failed");
  const unreadable = fakeMetrics(slow(10));
  unreadable.failRead = true;
  const none = await run(unreadable, fakeTracker(), 1);
  assert.equal(none.result.status, "metrics_unavailable");
  const unproven = fakeTracker();
  unproven.createResult = "null";
  const lost = await run(fakeMetrics(slow(10)), unproven, 1);
  assert.equal(lost.result.filed, 0);
  assert.equal(lost.result.stateWrite, "applied");
  const hanging = fakeTracker();
  hanging.hangList = true;
  const timed = await runFinalizeThroughputWatchdogV1(
    {
      metrics: fakeMetrics(slow(10)),
      issues: hanging,
      log: () => {},
      budgetMs: 20,
    },
    {
      cycle: { runId: 1, attempt: 1 },
      record: null,
      nowMs: NOW,
      enabled: true,
    },
  );
  assert.equal(timed.status, "timeout");
  // A repeated finalize of the same cycle acts once.
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  await run(metrics, issues, 9);
  issues.items[0].state = "closed";
  const again = await run(metrics, issues, 9, NOW + 30 * DAY);
  assert.equal(again.result.status, "already_evaluated");
  assert.equal(issues.creates.length, 1);
});

Deno.test("finalize metrics tail: the cycle's own record counts the filed issue", async () => {
  const facts = {
    cycle: { runId: 77, attempt: 1 },
    finalizeStartedAtMs: NOW,
    nowMs: NOW + 1_000,
    jobs: null,
    runSummary: null,
  };
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  const tail = await runFinalizeMetricsTailV1({
    metrics: { port: metrics, log: () => {} },
    watchdog: { metrics, issues, log: () => {} },
    selfImprove: "on",
  }, facts);
  assert.equal(tail.watchdog?.filed, 1);
  assert.equal(tail.metrics?.status, "applied");
  const own = metrics.ledger.records.find((r) => r.cycle.runId === 77)!;
  assert.equal(own.counts.watchdogIssuesFiled, 1);
  // The watchdog state survives the metrics append on the same sidecar.
  assert.equal(
    metrics.ledger.watchdog?.thresholds.maintenance_repair_median.issue,
    100,
  );
  // Off: the counter is absent (not observed), the record is still written.
  const offMetrics = fakeMetrics(slow(10));
  const off = await runFinalizeMetricsTailV1({
    metrics: { port: offMetrics, log: () => {} },
    watchdog: { metrics: offMetrics, issues: fakeTracker(), log: () => {} },
    selfImprove: "off",
  }, facts);
  assert.equal(off.metrics?.status, "applied");
  const bare = offMetrics.ledger.records.find((r) => r.cycle.runId === 77)!;
  assert(!Object.hasOwn(bare.counts, "watchdogIssuesFiled"));
  // A failing issue port never blocks the append.
  const broken = fakeTracker();
  broken.throwOnList = true;
  const brokenMetrics = fakeMetrics(slow(10));
  const kept = await runFinalizeMetricsTailV1({
    metrics: { port: brokenMetrics, log: () => {} },
    watchdog: { metrics: brokenMetrics, issues: broken, log: () => {} },
    selfImprove: undefined,
  }, facts);
  assert.equal(kept.watchdog?.status, "failed");
  assert.equal(kept.metrics?.status, "applied");
});

Deno.test("watchdog state round-trips on the metrics sidecar and survives appends", () => {
  const ledger: ThroughputMetricsLedgerV1 = {
    ...EMPTY_THROUGHPUT_LEDGER,
    watchdog: {
      version: 2,
      lastCycle: { runId: 3, attempt: 2 },
      daily: { date: "2026-11-05", filed: 1 },
      thresholds: {
        cells_planned: {
          issue: 12,
          measuredMilli: 2000,
          filedAtMs: NOW,
          cyclesSinceText: 4,
          closed: {
            atMs: NOW + 1,
            measuredMilli: 1000,
            runtime: { generation: 7, sha: "a".repeat(40) },
            newerCycles: 3,
          },
        },
      },
    },
  };
  const files = encodeThroughputLedgerV1(ledger);
  assert.equal(
    files.get(THROUGHPUT_WATCHDOG_PATH),
    `{"daily":{"date":"2026-11-05","filed":1},"lastCycle":{"attempt":2,"runId":3},"thresholds":{"cells_planned":{"closed":{"atMs":${
      NOW + 1
    },"measuredMilli":1000,"newerCycles":3,"runtime":{"generation":7,"sha":"${
      "a".repeat(40)
    }"}},"cyclesSinceText":4,"filedAtMs":${NOW},"issue":12,"measuredMilli":2000}},"version":2}\n`,
  );
  assert.deepEqual(decodeThroughputLedgerV1(files), ledger);
  const appended = appendThroughputRecordV1(
    ledger,
    cycleRecord({ runId: 4, finishedAtMs: NOW, maintenanceMin: 1 }),
  );
  assert.deepEqual(appended.ledger.watchdog, ledger.watchdog);
  // The historical version 1 file still reads, lifted with an unknown
  // runtime at close (the next known runtime becomes the baseline).
  const v1 = decodeThroughputLedgerV1(
    new Map([[
      THROUGHPUT_WATCHDOG_PATH,
      `{"lastCycle":{"attempt":2,"runId":3},"thresholds":{"cells_planned":{"closedAtMs":${
        NOW + 1
      },"filedAtMs":${NOW},"issue":12,"measuredMilli":2000},"repair_median":{"closedAtMs":null,"filedAtMs":${NOW},"issue":13,"measuredMilli":null}},"version":1}\n`,
    ]]),
  );
  assert.deepEqual(v1.watchdog, {
    version: 2,
    lastCycle: { runId: 3, attempt: 2 },
    daily: null,
    thresholds: {
      cells_planned: {
        issue: 12,
        measuredMilli: 2000,
        filedAtMs: NOW,
        cyclesSinceText: 0,
        closed: {
          atMs: NOW + 1,
          measuredMilli: 2000,
          runtime: null,
          newerCycles: 0,
        },
      },
      repair_median: {
        issue: 13,
        measuredMilli: null,
        filedAtMs: NOW,
        cyclesSinceText: 0,
        closed: null,
      },
    },
  });
  for (
    const bad of [
      '{"version":2}\n',
      '{"daily":null,"lastCycle":null,"thresholds":{"Bad-Id":{"closed":null,"cyclesSinceText":0,"filedAtMs":1,"issue":1,"measuredMilli":null}},"version":2}\n',
      '{"daily":{"date":"today","filed":1},"lastCycle":null,"thresholds":{},"version":2}\n',
      '{"daily":null,"lastCycle":null,"thresholds":{"cells_planned":{"closed":{"atMs":1,"measuredMilli":null,"newerCycles":0,"runtime":{"generation":1,"sha":"x"}},"cyclesSinceText":0,"filedAtMs":1,"issue":1,"measuredMilli":null}},"version":2}\n',
      '{"lastCycle":null,"thresholds":{},"version":2}\n',
      '{"daily":null,"lastCycle":null,"thresholds":{},"version":1}\n',
      '{"daily":null,"lastCycle":null,"thresholds":{},"version":2}\n{"x":1}\n',
    ]
  ) {
    assert.throws(() =>
      decodeThroughputLedgerV1(new Map([[THROUGHPUT_WATCHDOG_PATH, bad]]))
    );
  }
});

Deno.test("watchdog runtime comes from the run summary only when exact", () => {
  const summary = (generation: number | null, runtimeSha: string | null) =>
    ({ generation, runtimeSha }) as unknown as Parameters<
      typeof watchdogRuntimeOfV1
    >[0];
  assert.equal(watchdogRuntimeOfV1(null), null);
  assert.deepEqual(watchdogRuntimeOfV1(summary(4, "b".repeat(40))), {
    generation: 4,
    sha: "b".repeat(40),
  });
  assert.equal(watchdogRuntimeOfV1(summary(null, "b".repeat(40))), null);
  assert.equal(watchdogRuntimeOfV1(summary(4, null)), null);
  assert.equal(watchdogRuntimeOfV1(summary(4, "short")), null);
});

Deno.test("workflow and task carry SENTINEL_SELF_IMPROVE to finalize, default on", async () => {
  const root = new URL("../../", import.meta.url);
  const workflow = await Deno.readTextFile(
    new URL(".github/workflows/supervisor.yml", root),
  );
  const finalize = workflow.slice(workflow.indexOf("\n  finalize:"));
  assert.match(
    finalize,
    /^ {10}SENTINEL_SELF_IMPROVE: \$\{\{ vars\.SENTINEL_SELF_IMPROVE \|\| 'on' \}\}$/m,
  );
  const tasks = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", root)),
  ).tasks as Record<string, string>;
  assert.match(
    tasks["supervisor:run"],
    /--allow-env=[^ ]*\bSENTINEL_SELF_IMPROVE\b/,
  );
  const readme = await Deno.readTextFile(new URL("README.md", root));
  assert.match(readme, /`SENTINEL_SELF_IMPROVE` \(default `on`\) set to `off`/);
});

Deno.test("hosted watchdog issue port: one complete open listing and the trusted create", async () => {
  const repoUrl = "https://api.github.com/repos/ubiquity-sentinel/sentinel";
  const wire = (number: number, extra: Record<string, unknown>) => ({
    number,
    state: "open",
    title: `item ${number}`,
    body: "",
    user: { login: APP },
    created_at: "2026-11-05T10:00:00Z",
    repository_url: repoUrl,
    ...extra,
  });
  const page = [
    wire(3, {
      body:
        "Sentinel throughput watchdog.\n<!-- sentinel:throughput-watchdog:cells_planned -->\n",
    }),
    wire(4, {
      body: "<!-- sentinel:skip -->\n<!-- sentinel:target-capability -->",
    }),
    wire(5, {
      title: "Sentinel repair: issue 3",
      body: "Resolves #3",
      pull_request: {},
    }),
    wire(6, { body: null, user: { login: "someone" } }),
  ];
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let answer: unknown = page;
  const request = (
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ) => {
    calls.push({ method, path, body });
    if (method === "POST") {
      return Promise.resolve({
        ...wire(9, { title: body!.title, body: body!.body }),
        labels: (body!.labels as string[]).map((name) => ({ name })),
      });
    }
    return Promise.resolve(answer);
  };
  const port = createHostedWatchdogIssues(request, {
    owner: "ubiquity-sentinel",
    name: "sentinel",
    installationId: 0,
  });
  assert.deepEqual(await port.listOpen(), {
    issues: [{ number: 3, thresholdId: "cells_planned", appAuthored: true }],
    pulls: [{ number: 5, title: "Sentinel repair: issue 3", references: [3] }],
  });
  assert.equal(
    calls[0].path,
    "/repos/ubiquity-sentinel/sentinel/issues?state=open&sort=created&direction=asc&per_page=100&page=1",
  );
  // A malformed, repeated or foreign item refuses the whole listing.
  for (
    const bad of [
      [...page, page[0]],
      [wire(7, { repository_url: "https://api.github.com/repos/x/y" })],
      [null],
      [wire(8, { state: "closed" })],
    ]
  ) {
    answer = bad;
    assert.equal(await port.listOpen(), null);
  }
  answer = null;
  assert.equal(await port.listOpen(), null);
  const created = await port.create({
    title: "Throughput: x missed (1 vs <= 0)",
    body: "line\n<!-- sentinel:throughput-watchdog:cells_planned -->",
    labels: ["priority:2"],
  });
  assert.equal(created, 9);
  const post = calls.find((call) => call.method === "POST")!;
  assert.equal(post.path, "/repos/ubiquity-sentinel/sentinel/issues");
  assert.deepEqual((post.body as Record<string, unknown>).labels, [
    "priority:2",
  ]);
});
