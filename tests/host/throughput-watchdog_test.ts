/** Pure throughput watchdog verdicts, the threshold table and the report. */
import assert from "node:assert/strict";
import {
  foldThroughputRecordV1,
  type ThroughputDailySummaryV1,
  type ThroughputMetricsRecordV1,
} from "../../src/contracts/throughput-metrics.ts";
import {
  evaluateThroughputWatchdogV1,
  renderThroughputThresholdsV1,
  type ThroughputVerdictV1,
} from "../../src/host/throughput-watchdog.ts";
import { THROUGHPUT_WATCHDOG_THRESHOLDS } from "../../src/host/throughput-watchdog-thresholds.ts";
import { renderSentinelReportV1 } from "../../ops/sentinel-report.ts";
import { parseThroughputReportWindowV1 } from "../../src/state/throughput-report.ts";

import {
  type CycleFacts,
  cycles,
  H,
  M,
  NOW,
} from "./throughput-watchdog-helpers.ts";

function verdict(
  records: ThroughputMetricsRecordV1[],
  id: string,
  daily: ThroughputDailySummaryV1[] = [],
  nowMs = NOW,
): ThroughputVerdictV1 {
  const found = evaluateThroughputWatchdogV1({ records, daily, nowMs }).find(
    (row) => row.id === id,
  );
  if (found === undefined) throw new Error(`no verdict ${id}`);
  return found;
}

Deno.test("watchdog: maintenance+repair median over the latest 30 cycles", () => {
  const fast = verdict(
    cycles(30, () => ({ maintenanceMin: 3, repairMin: 4 })),
    "maintenance_repair_median",
  );
  assert.equal(fast.verdict, "met");
  assert.equal(fast.measured, 7);
  assert.equal(fast.cycles, 30);
  assert.deepEqual(fast.window, { kind: "cycles", size: 30 });
  const slow = verdict(
    cycles(30, () => ({ maintenanceMin: 5, repairMin: 4 })),
    "maintenance_repair_median",
  );
  assert.equal(slow.verdict, "missed");
  assert.equal(slow.measured, 9);
  // Only the latest 30 eligible cycles count: 10 old slow ones drop out.
  const recovered = verdict(
    cycles(40, (i) => ({ maintenanceMin: i < 10 ? 20 : 2, repairMin: 2 })),
    "maintenance_repair_median",
  );
  assert.equal(recovered.verdict, "met");
  assert.equal(recovered.cycles, 30);
  const few = verdict(
    cycles(9, () => ({ maintenanceMin: 50, repairMin: 50 })),
    "maintenance_repair_median",
  );
  assert.equal(few.verdict, "insufficient_data");
  assert.equal(few.measured, null);
  assert.match(few.detail, /fewer than 10 cycles/);
  // A cycle missing one phase is not eligible; all-null is never missed.
  const none = verdict(
    cycles(30, () => ({ maintenanceMin: 50 })),
    "maintenance_repair_median",
  );
  assert.equal(none.verdict, "insufficient_data");
  assert.equal(none.detail, "fields not recorded");
});

Deno.test("watchdog: repair median counts only cycles with >= 60 live records", () => {
  const small = verdict(
    cycles(30, () => ({ repairMin: 20, recordsRead: 59 })),
    "repair_median",
  );
  assert.equal(small.verdict, "insufficient_data");
  assert.match(small.detail, /recordsRead >= 60/);
  const met = verdict(
    cycles(30, () => ({ repairMin: 4, recordsRead: 80 })),
    "repair_median",
  );
  assert.equal(met.verdict, "met");
  const missed = verdict(
    cycles(30, (i) => ({ repairMin: 6, recordsRead: i % 2 === 0 ? 60 : 10 })),
    "repair_median",
  );
  assert.equal(missed.verdict, "missed");
  assert.equal(missed.cycles, 15);
  assert.equal(missed.measured, 6);
});

