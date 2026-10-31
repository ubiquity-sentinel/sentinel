/**
 * Review rounds are accounting, never a permanent park (owner directive
 * 2026-10-30). The retired ceiling used to stop every path at three or five
 * rounds and park the record with one of the fixed `review round ceiling
 * reached:` messages. The runtime now keeps iterating (review -> fix ->
 * review) until the current head holds a completed review with no unresolved
 * P0, or a different blocker applies; the counters and the durable ledger
 * still record every round and every charge.
 *
 * The loops reproduce how live ai.ubq.fi records passed three rounds: 684 /
 * PR 1059 (no-verdict journals re-requested on the same head and, after a
 * base move, on the refreshed head) and 698 / 880 (a base that moved after
 * every clean review). Neither shape may park on its round count.
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { isModelStartAction } from "../../src/repair/loop-eligibility.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop.ts";
import { ciCorrectionShape } from "../../src/repair/ci-rejection.ts";
import { conflictResolutionShape } from "../../src/repair/conflict-resolution.ts";
import { REVIEW_ROUND_CEILING_PREFIX } from "../../src/repair/review-round-cap.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { check, TASK } from "./ci-correction-rig.ts";
import {
  capRig,
  type CapRigV1,
  completedReceipt,
  MINUTE,
  PR,
  reviewCharges,
  sha,
  withDerivedIds,
} from "./review-round-cap-rig.ts";
import { ciRig } from "./ci-correction-rig.ts";

const ID = "issue-1";
const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

function reviewWait(since: number) {
  return { reason: "review_pending" as const, since, until: since + MINUTE };
}

async function runs(
  rig: CapRigV1,
  count: number,
  between?: (n: number) => void,
) {
  for (let run = 0; run < count; run++) {
    await rig.run();
    between?.(run);
    rig.clock.advance(16 * MINUTE);
  }
}

/** No retired ceiling message may ever be written by these paths. */
function assertNotCeilingParked(work: { blocker: { message: string } | null }) {
  assert.equal(
    (work.blocker?.message ?? "").startsWith(REVIEW_ROUND_CEILING_PREFIX),
    false,
    `a spent count never parks: ${work.blocker?.message}`,
  );
}

Deno.test("round cap: a reviewer that never returns a verdict keeps getting rounds", async () => {
  const rig = await capRig();
  rig.github.reviewMode = "no_verdict";
  await runs(rig, 7);
  assert.equal(
    rig.github.requests,
    7,
    `every run requests another round (${rig.github.requests} requested)`,
  );
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(work.nextStep, "review");
  assert.equal(work.counters.reviewRounds, 7, "the counter is accounting");
  assert.equal(work.intent, null);
  const charges = await rig.charges();
  assert.equal(charges.length, 7);
  assert.ok(
    charges.every((row) => row.outcome === "submitted"),
    "every charge stays submitted; nothing is refunded",
  );
  assert.equal(rig.github.pushes.length, 0, "the published head is kept");
  assert.equal(rig.github.remoteBranch, SHA3);
  assert.equal(rig.model.requests.length, 0);
  assert.equal(rig.github.merges, 0, "no merge without an accepted verdict");
});

Deno.test("round cap: no-verdict rounds interleaved with base moves keep iterating (the 684 shape)", async () => {
  const rig = await capRig();
  rig.github.reviewMode = "no_verdict";
  await runs(rig, 10, (run) => {
    if (run % 2 === 1) rig.github.remoteBase = sha(0x3000 + run);
  });
  assert.equal(rig.github.requests, 10);
  assert.equal((await rig.charges()).length, 10);
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(work.nextStep, "review");
  assert.equal(work.counters.reviewRounds, 10);
  assert.equal(work.intent, null);
  assert.equal(work.target.pr, PR);
  assert.equal(rig.github.merges, 0);
});

Deno.test("round cap: a P0 on the current head at a spent count goes to its correction, never merges", async () => {
  const rig = await capRig({
    reviewRounds: 3,
    nextStep: "review",
    wait: reviewWait(T0 - MINUTE),
    reservations: reviewCharges(ID, 3),
  });
  rig.github.bind(3);
  rejectWithP0(rig);
  await runs(rig, 2);
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.ok(rig.model.requests.length >= 1, "the correction starts");
  assert.equal(work.nextStep, "work");
  assert.equal(rig.github.merges, 0, "a P0 never merges");
  const state = await rig.snapshot();
  assert.equal(state.reviews.length, 1, "the rejecting receipt is retained");
  assert.deepEqual(state.reviews[0]!.unresolvedSeverities, ["P0"]);
  assert.ok(work.evidence.some((item) => item.kind === "review_receipt"));
});

