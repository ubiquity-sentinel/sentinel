/**
 * Owner throughput t20 (#282): a target with no pull-request CI and no local
 * verify must be parked by the trusted planner, before any reservation or
 * matrix cell exists. Its own admission park is unchanged for the serial lane.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { planMatrixWave } from "../../src/host/matrix-planner.ts";
import { implementationIntent } from "../../src/repair/loop-implementation.ts";
import { STALE_IMPLEMENTATION_INTENT_TTL_MS } from "../../src/repair/loop-eligibility.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "../repair/helpers.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";

const NO_EVIDENCE = "no_ci_and_no_local_verify";

Deno.test("matrix planner: a no-test-evidence target parks uncharged and plans no cell", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const config = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    commands: { replay: NO_EVIDENCE, test: NO_EVIDENCE },
    commandRegistry: {
      version: "v1",
      commands: {
        [NO_EVIDENCE]: {
          executable: "true",
          args: [],
          maxDurationMs: 1000,
          maxOutputBytes: 1024,
        },
      },
    },
  })[0]!;
  const record = workRecord("issue-no-test-evidence", {
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-no-test-evidence",
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
  const seeded = await state.writeRepair(
    parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: clock.now(),
      incidents: [],
      evidence: [],
      work: [record],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  let modelCalls = 0;
  const deps = {
    ciMinutes: INACTIVE_CI_MINUTES,
    clock,
    state,
    configs: [config],
    controllerSha: SHA1,
    github: new FakeGithub({ baseSha: SHA1 }),
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [] }),
    replay: new FakeReplay(),
    model: {
      modelId: "gpt-reserve",
      runModel: () => {
        modelCalls++;
        return Promise.reject(new Error("the planner cannot infer"));
      },
    },
    budget: new RollingStartBudget({ clock, state, configs: [config] }),
    externalImplementations: true,
    legacyReviewCutoff: null,
  } satisfies Parameters<typeof planMatrixWave>[0];
  const options = {
    waveId: "wave-no-test-evidence",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 1,
    deadline: clock.now() + 60 * 60_000,
    runStartedAt: clock.now(),
    plannedAt: clock.now(),
    modelStartsEnabled: true,
  } satisfies Parameters<typeof planMatrixWave>[1];
  const report = await planMatrixWave(deps, options);
  assert.equal(report.prepared, 0);
  assert.deepEqual(report.plan.cells, []);
  assert.equal(report.diagnostic?.notReadyByReason[NO_EVIDENCE], 1);
  assert.deepEqual(report.diagnostic?.skippedByReason, {});
  assert.deepEqual(
    report.diagnostic?.byRepository?.["ubiquity/ai.ubq.fi"]?.skippedByReason,
    {},
  );
  assert.equal(
    report.diagnostic?.byRepository?.["ubiquity/ai.ubq.fi"]
      ?.notReadyByReason[NO_EVIDENCE],
    1,
  );
  const parked = state.repair!.work[0]!;
  assert.equal(parked.nextStep, "blocked");
  assert.ok(parked.blocker?.message.startsWith(NO_EVIDENCE));
  assert.equal(parked.intent, null, "the planner park is uncharged");
  assert.equal(state.repair!.reservations.length, 0);
  assert.equal(modelCalls, 0);
  const replanned = await planMatrixWave(deps, {
    ...options,
    waveId: "wave-no-test-evidence-again",
  });
  assert.equal(replanned.diagnostic?.totalRecords, 1);
  assert.deepEqual(replanned.diagnostic?.skippedByReason, {});
  assert.deepEqual(replanned.diagnostic?.notReadyByReason, {
    [NO_EVIDENCE]: 1,
  });
  assert.deepEqual(
    replanned.diagnostic?.byRepository,
    report.diagnostic?.byRepository,
  );
});

Deno.test("matrix planner: a stale retained implementation intent is still parked", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const config = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    commands: { replay: NO_EVIDENCE, test: NO_EVIDENCE },
    commandRegistry: {
      version: "v1",
      commands: {
        [NO_EVIDENCE]: {
          executable: "true",
          args: [],
          maxDurationMs: 1000,
          maxOutputBytes: 1024,
        },
      },
    },
  })[0]!;
  const base = workRecord("issue-stale-intent", {
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-stale-intent",
      checkpoint: null,
      head: null,
      pr: null,
    },
  });
  // A matrix cell died after reserving and never ingested a result: the
  // implementation intent is past its TTL, so this record must not idle at
  // `work` while the planner excludes its config from every cell.
  const reservationId = "e".repeat(64);
  const intent = implementationIntent(
    reservationId,
    base,
    clock.now() - STALE_IMPLEMENTATION_INTENT_TTL_MS - 60_000,
  );
  const record = { ...base, intent };
  const seeded = await state.writeRepair(
    parseRepairStateSnapshotV1({
      version: "v1",
      kind: "repair_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: clock.now(),
      incidents: [],
      evidence: [],
      work: [record],
      reservations: [],
      reviews: [],
      replays: [],
      releaseRequests: [],
      githubCooldowns: [],
      attemptMemory: [],
      lessons: [],
    }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  let modelCalls = 0;
  const report = await planMatrixWave(
    {
      ciMinutes: INACTIVE_CI_MINUTES,
      clock,
      state,
      configs: [config],
      controllerSha: SHA1,
      github: new FakeGithub({ baseSha: SHA1 }),
      githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
      incidents: new FakeIncidents({ summaries: [] }),
      replay: new FakeReplay(),
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          modelCalls++;
          return Promise.reject(new Error("the planner cannot infer"));
        },
      },
      budget: new RollingStartBudget({ clock, state, configs: [config] }),
      externalImplementations: true,
      legacyReviewCutoff: null,
    },
    {
      waveId: "wave-stale-intent",
      run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
      runtimeSha: SHA1,
      generation: 1,
      deadline: clock.now() + 60 * 60_000,
      runStartedAt: clock.now(),
      plannedAt: clock.now(),
      modelStartsEnabled: true,
    },
  );
  assert.equal(report.prepared, 0);
  assert.deepEqual(report.plan.cells, []);
  assert.equal(report.diagnostic?.notReadyByReason[NO_EVIDENCE], 1);
  assert.deepEqual(report.diagnostic?.skippedByReason, {});
  assert.deepEqual(
    report.diagnostic?.byRepository?.["ubiquity/ai.ubq.fi"]?.skippedByReason,
    {},
  );
  const parked = state.repair!.work[0]!;
  assert.equal(parked.nextStep, "blocked");
  assert.ok(parked.blocker?.message.startsWith(NO_EVIDENCE));
  // `markBlocked` keeps the stale intent for audit, exactly as the admission
  // park does; the park itself is uncharged and opens no new reservation.
  assert.equal(parked.intent?.key, intent.key);
  assert.equal(parked.intent?.requestId, reservationId);
  assert.equal(parked.intent?.resultId, null);
  assert.equal(state.repair!.reservations.length, 0);
  assert.equal(modelCalls, 0);
});
