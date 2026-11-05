/**
 * A lost conflict-resolution cell through the REAL hosted loop: the
 * `issue-ubiquity-ai.ubq.fi-1176` shape (published, preserved head with its
 * open PR, a marked implementation intent and its `reserved` retry charge,
 * whose cell never uploaded an artifact) defers every cycle and is never
 * re-granted; past the cell evidence expiry the serial step settles it charged
 * (`ambiguous`, never refunded) and returns the record to the exact pending
 * resolution, which the planner admits again.
 */
import assert from "node:assert/strict";
import { deriveReservationId } from "../../src/budget/mod.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  CONFLICT_CELL_EVIDENCE_EXPIRY_MS,
  conflictMarker,
  conflictMarkerBase,
  conflictResolutionAdmissible,
  pendingConflictResolution,
} from "../../src/repair/conflict-resolution.ts";
import {
  LOST_CONFLICT_CELL_EXPIRY_MS,
  lostCellLine,
  lostConflictCellBinding,
  repentLostConflictCell,
} from "../../src/repair/conflict-lost-cell.ts";
import {
  baseRefreshIntentKey,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop-eligibility.ts";
import { REPO } from "../state/helpers.ts";
import {
  BRANCH,
  conflictGithub,
  type ConflictGitV1,
  ConflictModel,
  conflictRig,
  makeConflictGit,
  PR,
  publishedCandidate,
  TASK,
} from "./conflict-resolution-rig.ts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** The 1176 shape: an in-flight resolution admitted at `admittedAt`. */
async function inFlight(ctx: ConflictGitV1, admittedAt: number) {
  const record = await publishedCandidate(ctx);
  const attempt = record.counters.attempts + 1;
  const id = await deriveReservationId({
    repository: REPO,
    taskId: TASK,
    head: record.target.base,
    attempt,
    purpose: "retry",
  });
  const work: WorkRecordV1 = {
    ...record,
    counters: { ...record.counters, attempts: attempt },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(id),
      startedAt: admittedAt,
      branch: BRANCH,
      expectedHead: null,
      observedBase: record.target.base,
      pr: null,
      requestId: id,
      resultId: null,
      failure: conflictMarker(ctx.base, admittedAt),
    },
    updatedAt: admittedAt,
  };
  const charge: BudgetReservationV1 = {
    version: "v1",
    kind: "budget_reservation",
    repository: REPO,
    id,
    taskId: TASK,
    attempt,
    head: record.target.base,
    purpose: "retry",
    createdAt: admittedAt,
    outcome: "reserved",
    settledAt: null,
    proofRef: null,
  };
  return { work, charge };
}

async function hostedRig(ctx: ConflictGitV1) {
  const rig = conflictRig(conflictGithub(ctx), new ConflictModel(ctx), {
    externalImplementations: true,
  });
  const admittedAt = rig.clock.now();
  const seeded = await inFlight(ctx, admittedAt);
  await rig.seed([seeded.work], { reservations: [seeded.charge] });
  const plannable = async () => {
    const state = await rig.snapshot();
    return isMatrixImplementationReadyV1(
      state.work[0],
      state,
      rig.configs[0],
      rig.clock.now(),
      true,
      true,
    );
  };
  return { rig, admittedAt, ...seeded, plannable };
}

/** Captures console lines written while `body` runs. */
async function captured<T>(body: () => Promise<T>) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await body(), lines };
  } finally {
    console.log = original;
  }
}

Deno.test("lost cell: the expiry is the cell evidence horizon", () => {
  assert.equal(LOST_CONFLICT_CELL_EXPIRY_MS, CONFLICT_CELL_EVIDENCE_EXPIRY_MS);
  assert.equal(lostCellLine("t", "r", { runId: 42 }), "lost-cell:t:r:42");
  assert.equal(lostCellLine("t", "r", "expired"), "lost-cell:t:r:expired");
});

