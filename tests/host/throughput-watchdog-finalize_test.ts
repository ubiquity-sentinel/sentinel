/**
 * Finalize-level throughput watchdog: fake metrics sidecar (with the store's
 * CAS semantics) and a fake self-repository issue tracker. Proves the exact
 * filed issue, the guardrails, the kill switch, that it never throws, and
 * the `watchdogIssuesFiled` counter on the cycle's own record.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { ThroughputMetricsRecordV1 } from "../../src/contracts/throughput-metrics.ts";
import {
  parseThroughputWatchdogMarkerV1,
  referencedIssueNumbersV1,
  THROUGHPUT_WATCHDOG_COOLDOWN_MS,
  type ThroughputWatchdogIssuesV1,
} from "../../src/host/throughput-watchdog-issue.ts";
import {
  runFinalizeMetricsTailV1,
  runFinalizeThroughputWatchdogV1,
  selfImproveEnabled,
} from "../../src/host/throughput-watchdog-finalize.ts";
import {
  appendThroughputRecordV1,
  decodeThroughputLedgerV1,
  EMPTY_THROUGHPUT_LEDGER,
  encodeThroughputLedgerV1,
  THROUGHPUT_WATCHDOG_PATH,
  type ThroughputMetricsLedgerV1,
} from "../../src/state/throughput-metrics-ledger.ts";
import type { ThroughputMetricsPortV1 } from "../../src/state/throughput-metrics-store.ts";
import { cycleRecord, cycles, NOW } from "./throughput-watchdog-helpers.ts";
import { createHostedWatchdogIssues } from "../../ops/hosted-autonomy-watchdog-issues.ts";

const DAY = 86_400_000;
const APP = "ubiquity-sentinel[bot]";

function fakeMetrics(records: ThroughputMetricsRecordV1[]) {
  let head: GitSha | null = "f".repeat(40) as GitSha;
  const port = {
    ledger: { records, daily: [] } as ThroughputMetricsLedgerV1,
    writes: 0,
    failRead: false,
    read() {
      if (port.failRead) return Promise.resolve(portError("unavailable", "x"));
      return Promise.resolve(portOk({ head, ledger: port.ledger }));
    },
    write(
      input: { expectedHead: GitSha | null; ledger: ThroughputMetricsLedgerV1 },
    ) {
      if (input.expectedHead !== head) {
        return Promise.resolve(portOk({ status: "conflict" as const, head }));
      }
      // The real store re-decodes what it commits.
      decodeThroughputLedgerV1(encodeThroughputLedgerV1(input.ledger));
      port.writes++;
      port.ledger = input.ledger;
      head = `${port.writes}`.padStart(40, "0") as GitSha;
      return Promise.resolve(portOk({ status: "applied" as const, head }));
    },
  };
  return port satisfies ThroughputMetricsPortV1;
}

interface Item {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
  state: "open" | "closed";
  author: string;
  pull: boolean;
}

function fakeTracker(items: Item[] = []) {
  const tracker = {
    items,
    lists: 0,
    creates: [] as Item[],
    updates: [] as Array<{ number: number; title: string; body: string }>,
    createResult: "ok" as "ok" | "null",
    throwOnList: false,
    hangList: false,
    next: 100,
    listOpen() {
      tracker.lists++;
      if (tracker.throwOnList) throw new Error("boom");
      if (tracker.hangList) return new Promise<never>(() => {});
      const open = tracker.items.filter((item) => item.state === "open");
      return Promise.resolve({
        issues: open.flatMap((item) => {
          const id = item.pull
            ? null
            : parseThroughputWatchdogMarkerV1(item.body);
          return id === null ? [] : [{
            number: item.number,
            thresholdId: id,
            appAuthored: item.author === APP,
          }];
        }),
        pulls: open.filter((item) => item.pull).map((item) => ({
          number: item.number,
          title: item.title,
          references: referencedIssueNumbersV1(`${item.title}\n${item.body}`),
        })),
      });
    },
    create(input: { title: string; body: string; labels: readonly string[] }) {
      const item: Item = {
        number: tracker.next++,
        ...input,
        state: "open",
        author: APP,
        pull: false,
      };
      tracker.items.push(item);
      tracker.creates.push(item);
      return Promise.resolve(
        tracker.createResult === "ok" ? item.number : null,
      );
    },
    update(number: number, input: { title: string; body: string }) {
      const item = tracker.items.find((row) => row.number === number);
      if (item === undefined) return Promise.resolve(false);
      item.title = input.title;
      item.body = input.body;
      tracker.updates.push({ number, ...input });
      return Promise.resolve(true);
    },
  };
  return tracker satisfies ThroughputWatchdogIssuesV1;
}

/** 30 cycles whose maintenance+repair median is `minutes`. */
const slow = (minutes: number, base = 1000) =>
  cycles(
    30,
    () => ({ maintenanceMin: minutes - 2, repairMin: 2 }),
    NOW,
    5 * 60_000,
    base,
  );

