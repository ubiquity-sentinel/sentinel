/**
 * Throughput watchdog guardrails at the finalize boundary (fake sidecar and
 * tracker, injected clock and runtime): per-threshold in-flight exclusion,
 * the outcome check after close (10 cycles on a newer runtime, or at once
 * when more than 10% worse), edits only when the window advanced 10 cycles,
 * and the 3-per-UTC-day bound.
 */
import assert from "node:assert/strict";
import {
  measuredWorseV1,
  runtimeNewerV1,
} from "../../src/host/throughput-watchdog-plan.ts";
import { cycles, NOW } from "./throughput-watchdog-helpers.ts";
import {
  APP,
  DAY,
  fakeMetrics,
  fakeTracker,
  run,
  runtime,
  slow,
  slowAndUnplanned,
} from "./throughput-watchdog-fakes.ts";

const entry = (metrics: ReturnType<typeof fakeMetrics>, id: string) =>
  metrics.ledger.watchdog!.thresholds[id];

Deno.test("watchdog guardrail: in-flight exclusion is per threshold", async () => {
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  const first = await run(metrics, issues, 1);
  assert.deepEqual(first.result.issues, [100]);
  // A different threshold is filed while the first one's issue is open.
  metrics.ledger = { ...metrics.ledger, records: slowAndUnplanned(10, 2000) };
  const second = await run(metrics, issues, 2);
  assert.deepEqual(second.result.missed, [
    "maintenance_repair_median",
    "cells_planned",
  ]);
  assert.deepEqual(second.result.issues, [101]);
  assert.equal(
    issues.creates[1].body.split("\n")[1].includes("cells_planned"),
    true,
  );
  assert.deepEqual(second.result.blocked, {
    maintenance_repair_median: "open_watchdog_issue",
  });
  assert.equal(second.result.createBlocked, "open_watchdog_issue");
  // Its issue closed, an open pull request naming it still holds only it.
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
  const third = await run(metrics, issues, 3, NOW + 60_000);
  assert.deepEqual(third.result.blocked, {
    maintenance_repair_median: "open_pull_request",
    cells_planned: "open_watchdog_issue",
  });
  assert.equal(issues.creates.length, 2);
  // A pull request titled after the threshold holds it too, without a ref.
  issues.items[2].title =
    "Throughput: maintenance+repair phase median missed (10.0 min vs <= 8.0 min)";
  issues.items[2].body = "";
  const fourth = await run(metrics, issues, 4, NOW + 2 * 60_000);
  assert.equal(
    fourth.result.blocked.maintenance_repair_median,
    "open_pull_request",
  );
  // The other in-flight threshold never blocks a third one.
  const records = slowAndUnplanned(10, 3000);
  records.forEach((record) => {
    record.counts.recordsRead = 70;
    record.phaseMs.repair = 6 * 60_000;
  });
  metrics.ledger = { ...metrics.ledger, records };
  const fifth = await run(metrics, issues, 5, NOW + 3 * 60_000);
  assert.deepEqual(fifth.result.issues, [102]);
  assert.equal(entry(metrics, "repair_median").issue, 102);
});

Deno.test("watchdog guardrail: another threshold's open issue or PR never blocks (live #359/#360 shape)", async () => {
  // Both maintenance+repair and repair (>= 60 live records) are missed.
  const records = cycles(30, () => ({
    maintenanceMin: 8,
    repairMin: 6,
    recordsRead: 70,
  }));
  const marked = (number: number, id: string, title: string) => ({
    number,
    title: `Throughput: ${title} missed (17.6 min vs <= 5.0 min)`,
    body: `Sentinel throughput watchdog: \`${id}\` is missed.\n` +
      `<!-- sentinel:throughput-watchdog:${id} -->\n`,
    labels: ["priority:2"],
    state: "open" as const,
    author: APP,
    pull: false,
  });
  // Only repair_median's issue is open, plus a PR naming it: the other
  // threshold must still be filed.
  const issues = fakeTracker([
    marked(360, "repair_median", "repair phase median at >= 60 live records"),
    {
      number: 361,
      title:
        "Throughput: repair phase median at >= 60 live records missed (fix)",
      body: "Resolves #360",
      labels: [],
      state: "open",
      author: APP,
      pull: true,
    },
  ]);
  const metrics = fakeMetrics(records);
  const only = await run(metrics, issues, 1);
  assert.deepEqual(only.result.missed, [
    "maintenance_repair_median",
    "repair_median",
  ]);
  assert.deepEqual(only.result.issues, [100]);
  assert.equal(
    issues.creates[0].body.split("\n")[1],
    "<!-- sentinel:throughput-watchdog:maintenance_repair_median -->",
  );
  assert.deepEqual(only.result.blocked, {
    repair_median: "open_watchdog_issue",
  });
  // The live shape: an older open issue for maintenance+repair (#359) holds
  // exactly that threshold; repair is filed.
  const live = fakeTracker([
    marked(359, "maintenance_repair_median", "maintenance+repair phase median"),
  ]);
  live.next = 360;
  const liveRun = await run(fakeMetrics(records), live, 2);
  assert.deepEqual(liveRun.result.issues, [360]);
  assert.deepEqual(liveRun.result.blocked, {
    maintenance_repair_median: "open_watchdog_issue",
  });
});

