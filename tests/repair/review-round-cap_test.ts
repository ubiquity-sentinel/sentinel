/**
 * Hard review-round ceiling (owner decision 2026-10-16: "44 rounds is insane,
 * 3 round max"): no path of the real repair loop requests or records a fourth
 * review round, and a capped record parks with its PR, head and charges kept.
 *
 * The loops reproduce how live ai.ubq.fi records passed three rounds: 684 /
 * PR 1059 (no-verdict journals re-requested on the same head and, after a
 * base move, on the refreshed head: 50 rounds), and 698 / 880 (a base that
 * moved after every clean review, before the merge landed: 9 rounds). Each of
 * them exceeds three rounds without the ceiling.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { candidateBranch, reviewOperationKey } from "../../src/repair/keys.ts";
import { REVIEW_BOUND_MS } from "../../src/repair/loop-bounds.ts";
import { isModelStartAction } from "../../src/repair/loop-eligibility.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop.ts";
import { ciCorrectionShape } from "../../src/repair/ci-rejection.ts";
import { conflictResolutionShape } from "../../src/repair/conflict-resolution.ts";
import { TASK_ACCEPTANCE_MISSING_DETAIL } from "../../src/repair/review-gate.ts";
import { isDeliverableReviewRoundCeilingPark } from "../../src/repair/review-round-cap.ts";
import { isGatewayVpsRepository } from "../../src/repair/vps-delivery.ts";
import { deliveryEligible } from "../../ops/hosted-autonomy-policy.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { check, ciRig, TASK } from "./ci-correction-rig.ts";
import {
  assertParked,
  CAP_BASE_MOVED,
  CAP_PREFIX,
  CAP_REJECTED,
  CAP_UNACCEPTED,
  CAP_UNREVIEWED,
  capRig,
  type CapRigV1,
  completedReceipt,
  MINUTE,
  PR,
  reviewCharges,
  sha,
  withDerivedIds,
} from "./review-round-cap-rig.ts";

const ID = "issue-1";
const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

function reviewWait(since: number) {
  return { reason: "review_pending" as const, since, until: since + MINUTE };
}

/**
 * A completed receipt of `head` rejected by one unresolved P0 finding. Owner
 * directive 2026-10-24 ("the only internal policy is resolve all P0"): only an
 * unresolved P0 rejects a head; the rig's own "p1" verdict is a clean review
 * under that rule.
 */
