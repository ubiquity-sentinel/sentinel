/**
 * The throughput watchdog files once per missed threshold (owner decision
 * 2026-11-15). Live shape: #405, #408, #410, #411 and #414 were filed for the
 * same two thresholds, each merged fix leaving them missed. Only 10 full met
 * windows in a row since the close re-arm a threshold (one met window can be
 * noise in which cycles fill it; independent review). Driven through
 * finalize's real metrics tail (`runFinalizeMetricsTailV1`: the watchdog
 * evaluates the cycle's own record, then the record is appended) with the
 * fake metrics sidecar, a fake self-repository tracker, an injected clock and
 * the runtime the run summary names.
 */
import assert from "node:assert/strict";
import type { ThroughputMetricsRecordV1 } from "../../src/contracts/throughput-metrics.ts";
import type { HostedRuntimeRunSummaryV1 } from "../../src/host/run-summary.ts";
import { evaluateThroughputWatchdogV1 } from "../../src/host/throughput-watchdog.ts";
import { runFinalizeMetricsTailV1 } from "../../src/host/throughput-watchdog-finalize.ts";
import type { ThroughputWatchdogIssuesV1 } from "../../src/host/throughput-watchdog-issue.ts";
import { THROUGHPUT_WATCHDOG_THRESHOLDS } from "../../src/host/throughput-watchdog-thresholds.ts";
import { cycles, H, M, NOW } from "./throughput-watchdog-helpers.ts";
import {
  DAY,
  fakeMetrics,
  fakeTracker,
  run,
  runtime,
  slow,
} from "./throughput-watchdog-fakes.ts";

const MAIN = "maintenance_repair_median";
const REPAIR = "repair_median";

interface CycleInput {
  /** Maintenance plus repair wall minutes. */
  minutes: number;
  /** The repair part (default 2). */
  repairMin?: number;
  /** The repair job was skipped (its phase is not recorded). */
  repairSkipped?: boolean;
  /** The repair tier's records read (absent: not observed). */
  recordsRead?: number;
  generation: number;
}

/** One finalize per call, `stepMs` after the previous one. */
function harness() {
  const metrics = fakeMetrics(slow(13));
  const issues = fakeTracker();
  let clock = NOW;
  let runId = 5000;
  async function cycle(input: CycleInput, stepMs = 20 * M) {
    clock += stepMs;
    const repairEnd = clock - M;
    const repairStart = repairEnd - Math.round((input.repairMin ?? 2) * M);
    const maintenanceStart = repairStart -
      Math.round((input.minutes - (input.repairMin ?? 2)) * M);
    const out: string[] = [];
    const id = runId++;
    const tail = await runFinalizeMetricsTailV1({
      metrics: { port: metrics, log: (line) => out.push(line) },
      watchdog: { metrics, issues, log: (line) => out.push(line) },
      selfImprove: "on",
    }, {
      cycle: { runId: id, attempt: 1 },
      finalizeStartedAtMs: clock - 30_000,
      nowMs: clock,
      jobs: [{
        name: "maintenance",
        conclusion: "success",
        summary: null,
        startedAtMs: maintenanceStart,
        completedAtMs: repairStart,
      }, {
        name: "repair",
        conclusion: input.repairSkipped === true ? "skipped" : "success",
        summary: null,
        startedAtMs: repairStart,
        completedAtMs: repairEnd,
      }],
      runSummary: {
        purpose: "ordinary",
        modelStarts: 0,
        generation: input.generation,
        runtimeSha: runtime(input.generation).sha,
      } as unknown as HostedRuntimeRunSummaryV1,
      ...(input.recordsRead === undefined ? {} : {
        tierCounts: {
          recordsRead: input.recordsRead,
          demoted: 0,
          promoted: 0,
          releaseRequestsMovedToCold: null,
          releaseRequestsSuperseded: null,
        },
      }),
    });
    const line = JSON.parse(
      out.find((row) => row.includes('"sentinel_throughput_watchdog"'))!,
    );
    assert.equal(tail.metrics?.status, "applied", "every cycle is recorded");
    return { id, line, tail };
  }
  const entry = (id: string) => metrics.ledger.watchdog!.thresholds[id];
  return { metrics, issues, cycle, entry, now: () => clock };
}

