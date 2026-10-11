/** Bounded no-verdict review retry and transient transport recovery. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import {
  candidateBranch,
  reviewOperationKey,
  reviewReceiptId,
} from "../../src/repair/keys.ts";
import { SHA1, SHA3, workRecord } from "../state/helpers.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";
import {
  noVerdictObservation,
  rigAtReviewWait,
} from "./loop-review-fixtures.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

Deno.test(
  "review no-verdict: one bounded re-attempt is requested under its own attempt identity",
  async () => {
    const { rig, work } = await rigAtReviewWait("review-no-verdict-retry");
    try {
      const reason =
        "structured review unavailable: the runtime terminal was not completed";
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewStatus = "unavailable";
      rig.github.reviewObservations = noVerdictObservation(
        work.target.head!,
        reason,
        rig.clock.now() - 1000,
      );
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      const state = await rig.snapshot();
      const record = state.work[0]!;
      // A fresh round is a fresh bounded attempt of the SAME head: charged,
      // recorded and awaiting its own review.
      assert.equal(record.nextStep, "review");
      assert.equal(record.wait?.reason, "review_pending");
      assert.equal(record.counters.reviewRounds, 2);
      assert.equal(record.target.head, work.target.head);
      assert.equal(record.blocker, null);
      assert.equal(
        rig.github.reviewRequestIdentities.length,
        2,
        "the rejected head keeps exactly one request per attempt",
      );
      assert.equal(
        rig.github.reviewRequestIdentities[0]!.operationKey,
        `review:7:${work.target.head}`,
      );
      assert.equal(
        rig.github.reviewRequestIdentities[1]!.operationKey,
        `review:7:${work.target.head}:attempt-2`,
      );
      const reviewCharges = state.reservations.filter((reservation) =>
        reservation.purpose === "review_request"
      );
      assert.equal(reviewCharges.length, 2);
      // State reservation order is not a chronology; the durable attempt
      // identity is what proves each round was charged on its own.
      assert.deepEqual(
        reviewCharges.map((reservation) => reservation.attempt).sort(),
        [1, 2],
        "each attempt carries its own durable charge identity",
      );
      assert.ok(
        reviewCharges.every((reservation) =>
          reservation.outcome === "submitted"
        ),
      );

      // The re-attempt is a REAL review of the same head: when it completes
      // with an accepted verdict, the recorded receipt is bound to the exact
      // identity it was read under, so a later delivery can never be
      // authorized by the earlier attempt's receipt.
      const attemptKey = `review:7:${work.target.head}:attempt-2`;
      const completedAt = rig.clock.now() + 1000;
      rig.github.reviewObservationsByKey.set(attemptKey, {
        status: "completed",
        requestId: `review-${attemptKey}`,
        reviewer: rig.github.reviewerIdentity,
        resultId: "result-attempt-2",
        completedAt,
        observedHead: work.target.head!,
        observedBase: record.target.base,
        findings: [],
        summary: "No actionable defects found in the supplied change.",
        receivedAt: completedAt + 1,
        taskAcceptance: null,
      });
      rig.clock.advance(15 * 60_000 + 1);
      await rig.run();
      const delivered = await rig.snapshot();
      const deliveredRecord = delivered.work[0]!;
      const receiptId = await reviewReceiptId(
        attemptKey,
        work.target.head!,
      );
      assert.ok(
        deliveredRecord.evidence.some((ref) =>
          ref.ref === `artifact:review-receipt/${receiptId}`
        ),
        "the accepted verdict is recorded under the identity it was read at",
      );
      const receipt = delivered.reviews.find((review) =>
        review.id === receiptId
      );
      assert.ok(receipt !== undefined, "the receipt is durable");
      assert.equal(receipt.requestId, `review-${attemptKey}`);
      assert.equal(receipt.outcome, "completed");
      assert.equal(receipt.resultId, "result-attempt-2");
      assert.equal(receipt.completedAt, completedAt);
      assert.deepEqual(receipt.unresolvedSeverities, []);
      assert.equal(receipt.pullRequest.head, work.target.head);
      assert.equal(receipt.pullRequest.base, record.target.base);
      assert.equal(deliveredRecord.nextStep, "delivery");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "review no-verdict: the retired round allowance does not authorize or block the task",
  async () => {
    const { rig, work } = await rigAtReviewWait("review-no-verdict-blocked");
    try {
      const reason =
        "structured review unavailable: the review reported insufficient evidence";
      // Three no-verdict attempts remain charged after the ceiling is retired.
      rig.clock.advance(15 * 60_000 + 1);
      for (let round = 0; round < 2; round += 1) {
        rig.github.reviewStatus = "unavailable";
        rig.github.reviewObservations = noVerdictObservation(
          work.target.head!,
          reason,
          rig.clock.now() - 1000,
        );
        await rig.run();
        rig.clock.advance(15 * 60_000 + 1);
      }
      let state = await rig.snapshot();
      assert.equal(state.work[0]!.counters.reviewRounds, 3);
      const requestsBefore = rig.github.reviewRequestIdentities.length;
      const chargesBefore = structuredClone(state.reservations);
      const implementationsBefore = rig.model.requests.length;

      const continued = await rig.run();
      assert.equal(continued.status, "idle", JSON.stringify(continued));
      state = await rig.snapshot();
      const record = state.work[0]!;
      assert.equal(record.nextStep, "review");
      assert.equal(record.blocker, null);
      assert.equal(record.wait?.reason, "review_pending");
      assert.equal(record.counters.reviewRounds, 4);
      assert.equal(record.target.head, work.target.head);
      assert.equal(
        rig.github.reviewRequestIdentities.length,
        requestsBefore + 1,
      );
      assert.equal(
        rig.github.reviewRequestIdentities.at(-1)!.operationKey,
        reviewOperationKey(7, work.target.head!, 4),
      );
      assert.equal(state.reservations.length, chargesBefore.length + 1);
      for (const charge of chargesBefore) {
        assert.deepEqual(
          state.reservations.find((item) => item.id === charge.id),
          charge,
        );
      }
      const added = state.reservations.filter((charge) =>
        !chargesBefore.some((prior) => prior.id === charge.id)
      );
      assert.equal(added[0]!.purpose, "review_request");
      assert.equal(added[0]!.attempt, 4);
      assert.equal(added[0]!.outcome, "submitted");
      assert.equal(added[0]!.head, work.target.head);
      assert.equal(rig.model.requests.length, implementationsBefore);
      assert.equal(rig.github.calls.includes("merge"), false);
      assert.equal(
        rig.github.calls.some((call) => call.startsWith("closeIssue:")),
        false,
      );
      assert.equal(state.releaseRequests.length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "review no-verdict: a first-attempt journal stays observable under its legacy identity",
  async () => {
    const { rig, work } = await rigAtReviewWait("review-no-verdict-legacy");
    try {
      const head = work.target.head!;
      const reason =
        "structured review unavailable: the owned session was closed before completion";
      // The persisted record of a review requested BEFORE attempt identities
      // existed: round two is already consumed while its one durable journal
      // is bound only under the original first-attempt key.
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") return;
      const legacyRecord = {
        ...read.value.snapshot.work[0]!,
        counters: { ...work.counters, reviewRounds: 2 },
        wait: null,
      };
      const rewritten = await rig.store.writeRepair({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: rig.clock.now(),
        work: [legacyRecord],
      }, read.value.head);
      assert.ok(
        rewritten.ok && rewritten.value.status === "applied",
        JSON.stringify(rewritten),
      );
      rig.clock.advance(15 * 60_000 + 1);
      rig.github.reviewStatus = "unavailable";
      rig.github.unboundReviewKeys.add(`review:7:${head}:attempt-2`);
      rig.github.reviewObservationsByKey.set(
        `review:7:${head}`,
        noVerdictObservation(head, reason, rig.clock.now() - 1000),
      );
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      const state = await rig.snapshot();
      const record = state.work[0]!;
      // The legacy journal was observed, so exactly one re-attempt was
      // requested instead of waiting forever on an unobservable identity.
      assert.deepEqual(rig.github.observedReviewKeys, [
        `review:7:${head}:attempt-2`,
        `review:7:${head}`,
      ]);
      assert.equal(record.counters.reviewRounds, 3);
      assert.equal(record.nextStep, "review");
      assert.equal(
        rig.github.reviewRequestIdentities[1]!.operationKey,
        `review:7:${head}:attempt-3`,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Retired PR WIP: the hosted retirement disposition must free a real WIP slot
// for the ACTUAL loop, not only for a pure helper. These cases seed durable
// state with records parked through the actual applyHostedRetirements and then
// run the real repair cycle over real temporary Git state.
// ---------------------------------------------------------------------------

Deno.test(
  "review wait: a reviewer that never posts a verdict stays transient and never blocks",
  async () => {
    const rig = await makeRig("review-budget", {
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      // Run 1: the repair reaches the review wait with its request submitted.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      let state = await rig.snapshot();
      const pending = state.work[0];
      assert.equal(pending.nextStep, "review");
      assert.equal(pending.wait?.reason, "review_pending");
      const since = pending.wait?.since;
      assert.ok(typeof since === "number", "the pending baseline is recorded");

      // One poll still under the budget re-arms the wait and preserves the
      // FIRST pending instant, so the bound is total wall-clock.
      const budget = 4 * 60 * 60_000;
      const elapsed = rig.clock.now() - since;
      rig.clock.advance(budget - elapsed - 60_000);
      const under = await rig.run();
      assert.equal(under.status, "idle", JSON.stringify(under));
      state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "review", "still waiting");
      assert.equal(state.work[0].wait?.reason, "review_pending");
      assert.equal(state.work[0].wait?.since, since, "baseline preserved");

      // Crossing the budget is a TRANSIENT review unavailability, not a
      // terminal review failure: the explicit quota/awaiting state is re-armed
      // and the publication is never parked by a silent reviewer.
      rig.clock.advance(17 * 60_000);
      const over = await rig.run();
      assert.equal(over.status, "idle", JSON.stringify(over));
      state = await rig.snapshot();
      const stillWaiting = state.work[0];
      assert.equal(stillWaiting.nextStep, "review");
      assert.equal(
        stillWaiting.blocker,
        null,
        "a missing verdict never terminally blocks",
      );
      assert.equal(stillWaiting.wait?.reason, "review_pending");
      assert.equal(stillWaiting.wait?.since, since, "baseline preserved");
      assert.equal(stillWaiting.target.head, SHA3, "the candidate is retained");
      assert.equal(rig.model.requests.length, 1, "no new model work");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "transient review transport failure is re-armed as review_quota and never terminally blocks",
  async () => {
    const taskId = asWorkItemId("issue-quota");
    const branch = candidateBranch(taskId);
    const rig = await makeRig("review-quota", {
      summaries: false,
      github: {
        reviewUnavailable: true,
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: SHA3 },
          pullRequests: [exactOpenPr(7, SHA3, branch)],
        },
      },
    });
    try {
      const seeded = await rig.store.writeRepair(
        seededSnapshot([
          workRecord("issue-quota", {
            source: { kind: "issue", id: "900", revision: SHA1 },
            related: { incidentId: null, issueNumber: 900 },
            target: {
              base: SHA1,
              branch,
              checkpoint: null,
              head: SHA3,
              pr: 7,
            },
            nextStep: "review",
            wait: null,
          }),
        ]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const record = state.work[0];
      assert.equal(
        record.nextStep,
        "review",
        "a transient transport failure never parks the publication",
      );
      assert.equal(record.blocker, null, "no terminal blocker is written");
      assert.equal(
        record.wait?.reason,
        "review_quota",
        "the explicit transient review state is re-armed",
      );
      assert.equal(
        record.target.pr,
        7,
        "the published PR identity is retained for the drain",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "mergePr").length,
        0,
        "nothing merges without an accepted review",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