Deno.test(
  "lost cell: the 1176 shape defers every cycle and is never re-granted while its evidence may still arrive",
  async () => {
    const ctx = await makeConflictGit();
    try {
      const { rig, work, charge, plannable } = await hostedRig(ctx);
      // Four days of five-minute cycles, sampled: always deferred, unchanged.
      for (const at of [6 * HOUR, DAY, 4 * DAY, 7 * DAY]) {
        rig.clock.advance(at - (rig.clock.now() - work.updatedAt));
        const outcome = await rig.run();
        assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
        const state = await rig.snapshot();
        assert.deepEqual(state.work[0], work, "deferred, unchanged");
        assert.deepEqual(state.reservations, [charge], "still reserved");
        assert.ok(!await plannable(), "no planner re-grant");
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "lost cell: past the evidence expiry the serial step settles it charged and the planner re-grants the resolution",
  async () => {
    const ctx = await makeConflictGit();
    try {
      const { rig, work, charge, plannable } = await hostedRig(ctx);
      rig.clock.advance(LOST_CONFLICT_CELL_EXPIRY_MS);
      const { value: outcome, lines } = await captured(() => rig.run(1));
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const settled = state.reservations.find((row) => row.id === charge.id)!;
      assert.equal(settled.outcome, "ambiguous", "charged, never refunded");
      assert.equal(settled.proofRef, null);
      assert.equal(state.reservations.length, 1, "no new charge yet");
      const record = state.work[0];
      assert.equal(record.nextStep, "work");
      assert.equal(record.blocker, null);
      assert.equal(record.intent?.kind, "base_refresh");
      assert.equal(record.intent?.resultId, null);
      assert.equal(record.intent?.requestId, null);
      assert.equal(
        record.intent?.key,
        baseRefreshIntentKey(PR, ctx.head, ctx.base),
      );
      assert.equal(conflictMarkerBase(record.intent), ctx.base, "marker kept");
      assert.equal(pendingConflictResolution(record.intent), ctx.base);
      // Head, PR, preserved descriptor and counters are untouched.
      assert.deepEqual(record.target, work.target);
      assert.deepEqual(record.counters, work.counters);
      assert.ok(lines.includes(lostCellLine(TASK, charge.id, "expired")));
      // The next cycle's planner admits a fresh conflict resolution.
      assert.equal(
        conflictResolutionAdmissible(true, state, record),
        ctx.base,
      );
      assert.ok(await plannable());
      // And the serial step leaves the pending resolution to the planner.
      const again = await rig.run();
      assert.notEqual(again.status, "state_error");
      assert.deepEqual((await rig.snapshot()).work[0], record);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test("lost cell: only the exact charged marked resolution binds", async () => {
  const ctx = await makeConflictGit();
  try {
    const { work, charge } = await inFlight(ctx, 1_000);
    const snapshot = { reservations: [charge] };
    assert.deepEqual(lostConflictCellBinding(snapshot, work), {
      reservationId: charge.id,
      mergeBase: ctx.base,
    });
    // The settlement's own torn pair (charge settled, record not) binds.
    assert.ok(
      lostConflictCellBinding({
        reservations: [{ ...charge, outcome: "ambiguous", settledAt: 2_000 }],
      }, work) !== null,
    );
    const { failure: _marker, ...unmarked } = work.intent!;
    const refusals: [string, WorkRecordV1, BudgetReservationV1[]][] = [
      ["no charge", work, []],
      ["submitted", work, [{ ...charge, outcome: "submitted", settledAt: 2 }]],
      ["other task", work, [{ ...charge, taskId: "issue-2" as typeof TASK }]],
      ["other attempt", work, [{ ...charge, attempt: charge.attempt + 1 }]],
      ["blocked", { ...work, nextStep: "blocked" }, [charge]],
      ["unmarked", { ...work, intent: unmarked }, [charge]],
      ["no PR", { ...work, target: { ...work.target, pr: null } }, [charge]],
    ];
    for (const [name, record, reservations] of refusals) {
      assert.equal(
        lostConflictCellBinding({ reservations }, record),
        null,
        name,
      );
    }
    const repent = repentLostConflictCell(work, ctx.base, 5_000);
    assert.equal(repent.intent?.startedAt, 5_000);
    assert.equal(repent.updatedAt, 5_000);
  } finally {
    await ctx.cleanup();
  }
});
