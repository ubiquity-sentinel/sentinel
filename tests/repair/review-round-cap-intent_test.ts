/**
 * Owner directive 2026-10-30: a spent review-round count never parks a
 * record. A review attempt left at a spent count is still observed on its own
 * journal; a pending verdict holds, and a terminal no-verdict is re-requested
 * as the next round. Nothing is refunded or fabricated.
 *
 * Driven through the REAL repair loop with a scripted reviewer.
 */
import assert from "node:assert/strict";
import { SHA3, T0 } from "../state/helpers.ts";
import { capRig, reviewCharges } from "./review-round-cap-rig.ts";

const ID = "issue-1";
const ROUND = 5;

function spentRig() {
  return capRig({
    reviewRounds: ROUND,
    nextStep: "review",
    wait: {
      reason: "review_pending",
      since: T0 - 2 * 60_000,
      until: T0,
    },
    reservations: reviewCharges(ID, ROUND),
  });
}

Deno.test("ceiling intent: a pending verdict at a spent count waits, never parks", async () => {
  const rig = await spentRig();
  rig.github.bind(ROUND, SHA3);
  rig.github.reviewMode = "pending";
  await rig.run();
  const work = await rig.work();
  assert.equal(work.nextStep, "review");
  assert.equal(work.blocker, null);
  assert.equal(work.wait?.reason, "review_pending");
  assert.equal(work.counters.reviewRounds, ROUND);
  assert.equal(
    rig.github.requests,
    0,
    "no review is requested while one waits",
  );
});

Deno.test("ceiling intent: a no-verdict verdict at a spent count takes the next round, never parks", async () => {
  const rig = await spentRig();
  rig.github.bind(ROUND, SHA3);
  rig.github.reviewMode = "no_verdict";
  await rig.run();
  const work = await rig.work();
  assert.equal(work.nextStep, "review");
  assert.equal(work.blocker, null);
  assert.equal(work.counters.reviewRounds, ROUND + 1);
  assert.equal(rig.github.requests, 1, "the sixth round is requested");
  assert.equal(rig.github.reviewRequestIdentities.length, 1);
});