function run(
  metrics: ReturnType<typeof fakeMetrics>,
  issues: ReturnType<typeof fakeTracker>,
  runId: number,
  nowMs = NOW,
  enabled = true,
) {
  const lines: string[] = [];
  return runFinalizeThroughputWatchdogV1(
    { metrics, issues, log: (line) => lines.push(line) },
    { cycle: { runId, attempt: 1 }, record: null, nowMs, enabled },
  ).then((result) => ({ result, lines }));
}

Deno.test("watchdog finalize files exactly one issue with the marker, title and body shape", async () => {
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
  assert.equal(result.filed, 1);
  assert.deepEqual(result.missed, [
    "maintenance_repair_median",
    "repair_median",
  ]);
  assert.equal(issues.creates.length, 1, "at most one new issue per cycle");
  const [issue] = issues.creates;
  assert.equal(
    issue.title,
    "Throughput: maintenance+repair phase median missed (14.0 min vs <= 8.0 min)",
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
    ]
  ) assert(issue.body.includes(part), part);
  assert(!/https?:\/\//.test(issue.body));
  assert(issue.body.length < 16_384);
  const state = metrics.ledger.watchdog!;
  assert.deepEqual(state.lastCycle, { runId: 501, attempt: 1 });
  assert.deepEqual(state.thresholds.maintenance_repair_median, {
    issue: 100,
    measuredMilli: 14_000,
    filedAtMs: NOW,
    closedAtMs: null,
  });
  const log = JSON.parse(lines[0]);
  assert.equal(log.kind, "sentinel_throughput_watchdog");
  assert.equal(log.filed, 1);
  assert.equal(log.issue, 100);
  // The records were preserved by the watchdog's write.
  assert.equal(metrics.ledger.records.length, 30);
});

Deno.test("watchdog finalize never files while a watchdog issue is open and edits only past 10%", async () => {
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  await run(metrics, issues, 1);
  assert.equal(issues.creates.length, 1);
  // Next cycle, same measurement: nothing new, no edit.
  const second = await run(metrics, issues, 2);
  assert.equal(second.result.filed, 0);
  assert.equal(second.result.createBlocked, "open_watchdog_issue");
  assert.equal(issues.updates.length, 0);
  // Another threshold missing too never adds a second issue while one is open.
  metrics.ledger = { ...metrics.ledger, records: slow(10.5, 2000) };
  for (const record of metrics.ledger.records) {
    record.counts.cellsPlanned = 0;
    record.counts.readyRecordsNotPlanned = 4;
  }
  const third = await run(metrics, issues, 3);
  assert.deepEqual(third.result.missed, [
    "maintenance_repair_median",
    "cells_planned",
  ]);
  assert.equal(issues.creates.length, 1);
  assert.equal(issues.updates.length, 0, "a 5% change is not an edit");
  metrics.ledger = { ...metrics.ledger, records: slow(12, 3000) };
  const fourth = await run(metrics, issues, 4);
  assert.equal(fourth.result.edited, 1);
  assert.equal(issues.updates.length, 1);
  assert.equal(
    issues.items[0].title,
    "Throughput: maintenance+repair phase median missed (12.0 min vs <= 8.0 min)",
  );
  assert.equal(
    metrics.ledger.watchdog!.thresholds.maintenance_repair_median.measuredMilli,
    12_000,
  );
});

