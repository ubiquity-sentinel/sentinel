/**
 * #335: every planner pass records why ready records stayed unplanned (a
 * closed refusal reason plus the ready-unplanned count), the launcher's
 * re-emitted plan diagnostic carries it, and finalize folds it and the
 * end-of-cycle wait causes into the throughput metrics record.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { createMetricsCollectorV1 } from "../../src/contracts/throughput-metrics-collector.ts";
import {
  foldThroughputRecordV1,
  parseThroughputDailySummaryV1,
  parseThroughputMetricsLineV1,
  THROUGHPUT_METRICS_RECORD_MAX_BYTES,
} from "../../src/contracts/throughput-metrics.ts";
import {
  matrixPlanDiagnosticLineOf,
  scanPlanDiagnostic,
  scanPlanRefusalFromLog,
} from "../../src/host/matrix-plan-diagnostic.ts";
import { classifyMatrixPlanRefusalV1 } from "../../src/host/matrix-plan-refusal.ts";
import { planMatrixWave } from "../../src/host/matrix-planner.ts";
import {
  type ChildRuntimeSummaryV1,
  runtimeSummaryWithPlanRefusal,
} from "../../src/host/run-summary.ts";
import { collectFinalizeMetricsV1 } from "../../src/host/throughput-metrics-finalize.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../repair/helpers.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";

const SESSION = { maxDurationMs: 240_000, maxOutputChars: 200_000 };

function planner(
  work: ReturnType<typeof workRecord>[],
  deadlineMs: number,
) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  state.repair = seededSnapshot(work);
  state.repairHead = SHA1;
  const configs = repairConfigs({ sessionBound: SESSION });
  const deps = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github: new FakeGithub({ baseSha: SHA1 }),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    model: new FakeModel(),
    budget: new RollingStartBudget({ clock, state, configs }),
    externalImplementations: true,
    legacyReviewCutoff: null,
  } satisfies Parameters<typeof planMatrixWave>[0];
  const options = {
    waveId: "wave-refusal",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 1,
    deadline: clock.now() + deadlineMs,
    runStartedAt: clock.now(),
    plannedAt: clock.now(),
    modelStartsEnabled: true,
  } satisfies Parameters<typeof planMatrixWave>[1];
  return { deps, options };
}

Deno.test("planner: a start that cannot fit the operation margin refuses as deadline_margin", async () => {
  // 10 minutes left: the planner keeps one 5-minute margin for its handoff
  // and a 4-minute session plus another margin no longer fits.
  const { deps, options } = planner([workRecord("issue-late")], 10 * 60_000);
  const report = await planMatrixWave(deps, options);
  assert.equal(report.prepared, 0);
  assert.deepEqual(report.refusal, {
    reason: "deadline_margin",
    // The pass stopped before any state read, so the count is unknown.
    readyUnplanned: null,
  });
});

Deno.test("planner: a pass with no ready record refuses as no_ready_records with a zero count", async () => {
  const waiting = workRecord("issue-waiting", {
    wait: { reason: "backoff", since: T0, until: T0 + 3_600_000 },
  });
  const { deps, options } = planner([waiting], 60 * 60_000);
  const report = await planMatrixWave(deps, options);
  assert.equal(report.prepared, 0);
  assert.deepEqual(report.refusal, {
    reason: "no_ready_records",
    readyUnplanned: 0,
  });
});

Deno.test("refusal classification: closed reasons and the unplanned count", () => {
  const facts = {
    prepared: 1,
    readyIds: ["a", "b", "c"],
    plannedTaskIds: new Set(["a"]),
    stoppedByDeadline: false,
    modelStartsDisabled: false,
    deferredByReason: {},
    memoryRefused: 0,
  };
  assert.deepEqual(classifyMatrixPlanRefusalV1(facts), {
    reason: null,
    readyUnplanned: 2,
  });
  assert.equal(
    classifyMatrixPlanRefusalV1({ ...facts, memoryRefused: 1 }).reason,
    "reservation_denied",
  );
  assert.equal(
    classifyMatrixPlanRefusalV1({
      ...facts,
      deferredByReason: { admission_capacity: 1 },
    }).reason,
    "reservation_denied",
  );
  assert.equal(
    classifyMatrixPlanRefusalV1({ ...facts, deferredByReason: { cooldown: 2 } })
      .reason,
    "target_unavailable",
  );
  assert.equal(
    classifyMatrixPlanRefusalV1({ ...facts, deferredByReason: { bounds: 1 } })
      .reason,
    "deadline_margin",
  );
  assert.equal(
    classifyMatrixPlanRefusalV1({ ...facts, modelStartsDisabled: true })
      .reason,
    "provider_unavailable",
  );
  assert.deepEqual(
    classifyMatrixPlanRefusalV1({
      ...facts,
      readyIds: ["a"],
      plannedTaskIds: new Set(["a"]),
    }),
    { reason: null, readyUnplanned: 0 },
  );
});

function childSummary(): ChildRuntimeSummaryV1 {
  return {
    launcherSha: null,
    runtimeSha: null,
    generation: 90,
    purpose: "ordinary",
    targets: [],
    admittedWorkCount: 0,
    modelStarts: 0,
    prsTouched: [],
    outcome: "healthy",
    reasonCode: "ok",
  };
}

Deno.test("the re-emitted plan diagnostic carries the refusal to finalize's metrics", () => {
  const line = matrixPlanDiagnosticLineOf({
    waveId: "exec-1",
    prepared: 0,
    attempted: 0,
    deferred: 0,
    cause: "planner",
    refusal: { reason: "deadline_margin", readyUnplanned: 4 },
  });
  // The launcher re-parse keeps the optional keys; an older line without
  // them still parses.
  const hosted = scanPlanDiagnostic(JSON.stringify(line), { id: "exec-1" });
  assert.equal(hosted?.plannerRefusal, "deadline_margin");
  assert.equal(hosted?.readyUnplanned, 4);
  const { plannerRefusal: _r, readyUnplanned: _u, ...older } = line;
  const old = scanPlanDiagnostic(JSON.stringify(older), { id: "exec-1" });
  assert.ok(old !== null);
  assert.equal(Object.hasOwn(old, "plannerRefusal"), false);
  // An unknown reason is refused, not coerced.
  assert.equal(
    scanPlanDiagnostic(
      JSON.stringify({ ...line, plannerRefusal: "quota" }),
      { id: "exec-1" },
    ),
    null,
  );

  // Finalize reads the job log: Actions timestamps every line.
  const log = [
    `2026-11-05T12:00:00.0Z ${
      JSON.stringify({ ...childSummary(), kind: "hosted_runtime_summary" })
    }`,
    `2026-11-05T12:00:01.0Z ${JSON.stringify(hosted)}`,
  ].join("\n");
  assert.deepEqual(scanPlanRefusalFromLog(log), {
    reason: "deadline_margin",
    readyUnplanned: 4,
  });
  // The raw child line (no `advisory`) is never read.
  assert.equal(scanPlanRefusalFromLog(JSON.stringify(line)), null);
  const summary = runtimeSummaryWithPlanRefusal(log);
  assert.deepEqual(summary?.plannerRefusal, {
    reason: "deadline_margin",
    readyUnplanned: 4,
  });

  const waiting = (id: string, wait: unknown) =>
    ({
      ...workRecord(id),
      wait,
    }) as ReturnType<typeof workRecord>;
  const record = collectFinalizeMetricsV1({
    cycle: { runId: 9, attempt: 1 },
    finalizeStartedAtMs: T0 + 60_000,
    nowMs: T0 + 61_000,
    jobs: [{
      name: "matrix_plan",
      conclusion: "success",
      summary,
      startedAtMs: T0,
      completedAtMs: T0 + 10_000,
    }],
    runSummary: null,
    repair: seededSnapshot([
      waiting("a", {
        reason: "unavailable",
        since: T0,
        until: T0 + 1,
        cause: { port: "github", status: "5xx", code: "unavailable" },
      }),
      waiting("b", {
        reason: "unavailable",
        since: T0,
        until: T0 + 1,
        cause: { port: "github", status: "5xx", code: "unavailable" },
      }),
      waiting("c", { reason: "backoff", since: T0, until: null }),
      waiting("d", { reason: "ci_pending", since: T0, until: null }),
      workRecord("e"),
    ]),
  });
  assert.equal(record.plannerRefusal, "deadline_margin");
  assert.equal(record.counts.readyRecordsNotPlanned, 4);
  assert.deepEqual(record.waitCauses, {
    "github:5xx:unavailable": 2,
    "legacy:none:backoff": 1,
  });
});

Deno.test("metrics records parse with and without the bounded waitCauses field", () => {
  const collector = createMetricsCollectorV1();
  collector.setPlannerRefusal("no_ready_records");
  collector.addCount("readyRecordsNotPlanned", 0);
  // Seven distinct keys: five keep their own slot and the rest fold.
  for (
    const key of [
      "github:5xx:unavailable",
      "github:429:rate_limited",
      "queue:unknown:obs_unavail",
      "budget:none:ambiguous",
      "runtime:network:unavailable",
      "model:5xx:unavailable",
      "state:unknown:unavailable",
    ]
  ) collector.addWaitCause(key, 999_999);
  assert.throws(() => collector.addWaitCause("https://x.example/a:b:c"));
  const record = collector.snapshot({
    cycle: { runId: 2_000_000_000, attempt: 99 },
    startedAtMs: T0,
    finishedAtMs: T0 + 1,
  });
  assert.equal(Object.keys(record.waitCauses ?? {}).length, 6);
  assert.equal(record.waitCauses?.["other:none:other"], 1_999_998);
  const line = canonicalStringify(record);
  assert(
    new TextEncoder().encode(line).length <=
      THROUGHPUT_METRICS_RECORD_MAX_BYTES,
  );
  assert.deepEqual(parseThroughputMetricsLineV1(line), record);

  // A record written before the field existed re-parses byte for byte.
  const { waitCauses: _w, ...older } = record;
  const olderLine = canonicalStringify(older);
  assert.equal(
    canonicalStringify(parseThroughputMetricsLineV1(olderLine)),
    olderLine,
  );
  // A long or URL-shaped key is refused.
  assert.throws(() =>
    parseThroughputMetricsLineV1(canonicalStringify({
      ...record,
      waitCauses: { "github:5xx:unavailable_and_more_x": 1 },
    }))
  );
});

Deno.test("the daily rollup sums wait causes under the same bound", () => {
  const cut = (causes: Record<string, number> | null, at: number) => {
    const collector = createMetricsCollectorV1();
    for (const [key, n] of Object.entries(causes ?? {})) {
      collector.addWaitCause(key, n);
    }
    const record = collector.snapshot({
      cycle: { runId: at, attempt: 1 },
      startedAtMs: T0 + at,
      finishedAtMs: T0 + at + 1,
    });
    return causes === null ? { ...record, waitCauses: null } : record;
  };
  const { waitCauses: _w, ...older } = cut(null, 1);
  let day = foldThroughputRecordV1(null, older);
  assert.equal(Object.hasOwn(day, "waitCauses"), false);
  day = foldThroughputRecordV1(day, cut({ "github:5xx:unavailable": 2 }, 2));
  day = foldThroughputRecordV1(
    day,
    cut({ "github:5xx:unavailable": 1, "legacy:none:backoff": 3 }, 3),
  );
  day = foldThroughputRecordV1(day, cut(null, 4));
  assert.deepEqual(day.waitCauses, {
    "github:5xx:unavailable": 3,
    "legacy:none:backoff": 3,
  });
  assert.deepEqual(parseThroughputDailySummaryV1(day), day);
  const { waitCauses: _d, ...olderDay } = day;
  assert.deepEqual(parseThroughputDailySummaryV1(olderDay), olderDay);
});