function rejectedReceipt(round: number, head: GitSha) {
  const receipt = completedReceipt(round, head, "p1");
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

/** Parked is final for the runtime: later runs and base moves change nothing. */
async function assertStaysParked(rig: CapRigV1) {
  const parked = await rig.snapshot();
  const calls = {
    requests: rig.github.requests,
    pushes: rig.github.pushes.length,
    refreshes: rig.github.refreshes,
    merges: rig.github.merges,
    models: rig.model.requests.length,
  };
  rig.github.remoteBase = sha(0x7777);
  await runs(rig, 2);
  assert.deepEqual(await rig.snapshot(), parked, "a park is never rewritten");
  assert.deepEqual({
    requests: rig.github.requests,
    pushes: rig.github.pushes.length,
    refreshes: rig.github.refreshes,
    merges: rig.github.merges,
    models: rig.model.requests.length,
  }, calls);
}

Deno.test("round cap: a reviewer that never returns a verdict gets exactly three charged rounds on one head", async () => {
  const rig = await capRig();
  rig.github.reviewMode = "no_verdict";
  await runs(rig, 7);
  assert.equal(
    rig.github.requests,
    3,
    `no fourth review is requested (${rig.github.requests} requested)`,
  );
  const work = await assertParked(rig, CAP_UNREVIEWED);
  assert.equal(work.counters.reviewRounds, 3);
  assert.equal(work.intent, null, "no refresh intent");
  const charges = await rig.charges();
  assert.deepEqual(charges.map((row) => row.attempt).sort(), [1, 2, 3]);
  assert.ok(
    charges.every((row) => row.outcome === "submitted"),
    "every charge stays submitted; nothing is refunded",
  );
  assert.equal(rig.github.pushes.length, 1, "only the first publication");
  assert.equal(rig.model.requests.length, 0);
  assert.equal(rig.github.merges, 0, "no merge without an accepted verdict");
  await assertStaysParked(rig);
});

Deno.test("round cap: no-verdict rounds interleaved with base moves stop at three (the 684 shape)", async () => {
  const rig = await capRig();
  rig.github.reviewMode = "no_verdict";
  await runs(rig, 10, (run) => {
    if (run % 2 === 1) rig.github.remoteBase = sha(0x3000 + run);
  });
  assert.equal(
    rig.github.requests,
    3,
    `no fourth review is requested (${rig.github.requests} requested)`,
  );
  const charges = await rig.charges();
  assert.equal(charges.length, 3);
  const work = await rig.work();
  assert.equal(work.nextStep, "blocked", JSON.stringify(work.blocker));
  assert.equal(work.blocker?.message, CAP_UNREVIEWED);
  assert.equal(work.intent, null, "no base_refresh intent at the ceiling");
  assert.equal(work.target.pr, PR);
  assert.equal(
    work.target.head,
    charges.find((row) => row.attempt === 3)!.head,
    "the head the last round was charged for is kept",
  );
  await assertStaysParked(rig);
});

Deno.test("round cap: a base that moves after every clean review stops at three and parks BASE_MOVED", async () => {
  const rig = await capRig();
  const heads: GitSha[] = [];
  for (let move = 0; move < 6; move++) {
    await runs(rig, 2);
    heads.push((await rig.work()).target.head!);
    rig.github.remoteBase = sha(0x2000 + move);
  }
  await runs(rig, 2);
  assert.equal(
    rig.github.requests,
    3,
    `no fourth review is requested (${rig.github.requests} requested)`,
  );
  assert.equal(
    rig.github.refreshes,
    2,
    "only the refreshes rounds 2 and 3 reviewed",
  );
  const work = await assertParked(rig, CAP_BASE_MOVED, heads[2]!);
  assert.equal(work.counters.reviewRounds, 3);
  assert.equal(work.intent, null, "no refresh intent, nothing pushed");
  assert.equal(
    rig.github.remoteBranch,
    work.target.head,
    "the PR head is the reviewed head",
  );
  assert.equal(rig.github.mergedSha, null);
  const reviews = (await rig.snapshot()).reviews;
  assert.equal(reviews.length, 3, "every completed receipt is retained");
  await assertStaysParked(rig);
});

Deno.test("round cap: a Gateway head reviewed clean three times parks BASE_MOVED as a deliverable spent park", async () => {
  // The live 599 / 684 shape: the third clean review, then the base moves
  // before the merge lands. The park is the spent-delivery rule's to merge
  // (moved-base rule); it is never handed back for another review.
  const issue = 9001;
  const rig = await capRig({
    repository: AI,
    issueNumber: issue,
    id: `issue-ubiquity-ai.ubq.fi-${issue}`,
  });
  const heads: GitSha[] = [];
  for (let move = 0; move < 4; move++) {
    await runs(rig, 2);
    heads.push((await rig.work()).target.head!);
    rig.github.remoteBase = sha(0x2000 + move);
  }
  await runs(rig, 2);
  assert.equal(rig.github.requests, 3);
  const work = await assertParked(rig, CAP_BASE_MOVED, heads[2]!);
  assert.equal(isGatewayVpsRepository(work.repository), true);
  assert.equal(isDeliverableReviewRoundCeilingPark(work), true);
  const snapshot = await rig.snapshot();
  assert.equal(deliveryEligible(work, snapshot), true);
  // Its reviewed base is the base the third clean review bound.
  const latest = snapshot.reviews.filter((review) =>
    review.pullRequest.head === work.target.head
  ).at(-1)!;
  assert.equal(latest.pullRequest.base, work.target.base);
  assert.deepEqual(latest.unresolvedSeverities, []);
  await assertStaysParked(rig);
});

Deno.test("round cap: an unchanged base still merges the third-round head (control)", async () => {
  const rig = await capRig();
  for (let move = 0; move < 2; move++) {
    await runs(rig, 2);
    rig.github.remoteBase = sha(0x2000 + move);
  }
  rig.github.mergeMode = "merged";
  await runs(rig, 3);
  assert.equal(rig.github.requests, 3);
  assert.notEqual(rig.github.mergedSha, null, "the reviewed head merged");
  const work = await rig.work();
  assert.ok(
    !(work.blocker?.message ?? "").startsWith(CAP_PREFIX),
    JSON.stringify(work.blocker),
  );
  assert.equal((await rig.snapshot()).releaseRequests.length, 1);
});

Deno.test("round cap: a stale merge intent at the ceiling on a moved base is cleared and parks", async () => {
  const rig = await capRig({
    reviewRounds: 3,
    nextStep: "delivery",
    reservations: reviewCharges(ID, 3),
    reviews: [completedReceipt(3, SHA3, "clean")],
    record: {
      intent: {
        kind: "merge",
        key: `merge:${PR}:${SHA3}`,
        startedAt: T0 - 30 * MINUTE,
        branch: "sentinel/repair/issue-1",
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: PR,
        requestId: null,
        resultId: null,
      },
    },
  });
  rig.github.remoteBase = SHA2;
  await rig.run();
  const work = await assertParked(rig, CAP_BASE_MOVED);
  assert.equal(work.intent, null, "the stale merge intent is cleared");
  assert.equal(rig.github.refreshes, 0);
  assert.equal(rig.github.pushes.length, 0);
  assert.equal(rig.github.requests, 0);
  assert.equal((await rig.charges()).length, 3);
});

Deno.test("round cap: an expired ambiguous round-4 intent (the 647 shape) is counted once and parks", async () => {
  const charges = reviewCharges(ID, 4, {
    outcome: (attempt) => attempt === 4 ? "ambiguous" : "submitted",
  });
  const startedAt = T0 - REVIEW_BOUND_MS - 10 * MINUTE;
  const rig = await capRig({
    reviewRounds: 3,
    nextStep: "review",
    wait: reviewWait(startedAt),
    reservations: charges,
    record: {
      intent: {
        kind: "review_request",
        key: reviewOperationKey(PR, SHA3, 4),
        startedAt,
        branch: "sentinel/repair/issue-1",
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: PR,
        requestId: charges[3]!.id,
        resultId: null,
      },
    },
  });
  rig.github.bind(4);
  rig.github.reviewMode = "pending";
  await runs(rig, 3);
  assert.equal(rig.github.requests, 0, "attempt 5 is never requested");
  const work = await assertParked(rig, CAP_UNREVIEWED);
  assert.equal(
    work.counters.reviewRounds,
    4,
    "the in-flight round counted once",
  );
  const after = await rig.charges();
  assert.equal(after.length, 4, "no fifth reservation");
  assert.equal(
    after.find((row) => row.attempt === 4)?.outcome,
    "ambiguous",
    "the ambiguous charge is never refunded",
  );
});

Deno.test("round cap: an in-flight attempt is still observed to its clean verdict", async () => {
  const charges = reviewCharges(ID, 4, {
    outcome: (attempt) => attempt === 4 ? "ambiguous" : "submitted",
  });
  const rig = await capRig({
    reviewRounds: 3,
    nextStep: "review",
    wait: reviewWait(T0 - MINUTE),
    reservations: charges,
    record: {
      intent: {
        kind: "review_request",
        key: reviewOperationKey(PR, SHA3, 4),
        startedAt: T0 - MINUTE,
        branch: "sentinel/repair/issue-1",
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: PR,
        requestId: charges[3]!.id,
        resultId: null,
      },
    },
  });
  rig.github.bind(4);
  rig.github.mergeMode = "merged";
  await runs(rig, 2);
  assert.equal(rig.github.requests, 0);
  assert.equal((await rig.snapshot()).reviews.length, 1);
  assert.notEqual(rig.github.mergedSha, null, "the authorized head merges");
});

Deno.test("round cap: a P0 verdict in round three parks REJECTED instead of a correction", async () => {
  const rig = await capRig({
    reviewRounds: 3,
    nextStep: "review",
    wait: reviewWait(T0 - MINUTE),
    reservations: reviewCharges(ID, 3),
  });
  rig.github.bind(3);
  rejectWithP0(rig);
  await runs(rig, 2);
  const work = await assertParked(rig, CAP_REJECTED);
  assert.equal(rig.model.requests.length, 0, "no correction model start");
  assert.equal(rig.github.requests, 0);
  const state = await rig.snapshot();
  assert.equal(state.reviews.length, 1, "the rejecting receipt is retained");
  assert.deepEqual(state.reviews[0]!.unresolvedSeverities, ["P0"]);
  assert.ok(work.evidence.some((item) => item.kind === "review_receipt"));
  assert.equal(rig.github.merges, 0, "a P0 never merges");
});

Deno.test("round cap: a P1 verdict in round three is no rejection: the reviewed head is delivered", async () => {
  // Owner directive 2026-10-24: only an unresolved P0 blocks. A completed
  // round-three verdict whose only finding is a P1 neither parks REJECTED nor
  // spends a correction: the accepted head goes to delivery and merges.
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
  assert.ok(
    !(work.blocker?.message ?? "").startsWith(CAP_PREFIX),
    JSON.stringify(work.blocker),
  );
  assert.equal(rig.model.requests.length, 0, "no correction model start");
  assert.equal(rig.github.requests, 0, "no fourth review round");
  const state = await rig.snapshot();
  assert.equal(state.reviews.length, 1, "the P1 receipt is retained");
  assert.deepEqual(state.reviews[0]!.unresolvedSeverities, ["P1"]);
  assert.equal(work.counters.reviewRounds, 3, "no round spent");
  assert.equal(work.target.head, SHA3, "the reviewed head is delivered");
  assert.notEqual(rig.github.mergedSha, null, "the P1-reviewed head merges");
  assert.equal((await rig.charges()).length, 3, "nothing more is charged");
});

Deno.test("round cap: a P0 verdict in round two still goes to its correction (control)", async () => {
  const rig = await capRig({
    reviewRounds: 2,
    nextStep: "review",
    wait: reviewWait(T0 - MINUTE),
    reservations: reviewCharges(ID, 2),
  });
  rig.github.bind(2);
  rejectWithP0(rig);
  await rig.run();
  const work = await rig.work();
  assert.ok(
    !(work.blocker?.message ?? "").startsWith(CAP_PREFIX),
    JSON.stringify(work.blocker),
  );
  assert.ok(rig.model.requests.length >= 1, "the correction starts");
});

Deno.test("round cap: a P1 verdict in round two spends no correction: the reviewed head goes to delivery", async () => {
  // Owner directive 2026-10-24: a P1 never spends a correction round, below
  // the ceiling as much as at it.
  const rig = await capRig({
    reviewRounds: 2,
    nextStep: "review",
    wait: reviewWait(T0 - MINUTE),
    reservations: reviewCharges(ID, 2),
  });
  rig.github.bind(2);
  rig.github.reviewMode = "p1";
  await rig.run();
  const work = await rig.work();
  assert.equal(work.nextStep, "delivery", JSON.stringify(work.blocker));
  assert.equal(rig.model.requests.length, 0, "no correction model start");
  assert.equal(rig.github.requests, 0, "no further review round");
  assert.equal(work.counters.reviewRounds, 2, "no round spent");
  assert.equal(work.target.head, SHA3, "the reviewed head is kept");
  const state = await rig.snapshot();
  assert.deepEqual(state.reviews[0]!.unresolvedSeverities, ["P1"]);
  assert.equal((await rig.charges()).length, 2, "nothing more is charged");
});

Deno.test("round cap: missing task acceptance at the ceiling parks UNACCEPTED, never another review", async (t) => {
  await t.step("observed in round three", async () => {
    const rig = await capRig({
      reviewRounds: 3,
      nextStep: "review",
      wait: reviewWait(T0 - MINUTE),
      reservations: reviewCharges(ID, 3),
    });
    rig.github.bind(3);
    rig.github.reviewMode = "missing_acceptance";
    await runs(rig, 2);
    assert.equal(rig.github.requests, 0, "no fourth review");
    await assertParked(rig, CAP_UNACCEPTED);
    assert.equal((await rig.snapshot()).reviews.length, 1, "receipt kept");
    assert.equal((await rig.charges()).length, 3);
  });
  await t.step(
    "the live 263 block (missing acceptance at three rounds)",
    async () => {
      const rig = await capRig({
        reviewRounds: 3,
        nextStep: "blocked",
        blocker: {
          kind: "missing_evidence",
          message: TASK_ACCEPTANCE_MISSING_DETAIL,
          since: T0 - MINUTE,
        },
        reservations: reviewCharges(ID, 3),
      });
      rig.github.bind(3);
      rig.github.reviewMode = "missing_acceptance";
      await runs(rig, 2);
      assert.equal(rig.github.requests, 0, "no fourth review");
      const work = await assertParked(rig, CAP_UNACCEPTED);
      assert.notEqual(work.blocker?.message, TASK_ACCEPTANCE_MISSING_DETAIL);
      assert.equal((await rig.charges()).length, 3);
      await assertStaysParked(rig);
    },
  );
});

Deno.test("round cap: a lowered counter (the 264 shape) is counted from the ledger", async () => {
  // Three admissions on earlier heads, counter 0: no fourth round anywhere.
  const rig = await capRig({
    reviewRounds: 0,
    reservations: reviewCharges(ID, 3, { head: SHA2 }),
  });
  await runs(rig, 3);
  assert.equal(rig.github.requests, 0);
  assert.equal(rig.github.pushes.length, 0, "nothing is published");
  await assertParked(rig, CAP_UNREVIEWED);
  assert.equal((await rig.charges()).length, 3);
});

Deno.test("round cap: a reserved admission whose intent was lost is completed below the ceiling, kept at it", async (t) => {
  await t.step(
    "below: the next request completes it, no second charge",
    async () => {
      const rig = await capRig({
        reviewRounds: 2,
        reservations: await withDerivedIds(reviewCharges(ID, 3, {
          outcome: (attempt) => attempt === 3 ? "reserved" : "submitted",
        })),
      });
      rig.github.reviewMode = "pending";
      await rig.run();
      assert.equal(rig.github.requests, 1);
      const charges = await rig.charges();
      assert.equal(charges.length, 3, "the reserved admission was completed");
      assert.equal(
        charges.find((row) => row.attempt === 3)?.outcome,
        "submitted",
      );
    },
  );
  await t.step(
    "at the ceiling: parked, the reservation stays reserved",
    async () => {
      const rig = await capRig({
        reviewRounds: 3,
        reservations: await withDerivedIds(reviewCharges(ID, 4, {
          outcome: (attempt) => attempt === 4 ? "reserved" : "submitted",
        })),
      });
      await runs(rig, 2);
      assert.equal(rig.github.requests, 0);
      await assertParked(rig, CAP_UNREVIEWED);
      const charges = await rig.charges();
      assert.equal(charges.length, 4);
      assert.equal(
        charges.find((row) => row.attempt === 4)?.outcome,
        "reserved",
        "a park never settles or refunds a charge",
      );
    },
  );
});

Deno.test("round cap: a refunded round does not consume the ceiling", async () => {
  const rig = await capRig({
    reviewRounds: 3,
    reservations: reviewCharges(ID, 3, {
      outcome: (attempt) =>
        attempt === 3 ? "confirmed_not_submitted" : "submitted",
    }),
  });
  rig.github.reviewMode = "no_verdict";
  await runs(rig, 5);
  assert.equal(
    rig.github.requests,
    1,
    "exactly the one round the refund freed",
  );
  await assertParked(rig, CAP_UNREVIEWED);
  const charges = await rig.charges();
  assert.equal(charges.length, 4);
  assert.equal(
    charges.find((row) => row.attempt === 3)?.outcome,
    "confirmed_not_submitted",
  );
});

Deno.test("round cap: the work step at the ceiling starts, pushes and opens nothing", async (t) => {
  const cases = [
    {
      name: "no candidate yet",
      head: null,
      reviews: [],
      message: CAP_UNREVIEWED,
      pr: null,
    },
    {
      name: "a head rejected by a P0 review",
      head: SHA3,
      reviews: [rejectedReceipt(3, SHA3)],
      message: CAP_REJECTED,
      pr: PR,
    },
    {
      // Owner directive 2026-10-24: a P1-only verdict is no rejection; this
      // change-only one lacks a task acceptance, so the head parks UNACCEPTED.
      name: "a head whose only finding is a P1, without a task acceptance",
      head: SHA3,
      reviews: [completedReceipt(3, SHA3, "p1")],
      message: CAP_UNACCEPTED,
      pr: PR,
    },
    {
      name: "a closed pull request awaiting its replacement",
      head: SHA3,
      reviews: [],
      message: CAP_UNREVIEWED,
      pr: null,
    },
  ] as const;
  for (const item of cases) {
    await t.step(item.name, async () => {
      const rig = await capRig({
        reviewRounds: 3,
        head: item.head,
        reservations: reviewCharges(ID, 3),
        reviews: [...item.reviews],
        record: item.head !== null && item.pr === null
          ? {
            target: {
              base: SHA1,
              branch: "sentinel/repair/issue-1",
              checkpoint: null,
              head: SHA3,
              pr: null,
            },
          }
          : {},
      });
      await runs(rig, 2);
      assert.equal(rig.model.requests.length, 0, "no implementation start");
      assert.equal(rig.github.requests, 0);
      assert.equal(rig.github.pushes.length, 0, "nothing is pushed");
      assert.equal(
        rig.github.calls.includes("createPr"),
        false,
        "no replacement pull request",
      );
      await assertParked(rig, item.message, item.head, item.pr);
    });
  }
});

Deno.test("round cap: no matrix cell, model start, CI correction or conflict resolution once no round is left", async () => {
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
      reviews: [rejectedReceipt(2, SHA3)],
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
  const below = await make(2);
  const at = await make(3);
  for (const [rig, open] of [[below, true], [at, false]] as const) {
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
      open,
      "matrix readiness",
    );
    assert.equal(isModelStartAction(snapshot, record, true, true), open);
    const clean = { ...snapshot, reviews: [] };
    assert.equal(ciCorrectionShape(record, clean), open, "CI correction");
    assert.equal(conflictResolutionShape(record, clean), open, "conflict");
  }
});