Deno.test("watchdog guardrail: outcome check waits for 10 cycles on a newer runtime", async () => {
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  await run(metrics, issues, 1, NOW, true, runtime(5));
  issues.items[0].state = "closed";
  // The close is observed with the runtime then installed and measurement.
  const closing = await run(metrics, issues, 2, NOW + 60_000, true, runtime(5));
  assert.equal(closing.result.createBlocked, "outcome_pending");
  assert.deepEqual(entry(metrics, "maintenance_repair_median").closed, {
    atMs: NOW + 60_000,
    measuredMilli: 10_000,
    runtime: runtime(5),
    newerCycles: 0,
  });
  let runId = 3;
  // Cycles on the same runtime, an unknown runtime, or a bootstrap of the
  // same SHA at a later generation do not count; time alone never does.
  const sameSha = { generation: 6, sha: runtime(5).sha };
  for (const at of [runtime(5), null, sameSha, runtime(5)]) {
    const held = await run(metrics, issues, runId++, NOW + 30 * DAY, true, at);
    assert.equal(held.result.createBlocked, "outcome_pending");
  }
  assert.equal(
    entry(metrics, "maintenance_repair_median").closed!.newerCycles,
    0,
  );
  for (let i = 1; i <= 9; i++) {
    const held = await run(
      metrics,
      issues,
      runId++,
      NOW + 30 * DAY,
      true,
      runtime(6),
    );
    assert.equal(held.result.createBlocked, "outcome_pending");
  }
  assert.equal(
    entry(metrics, "maintenance_repair_median").closed!.newerCycles,
    9,
  );
  assert.equal(issues.creates.length, 1);
  // The tenth newer cycle completes the check: met now, nothing is filed.
  metrics.ledger = { ...metrics.ledger, records: slow(7, 5000) };
  const met = await run(
    metrics,
    issues,
    runId++,
    NOW + 30 * DAY,
    true,
    runtime(6),
  );
  assert.equal(met.result.createBlocked, "nothing_missed");
  assert.equal(
    entry(metrics, "maintenance_repair_median").closed!.newerCycles,
    10,
  );
  // Still missed later: re-filed.
  metrics.ledger = { ...metrics.ledger, records: slow(10, 6000) };
  const refiled = await run(
    metrics,
    issues,
    runId++,
    NOW + 30 * DAY,
    true,
    runtime(7),
  );
  assert.deepEqual(refiled.result.issues, [101]);
  assert.equal(entry(metrics, "maintenance_repair_median").closed, null);
});

Deno.test("watchdog guardrail: an unknown runtime at close takes the next known one as baseline", async () => {
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  await run(metrics, issues, 1);
  issues.items[0].state = "closed";
  await run(metrics, issues, 2, NOW + 60_000, true, null);
  assert.equal(
    entry(metrics, "maintenance_repair_median").closed!.runtime,
    null,
  );
  await run(metrics, issues, 3, NOW + 60_000, true, runtime(8));
  const closed = entry(metrics, "maintenance_repair_median").closed!;
  assert.deepEqual(closed.runtime, runtime(8));
  assert.equal(closed.newerCycles, 0);
  await run(metrics, issues, 4, NOW + 60_000, true, runtime(9));
  assert.equal(
    entry(metrics, "maintenance_repair_median").closed!.newerCycles,
    1,
  );
});