/** The watchdog line of a cycle that filed nothing and holds `blocked`. */
const held = (
  runId: number,
  blocked: Record<string, string>,
  missed: string[],
) => ({
  kind: "sentinel_throughput_watchdog",
  runId,
  attempt: 1,
  status: "evaluated",
  filed: 0,
  edited: 0,
  issues: [],
  stateWrite: "applied",
  createBlocked: Object.values(blocked)[0] ?? "nothing_missed",
  blocked,
  missed,
});

/** #100 filed, its fix merged with the threshold still missed. */
async function spent() {
  const h = harness();
  const first = await h.cycle({ minutes: 13, generation: 247 });
  assert.deepEqual(first.line.issues, [100]);
  h.issues.items[0].state = "closed";
  const closing = await h.cycle({ minutes: 13, generation: 247 });
  assert.deepEqual(
    closing.line,
    held(closing.id, { [MAIN]: "outcome_pending" }, [MAIN]),
  );
  return h;
}

/**
 * One cycle per letter on `generation`: `A` 7 min, `B` 13 min, `s` 13 min
 * with the repair job skipped (its record enters no maintenance+repair
 * window). Each row says whether the cycle's window was met.
 */
async function replay(
  h: ReturnType<typeof harness>,
  letters: string,
  generation: number,
) {
  const rows = [];
  for (const letter of letters) {
    const { line } = await h.cycle({
      minutes: letter === "A" ? 7 : 13,
      repairSkipped: letter === "s",
      generation,
    });
    rows.push({ letter, met: !line.missed.includes(MAIN), line });
  }
  return rows;
}

/** Lengths of the runs of met windows; `s` cycles are left out. */
function metRuns(rows: ReadonlyArray<{ letter: string; met: boolean }>) {
  const runs: number[] = [];
  let length = 0;
  for (const row of rows.filter((row) => row.letter !== "s")) {
    if (row.met) length++;
    else if (length > 0) {
      runs.push(length);
      length = 0;
    }
  }
  return length > 0 ? [...runs, length] : runs;
}

/**
 * After an all-`B` window, letters whose windows are met exactly `count`
 * times in a row and then missed (1 <= count <= 15): the first met window
 * holds 16 of 30 cycles at 7 min (median 7.0), among them the lone early
 * `A`, which leaves it `count` cycles later (15 of 30: median 10.0, not more
 * than 10% worse than 13.0 at close). No earlier window holds more than 15.
 */
const metRun = (count: number) =>
  "B".repeat(count - 1) + "A" + "B".repeat(15 - count) + "A".repeat(15) +
  "B".repeat(count);

/** `letters` with a repair-skipped cycle inserted at `index`. */
const skipAt = (letters: string, index: number) =>
  `${letters.slice(0, index)}s${letters.slice(index)}`;

/** The maintenance+repair verdict over `records` at `nowMs`. */
const mainVerdict = (
  records: readonly ThroughputMetricsRecordV1[],
  nowMs: number,
) =>
  evaluateThroughputWatchdogV1(
    { records, daily: [], nowMs },
    THROUGHPUT_WATCHDOG_THRESHOLDS.filter((row) => row.id === MAIN),
  )[0];