Deno.test("round cap: missing task acceptance at a spent count keeps requesting reviews", async () => {
  const rig = await capRig({
    reviewRounds: 3,
    nextStep: "review",
    wait: reviewWait(T0 - MINUTE),
    reservations: reviewCharges(ID, 3),
  });
  rig.github.bind(3);
  rig.github.reviewMode = "missing_acceptance";
  await runs(rig, 2);
  assert.equal(rig.github.requests, 2, "no acceptance: another round");
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(work.nextStep, "review");
  assert.equal((await rig.snapshot()).reviews.length, 2, "receipts kept");
  assert.equal((await rig.charges()).length, 5);
});

Deno.test("round cap: a lowered counter (the 264 shape) is counted from the ledger, never parked", async () => {
  const rig = await capRig({
    reviewRounds: 0,
    reservations: reviewCharges(ID, 3, { head: SHA2 }),
  });
  await runs(rig, 3);
  assert.equal(rig.github.requests, 1, "a fresh round is requested");
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(work.counters.reviewRounds, 1);
  assert.equal((await rig.charges()).length, 4);
});

Deno.test("round cap: a reserved admission whose intent was lost is completed, never parked", async () => {
  const rig = await capRig({
    reviewRounds: 3,
    reservations: await withDerivedIds(reviewCharges(ID, 4, {
      outcome: (attempt) => attempt === 4 ? "reserved" : "submitted",
    })),
  });
  rig.github.reviewMode = "pending";
  await rig.run();
  assert.equal(rig.github.requests, 1);
  const charges = await rig.charges();
  assert.equal(charges.length, 4, "the reserved admission was completed");
  assert.equal(
    charges.find((row) => row.attempt === 4)?.outcome,
    "submitted",
    "the next request completes the reservation instead of charging",
  );
  assertNotCeilingParked(await rig.work());
});

Deno.test("round cap: a refunded round is accounting, not a ceiling", async () => {
  const rig = await capRig({
    reviewRounds: 3,
    reservations: reviewCharges(ID, 3, {
      outcome: (attempt) =>
        attempt === 3 ? "confirmed_not_submitted" : "submitted",
    }),
  });
  rig.github.reviewMode = "no_verdict";
  await runs(rig, 5);
  assert.equal(rig.github.requests, 5, "every run requests a round");
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(work.counters.reviewRounds, 8);
  const charges = await rig.charges();
  assert.equal(charges.length, 8);
  assert.equal(
    charges.find((row) => row.attempt === 3)?.outcome,
    "confirmed_not_submitted",
    "the refund is kept exactly",
  );
});

Deno.test("round cap: a P1-only verdict is no rejection: the reviewed head is delivered", async () => {
  // Owner directive 2026-10-24: only an unresolved P0 blocks. A completed
  // verdict whose only finding is a P1 neither parks nor spends a correction.
  const rig = await capRig({
    reviewRounds: 3,
    nextStep: "review",
    wait: reviewWait(T0 - MINUTE),
    reservations: reviewCharges(ID, 3),
  });
  rig.github.bind(3);
  rig.github.reviewMode = "p1";
  rig.github.mergeMode = "merged";
  await runs(rig, 2);
  const work = await rig.work();
  assertNotCeilingParked(work);
  assert.equal(rig.model.requests.length, 0, "no correction model start");
  assert.equal(rig.github.requests, 0, "no further review round");
  const state = await rig.snapshot();
  assert.equal(state.reviews.length, 1, "the P1 receipt is retained");
  assert.deepEqual(state.reviews[0]!.unresolvedSeverities, ["P1"]);
  assert.equal(work.counters.reviewRounds, 3, "no round spent");
  assert.equal(work.target.head, SHA3, "the reviewed head is delivered");
  assert.notEqual(rig.github.mergedSha, null, "the P1-reviewed head merges");
});

Deno.test("round cap: the work step starts a spent record instead of parking it", async (t) => {
  const rejected = (() => {
    const receipt = completedReceipt(3, SHA3, "p1");
    return {
      ...receipt,
      findings: receipt.findings.map((finding) => ({
        ...finding,
        severity: "P0" as const,
        message: "P0 finding",
      })),
      unresolvedSeverities: ["P0" as const],
    };
  })();
  for (
    const item of [
      { name: "no candidate yet", reviews: [] },
      { name: "a head rejected by a P0 review", reviews: [rejected] },
    ]
  ) {
    await t.step(item.name, async () => {
      const rig = await capRig({
        reviewRounds: 3,
        head: item.reviews.length === 0 ? null : SHA3,
        reservations: reviewCharges(ID, 3),
        reviews: [...item.reviews],
      });
      await runs(rig, 2);
      const work = await rig.work();
      assertNotCeilingParked(work);
      assert.ok(rig.model.requests.length >= 1, "the work step starts");
      assert.notEqual(work.nextStep, "blocked");
      assert.equal(rig.github.merges, 0);
    });
  }
});