Deno.test("watchdog guardrail: more than 10% worse than at close re-files at once", async () => {
  assert.equal(measuredWorseV1(10_000, 11_000), false);
  assert.equal(measuredWorseV1(10_000, 11_001), true);
  assert.equal(measuredWorseV1(0, 1), true);
  assert.equal(runtimeNewerV1(runtime(6), runtime(5)), true);
  assert.equal(runtimeNewerV1(runtime(5), runtime(6)), false);
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  await run(metrics, issues, 1, NOW, true, runtime(5));
  issues.items[0].state = "closed";
  await run(metrics, issues, 2, NOW + 60_000, true, runtime(5));
  // Exactly 10% worse still waits for the outcome cycles.
  metrics.ledger = { ...metrics.ledger, records: slow(11, 2000) };
  const even = await run(
    metrics,
    issues,
    3,
    NOW + 2 * 60_000,
    true,
    runtime(5),
  );
  assert.equal(even.result.createBlocked, "outcome_pending");
  metrics.ledger = { ...metrics.ledger, records: slow(11.5, 3000) };
  const worse = await run(
    metrics,
    issues,
    4,
    NOW + 3 * 60_000,
    true,
    runtime(5),
  );
  assert.deepEqual(worse.result.issues, [101]);
  assert.equal(
    entry(metrics, "maintenance_repair_median").measuredMilli,
    11_500,
  );
});

Deno.test("watchdog guardrail: an open issue is edited only when the window advanced 10 cycles", async () => {
  const metrics = fakeMetrics(slow(10));
  const issues = fakeTracker();
  await run(metrics, issues, 1);
  // A large change alone is no edit before ten more cycles were evaluated.
  metrics.ledger = { ...metrics.ledger, records: slow(14, 2000) };
  for (let runId = 2; runId <= 10; runId++) {
    const held = await run(metrics, issues, runId);
    assert.equal(held.result.edited, 0);
    assert.equal(held.result.createBlocked, "open_watchdog_issue");
  }
  assert.equal(entry(metrics, "maintenance_repair_median").cyclesSinceText, 9);
  const edited = await run(metrics, issues, 11);
  assert.equal(edited.result.edited, 1);
  assert.equal(
    issues.items[0].title,
    "Throughput: maintenance+repair phase median missed (14.0 min vs <= 8.0 min)",
  );
  assert.equal(issues.items[0].body.includes("run 11 attempt 1"), true);
  const stored = entry(metrics, "maintenance_repair_median");
  assert.equal(stored.measuredMilli, 14_000);
  assert.equal(stored.cyclesSinceText, 0);
  const next = await run(metrics, issues, 12);
  assert.equal(next.result.edited, 0);
});

Deno.test("watchdog guardrail: at most three issues per UTC day", async () => {
  // Four thresholds missed in one cycle.
  const records = cycles(30, () => ({
    maintenanceMin: 8,
    repairMin: 6,
    recordsRead: 70,
    bootstrapMin: 6,
    cells: 0,
    ready: 4,
  }));
  const metrics = fakeMetrics(records);
  const issues = fakeTracker();
  const first = await run(metrics, issues, 1);
  assert.deepEqual(first.result.missed, [
    "maintenance_repair_median",
    "repair_median",
    "bootstrap_median",
    "cells_planned",
  ]);
  assert.deepEqual(first.result.issues, [100, 101, 102]);
  assert.deepEqual(first.result.blocked, { cells_planned: "daily_bound" });
  assert.equal(first.result.createBlocked, "daily_bound");
  assert.equal(JSON.parse(first.lines[0]).createBlocked, "daily_bound");
  assert.deepEqual(metrics.ledger.watchdog!.daily, {
    date: "2026-11-05",
    filed: 3,
  });
  // Same UTC day: still bounded; an unproven create counted when attempted.
  const later = await run(metrics, issues, 2, NOW + 60_000);
  assert.equal(later.result.blocked.cells_planned, "daily_bound");
  // The next UTC day files the remaining threshold.
  const tomorrow = await run(metrics, issues, 3, NOW + DAY);
  assert.deepEqual(tomorrow.result.issues, [103]);
  assert.deepEqual(metrics.ledger.watchdog!.daily, {
    date: "2026-11-06",
    filed: 1,
  });
  // Attempts with an unknown outcome count toward the bound.
  const unproven = fakeTracker();
  unproven.createResult = "null";
  const lost = fakeMetrics(records);
  const attempt = await run(lost, unproven, 1);
  assert.equal(attempt.result.filed, 0);
  assert.equal(unproven.creates.length, 3);
  assert.equal(lost.ledger.watchdog!.daily!.filed, 3);
});