Deno.test("watchdog refile: a threshold still missed after its fix merged is logged every cycle, never filed again (live #405-#415)", async () => {
  const h = await spent();
  // Auto-follow installs the fix and later revisions; three UTC days of
  // cycles every two hours, still missed (live: 13.7 -> 13.1 min).
  let generation = 248;
  for (let i = 0; i < 36; i++) {
    if (i % 12 === 11) generation++;
    const minutes = [12.5, 12.8, 13.1][i % 3];
    const cycle = await h.cycle({ minutes, generation }, 2 * H);
    assert.deepEqual(
      cycle.line,
      held(cycle.id, { [MAIN]: "outcome_pending" }, [MAIN]),
    );
    // Measured and recorded exactly as before.
    const own = h.metrics.ledger.records.find((record) =>
      record.cycle.runId === cycle.id
    )!;
    assert.equal(
      own.phaseMs.maintenance! + own.phaseMs.repair!,
      Math.round(minutes * M),
    );
    assert.equal(own.counts.watchdogIssuesFiled, 0);
  }
  assert.equal(h.issues.creates.length, 1);
  const closed = h.entry(MAIN).closed!;
  // The retired rule re-filed once ten cycles ran on a newer runtime.
  assert.equal(closed.newerCycles, 36);
  assert.equal(closed.runtime!.generation, 247);
  assert.equal(h.entry(MAIN).issue, 100);
  assert.equal(h.metrics.ledger.records.length, 30 + 38);
});

Deno.test("watchdog refile: met since the close and missed again files exactly once", async () => {
  const h = await spent();
  for (let i = 0; i < 12; i++) await h.cycle({ minutes: 13, generation: 248 });
  // Sixteen fast cycles bring the 30-cycle median within the limit.
  for (let i = 0; i < 16; i++) {
    const cycle = await h.cycle({ minutes: 6, generation: 249 });
    const blocked: Record<string, string> = i < 15
      ? { [MAIN]: "outcome_pending" }
      : {};
    const missed = i < 15 ? [MAIN] : [];
    assert.deepEqual(cycle.line, held(cycle.id, blocked, missed));
  }
  // It regresses: the fifteenth slow cycle is missed again and filed once.
  const filed: number[] = [];
  for (let i = 0; i < 20; i++) {
    const cycle = await h.cycle({ minutes: 13, generation: 249 });
    filed.push(...cycle.line.issues);
    if (i === 14) assert.deepEqual(cycle.line.issues, [101]);
  }
  assert.deepEqual(filed, [101]);
  const regression = h.issues.creates[1];
  assert.equal(
    regression.body.split("\n")[1],
    "<!-- sentinel:throughput-watchdog:maintenance_repair_median -->",
  );
  assert.equal(
    regression.title,
    "Throughput: maintenance+repair phase median missed (9.5 min vs <= 8.0 min)",
  );
  // Its fix merges with the threshold still missed: newer runtimes over two
  // more days file nothing.
  h.issues.items.find((item) => item.number === 101)!.state = "closed";
  for (let i = 0; i < 24; i++) {
    const generation = 250 + Math.floor(i / 12);
    const cycle = await h.cycle({ minutes: 13, generation }, 2 * H);
    assert.deepEqual(
      cycle.line,
      held(cycle.id, { [MAIN]: "outcome_pending" }, [MAIN]),
    );
  }
  assert.equal(h.issues.creates.length, 2);
  assert.equal(h.entry(MAIN).issue, 101);
});

Deno.test("watchdog refile: a met cycle before the close does not re-arm the threshold", async () => {
  const h = harness();
  await h.cycle({ minutes: 13, generation: 247 });
  // Met while #100 is still open, then missed again before its fix merges.
  for (let i = 0; i < 16; i++) await h.cycle({ minutes: 6, generation: 247 });
  for (let i = 0; i < 16; i++) await h.cycle({ minutes: 13, generation: 247 });
  h.issues.items[0].state = "closed";
  const closing = await h.cycle({ minutes: 13, generation: 247 });
  assert.equal(closing.line.createBlocked, "outcome_pending");
  for (let i = 0; i < 24; i++) {
    const cycle = await h.cycle({ minutes: 13, generation: 248 }, 2 * H);
    assert.equal(cycle.line.createBlocked, "outcome_pending");
  }
  assert.equal(h.issues.creates.length, 1);
});

for (const count of [1, 9]) {
  Deno.test(`watchdog refile: ${count} met window(s) in a row then a miss files nothing (window noise near the limit)`, async () => {
    const h = await spent();
    // On newer runtimes (the outcome cycles ran long before), the median
    // dips to met by which cycles fill the window, then is missed again.
    const rows = await replay(h, metRun(count) + "B".repeat(20), 248);
    assert.deepEqual(metRuns(rows), [count]);
    for (const { met, line } of rows) {
      assert.equal(line.filed, 0);
      assert.deepEqual(line.blocked, met ? {} : { [MAIN]: "outcome_pending" });
    }
    assert.equal(h.entry(MAIN).closed!.newerCycles, rows.length);
    assert.equal(h.issues.creates.length, 1);
  });
}

