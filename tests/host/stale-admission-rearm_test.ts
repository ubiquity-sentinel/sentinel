/**
 * A stale implementation intent (a matrix cell that died after reserving) was
 * admitted over and refused by the budget as `invalid`, parking the record for
 * good (40 live records, 2026-11-01/02). The runtime now retires such an intent
 * before admission, and the historical parks re-arm exactly once through the
 * retry table. Every dead charge is kept as it is: nothing is refunded.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { deriveReservationId } from "../../src/budget/mod.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import { STALE_IMPLEMENTATION_INTENT_TTL_MS } from "../../src/repair/loop-eligibility.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  STALE_ADMISSION_INVALID_DETAIL,
  STALE_ADMISSION_REARM_CUTOFF_MS,
} from "../../ops/hosted-autonomy-policy.ts";
import { T0 } from "../state/helpers.ts";
import {
  activeIntent,
  LAUNCHER,
  makeRig,
  seedSnapshot,
  snapshot,
} from "./matrix-runtime-fixtures.ts";

const ISSUE = 754;
const STALE_AT = T0 - STALE_IMPLEMENTATION_INTENT_TTL_MS - 60_000;

async function deadAdmission(base: GitSha): Promise<{
  record: WorkRecordV1;
  charge: BudgetReservationV1;
}> {
  const shape = activeIntent(ISSUE, "0".repeat(64), base);
  const id = await deriveReservationId({
    repository: shape.repository,
    taskId: shape.id,
    head: base,
    attempt: 1,
    purpose: "implementation",
  });
  const live = activeIntent(ISSUE, id, base);
  const record = { ...live, intent: { ...live.intent!, startedAt: STALE_AT } };
  const charge: BudgetReservationV1 = {
    version: "v1",
    kind: "budget_reservation",
    repository: record.repository,
    id,
    taskId: record.id,
    attempt: 1,
    head: base,
    purpose: "implementation",
    createdAt: STALE_AT,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
  };
  return { record, charge };
}

function burstPark(record: WorkRecordV1, since: number): WorkRecordV1 {
  return {
    ...record,
    nextStep: "blocked",
    blocker: {
      kind: "unavailable",
      message: STALE_ADMISSION_INVALID_DETAIL,
      since,
    },
    wait: null,
  };
}

async function nextCharge(record: WorkRecordV1, base: GitSha) {
  return await deriveReservationId({
    repository: record.repository,
    taskId: record.id,
    head: base,
    attempt: 2,
    purpose: "retry",
  });
}

Deno.test("stale admission: the planner retires a dead intent and admits the next charged attempt", async () => {
  const rig = await makeRig([ISSUE], 1);
  try {
    const { record, charge } = await deadAdmission(rig.base);
    const seeded = await rig.store.writeRepair(
      parseRepairStateSnapshotV1({
        ...seedSnapshot([record]),
        reservations: [charge],
      }),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");

    const report = await planMatrixWave(rig.deps, rig.planOptions());

    const after = await snapshot(rig);
    const row = after.work.find((work) => work.id === record.id)!;
    assert.equal(row.blocker, null, row.blocker?.message);
    assert.equal(report.plan.cells.length, 1);
    const next = await nextCharge(record, rig.base);
    assert.equal(report.plan.cells[0].reservationId, next);
    assert.equal(row.counters.attempts, 2);
    assert.equal(row.intent?.requestId, next);
    // The dead admission stays exactly as charged; one new start is charged.
    assert.deepEqual(
      after.reservations.find((r) => r.id === charge.id),
      charge,
    );
    const fresh = after.reservations.find((r) => r.id === next)!;
    assert.equal(fresh.outcome, "reserved");
    assert.equal(fresh.attempt, 2);
    assert.equal(fresh.purpose, "retry");
    assert.equal(after.reservations.length, 2);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("stale admission: a historical invalid park re-arms once and is admitted through the planner", async () => {
  const rig = await makeRig([ISSUE], 1);
  try {
    const { record, charge } = await deadAdmission(rig.base);
    const seeded = await rig.store.writeRepair(
      parseRepairStateSnapshotV1({
        ...seedSnapshot([burstPark(record, T0 - 1000)]),
        reservations: [charge],
      }),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const before = await rig.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    if (!before.ok || before.value.status !== "found") return;

    const plans = planHostedRetries(
      before.value.snapshot,
      rig.clock.now(),
      LAUNCHER,
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].grant, 0);
    const reopened = applyHostedRetries(
      before.value.snapshot,
      before.value.head,
      plans,
      rig.clock.now(),
    );
    const armed = reopened.work[0];
    assert.equal(armed.nextStep, "work");
    assert.equal(armed.blocker, null);
    assert.equal(armed.intent, null);
    assert.equal(armed.counters.attempts, 1);
    assert.deepEqual(reopened.reservations, [charge]);
    const written = await rig.store.writeRepair(reopened, before.value.head);
    assert.ok(written.ok && written.value.status === "applied");

    const report = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(report.plan.cells.length, 1);
    assert.equal(
      report.plan.cells[0].reservationId,
      await nextCharge(record, rig.base),
    );
    const after = await snapshot(rig);
    assert.deepEqual(
      after.reservations.find((r) => r.id === charge.id),
      charge,
    );
    assert.equal(after.reservations.length, 2);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("stale admission: the re-arm is bounded to the historical dead-admission shape", async () => {
  const base = "1ad85317e2e681b9deb5a2f4c7b653df34a691b7" as GitSha;
  const { record, charge } = await deadAdmission(base);
  const plan = (work: WorkRecordV1, reservations = [charge], now = T0) =>
    planHostedRetries(
      parseRepairStateSnapshotV1({ ...seedSnapshot([work]), reservations }),
      now,
      LAUNCHER,
    );
  assert.equal(plan(burstPark(record, T0 - 1000)).length, 1);
  // A park written at or after the cutoff (a re-armed record refused again
  // included) stays terminal.
  const late = STALE_ADMISSION_REARM_CUTOFF_MS;
  assert.equal(plan(burstPark(record, late), [charge], late + 1).length, 0);
  // A live (not yet stale) intent keeps its owner.
  const live = { ...record, intent: { ...record.intent!, startedAt: T0 } };
  assert.equal(plan(burstPark(live, T0 - 1000)).length, 0);
  // No retained intent, or one whose charge is absent or at another attempt
  // index, is not the diagnosed shape.
  assert.equal(plan(burstPark({ ...record, intent: null }, T0 - 1)).length, 0);
  assert.equal(plan(burstPark(record, T0 - 1000), []).length, 0);
  assert.equal(
    plan(burstPark(record, T0 - 1000), [{ ...charge, attempt: 2 }]).length,
    0,
  );
  // A carried marker belongs to its own route and is never retired here.
  const marked = {
    ...record,
    intent: {
      ...record.intent!,
      failure: {
        kind: "base_review" as const,
        detail: "model run completed without any change to its checkout",
        attempts: 1,
        atMs: STALE_AT,
      },
    },
  };
  assert.equal(plan(burstPark(marked, T0 - 1000)).length, 0);
});