Deno.test("watchdog finalize respects the 7-day cooldown after its issue closes", async () => {
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  await run(metrics, issues, 1);
  issues.items[0].state = "closed";
  const closed = await run(metrics, issues, 2, NOW + 60_000);
  assert.equal(closed.result.createBlocked, "cooldown");
  assert.equal(closed.result.filed, 0);
  assert.equal(
    metrics.ledger.watchdog!.thresholds.maintenance_repair_median.closedAtMs,
    NOW + 60_000,
  );
  const almost = await run(
    metrics,
    issues,
    3,
    NOW + 60_000 + THROUGHPUT_WATCHDOG_COOLDOWN_MS - 1,
  );
  assert.equal(almost.result.createBlocked, "cooldown");
  // The close instant is kept from the first observation.
  const after = await run(metrics, issues, 4, NOW + 60_000 + 7 * DAY);
  assert.equal(after.result.filed, 1);
  assert.equal(issues.creates.length, 2);
  assert.equal(
    metrics.ledger.watchdog!.thresholds.maintenance_repair_median.issue,
    101,
  );
});

Deno.test("watchdog finalize never files while an open pull request references a watchdog issue", async () => {
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  await run(metrics, issues, 1);
  issues.items[0].state = "closed";
  issues.items.push({
    number: 140,
    title: "Sentinel repair: issue 100",
    body: "Resolves #100",
    labels: [],
    state: "open",
    author: APP,
    pull: true,
  });
  // The close is observed now; the PR still blocks after the cooldown.
  const closing = await run(metrics, issues, 2, NOW + 60_000);
  assert.equal(closing.result.createBlocked, "open_pull_request");
  const blocked = await run(metrics, issues, 3, NOW + 8 * DAY);
  assert.equal(blocked.result.createBlocked, "open_pull_request");
  assert.equal(issues.creates.length, 1);
  issues.items[1].state = "closed";
  const free = await run(metrics, issues, 4, NOW + 8 * DAY);
  assert.equal(free.result.filed, 1);
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
      version: 1,
      lastCycle: { runId: 3, attempt: 2 },
      thresholds: {
        cells_planned: {
          issue: 12,
          measuredMilli: 2000,
          filedAtMs: NOW,
          closedAtMs: NOW + 1,
        },
      },
    },
  };
  const files = encodeThroughputLedgerV1(ledger);
  assert.equal(
    files.get(THROUGHPUT_WATCHDOG_PATH),
    `{"lastCycle":{"attempt":2,"runId":3},"thresholds":{"cells_planned":{"closedAtMs":${
      NOW + 1
    },"filedAtMs":${NOW},"issue":12,"measuredMilli":2000}},"version":1}\n`,
  );
  assert.deepEqual(decodeThroughputLedgerV1(files), ledger);
  const appended = appendThroughputRecordV1(
    ledger,
    cycleRecord({ runId: 4, finishedAtMs: NOW, maintenanceMin: 1 }),
  );
  assert.deepEqual(appended.ledger.watchdog, ledger.watchdog);
  for (
    const bad of [
      '{"version":1}\n',
      '{"lastCycle":null,"thresholds":{"Bad-Id":{"closedAtMs":null,"filedAtMs":1,"issue":1,"measuredMilli":null}},"version":1}\n',
      '{"lastCycle":null,"thresholds":{},"version":1}\n{"x":1}\n',
    ]
  ) {
    assert.throws(() =>
      decodeThroughputLedgerV1(new Map([[THROUGHPUT_WATCHDOG_PATH, bad]]))
    );
  }
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