Deno.test("watchdog refile: 10 met windows in a row then a miss file once, after the outcome cycles ran", async () => {
  const h = await spent();
  // Met ten times in a row, then missed, all on the runtime at close: held.
  const rows = await replay(h, metRun(10) + "B".repeat(5), 247);
  assert.deepEqual(metRuns(rows), [10]);
  assert(rows.every(({ line }) => line.filed === 0));
  assert.equal(rows.at(-1)!.line.createBlocked, "outcome_pending");
  assert.equal(h.entry(MAIN).closed!.newerCycles, 0);
  // Nine cycles on a newer runtime still wait; the tenth files exactly once.
  const newer = await replay(h, "B".repeat(14), 248);
  assert.deepEqual(
    newer.map(({ line }) => line.issues[0] ?? line.createBlocked),
    [
      ...Array(9).fill("outcome_pending"),
      101,
      ...Array(4).fill("open_watchdog_issue"),
    ],
  );
  // Its fix merges with the threshold still missed and never met again.
  h.issues.items.find((item) => item.number === 101)!.state = "closed";
  const after = [
    ...await replay(h, "B".repeat(12), 249),
    ...await replay(h, "B".repeat(12), 250),
  ];
  assert(after.every(({ line }) => line.createBlocked === "outcome_pending"));
  assert.equal(h.entry(MAIN).closed!.newerCycles, 12);
  assert.equal(h.issues.creates.length, 2);
});

Deno.test("watchdog refile: met runs split by one missed window do not add up", async () => {
  const h = await spent();
  // Six met windows, one missed, six met again, then missed: twelve met,
  // never ten in a row.
  const rows = await replay(
    h,
    "B".repeat(5) + "A" + "B".repeat(6) + "A" + "B".repeat(3) +
      "A".repeat(14) + "B".repeat(6) + "A" + "B".repeat(20),
    248,
  );
  assert.deepEqual(metRuns(rows), [6, 6]);
  for (const { met, line } of rows) {
    assert.equal(line.filed, 0);
    assert.deepEqual(line.blocked, met ? {} : { [MAIN]: "outcome_pending" });
  }
  assert.equal(h.issues.creates.length, 1);
});

Deno.test("watchdog refile: a cycle whose repair job was skipped neither extends nor breaks a met run", async () => {
  const h = await spent();
  // Such a cycle enters no maintenance+repair window: its own evaluation
  // re-judges the window before it (met here), which is no new evidence.
  const nine = await replay(h, skipAt(metRun(9), 30), 248);
  assert.equal(nine[30].letter, "s");
  assert.equal(nine[30].met, true);
  assert.deepEqual(metRuns(nine), [9]);
  assert(nine.every(({ line }) => line.filed === 0));
  assert.equal(nine.at(-1)!.line.createBlocked, "outcome_pending");
  // Ten met windows with one such cycle among them still count as ten.
  const ten = await replay(h, "B".repeat(30) + skipAt(metRun(10), 34), 248);
  assert.equal(ten[64].letter, "s");
  assert.deepEqual(metRuns(ten), [10]);
  assert.deepEqual(ten.flatMap(({ line }) => line.issues), [101]);
  assert.deepEqual(ten.at(-1)!.line.issues, [101]);
});

