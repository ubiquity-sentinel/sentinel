import assert from "node:assert/strict";
import { planMatrixWave } from "../../src/host/matrix-planner.ts";
import { prepareMatrixIntakeV1 } from "../../src/repair/loop.ts";
import {
  existingPrLifecycleRig,
  seedFreshTakeoverIssue,
} from "../repair/existing-pr-lifecycle-fixtures.ts";
import { seededSnapshot } from "../repair/loop-rig.ts";
import { SHA1 } from "../state/helpers.ts";

Deno.test("existing PR matrix: unresolved reference never receives a replacement cell", async () => {
  const rig = existingPrLifecycleRig();
  // Seed via the actual cycle's intake with matrix implementations disabled.
  rig.deps.externalImplementations = true;
  await rig.run();
  await prepareMatrixIntakeV1(rig.deps, rig.options);
  const result = await planMatrixWave(rig.deps, {
    waveId: "existing-pr-wave",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 82,
    plannedAt: rig.clock.now(),
    deadline: rig.options.deadline,
  });
  assert.equal(result.plan.cells.length, 0, "existing PR prevents a new grant");
  assert.equal((await rig.snapshot()).reservations.length, 0);
  assert.ok(rig.calls.includes("discover"));
});

Deno.test("existing PR matrix: native queue preflight precedes fresh intake discovery", async () => {
  const r = existingPrLifecycleRig();
  r.state.repair = seededSnapshot([]);
  r.state.repairHead = SHA1;
  await prepareMatrixIntakeV1(r.deps, r.options);
  assert.equal(r.calls[0], "queue");
  assert.ok(r.calls.indexOf("rules") < r.calls.indexOf("discover"));
  assert.ok(r.calls.indexOf("discover") < r.calls.indexOf("takeover_write"));
  r.calls.length = 0;
  await planMatrixWave(r.deps, {
    waveId: "existing-pr-queue-order",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 82,
    plannedAt: r.clock.now(),
    deadline: r.options.deadline,
  });
  assert.equal(r.calls[0], "queue");
  assert.ok(r.calls.indexOf("rules") < r.calls.indexOf("discover"));
});

Deno.test("existing PR matrix: unknown queue holds until fresh evidence retries the existing PR without a new grant", async () => {
  const r = existingPrLifecycleRig();
  r.state.repair = seededSnapshot([]);
  r.state.repairHead = SHA1;
  r.queueControls.unavailable = true;
  await prepareMatrixIntakeV1(r.deps, r.options);
  const afterIntake = await r.snapshot();
  assert.equal(r.calls[0], "queue");
  assert.equal(r.calls.includes("discover"), false);
  assert.equal(afterIntake.work[0].wait?.until, null);
  assert.equal(afterIntake.work[0].wait?.reason, "backoff");
  r.calls.length = 0;
  r.queueControls.unavailable = false;
  const result = await planMatrixWave(r.deps, {
    waveId: "existing-pr-held",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 82,
    plannedAt: r.clock.now(),
    deadline: r.options.deadline,
  });
  assert.equal(r.calls[0], "queue");
  assert.equal(r.calls.includes("discover"), true);
  assert.ok(r.calls.indexOf("rules") < r.calls.indexOf("discover"));
  const retried = await r.snapshot();
  assert.match(retried.work[0].blocker?.message ?? "", /association_unproven/);
  assert.deepEqual(retried.work[0].counters, afterIntake.work[0].counters);
  assert.deepEqual(retried.reservations, afterIntake.reservations);
  assert.equal(result.plan.cells.length, 0);
  assert.equal(r.model.requests.length, 0);
});

Deno.test("existing PR matrix: positive native absence clears only its own preflight wait and permits ordinary planning", async () => {
  const r = existingPrLifecycleRig("human-owner", false);
  r.state.repair = seededSnapshot([]);
  r.state.repairHead = SHA1;
  r.queueControls.unavailable = true;
  await prepareMatrixIntakeV1(r.deps, r.options);
  const held = await r.snapshot();
  assert.equal(held.work[0].wait?.until, null);
  r.queueControls.unavailable = false;
  await prepareMatrixIntakeV1(r.deps, r.options);
  const retried = await r.snapshot();
  assert.equal(retried.work[0].wait, null);
  assert.equal(retried.work[0].blocker, null);
  assert.deepEqual(retried.work[0].counters, held.work[0].counters);
  assert.deepEqual(retried.reservations, held.reservations);
  const planned = await planMatrixWave(r.deps, {
    waveId: "existing-pr-negative-retry",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 82,
    plannedAt: r.clock.now(),
    deadline: r.options.deadline,
  });
  assert.equal(planned.plan.cells.length, 1);
});

