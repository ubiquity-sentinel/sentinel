/**
 * Owner directive 2026-10-30: a spent review-round count or CI-fix count is
 * accounting, never a permanent park. The runtime keeps iterating until the
 * current head has a completed review with no P0 (or another blocker applies);
 * a P0 on the current head still never merges.
 */
import assert from "node:assert/strict";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import { SHA1, SHA3, T0 } from "../state/helpers.ts";
import {
  capRig,
  completedReceipt,
  reviewCharges,
} from "./review-round-cap-rig.ts";
import { check, ciFirstRig, modelCharges, taskRecord } from "./ci-first-rig.ts";

const RED = {
  [SHA3]: [
    check("validate", SHA3, "failure"),
    check("verify-artifact", SHA3, "skipped"),
  ],
  [SHA1]: [
    check("validate", SHA1, "success"),
    check("verify-artifact", SHA1, "success"),
  ],
};

Deno.test("review rounds are accounting: a spent clean head is reviewed again, never parked", async () => {
  const rig = await capRig({
    reviewRounds: 5,
    nextStep: "review",
    wait: {
      reason: "review_pending",
      since: T0 - 21 * 60_000,
      until: T0 - 60_000,
    },
    reservations: reviewCharges("issue-1", 5),
    reviews: [completedReceipt(5, SHA3, "clean")],
  });
  const outcome = await rig.run();
  assert.equal(outcome.status, "idle", JSON.stringify(outcome));
  const work = await rig.work();
  assert.notEqual(work.nextStep, "blocked", JSON.stringify(work.blocker));
  assert.equal(work.blocker, null);
  assert.equal(work.counters.reviewRounds, 6, "the next round is counted");
  assert.equal(
    rig.github.reviewRequestIdentities.length,
    1,
    "the sixth review is requested",
  );
});

Deno.test("CI fix attempts are accounting: a red head past the old cap still gets its fix", async () => {
  const { rig } = await ciFirstRig("ceiling-ci-fix-unbounded", {
    hosted: false,
    retries: 3,
    attempts: 4,
    checks: RED,
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.notEqual(work.nextStep, "blocked", JSON.stringify(work.blocker));
    assert.equal(
      (work.blocker?.message ?? "").startsWith(
        "CI fix attempts exhausted (3 of 3): ",
      ),
      false,
      "the retired cap never parks the record",
    );
    assert.ok(
      isCiFixMarker(work.wait) || rig.model.requests.length > 0,
      "the red head is routed to a real fix",
    );
    assert.equal(
      rig.github.calls.includes("requestReview"),
      true,
      "the fixed head reaches review instead of parking",
    );
    assert.ok(modelCharges(after).length >= 4);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("a P0 on the current head still never merges", async () => {
  const rejected = completedReceipt(5, SHA3, "p1", { base: SHA1 });
  const p0 = {
    ...rejected,
    findings: rejected.findings.map((finding) => ({
      ...finding,
      severity: "P0" as const,
      message: "P0 finding",
    })),
    unresolvedSeverities: ["P0" as const],
  };
  const rig = await capRig({
    reviewRounds: 5,
    nextStep: "delivery",
    reservations: reviewCharges("issue-1", 5),
    reviews: [p0],
  });
  await rig.run();
  const work = await rig.work();
  const state = await rig.snapshot();
  assert.equal(rig.github.calls.includes("merge"), false);
  assert.notEqual(work.nextStep, "done");
  assert.equal(state.releaseRequests.length, 0);
});
