/**
 * #335: every planner pass names its deferred records (record id, repository
 * and closed key) and carries its deferral histogram on every pass, not only
 * a zero-cell one. Live: runs 41974809569 printed `deferred:17` with
 * `deferredByReason:{}` because the histogram rode only the zero-cell
 * diagnostic and takeover/publication deferrals were never keyed.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import {
  MATRIX_PLAN_DIAGNOSTIC_KIND,
  matrixPlanDiagnosticLineOf,
  MAX_PLAN_DEFERRED_RECORDS,
  scanPlanDiagnostic,
} from "../../src/host/matrix-plan-diagnostic.ts";
import { planMatrixWave } from "../../src/host/matrix-planner.ts";
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
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

Deno.test("planner: a deferred ready record is named with its closed key on the report", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  state.repair = seededSnapshot([workRecord("issue-1176", {
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1176",
      checkpoint: null,
      head: null,
      pr: null,
    },
  })]);
  state.repairHead = SHA1;
  const githubCooldown = new DurableGitHubCooldownGate({ state, clock });
  assert.equal(
    (await githubCooldown.recordRateLimit(7, {
      kind: "secondary",
      observedAt: clock.now(),
      retryNotBefore: clock.now() + 60_000,
      observationId: "b".repeat(64),
      fallback: true,
    })).ok,
    true,
  );
  const report = await planMatrixWave({
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github: new FakeGithub({ baseSha: SHA1 }),
    githubCooldown,
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({ head: SHA2, changedPaths: [] }),
    budget: new RollingStartBudget({ clock, state, configs }),
  }, {
    waveId: "w-named",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 82,
    plannedAt: clock.now(),
    deadline: clock.now() + 3_600_000,
  });
  assert.equal(report.prepared, 0);
  assert.equal(report.deferred, 1);
  assert.deepEqual(report.deferredByReason, { cooldown: 1 });
  const repository = `${state.repair.work[0].repository.owner}/${
    state.repair.work[0].repository.name
  }`;
  assert.deepEqual(report.deferredRecords, [{
    taskId: "issue-1176",
    repository,
    reason: "cooldown",
  }]);
  assert.equal(report.refusal?.reason, "target_unavailable");
  assert.equal(report.refusal?.readyUnplanned, 1);
});

Deno.test("plan diagnostic: a pass with cells still carries its histogram and named deferrals", () => {
  const line = matrixPlanDiagnosticLineOf({
    waveId: "w",
    prepared: 3,
    attempted: 20,
    deferred: 2,
    // No zero-cell diagnostic: the histogram comes from the report itself.
    deferredByReason: { admission: 1, cooldown: 1 },
    deferredRecords: [
      {
        taskId: "issue-ubiquity-ai.ubq.fi-1176",
        repository: "ubiquity/ai.ubq.fi",
        reason: "admission",
      },
      {
        taskId: "issue-ubiquity-sentinel-312",
        repository: "ubiquity-sentinel/sentinel",
        reason: "invented",
      },
    ],
    cause: "planner",
    refusal: { reason: "target_unavailable", readyUnplanned: 3 },
  });
  assert.deepEqual(line.deferredByReason, { admission: 1, cooldown: 1 });
  assert.deepEqual(line.deferredRecords, [
    {
      taskId: "issue-ubiquity-ai.ubq.fi-1176",
      repository: "ubiquity/ai.ubq.fi",
      reason: "admission",
    },
    {
      taskId: "issue-ubiquity-sentinel-312",
      repository: "ubiquity-sentinel/sentinel",
      reason: "other",
    },
  ]);
  const scanned = scanPlanDiagnostic(JSON.stringify(line) + "\n", { id: "w" });
  assert.notEqual(scanned, null);
  assert.equal(scanned!.advisory, true);
  assert.deepEqual(scanned!.deferredRecords, line.deferredRecords);
  assert.equal(scanned!.plannerRefusal, "target_unavailable");
});

Deno.test("plan diagnostic: the per-record list is bounded and strictly re-parsed", () => {
  const many = Array.from(
    { length: MAX_PLAN_DEFERRED_RECORDS + 5 },
    (_, index) => ({
      taskId: `issue-${index}`,
      repository: "ubiquity/ai.ubq.fi",
      reason: "progress",
    }),
  );
  const line = matrixPlanDiagnosticLineOf({
    waveId: "w",
    prepared: 0,
    cause: "planner",
    deferredRecords: many,
  });
  assert.equal(line.deferredRecords?.length, MAX_PLAN_DEFERRED_RECORDS);
  const base = {
    kind: MATRIX_PLAN_DIAGNOSTIC_KIND,
    waveId: "w",
    cause: "planner",
    prepared: 0,
    attempted: 0,
    deferred: 0,
    deferredByReason: {},
    totalRecords: null,
    repositories: [],
  };
  // An older child without the key still parses.
  assert.notEqual(scanPlanDiagnostic(JSON.stringify(base), { id: "w" }), null);
  const bad = (row: Record<string, unknown>) =>
    scanPlanDiagnostic(
      JSON.stringify({ ...base, deferredRecords: [row] }),
      { id: "w" },
    );
  const good = {
    taskId: "issue-1",
    repository: "ubiquity/ai.ubq.fi",
    reason: "cooldown",
  };
  assert.notEqual(bad(good), null);
  assert.equal(bad({ ...good, reason: "unknown" }), null);
  assert.equal(bad({ ...good, detail: "secret" }), null);
  assert.equal(bad({ ...good, taskId: "../x" }), null);
  assert.equal(bad({ ...good, repository: "not a slug" }), null);
  assert.equal(
    scanPlanDiagnostic(
      JSON.stringify({ ...base, deferredRecords: many }),
      { id: "w" },
    ),
    null,
    "an over-bound list is refused, not truncated",
  );
});
