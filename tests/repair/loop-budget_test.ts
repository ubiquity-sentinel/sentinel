/** Durable implementation and review start accounting. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  incidentEvidence,
  incidentSummary,
  SHA2,
  SHA3,
  T0,
} from "../state/helpers.ts";
import {
  evidenceFixture,
  FINGERPRINT,
  FINGERPRINT_B,
  makeRig,
  SHA4,
  summaryFixture,
} from "./loop-rig.ts";
import { positiveLifecycle } from "./loop-candidate-fixtures.ts";

Deno.test("rolling budget caps share model starts and review requests", async () => {
  const rig = await makeRig("sharedcap", {
    configOverrides: { liveStartLimits: { perHour: 1, perSevenDays: 5 } },
    github: {
      candidateLifecycle: positiveLifecycle(),
      reviewRequestedAt: T0 + 3_600_000 + 1000,
    },
  });
  try {
    // The first task's implementation consumes the single hour-window start;
    // its review request is the same shared budget and must defer, proving
    // there is no GitHubPort budget bypass.
    const run1 = await rig.run();
    assert.equal(run1.status, "idle", JSON.stringify(run1));
    assert.equal(rig.model.requests.length, 1);
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "work");
    assert.equal(
      state.work[0].target.pr,
      7,
      "PR published before the review wait",
    );
    assert.equal(
      state.work[0].wait?.reason,
      "review_quota",
      "review-request quota deferral is the explicit transient state",
    );
    assert.ok((state.work[0].wait?.until ?? 0) > T0, "explicit retryAt");
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].purpose, "implementation");
    assert.equal(state.reservations[0].outcome, "submitted");
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      0,
      "review request is never invoked at the shared cap",
    );

    // A second distinct incident arrives while the window is full.
    rig.incidents.setSummaries([
      summaryFixture(),
      incidentSummary("inc-b", {
        fingerprint: FINGERPRINT_B,
        severity: "P2",
        failingRevision: SHA2,
        evidenceRef: {
          ref: "artifact://inbox/inc-b.pgp",
          digest: "2".repeat(64),
        },
      }),
    ]);
    rig.incidents.setEvidence([
      evidenceFixture(),
      incidentEvidence("inc-b", {
        incidentId: "inc-b",
        fingerprint: FINGERPRINT_B,
        failingRevision: SHA2,
        replay: {
          fixtureRef: "fixture://sentinel/b.json",
          fixtureDigest: "3".repeat(64) as never,
          upstreamCaptured: true,
          commandId: "replay_capture",
          reproducedAt: T0,
        },
      }),
    ]);
    const run2 = await rig.run();
    assert.equal(run2.status, "idle", JSON.stringify(run2));
    assert.equal(rig.model.requests.length, 1, "no model start at cap");
    state = await rig.snapshot();
    const second = state.work.find((record) =>
      record.fingerprint === FINGERPRINT_B
    );
    assert.ok(second, "second work record exists");
    assert.equal(second?.wait?.reason, "budget_cap");
    assert.ok((second?.wait?.until ?? 0) > T0, "explicit retryAt");
    assert.equal(state.reservations.length, 1, "no charge was ever deferred");

    // After the rolling hour the first task's review request is admitted
    // (its implementation charge fell out of the window); the single hourly
    // slot is consumed again, so the second task's implementation must defer
    // and no second model start happens.
    rig.clock.advance(3_600_000 + 1000);
    const run3 = await rig.run();
    assert.equal(run3.status, "idle", JSON.stringify(run3));
    assert.equal(
      rig.model.requests.length,
      1,
      "no second model at the shared cap",
    );
    state = await rig.snapshot();
    const firstAfter = state.work.find((record) =>
      record.fingerprint === FINGERPRINT
    );
    assert.ok(firstAfter, "first work record still exists");
    assert.equal(firstAfter?.nextStep, "review");
    assert.equal(firstAfter?.wait?.reason, "review_pending");
    const secondStill = state.work.find((record) =>
      record.fingerprint === FINGERPRINT_B
    );
    assert.equal(
      secondStill?.wait?.reason,
      "budget_cap",
      "task still deferred",
    );
    assert.equal(
      state.reservations.filter((reservation) =>
        reservation.outcome === "submitted"
      ).length,
      2,
      "implementation + review charged, one per hourly slot",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "the first review request is admitted exactly once",
    );

    // The admitted review finishes within its twenty-minute session bound.
    // Keeping it pending for another hour would request a real recovery round
    // and consume the released slot instead of testing implementation admission.
    rig.github.completeReview([], rig.clock.now() + 1000);

    // Another hour releases the slot: the second task implements and
    // publishes; its review request then defers again on the shared cap.
    rig.clock.advance(3_600_000 + 1000);
    const run4 = await rig.run();
    assert.equal(run4.status, "idle", JSON.stringify(run4));
    assert.equal(rig.model.requests.length, 2, "admission after cap release");
    state = await rig.snapshot();
    const secondAfter = state.work.find((record) =>
      record.fingerprint === FINGERPRINT_B
    );
    assert.ok(secondAfter, "second work record still exists");
    assert.equal(secondAfter?.nextStep, "work");
    assert.equal(
      secondAfter?.target.pr,
      8,
      "second PR published before its review wait",
    );
    assert.equal(secondAfter?.wait?.reason, "review_quota");
    assert.equal(
      state.reservations.filter((reservation) =>
        reservation.outcome === "submitted"
      ).length,
      3,
      "implementation + review + implementation are each charged",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "only the first review request was admitted; the second stays deferred",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("review request ambiguous/failed stays charged once and never resubmits", async () => {
  // Lost response (ambiguous submission): charged ambiguous with the intent
  // preserved; recovery observes, never resubmits, and adds no second charge.
  const rig = await makeRig("reviewlost", {
    github: {
      reviewRequestOutcome: "ambiguous",
      candidateLifecycle: positiveLifecycle(),
    },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    let state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].wait?.reason, "review_pending");
    assert.equal(state.work[0].intent?.kind, "review_request");
    assert.equal(state.work[0].intent?.pr, 7, "exact PR binding");
    assert.equal(
      state.work[0].intent?.expectedHead,
      SHA3,
      "exact head binding",
    );
    assert.equal(
      state.reviews.length,
      0,
      "a lost acknowledgement never fabricates a completed verdict",
    );
    assert.equal(state.reservations.length, 2);
    const review = state.reservations.find((reservation) =>
      reservation.purpose === "review_request"
    );
    assert.ok(review, "review admission reservation exists");
    assert.equal(review?.outcome, "ambiguous");
    assert.ok(review?.settledAt !== null, "ambiguous charge is settled");
    const ambiguousBytes = canonicalStringify(review);
    const savedIntent = state.work[0].intent;

    // Recovery observes the exact remote review state: no resubmission, no
    // second charge. The actual observation request is bound to the saved
    // operation/PR/head instead of trusting the fixture.
    const observe = rig.github.observeReview.bind(rig.github);
    let observedKey: string | null = null;
    let observedPr: number | null = null;
    let observedHead: GitSha | null = null;
    rig.github.observeReview = (request) => {
      const bound = request as {
        operationKey: string;
        prNumber: number;
        head: GitSha;
      };
      observedKey = bound.operationKey;
      observedPr = bound.prNumber;
      observedHead = bound.head;
      return observe(request);
    };
    rig.clock.advance(15 * 60_000 + 1);
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
      "observation never resubmits",
    );
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].intent?.kind, "review_request");
    assert.equal(state.work[0].intent?.expectedHead, SHA3);
    assert.equal(
      state.reviews.length,
      0,
      "pending observation is not a verdict",
    );
    assert.equal(state.reservations.length, 2, "no second review charge");
    assert.equal(observedKey, savedIntent?.key, "exact saved operation");
    assert.equal(observedPr, savedIntent?.pr, "exact saved PR");
    assert.equal(observedHead, savedIntent?.expectedHead, "exact saved head");
    assert.equal(
      canonicalStringify(
        state.reservations.find((entry) => entry.id === review?.id),
      ),
      ambiguousBytes,
      "the original ambiguous reservation is unchanged",
    );

    // The pending observation ends in the normal accepted flow.
    rig.clock.advance(15 * 60_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    const third = await rig.run();
    assert.equal(third.status, "idle", JSON.stringify(third));
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "delivery");
  } finally {
    await rig.ctx.cleanup();
  }

  // Transport loss immediately after admission: identical one-charge
  // recovery; the saved observation intent is never resubmitted.
  const rig2 = await makeRig("reviewfail", {
    github: {
      reviewRequestFailNext: true,
      candidateLifecycle: positiveLifecycle(),
    },
  });
  try {
    const first = await rig2.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(
      rig2.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    const state = await rig2.snapshot();
    assert.equal(state.work[0].nextStep, "review");
    assert.equal(state.work[0].intent?.kind, "review_request");
    assert.equal(state.reservations.length, 2);
    const review = state.reservations.find((reservation) =>
      reservation.purpose === "review_request"
    );
    assert.equal(review?.outcome, "ambiguous");
    assert.ok(review?.settledAt !== null);
    const ambiguousBytes = canonicalStringify(review);
    const savedIntent = state.work[0].intent;

    // The restart observes exactly the saved operation/PR/head and leaves the
    // original ambiguous reservation byte-identical.
    const observe = rig2.github.observeReview.bind(rig2.github);
    let observedKey: string | null = null;
    let observedPr: number | null = null;
    let observedHead: GitSha | null = null;
    rig2.github.observeReview = (request) => {
      const bound = request as {
        operationKey: string;
        prNumber: number;
        head: GitSha;
      };
      observedKey = bound.operationKey;
      observedPr = bound.prNumber;
      observedHead = bound.head;
      return observe(request);
    };

    rig2.clock.advance(15 * 60_000 + 1);
    const second = await rig2.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig2.github.calls.filter((call) => call === "requestReview").length,
      1,
      "never resubmits",
    );
    const restarted = await rig2.snapshot();
    assert.equal(
      restarted.reservations.length,
      2,
      "no second charge",
    );
    assert.equal(observedKey, savedIntent?.key, "exact saved operation");
    assert.equal(observedPr, savedIntent?.pr, "exact saved PR");
    assert.equal(observedHead, savedIntent?.expectedHead, "exact saved head");
    assert.equal(
      canonicalStringify(
        restarted.reservations.find((entry) => entry.id === review?.id),
      ),
      ambiguousBytes,
      "the original ambiguous reservation is unchanged",
    );
  } finally {
    await rig2.ctx.cleanup();
  }
});

Deno.test(
  "review receipt: a completed observation is recorded even after its wait was cleared",
  async () => {
    const rig = await makeRig("clearedwait", {
      model: { heads: [SHA3, SHA4] },
      github: { candidateLifecycle: positiveLifecycle() },
    });
    try {
      // Run 1: the candidate reaches the review wait, which persists the
      // durable review-request reservation for this round.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "review");
      assert.equal(state.reservations.length, 2, "review is charged");

      // A bounded recovery cleared the wait while the review was completing,
      // so the record carries no wait to quote and its updatedAt is LATER than
      // the completion. The receipt must still be built from the reservation.
      // The finding is a P0, the one severity that still rejects a head
      // (owner directive 2026-10-24), so the recorded receipt drives a
      // correction.
      rig.github.completeReview([{
        id: "finding-1",
        severity: "P0",
        path: "src/app.ts",
        message: "required fix",
        fingerprint: "a".repeat(64),
        resolved: false,
        resolutionEvidence: null,
      }], rig.clock.now());
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") return;
      rig.clock.advance(5 * 60_000);
      const cleared = {
        ...read.value.snapshot.work[0]!,
        wait: null,
        updatedAt: rig.clock.now(),
      };
      const written = await rig.store.writeRepair({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: rig.clock.now(),
        work: [cleared],
      }, read.value.head);
      assert.ok(
        written.ok && written.value.status === "applied",
        JSON.stringify(written),
      );

      rig.clock.advance(15 * 60_000 + 1);
      const second = await rig.run();
      assert.equal(second.status, "idle", JSON.stringify(second));
      const after = await rig.snapshot();
      const record = after.work[0]!;
      // The settled observation was recorded instead of being re-armed
      // forever: the receipt is durable and the task continues to a correction
      // that carries the exact finding.
      assert.ok(
        record.evidence.some((ref) =>
          ref.kind === "review_receipt" && ref.ref.includes("review-receipt:")
        ),
        "the completed review is recorded as a receipt",
      );
      // The recorded finding drove a correction in the SAME run: a fresh
      // implementation ran with the finding, published a new head and
      // requested its review, so the task is back at `review`.
      assert.equal(record.nextStep, "review");
      assert.equal(record.target.head, SHA4, "corrected candidate head");
      assert.equal(record.counters.reviewRounds, 2, "fresh correction round");
      assert.equal(rig.model.requests.length, 2);
      assert.deepEqual(rig.model.requests[1]?.reviewFindings, [{
        severity: "P0",
        path: "src/app.ts",
        message: "required fix",
      }]);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