Deno.test("watchdog refile: windows over a short history do not count as met", async () => {
  // The close is older than the oldest kept record (older ones folded
  // away): 15 cycles at 7 min, then 45 at 13, every 20 minutes. Each window
  // over 10 to 29 cycles is met; every full 30-cycle window is missed.
  const records = cycles(
    60,
    (i) => ({ maintenanceMin: i < 15 ? 5 : 11, repairMin: 2 }),
    NOW,
    20 * M,
  );
  for (let n = 10; n <= 60; n++) {
    const verdict = mainVerdict(records.slice(0, n), NOW);
    assert.deepEqual(
      [verdict.verdict, verdict.cycles],
      n < 30 ? ["met", n] : ["missed", 30],
    );
  }
  const closedAt = records[0].finishedAtMs - DAY;
  const metrics = fakeMetrics(records);
  metrics.ledger = {
    ...metrics.ledger,
    watchdog: {
      version: 2,
      lastCycle: null,
      daily: null,
      thresholds: {
        [MAIN]: {
          issue: 90,
          measuredMilli: 13_000,
          filedAtMs: closedAt - DAY,
          cyclesSinceText: 0,
          closed: {
            atMs: closedAt,
            measuredMilli: 13_000,
            runtime: runtime(247),
            newerCycles: 60,
          },
        },
      },
    },
  };
  const issues = fakeTracker();
  const { result } = await run(
    metrics,
    issues,
    7000,
    NOW + M,
    true,
    runtime(248),
  );
  assert.deepEqual(result.missed, [MAIN]);
  assert.deepEqual(result.blocked, { [MAIN]: "outcome_pending" });
  assert.equal(issues.creates.length, 0);
  assert.equal(
    metrics.ledger.watchdog!.thresholds[MAIN].closed!.newerCycles,
    61,
  );
});

Deno.test("watchdog refile: more than 10% worse than at close still files at once (owner clause, unchanged)", async () => {
  const h = await spent();
  // Closed at 13.0 min; never met since and no cycle on a newer runtime.
  // Up to exactly 10% worse (14.3 min) is held.
  for (let i = 0; i < 16; i++) {
    const { line } = await h.cycle({ minutes: 14.3, generation: 247 });
    assert.deepEqual(line.blocked, { [MAIN]: "outcome_pending" });
  }
  assert.equal(mainVerdict(h.metrics.ledger.records, h.now()).measured, 14.3);
  assert.equal(h.entry(MAIN).closed!.measuredMilli, 13_000);
  assert.equal(h.entry(MAIN).closed!.newerCycles, 0);
  // The median moves to 14.65 min, more than 10% worse: filed at once.
  const filed: number[] = [];
  for (let i = 0; i < 15; i++) {
    const { line } = await h.cycle({ minutes: 15, generation: 247 });
    filed.push(...line.issues);
    if (i < 14) {
      assert.deepEqual(line.blocked, { [MAIN]: "outcome_pending" });
    }
  }
  assert.deepEqual(filed, [101]);
  assert.equal(h.entry(MAIN).issue, 101);
  assert.equal(h.entry(MAIN).measuredMilli, 14_650);
  assert.equal(h.issues.creates.length, 2);
});

Deno.test("watchdog refile: each threshold is bounded on its own", async () => {
  const h = await spent();
  // Repair (>= 60 live records) is missed for the first time: filed at once
  // while maintenance+repair stays held.
  let repairIssue: number | null = null;
  for (let i = 0; i < 10; i++) {
    const cycle = await h.cycle({
      minutes: 13,
      repairMin: 6,
      recordsRead: 70,
      generation: 248,
    }, H);
    if (i < 9) {
      assert.deepEqual(
        cycle.line,
        held(cycle.id, { [MAIN]: "outcome_pending" }, [MAIN]),
      );
      continue;
    }
    assert.deepEqual(cycle.line.issues, [101]);
    assert.deepEqual(cycle.line.blocked, { [MAIN]: "outcome_pending" });
    repairIssue = cycle.line.issues[0];
  }
  assert.equal(h.entry(REPAIR).issue, repairIssue);
  // Its fix merges with repair still missed; on newer runtimes
  // maintenance+repair is met and then missed again: only it is filed.
  h.issues.items.find((item) => item.number === repairIssue)!.state = "closed";
  const live = { repairMin: 6, recordsRead: 70 };
  for (let i = 0; i < 12; i++) {
    await h.cycle({ minutes: 13, ...live, generation: 249 }, H);
  }
  for (let i = 0; i < 16; i++) {
    const cycle = await h.cycle({ minutes: 7, ...live, generation: 250 }, H);
    assert.equal(cycle.line.blocked[REPAIR], "outcome_pending");
  }
  const filed: number[] = [];
  for (let i = 0; i < 20; i++) {
    const cycle = await h.cycle({ minutes: 13, ...live, generation: 250 }, H);
    filed.push(...cycle.line.issues);
    assert.equal(cycle.line.blocked[REPAIR], "outcome_pending");
  }
  assert.deepEqual(filed, [102]);
  assert.equal(h.entry(MAIN).issue, 102);
  assert.equal(h.entry(REPAIR).issue, 101);
  assert.equal(h.entry(REPAIR).closed!.newerCycles, 36);
});