Deno.test("watchdog: bootstrap median over the last three bootstrap cycles", () => {
  const two = verdict(
    cycles(2, () => ({ bootstrapMin: 9 })),
    "bootstrap_median",
  );
  assert.equal(two.verdict, "insufficient_data");
  const slow = [
    ...cycles(1, () => ({ bootstrapMin: 1 }), NOW - 3 * H, H, 10),
    ...cycles(3, (i) => ({ bootstrapMin: [4, 6, 7][i] }), NOW, H, 20),
    ...cycles(20, () => ({ maintenanceMin: 1 }), NOW - 4 * H, 5 * M, 30),
  ];
  const missed = verdict(slow, "bootstrap_median");
  assert.equal(missed.verdict, "missed");
  assert.equal(missed.measured, 6);
  assert.equal(missed.cycles, 3);
  const met = verdict(
    cycles(3, (i) => ({ bootstrapMin: [3, 4, 10][i] })),
    "bootstrap_median",
  );
  assert.equal(met.verdict, "met");
  assert.equal(met.measured, 4);
});

Deno.test("watchdog: cells planned whenever ready work exists and no refusal", () => {
  const met = verdict(
    cycles(12, (i) => ({ cells: i % 3 === 0 ? 0 : 2, ready: 0 })),
    "cells_planned",
  );
  assert.equal(met.verdict, "met");
  assert.equal(met.measured, 0);
  const missed = verdict(
    cycles(12, (i) => ({ cells: i === 4 ? 0 : 1, ready: 3 })),
    "cells_planned",
  );
  assert.equal(missed.verdict, "missed");
  assert.equal(missed.measured, 1);
  // A refused plan is explained, so it is not a violation.
  const refused = verdict(
    cycles(12, () => ({ cells: 0, ready: 3, refusal: "deadline_margin" })),
    "cells_planned",
  );
  assert.equal(refused.verdict, "met");
  const unrecorded = verdict(cycles(30, () => ({ cells: 0 })), "cells_planned");
  assert.equal(unrecorded.verdict, "insufficient_data");
});

/** One cycle every six hours over the last `days` days. */
function weekly(
  days: number,
  facts: (
    i: number,
  ) => Omit<CycleFacts, "runId" | "finishedAtMs">,
): ThroughputMetricsRecordV1[] {
  return cycles(days * 4, facts, NOW, 6 * H);
}

Deno.test("watchdog: refresh commits per merge over seven days", () => {
  const met = verdict(
    weekly(7, () => ({ refresh: 1, merges: 1 })),
    "refresh_per_merge",
  );
  assert.equal(met.verdict, "met");
  assert.equal(met.measured, 1);
  assert.deepEqual(met.window, { kind: "days", size: 7 });
  const missed = verdict(
    weekly(7, () => ({ refresh: 2, merges: 1 })),
    "refresh_per_merge",
  );
  assert.equal(missed.verdict, "missed");
  assert.equal(missed.measured, 2);
  assert.equal(missed.detail, "56 / 28");
  const unrecorded = verdict(
    weekly(7, () => ({ merges: 1 })),
    "refresh_per_merge",
  );
  assert.equal(unrecorded.verdict, "insufficient_data");
  assert.equal(unrecorded.detail, "fields not recorded");
  const short = verdict(
    weekly(3, () => ({ refresh: 9, merges: 1 })),
    "refresh_per_merge",
  );
  assert.equal(short.verdict, "insufficient_data");
  assert.match(short.detail, /fewer than 7 days/);
  const noMerges = verdict(
    weekly(7, () => ({ refresh: 3, merges: 0 })),
    "refresh_per_merge",
  );
  assert.equal(noMerges.verdict, "insufficient_data");
  assert.equal(noMerges.detail, "no merges in window");
});