Deno.test("round cap: no matrix cell, model start, CI correction or conflict resolution is gated by a spent count", async () => {
  const preserved = {
    operationKey: `impl:${"a".repeat(64)}`,
    base: SHA1,
    head: SHA3,
    ref: `refs/heads/sentinel-candidates/${"b".repeat(64)}`,
  };
  const make = (ledgerRounds: number) =>
    capRig({
      reviewRounds: 2,
      reservations: reviewCharges(ID, ledgerRounds, { head: SHA2 }),
      reviews: [p0Receipt()],
      record: {
        target: {
          base: SHA1,
          branch: candidateBranch(TASK),
          checkpoint: null,
          head: SHA3,
          pr: PR,
          candidateState: { preserved, publishedHead: SHA3 },
        },
      },
    });
  for (const ledgerRounds of [2, 3]) {
    const rig = await make(ledgerRounds);
    const snapshot = await rig.snapshot();
    const record = snapshot.work[0]!;
    const config = rig.deps.configs[0]!;
    assert.equal(
      isMatrixImplementationReadyV1(
        record,
        snapshot,
        config,
        rig.clock.now(),
        true,
        true,
      ),
      true,
      `matrix readiness at ${ledgerRounds} rounds`,
    );
    assert.equal(isModelStartAction(snapshot, record, true, true), true);
    const clean = { ...snapshot, reviews: [] };
    assert.equal(ciCorrectionShape(record, clean), true, "CI correction");
    assert.equal(conflictResolutionShape(record, clean), true, "conflict");
  }
});

Deno.test("round cap: a CI failure at a spent count still starts its correction", async () => {
  const { rig } = await ciRig("round-cap-ci", {
    reviewRounds: 3,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.ok(rig.model.requests.length >= 1, "the correction model start");
    const work = (await rig.snapshot()).work[0]!;
    assertNotCeilingParked(work);
    assert.notEqual(
      work.blocker?.message ?? "",
      "CI checks failed: validate(failure)",
      "the red head is corrected instead of keeping the CI block",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("round cap: a legacy record keeps iterating past its old final round", async (t) => {
  // Every seeded review charge precedes the cutoff, so the record is legacy.
  const CUT = T0 - MINUTE;
  const id = (issue: number) => `issue-ubiquity-ai.ubq.fi-${issue}`;
  const fix = (issue: number) =>
    reservation(`${id(issue)}-ci-fix`, {
      repository: AI,
      taskId: id(issue),
      attempt: 2,
      head: SHA3,
      purpose: "retry",
      outcome: "submitted",
      createdAt: CUT + 1,
      settledAt: CUT + 2,
    });
  const legacy = (
    issue: number,
    rounds: number,
    extra: BudgetReservationV1[] = [],
  ) =>
    capRig({
      id: id(issue),
      issueNumber: issue,
      repository: AI,
      reviewRounds: rounds,
      reservations: [
        ...reviewCharges(id(issue), rounds, { repository: AI }),
        ...extra,
      ],
      legacyReviewCutoff: CUT,
    });
  await t.step("armed final round: reviews keep coming", async () => {
    const rig = await legacy(595, 4, [fix(595)]);
    rig.github.reviewMode = "no_verdict";
    await runs(rig, 4);
    assert.equal(rig.github.requests, 4, "the retired pin bounds nothing");
    assertNotCeilingParked(await rig.work());
  });
  await t.step(
    "never CI-fixed: the ordinary round is still reviewed",
    async () => {
      const rig = await legacy(595, 4);
      await runs(rig, 2);
      assert.equal(rig.github.requests, 1);
      const work = await rig.work();
      assertNotCeilingParked(work);
      assert.equal(work.counters.reviewRounds, 5);
    },
  );
});

function p0Receipt() {
  const receipt = completedReceipt(2, SHA3, "p1");
  return {
    ...receipt,
    findings: receipt.findings.map((finding) => ({
      ...finding,
      severity: "P0" as const,
      message: "P0 finding",
    })),
    unresolvedSeverities: ["P0" as const],
  };
}

/** Script the fake's live verdict as a rejection: one unresolved P0 finding. */
function rejectWithP0(rig: CapRigV1): void {
  rig.github.reviewMode = "p1";
  const observe = rig.github.observeReview.bind(rig.github);
  rig.github.observeReview = async (request: unknown) => {
    const observed = await observe(request);
    if (!observed.ok) return observed;
    return portOk({
      ...observed.value,
      findings: observed.value.findings.map((finding) => ({
        ...finding,
        severity: "P0" as const,
        message: "P0 finding",
      })),
    });
  };
}