Deno.test("watchdog refile: the first-ever filing is unchanged", async () => {
  const h = harness();
  const first = await h.cycle({ minutes: 13, generation: 247 });
  assert.deepEqual(first.line, {
    ...held(first.id, {}, [MAIN]),
    filed: 1,
    issues: [100],
    createBlocked: null,
  });
  const [issue] = h.issues.creates;
  assert.equal(
    issue.title,
    "Throughput: maintenance+repair phase median missed (13.0 min vs <= 8.0 min)",
  );
  assert.deepEqual(issue.labels, ["priority:2"]);
  const body = issue.body.split("\n");
  assert.deepEqual(body.slice(0, 5), [
    "Sentinel throughput watchdog: `maintenance_repair_median` is missed.",
    "<!-- sentinel:throughput-watchdog:maintenance_repair_median -->",
    "",
    "## Measurement",
    "",
  ]);
  assert(body.includes("- Measured: 13.0 min (median); limit: <= 8.0 min."));
  assert(
    body.includes(
      `- Evaluated by finalize of run ${first.id} attempt 1; the same evaluation prints in the \`sentinel report\` Thresholds table.`,
    ),
  );
  assert.equal(
    body.at(-1),
    "- Outcome rule: this issue is re-evaluated after 10 cycles on a newer runtime. After it closes, the threshold is filed again only if it was met over a full window in 10 consecutive cycles since the close and is missed again after 10 cycles on a runtime newer than the one installed at close, or at once if the measurement gets more than 10% worse than at close; a threshold still missed after its fix merged is otherwise only logged.",
  );
  assert.deepEqual(h.entry(MAIN), {
    issue: 100,
    measuredMilli: 13_000,
    filedAtMs: h.now(),
    cyclesSinceText: 0,
    closed: null,
  });
  const own = h.metrics.ledger.records.at(-1)!;
  assert.equal(own.cycle.runId, first.id);
  assert.equal(own.counts.watchdogIssuesFiled, 1);
});

Deno.test("watchdog refile: the log line when issue delivery fails is unchanged", async () => {
  // An unproven create: counted, unrecorded, adopted by its marker next.
  const h = harness();
  h.issues.createResult = "null";
  const lost = await h.cycle({ minutes: 13, generation: 247 });
  assert.deepEqual(lost.line, {
    ...held(lost.id, {}, [MAIN]),
    createBlocked: null,
  });
  assert.equal(h.entry(MAIN), undefined);
  assert.deepEqual(h.metrics.ledger.watchdog!.daily, {
    date: "2026-11-05",
    filed: 1,
  });
  const adopted = await h.cycle({ minutes: 13, generation: 247 });
  assert.deepEqual(adopted.line, {
    ...held(adopted.id, { [MAIN]: "open_watchdog_issue" }, [MAIN]),
    edited: 1,
  });
  // An unproven listing: nothing is planned, written or filed.
  const unlisted = harness();
  const port: ThroughputWatchdogIssuesV1 = unlisted.issues;
  port.listOpen = () => Promise.resolve(null);
  const none = await unlisted.cycle({ minutes: 13, generation: 247 });
  assert.deepEqual(none.line, {
    ...held(none.id, {}, [MAIN]),
    status: "listing_unavailable",
    stateWrite: null,
    createBlocked: null,
  });
  assert.equal(unlisted.issues.creates.length, 0);
});