Deno.test("watchdog: weekly ratios include folded daily rollups in the window", () => {
  const all = weekly(7, () => ({ ci: 4, merges: 1 }));
  // Fold the oldest four days into rollups, as the hot-tier bound would.
  const hot = all.slice(16);
  const daily = new Map<string, ThroughputDailySummaryV1>();
  for (const record of all.slice(0, 16)) {
    const date = new Date(record.finishedAtMs).toISOString().slice(0, 10);
    daily.set(date, foldThroughputRecordV1(daily.get(date) ?? null, record));
  }
  const rows = [...daily.values()];
  const missed = verdict(hot, "ci_runs_per_merge", rows);
  assert.equal(missed.verdict, "missed");
  assert.equal(missed.measured, 4);
  const met = verdict(
    weekly(7, () => ({ ci: 3, merges: 1 })),
    "ci_runs_per_merge",
  );
  assert.equal(met.verdict, "met");
  // Folded days outside the window are not counted.
  const stale = verdict([], "ci_runs_per_merge", rows, NOW + 30 * 24 * H);
  assert.equal(stale.verdict, "insufficient_data");
  assert.equal(stale.cycles, 0);
});

Deno.test("watchdog: owner notices are informational and never filed", () => {
  const seen = verdict(
    cycles(12, (i) => (i === 3 ? { notices: 1 } : {})),
    "owner_notice_count",
  );
  assert.equal(seen.informational, true);
  assert.equal(seen.verdict, "missed");
  assert.equal(seen.measured, 1);
  const none = verdict(cycles(12, () => ({})), "owner_notice_count");
  assert.equal(none.verdict, "insufficient_data");
});

Deno.test("watchdog: the threshold table is unique, bounded and names real files", async () => {
  const ids = THROUGHPUT_WATCHDOG_THRESHOLDS.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  assert(ids.length <= 16);
  const root = new URL("../../", import.meta.url);
  for (const row of THROUGHPUT_WATCHDOG_THRESHOLDS) {
    assert.match(row.id, /^[a-z][a-z0-9_]{0,39}$/);
    assert([324, 326, 327, 329, 330, 335, 336].includes(row.childIssue));
    for (const line of row.investigate) {
      for (const match of line.matchAll(/`((?:src|ops)\/[^`*]+\.ts)`/g)) {
        await Deno.stat(new URL(match[1], root));
      }
    }
  }
  // Every null field everywhere: insufficient, never missed.
  for (
    const row of evaluateThroughputWatchdogV1({
      records: cycles(40, () => ({})),
      daily: [],
      nowMs: NOW,
    })
  ) assert.equal(row.verdict, "insufficient_data", row.id);
});

Deno.test("sentinel report prints the watchdog's Thresholds table", () => {
  const records = cycles(30, () => ({ maintenanceMin: 6, repairMin: 4 }));
  const text = renderSentinelReportV1(
    { records, daily: [] },
    null,
    parseThroughputReportWindowV1("2026-11-05", "2026-11-05", NOW),
  );
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.startsWith("Thresholds ("));
  assert(start > 0, text);
  assert.equal(
    lines[start],
    "Thresholds (watchdog evaluation as of 2026-11-05 12:00 UTC; " +
      "a missed, non-informational threshold files a Sentinel issue)",
  );
  assert.match(lines[start + 1], /^threshold +child +verdict +measured +limit/);
  const row = lines.find((line) =>
    line.startsWith("maintenance_repair_median")
  );
  assert.match(
    row ?? "",
    /^maintenance_repair_median +#324 +missed +10\.0 min +<= 8\.0 min +latest 30 cycles +30 +median$/,
  );
  assert.match(
    lines.find((line) => line.startsWith("refresh_per_merge")) ?? "",
    /insufficient_data +n\/a +<= 1\.00 +latest 7 days +30 +fields not recorded/,
  );
  // The same evaluation as the watchdog's, as of the end of --until.
  const table = renderThroughputThresholdsV1(
    evaluateThroughputWatchdogV1({ records, daily: [], nowMs: NOW }),
    NOW,
  );
  assert.deepEqual(lines.slice(start, start + table.length), table);
  // An absent metrics ref still prints the table, every row insufficient.
  const empty = renderSentinelReportV1(
    null,
    null,
    parseThroughputReportWindowV1("2026-11-05", "2026-11-05", NOW),
  );
  assert.equal(
    empty.split("\n").filter((line) => / insufficient_data /.test(line))
      .length,
    THROUGHPUT_WATCHDOG_THRESHOLDS.length,
  );
});