Deno.test("round cap: the historical review-ceiling block is no longer re-armed into review", async () => {
  const rig = await capRig({
    reviewRounds: 3,
    nextStep: "blocked",
    blocker: {
      kind: "review_quota",
      message:
        "review rounds exhausted without an accepted verdict (no verdict)",
      since: T0 - MINUTE,
    },
    reservations: reviewCharges(ID, 3),
  });
  const before = await rig.snapshot();
  await runs(rig, 2);
  assert.equal(rig.github.requests, 0);
  assert.deepEqual(await rig.snapshot(), before, "nothing is rewritten");
});

Deno.test("round cap: a legacy-class record gets exactly one more round once its CI fix armed it, others none", async (t) => {
  // Every seeded review charge (T0 - 10 min + attempt) precedes the cutoff.
  const CUT = T0 - MINUTE;
  const id = (issue: number) => `issue-ubiquity-ai.ubq.fi-${issue}`;
  /** The CI fix admitted at or after the cutoff that arms the final round. */
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
    reviewCharges_ = reviewCharges(id(issue), rounds, { repository: AI }),
  ) =>
    capRig({
      id: id(issue),
      issueNumber: issue,
      repository: AI,
      reviewRounds: rounds,
      reservations: [...reviewCharges_, ...extra],
      legacyReviewCutoff: CUT,
    });
  await t.step(
    "595 at its pin of 4, armed: one final request, then parked",
    async () => {
      const rig = await legacy(595, 4, [fix(595)]);
      rig.github.reviewMode = "no_verdict";
      await runs(rig, 4);
      assert.equal(rig.github.requests, 1, "exactly one final review");
      await assertParked(rig, CAP_UNREVIEWED);
      assert.equal((await rig.charges()).length, 5);
    },
  );
  await t.step("595 at its pin, never CI-fixed: no request", async () => {
    const rig = await legacy(595, 4);
    await runs(rig, 2);
    assert.equal(rig.github.requests, 0);
    await assertParked(rig, CAP_UNREVIEWED);
  });
  await t.step(
    "595 whose final round was spent after the cutoff: no request",
    async () => {
      const charges = reviewCharges(id(595), 5, { repository: AI }).map(
        (charge) =>
          charge.attempt === 5
            ? { ...charge, createdAt: CUT + 3, settledAt: CUT + 4 }
            : charge,
      );
      const rig = await legacy(595, 5, [fix(595)], charges);
      await runs(rig, 2);
      assert.equal(rig.github.requests, 0);
      await assertParked(rig, CAP_UNREVIEWED);
    },
  );
  await t.step(
    "a record whose rounds all follow the cutoff: no fourth request",
    async () => {
      const charges = reviewCharges(id(1600), 3, { repository: AI }).map(
        (charge) => ({
          ...charge,
          createdAt: CUT + charge.attempt,
          settledAt: CUT + charge.attempt + 1,
        }),
      );
      const rig = await legacy(1600, 3, [fix(1600)], charges);
      await runs(rig, 2);
      assert.equal(rig.github.requests, 0);
      await assertParked(rig, CAP_UNREVIEWED);
    },
  );
  await t.step("no cutoff handed over: nothing is legacy", async () => {
    const rig = await capRig({
      id: id(595),
      issueNumber: 595,
      repository: AI,
      reviewRounds: 4,
      reservations: [
        ...reviewCharges(id(595), 4, { repository: AI }),
        fix(595),
      ],
    });
    await runs(rig, 2);
    assert.equal(rig.github.requests, 0);
    await assertParked(rig, CAP_UNREVIEWED);
  });
});

