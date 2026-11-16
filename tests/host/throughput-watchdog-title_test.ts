/**
 * Live #416: the throughput watchdog filed a 5.033 min repair median against
 * its 5 min limit as "5.0 min vs <= 5.0 min". A filed miss now reads larger
 * than its limit; titles of the older format still hold their threshold.
 */
import assert from "node:assert/strict";
import type { ThroughputMetricsRecordV1 } from "../../src/contracts/throughput-metrics.ts";
import {
  evaluateThroughputWatchdogV1,
  formatLimitV1,
  formatMeasuredV1,
  type ThroughputVerdictV1,
} from "../../src/host/throughput-watchdog.ts";
import { throughputWatchdogTitleV1 } from "../../src/host/throughput-watchdog-issue.ts";
import { cycles, H, M, NOW } from "./throughput-watchdog-helpers.ts";
import {
  APP,
  fakeMetrics,
  fakeTracker,
  run,
} from "./throughput-watchdog-fakes.ts";

const REPAIR = "Throughput: repair phase median at >= 60 live records missed";

/** 30 live cycles whose repair phases take `repairMs` (cycle by cycle). */
function repairCycles(repairMs: (i: number) => number, base = 1000) {
  const records = cycles(
    30,
    () => ({ maintenanceMin: 2, repairMin: 5, recordsRead: 70 }),
    NOW,
    5 * M,
    base,
  );
  records.forEach((record, i) => {
    record.phaseMs.repair = repairMs(i);
  });
  return records;
}

function verdictOf(
  records: ThroughputMetricsRecordV1[],
  id: string,
): ThroughputVerdictV1 {
  return evaluateThroughputWatchdogV1({ records, daily: [], nowMs: NOW })
    .find((row) => row.id === id)!;
}

/** The measured value and limit as a title shows them. */
function shown(verdict: ThroughputVerdictV1): [string, string] {
  const match = / missed \((.+) vs <= (.+)\)$/.exec(
    throughputWatchdogTitleV1(verdict),
  );
  assert(match !== null);
  return [match[1], match[2]];
}

Deno.test("watchdog title: the live #416 miss reads larger than its limit", async () => {
  const metrics = fakeMetrics(repairCycles(() => 301_980));
  const issues = fakeTracker();
  const { result } = await run(metrics, issues, 1);
  assert.deepEqual(result.missed, ["repair_median"]);
  assert.equal(
    issues.creates[0].title,
    `${REPAIR} (5.03 min vs <= 5.00 min)`,
  );
  assert(
    issues.creates[0].body.includes(
      "- Measured: 5.03 min (median); limit: <= 5.00 min.",
    ),
  );
});

Deno.test("watchdog title: every filed miss reads unequal to and above its limit", () => {
  const misses: Array<[ThroughputVerdictV1, string]> = [
    [verdictOf(repairCycles(() => 300_001), "repair_median"), "5.00002 min"],
    // A median of two middle values: 300000.5 ms.
    [
      verdictOf(
        repairCycles((i) => i < 15 ? 300_000 : 300_001),
        "repair_median",
      ),
      "5.00001 min",
    ],
    [verdictOf(repairCycles(() => 300_600), "repair_median"), "5.01 min"],
    [verdictOf(repairCycles(() => 303_000), "repair_median"), "5.05 min"],
    // Clear misses keep the usual precision.
    [verdictOf(repairCycles(() => 306_000), "repair_median"), "5.1 min"],
    [
      verdictOf(
        cycles(
          14,
          (i) => ({ ci: i === 0 ? 3001 : 0, merges: i === 0 ? 1000 : 0 }),
          NOW,
          12 * H,
        ),
        "ci_runs_per_merge",
      ),
      "3.001",
    ],
  ];
  for (const [verdict, measured] of misses) {
    assert.equal(verdict.verdict, "missed", verdict.detail);
    const [value, limit] = shown(verdict);
    assert.equal(value, measured);
    assert.notEqual(value, limit);
    assert(parseFloat(value) > parseFloat(limit), `${value} vs ${limit}`);
    assert.equal(value.split(" ")[0].length, limit.split(" ")[0].length);
  }
  // The report shows a near-limit met value below its limit, the same way.
  const met = verdictOf(repairCycles(() => 299_999), "repair_median");
  assert.equal(met.verdict, "met");
  assert.equal(formatMeasuredV1(met), "4.99998 min");
  assert.equal(formatLimitV1(met), "<= 5.00000 min");
  // A value exactly at its limit is met and keeps the usual precision.
  const at = verdictOf(repairCycles(() => 300_000), "repair_median");
  assert.equal(at.verdict, "met");
  assert.deepEqual(shown(at), ["5.0 min", "5.0 min"]);
});

Deno.test("watchdog title: issues and pull requests titled in the older format still hold their threshold", async () => {
  const records = repairCycles(() => 301_980);
  const metrics = fakeMetrics(records);
  const issues = fakeTracker();
  await run(metrics, issues, 1);
  assert.equal(issues.creates.length, 1);
  // The open issue as an older runtime titled it: held by its marker, and
  // not edited before its text is 10 cycles old.
  issues.items[0].title = `${REPAIR} (5.0 min vs <= 5.0 min)`;
  const held = await run(metrics, issues, 2, NOW + M);
  assert.deepEqual(held.result.blocked, {
    repair_median: "open_watchdog_issue",
  });
  assert.equal(issues.updates.length, 0);
  assert.equal(issues.creates.length, 1);
  // Closed: a pull request titled after it (older or newer format) holds it.
  issues.items[0].state = "closed";
  for (
    const [number, title] of [
      [140, `${REPAIR} (5.0 min vs <= 5.0 min)`],
      [141, `${REPAIR} (5.03 min vs <= 5.00 min)`],
    ] as const
  ) {
    issues.items.push({
      number,
      title,
      body: "",
      labels: [],
      state: "open",
      author: APP,
      pull: true,
    });
    const pulled = await run(metrics, issues, number, NOW + number * M);
    assert.equal(pulled.result.blocked.repair_median, "open_pull_request");
    issues.items.at(-1)!.state = "closed";
  }
  // With nothing open, the closed threshold waits for its outcome check:
  // the re-file rule never reads a title.
  const pending = await run(metrics, issues, 3, NOW + 200 * M);
  assert.equal(pending.result.blocked.repair_median, "outcome_pending");
  assert.equal(issues.creates.length, 1);
});
