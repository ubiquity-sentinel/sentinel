/**
 * Issue #155 (3): a review intent left in flight at the hard review-round
 * ceiling. The ceiling gate defers while an operation is in flight, so an
 * intent no path ever clears deferred every run: live 264's shape (counter 0,
 * three charges) kept its `review_request` intent through every no-verdict
 * re-request (the observation's counting branch needs a counter of at least
 * one), and an intent whose own journal is not the one observed never
 * concluded at all. At the ceiling the gate now recovers a review attempt
 * that is over, as `recoverExpiredReviewAttempt` does (the round counted
 * once, the intent cleared, its charge kept), and parks in the same write:
 * one whose own journal concluded at once, any other after 6 hours.
 *
 * Driven through the REAL repair loop with a scripted reviewer; nothing is
 * reserved, settled or refunded, and no review is requested.
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import { CEILING_REVIEW_INTENT_BOUND_MS } from "../../src/repair/loop-review-round-cap.ts";
import { SHA1, SHA3, T0 } from "../state/helpers.ts";
import {
  assertParked,
  CAP_UNREVIEWED,
  capRig,
  type CapRigV1,
  MINUTE,
  PR,
  reviewCharges,
} from "./review-round-cap-rig.ts";

const ID = "issue-1";

/** A saved `review_request` intent for attempt `round` of SHA3 on PR 7. */
function reviewIntent(
  round: number,
  startedAt: number,
  requestId: string,
): WorkRecordV1["intent"] {
  return {
    kind: "review_request",
    key: reviewOperationKey(PR, SHA3, round),
    startedAt,
    branch: "sentinel/repair/issue-1",
    expectedHead: SHA3,
    observedBase: SHA1,
    pr: PR,
    requestId,
    resultId: null,
  };
}

/** A record at `review` holding `intent`, with `charges` in the ledger. */
function atReview(
  reviewRounds: number,
  charges: BudgetReservationV1[],
  intent: WorkRecordV1["intent"],
  startedAt: number,
) {
  return capRig({
    reviewRounds,
    nextStep: "review",
    wait: { reason: "review_pending", since: startedAt, until: startedAt },
    reservations: charges,
    record: { intent },
  });
}

/** Parked by the ceiling with the attempt recovered: counted, cleared, kept. */
async function assertRecoveredPark(
  rig: CapRigV1,
  charges: BudgetReservationV1[],
  rounds: number,
) {
  const work = await assertParked(rig, CAP_UNREVIEWED);
  assert.equal(work.intent, null, "the intent is cleared");
  assert.equal(work.counters.reviewRounds, rounds, "counted exactly once");
  assert.equal(rig.github.requests, 0, "no review is requested");
  assert.deepEqual(await rig.charges(), charges, "every charge kept exactly");
  // The park is final: later runs change nothing.
  const parked = await rig.snapshot();
  for (let run = 0; run < 2; run++) {
    rig.clock.advance(16 * MINUTE);
    await rig.run();
  }
  assert.deepEqual(await rig.snapshot(), parked);
  assert.equal(rig.github.requests, 0);
}

Deno.test("ceiling intent: the 264 shape (counter 0, three charges) whose own journal ended without a verdict parks instead of deferring forever", async () => {
  const charges = reviewCharges(ID, 3);
  const startedAt = T0 - 2 * MINUTE;
  const rig = await atReview(
    0,
    charges,
    reviewIntent(1, startedAt, charges[0]!.id),
    startedAt,
  );
  // The intent's own attempt-1 journal is bound and terminal, no verdict.
  rig.github.bind(1);
  rig.github.reviewMode = "no_verdict";
  await rig.run();
  await assertRecoveredPark(rig, charges, 1);
});

Deno.test("ceiling intent: the 264 shape whose intent no observed journal concludes defers without a write, then parks after 6 hours", async () => {
  const charges = reviewCharges(ID, 3);
  const startedAt = T0 - 2 * MINUTE;
  // The saved intent names attempt 4; the record reads attempt 1's journal
  // (counter 0), which ended without a verdict.
  const rig = await atReview(
    0,
    charges,
    reviewIntent(4, startedAt, charges[2]!.id),
    startedAt,
  );
  rig.github.bind(1);
  rig.github.reviewMode = "no_verdict";
  const before = await rig.snapshot();
  await rig.run();
  assert.deepEqual(await rig.snapshot(), before, "inside the bound: no write");
  rig.clock.advance(CEILING_REVIEW_INTENT_BOUND_MS - 3 * MINUTE);
  await rig.run();
  assert.deepEqual(await rig.snapshot(), before, "still inside the bound");
  rig.clock.advance(2 * MINUTE);
  await rig.run();
  await assertRecoveredPark(rig, charges, 1);
});

Deno.test("ceiling intent: the 647 shape (counter 3, four charges) whose round-4 journal ended without a verdict is counted once and parks", async () => {
  const charges = reviewCharges(ID, 4, {
    outcome: (attempt) => attempt === 4 ? "ambiguous" : "submitted",
  });
  const startedAt = T0 - 2 * MINUTE;
  const rig = await atReview(
    3,
    charges,
    reviewIntent(4, startedAt, charges[3]!.id),
    startedAt,
  );
  rig.github.bind(4);
  rig.github.reviewMode = "no_verdict";
  await rig.run();
  await assertRecoveredPark(rig, charges, 4);
});

Deno.test("ceiling intent: the 647 shape holding an already counted round-3 intent whose journal ended without a verdict parks instead of deferring forever", async () => {
  const charges = reviewCharges(ID, 4);
  const startedAt = T0 - 2 * MINUTE;
  // The counter already counts round 3, whose intent was never cleared: the
  // observation reads round 3's own journal (no verdict).
  const rig = await atReview(
    3,
    charges,
    reviewIntent(3, startedAt, charges[2]!.id),
    startedAt,
  );
  rig.github.bind(3);
  rig.github.reviewMode = "no_verdict";
  await rig.run();
  await assertRecoveredPark(rig, charges, 4);
});

Deno.test("ceiling intent: below the ceiling an intent in flight is untouched (control)", async () => {
  const charges = reviewCharges(ID, 1);
  const startedAt = T0 - 2 * MINUTE;
  const rig = await atReview(
    1,
    charges,
    reviewIntent(2, startedAt, charges[0]!.id),
    startedAt,
  );
  rig.github.bind(2);
  rig.github.reviewMode = "pending";
  await rig.run();
  const work = await rig.work();
  assert.equal(work.nextStep, "review");
  assert.equal(work.blocker, null);
  assert.equal(rig.github.requests, 0);
});