Deno.test("round cap: rounds below the ceiling keep today's no-verdict recovery (control)", async () => {
  const rig = await capRig({
    reviewRounds: 1,
    reservations: reviewCharges(ID, 1, { head: SHA1 }),
  });
  rig.github.reviewMode = "no_verdict";
  await runs(rig, 6);
  assert.equal(rig.github.requests, 2, "rounds two and three are requested");
  await assertParked(rig, CAP_UNREVIEWED);
});

Deno.test("round cap: a CI failure with no round left by the ledger keeps its CI block, no correction", async () => {
  // Counter 2, but a third review admission is durable (on an earlier head):
  // a corrected head could never be reviewed, so no correction is charged.
  const { rig, charges } = await ciRig("round-cap-ci", {
    reviewRounds: 2,
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    const extra = reservation("round-cap-ci-review-earlier", {
      taskId: TASK,
      head: SHA2,
      attempt: 1,
      purpose: "review_request",
      outcome: "submitted",
      settledAt: T0 + 900,
    });
    const read = await rig.store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const seeded = read.value.snapshot;
    const written = await rig.store.writeRepair({
      ...seeded,
      stateHead: read.value.head,
      sequence: seeded.sequence + 1,
      reservations: [...seeded.reservations, extra],
    }, read.value.head);
    assert.ok(
      written.ok && written.value.status === "applied",
      JSON.stringify(written),
    );
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "no correction model start");
    const after = await rig.snapshot();
    const work = after.work[0]!;
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.blocker?.message, "CI checks failed: validate(failure)");
    assert.equal(work.target.pr, 7);
    assert.deepEqual(after.reservations, [...charges, extra]);
  } finally {
    await rig.ctx.cleanup();
  }
});
