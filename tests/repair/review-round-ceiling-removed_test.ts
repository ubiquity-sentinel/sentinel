/**
 * Owner directive 2026-10-30: a spent review-round count or CI-fix count is
 * accounting, never a permanent park. The runtime keeps iterating until the
 * current head has a completed review with no P0 (or another blocker applies);
 * a P0 on the current head still never merges.
 */
import assert from "node:assert/strict";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import { lineStanding } from "../../src/repair/delivery-queue.ts";
import {
  currentHeadReviewTerminal,
  reviewedHeadCarried,
  reviewRoundsLeft,
} from "../../src/repair/review-round-cap.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import { REPO, SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import {
  capRig,
  completedReceipt,
  PR,
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
  // Drives the rejection through the REVIEW step: a pending request at the
  // current head whose observed verdict leaves a P0 unresolved. The review
  // advances to its correction and delivery's merge gate is never reached.
  const rig = await capRig({
    reviewRounds: 5,
    nextStep: "review",
    // A poll that is due now, inside the attempt's own 20-minute bound, so
    // the step observes the standing request instead of re-requesting it.
    wait: { reason: "review_pending", since: T0 - 10 * 60_000, until: T0 - 1 },
    reservations: reviewCharges("issue-1", 5),
  });
  rig.github.reviewMode = "p0";
  rig.github.bind(5);
  const outcome = await rig.run();
  assert.equal(outcome.status, "idle", JSON.stringify(outcome));
  assert.ok(
    rig.github.observedReviewKeys.includes(reviewOperationKey(PR, SHA3, 5)),
    "the review step observed the in-flight verdict",
  );
  const work = await rig.work();
  const state = await rig.snapshot();
  const receipt = state.reviews.find((review) =>
    review.pullRequest.head === SHA3 &&
    review.unresolvedSeverities.includes("P0")
  );
  assert.ok(receipt, "the P0 verdict is a persisted current-head receipt");
  assert.equal(rig.github.calls.includes("merge"), false, "never merged");
  assert.equal(work.nextStep, "work", "it advances to its correction");
  assert.equal(work.blocker, null);
  assert.notEqual(work.nextStep, "done");
  assert.equal(state.releaseRequests.length, 0);
});

Deno.test("a cleanly reviewed head is deliverable whatever its count: no consumer reads a zero round", () => {
  // P1 regression (native review round 2): a head holding its completed
  // accepted review used to make `reviewRoundsLeft` zero, and every consumer
  // that reads zero as "no round left" refused it (conflict resolution, the
  // launcher's conflict grant, the delivery line's standings).
  const record = workRecord("issue-1", {
    repository: REPO,
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1",
      checkpoint: null,
      head: SHA3,
      pr: PR,
    },
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: 5 },
  });
  const snapshot = {
    work: [record],
    reservations: reviewCharges("issue-1", 5, { repository: REPO }),
    reviews: [completedReceipt(5, SHA3, "clean", { base: SHA1 })],
    releaseRequests: [],
  };
  assert.ok(
    reviewRoundsLeft(snapshot as never, record) > 0,
    "a spent count is never a zero round",
  );
  assert.equal(currentHeadReviewTerminal(snapshot as never, record), true);
  assert.equal(reviewedHeadCarried(snapshot as never, record), true);
  // The delivery line's own reading: reviewed, on a moved base, deliverable
  // now ("ready") instead of "reviewed"/"waiting", which held its refresh.
  assert.equal(
    lineStanding(
      snapshot as never,
      record,
      SHA2,
      T0,
      null,
    ),
    "ready",
  );
});