import { candidateBranch } from "../../src/repair/keys.ts";

Deno.test("existing PR dormant coordinator: unmarked matrix intake retains ordinary branch assignment without observations", async () => {
  const r = existingPrLifecycleRig("human-owner", false);
  await seedFreshTakeoverIssue(r);
  r.takeoverControls.activated = false;
  await prepareMatrixIntakeV1(r.deps, r.options);
  const work = (await r.snapshot()).work[0];
  assert.equal(work.target.branch, candidateBranch(work.id));
  assert.deepEqual(r.calls, []);
});

Deno.test("existing PR dormant coordinator: a released preflight hold receives Sentinel's own matrix grant", async () => {
  // Owner directive 2026-10-24: the takeover preflight hold no longer keeps
  // Sentinel's own repair out of the matrix once discovery is off.
  const r = existingPrLifecycleRig("human-owner", false);
  r.state.repair = seededSnapshot([]);
  r.state.repairHead = SHA1;
  r.queueControls.unavailable = true;
  await prepareMatrixIntakeV1(r.deps, r.options);
  const before = await r.snapshot();
  assert.equal(before.work[0].nextStep, "blocked");
  r.takeoverControls.activated = false;
  r.queueControls.unavailable = false;
  r.calls.length = 0;
  await prepareMatrixIntakeV1(r.deps, r.options);
  const planned = await planMatrixWave(r.deps, {
    waveId: "existing-pr-dormant-held",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    runtimeSha: SHA1,
    generation: 82,
    plannedAt: r.clock.now(),
    deadline: r.options.deadline,
  });
  const after = await r.snapshot();
  const work = after.work[0];
  assert.equal(work.nextStep, "work");
  assert.equal(work.blocker, null);
  assert.equal(work.target.branch, candidateBranch(work.id));
  assert.equal(after.reservations.length, before.reservations.length + 1);
  assert.equal(planned.attempted, 1);
  assert.equal(planned.plan.cells.length, 1);
  assert.equal(r.calls.includes("discover"), false);
});

for (const mode of ["unavailable", "throwing"] as const) {
  Deno.test(`existing PR matrix pass refusal: ${mode} discovery cannot assign a new branch`, async () => {
    const r = existingPrLifecycleRig();
    await seedFreshTakeoverIssue(r);
    r.takeover.discover = () => {
      if (mode === "throwing") throw new Error("offline discovery failure");
      return Promise.resolve({ status: "unavailable", reason: "pagination" });
    };
    const before = await r.snapshot();
    await prepareMatrixIntakeV1(r.deps, r.options);
    const after = await r.snapshot();
    assert.equal(
      after.work[0].target.branch,
      null,
      "unavailable discovery is not ordinary-new-work permission",
    );
    assert.deepEqual(after.work, before.work);
    assert.deepEqual(after.reservations, before.reservations);
  });
  Deno.test(`existing PR matrix pass refusal: ${mode} discovery cannot decompose or grant on the next iteration`, async () => {
    const r = existingPrLifecycleRig();
    const context = await seedFreshTakeoverIssue(r);
    const next = structuredClone(context.snapshot);
    next.stateHead = context.head;
    next.sequence++;
    next.work[0].target.branch = candidateBranch(next.work[0].id);
    next.work[0].counters.timeouts = 1;
    const seeded = await r.state.writeRepair(next, context.head);
    assert.ok(seeded.ok && seeded.value.status === "applied");
    r.takeover.discover = () => {
      if (mode === "throwing") throw new Error("offline discovery failure");
      return Promise.resolve({ status: "unavailable", reason: "pagination" });
    };
    const before = await r.snapshot();
    const planned = await planMatrixWave(r.deps, {
      waveId: "existing-pr-unavailable",
      run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
      runtimeSha: SHA1,
      generation: 82,
      plannedAt: r.clock.now(),
      deadline: r.options.deadline,
    });
    const after = await r.snapshot();
    assert.deepEqual(
      after.work,
      before.work,
      "no decomposition after failed discovery",
    );
    assert.deepEqual(after.reservations, before.reservations);
    assert.equal(planned.attempted, 0);
    assert.equal(planned.plan.cells.length, 0);
    assert.equal(r.model.requests.length, 0);
  });
}
