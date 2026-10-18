/**
 * JAM B6 (absorbing): a completed review whose task acceptance is
 * `not_fulfilled` (and that left no P0/P1) is corrected exactly like a P0/P1
 * finding while a review round is left (B6a), and parks once, explicitly and
 * owner-gated, when none is (B6b). The review receipt keeps the reviewer's
 * acceptance verdict verbatim and carries its statement as one bounded P1
 * finding, so every P0/P1 consumer (correction, round cap, merge gates, the
 * matrix consumer and the rollback target R80) treats it as one.
 */
import assert from "node:assert/strict";
import { asFindingFingerprint } from "../../src/contracts/brands.ts";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import type { ReviewTaskAcceptanceV1 } from "../../src/contracts/review-receipt.ts";
import { MaxItems } from "../../src/contracts/validation.ts";
import {
  acceptanceFinding,
  acceptanceFindingMessage,
  TASK_ACCEPTANCE_FINDING_ID,
  TASK_ACCEPTANCE_FINDING_MAX_CHARS,
  TASK_ACCEPTANCE_FINDING_PREFIX,
  TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
  withAcceptanceFinding,
} from "../../src/repair/acceptance-correction.ts";
import {
  reviewEvidenceRef,
  reviewOperationKey,
  reviewReceiptId,
} from "../../src/repair/keys.ts";
import {
  correctionFindings,
  headAwaitsCiCorrection,
  headNeedsCorrection,
  MAX_CORRECTION_FINDING_CHARS,
} from "../../src/repair/loop-review-records.ts";
import { isMatrixImplementationReadyV1 } from "../../src/repair/loop-eligibility.ts";
import { repairConfigs } from "./helpers.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import { acceptanceRig, NOT_FULFILLED } from "./acceptance-fixtures.ts";
import {
  acceptedObservation,
  completedReceipt,
} from "./loop-review-fixtures.ts";

Deno.test("B6a: a not-fulfilled acceptance with a round left becomes a correction like a P0/P1 finding", async () => {
  const rig = await acceptanceRig("b6a-correction", 1);
  try {
    const key = rig.operationKey;
    await rig.run();
    const state = await rig.snapshot();
    const work = state.work[0]!;
    assert.notEqual(work.nextStep, "blocked", JSON.stringify(work.blocker));
    const id = await reviewReceiptId(key, SHA2);
    const receipt = state.reviews.find((review) => review.id === id);
    assert.ok(receipt, "the refusing receipt is durable evidence");
    assert.deepEqual(receipt.taskAcceptance, NOT_FULFILLED, "verbatim");
    assert.deepEqual(receipt.unresolvedSeverities, ["P1"]);
    assert.equal(receipt.findings.length, 1);
    const finding = receipt.findings[0]!;
    assert.equal(finding.severity, "P1");
    assert.equal(finding.path, null);
    assert.equal(finding.resolved, false);
    for (const line of NOT_FULFILLED.evidence) {
      assert.ok(finding.message.includes(line), finding.message);
    }
    assert.ok(
      work.evidence.some((ref) =>
        ref.kind === "review_receipt" && ref.ref === reviewEvidenceRef(id)
      ),
    );
    // Exactly one correction session, from the refused head, carrying the
    // acceptance statement as its first finding.
    assert.equal(rig.model.requests.length, 1);
    const request = rig.model.requests[0]!;
    assert.equal(request.checkoutBase, SHA2);
    assert.deepEqual(request.reviewFindings?.[0], {
      severity: "P1",
      path: null,
      message: finding.message,
    });
    assert.equal(rig.github.calls.includes("merge"), false);
    assert.equal(
      rig.github.calls.some((call) => call.startsWith("closeIssue:")),
      false,
    );
    assert.equal(state.releaseRequests.length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("B6b: a not-fulfilled acceptance with every round spent parks once, owner-gated, with its receipt", async () => {
  const rig = await acceptanceRig("b6b-owner-gate", 3);
  try {
    const key = rig.operationKey;
    await rig.run();
    const state = await rig.snapshot();
    const work = state.work[0]!;
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.blocker?.kind, "other");
    assert.equal(
      work.blocker?.message,
      TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
    );
    const id = await reviewReceiptId(key, SHA2);
    const receipt = state.reviews.find((review) => review.id === id);
    assert.ok(receipt, "the park keeps its receipt");
    assert.deepEqual(receipt.unresolvedSeverities, ["P1"]);
    assert.equal(rig.model.requests.length, 0, "no fourth round is bought");
    assert.equal(rig.github.reviewRequestIdentities.length, 0);
    assert.deepEqual(
      state.reservations,
      rig.charges,
      "nothing charged or refunded",
    );
    assert.equal(rig.github.calls.includes("merge"), false);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("B6: the live round shapes move (576, 653, 660 correct; 611, 1127, 118 park owner-gated)", async (t) => {
  // Counted rounds of the live records at sequence 41474.
  const shapes: [string, number, "correct" | "park"][] = [
    ["653", 1, "correct"],
    ["576 and 660", 2, "correct"],
    ["611 and 1127", 3, "park"],
    ["118", 22, "park"],
  ];
  for (const [label, rounds, outcome] of shapes) {
    await t.step(`${label}: ${rounds} round(s) spent`, async () => {
      const rig = await acceptanceRig(`b6-live-${rounds}`, rounds, true);
      try {
        await rig.run();
        const state = await rig.snapshot();
        const work = state.work[0]!;
        const receiptId = await reviewReceiptId(rig.operationKey, SHA2);
        const receipt = state.reviews.find((review) => review.id === receiptId);
        assert.ok(receipt);
        assert.deepEqual(receipt.unresolvedSeverities, ["P1"]);
        if (outcome === "correct") {
          // A hosted run leaves the correction to the planner's cell.
          assert.equal(work.nextStep, "work");
          assert.equal(work.blocker, null);
          assert.equal(work.target.head, SHA2);
          assert.equal(headNeedsCorrection(state, work, true, true), true);
          assert.equal(headAwaitsCiCorrection(state, work, true), false);
          assert.equal(
            isMatrixImplementationReadyV1(
              work,
              state,
              repairConfigs({
                sessionBound: {
                  maxDurationMs: 240_000,
                  maxOutputChars: 200_000,
                },
              })[0],
              rig.clock.now(),
              true,
              true,
              true,
            ),
            true,
          );
          assert.equal(
            correctionFindings(state, work)?.[0]?.message,
            receipt.findings[0]!.message,
          );
        } else {
          assert.equal(work.nextStep, "blocked");
          assert.equal(
            work.blocker?.message,
            TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
          );
        }
        assert.equal(work.counters.reviewRounds, rounds);
        const byId = (a: { id: string }, b: { id: string }) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        assert.deepEqual(state.reservations, [...rig.charges].sort(byId));
        assert.equal(rig.github.reviewRequestIdentities.length, 0);
      } finally {
        await rig.ctx.cleanup();
      }
    });
  }
});

Deno.test("B6a: the correction keeps the three-round cap; a third not-fulfilled verdict parks owner-gated", async () => {
  const rig = await acceptanceRig("b6a-cap", 2);
  try {
    await rig.run();
    const corrected = await rig.snapshot();
    const work = corrected.work[0]!;
    assert.equal(rig.model.requests.length, 1, "one correction session");
    const head = work.target.head!;
    assert.notEqual(head, SHA2);
    assert.equal(work.nextStep, "review", JSON.stringify(work));
    assert.equal(work.counters.reviewRounds, 3, "the third round reviews it");
    const third = reviewOperationKey(7, head, 3);
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((row) => row.operationKey),
      [third],
    );
    rig.github.reviewObservationsByKey.set(third, {
      ...acceptedObservation(head, NOT_FULFILLED, rig.clock.now() + 1000),
      requestId: "review-req-3",
      resultId: "result-3",
    });
    rig.clock.advance(15 * 60_000 + 1);
    await rig.run();
    const state = await rig.snapshot();
    const parked = state.work[0]!;
    assert.equal(parked.nextStep, "blocked");
    assert.equal(parked.blocker?.message, TASK_ACCEPTANCE_OWNER_GATE_DETAIL);
    assert.equal(parked.counters.reviewRounds, 3);
    assert.equal(rig.model.requests.length, 1, "no correction after the cap");
    assert.equal(rig.github.reviewRequestIdentities.length, 1, "no 4th round");
    assert.equal(
      state.reservations.filter((row) => row.purpose === "review_request")
        .length,
      3,
    );
    assert.equal(
      state.reservations.some((row) =>
        row.outcome === "confirmed_not_submitted"
      ),
      false,
      "nothing refunded",
    );
    assert.equal(rig.github.calls.includes("merge"), false);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("acceptance finding: bounded, verbatim beside the reviewer's findings, and never doubled", async () => {
  const long: ReviewTaskAcceptanceV1 = {
    ...NOT_FULFILLED,
    evidence: Array.from({ length: 4 }, (_, index) => `${index}`.repeat(1024)),
  };
  assert.equal(TASK_ACCEPTANCE_FINDING_MAX_CHARS, MAX_CORRECTION_FINDING_CHARS);
  const message = acceptanceFindingMessage(long);
  assert.equal(message.length, MAX_CORRECTION_FINDING_CHARS);
  assert.ok(message.startsWith(TASK_ACCEPTANCE_FINDING_PREFIX));
  assert.ok(message.endsWith(" [statement truncated]"));
  const short = acceptanceFindingMessage(NOT_FULFILLED);
  assert.ok(short.length < MAX_CORRECTION_FINDING_CHARS);
  assert.ok(short.includes("source issue #1"));
  const finding = await acceptanceFinding(NOT_FULFILLED);
  assert.equal(finding.id, TASK_ACCEPTANCE_FINDING_ID);
  assert.equal(
    finding.fingerprint,
    await canonicalStringifySha256({
      id: finding.id,
      severity: "P1",
      path: null,
      message: finding.message,
    }),
  );
  const p3 = {
    id: "github-review-9-finding-0",
    severity: "P3" as const,
    path: "src/app.ts",
    message: "nit",
    fingerprint: asFindingFingerprint("c".repeat(64)),
    resolved: false,
    resolutionEvidence: null,
  };
  const base = completedReceipt(7, SHA2, SHA1, {
    findings: [p3],
    unresolvedSeverities: ["P3"],
    taskAcceptance: NOT_FULFILLED,
  });
  const corrected = await withAcceptanceFinding(base);
  assert.ok(corrected);
  assert.deepEqual(corrected.findings, [finding, p3]);
  assert.deepEqual(corrected.unresolvedSeverities, ["P1", "P3"]);
  assert.deepEqual(corrected.taskAcceptance, NOT_FULFILLED);
  assert.equal(corrected.id, base.id);
  assert.equal(await withAcceptanceFinding(corrected), null, "never doubled");
  assert.equal(
    await withAcceptanceFinding({
      ...base,
      taskAcceptance: { ...NOT_FULFILLED, verdict: "uncertain" },
    }),
    null,
  );
  const full = {
    ...base,
    findings: Array.from({ length: MaxItems.findings }, (_, index) => ({
      ...p3,
      id: `github-review-9-finding-${index}`,
    })),
  };
  assert.equal(await withAcceptanceFinding(full), null, "no room: owner gate");
});

Deno.test("B6a: an earlier change-only receipt of the same head never outvotes the later not-fulfilled verdict", async () => {
  // The missing-acceptance recovery re-reviews the SAME head, so the head
  // carries the change-only receipt of round 1 (clean, no acceptance) and the
  // not-fulfilled verdict of round 2. Whichever the state lists first, the
  // later verdict rejects the head: otherwise the clean receipt reads as a
  // head awaiting a CI correction whose green exit returns it to `review`,
  // whose re-observation corrects it again, without end.
  for (const first of [true, false]) {
    const rig = await acceptanceRig(`b6a-dual-${first}`, 2);
    try {
      const seeded = await rig.snapshot();
      const clean = completedReceipt(7, SHA2, SHA1, {
        id: first ? "review-receipt:0" : "review-receipt:z",
        requestId: "review-req-0",
        resultId: "result-0",
        taskAcceptance: null,
        repository: seeded.work[0]!.repository,
      });
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const written = await rig.store.writeRepair(
        {
          ...seeded,
          stateHead: read.value.head,
          sequence: seeded.sequence + 1,
          reviews: [clean],
        },
        read.value.head,
      );
      assert.ok(written.ok && written.value.status === "applied", first + "");
      const outcome = await rig.run();
      const after = await rig.snapshot();
      assert.equal(
        rig.model.requests.length,
        1,
        `first=${first} ${JSON.stringify(outcome)} seq=${after.sequence} step=${
          after.work[0]!.nextStep
        }`,
      );
      assert.ok(
        rig.model.requests[0]!.reviewFindings?.[0]?.message.startsWith(
          TASK_ACCEPTANCE_FINDING_PREFIX,
        ),
      );
      assert.equal(rig.model.requests[0]!.checkoutBase, SHA2);
    } finally {
      await rig.ctx.cleanup();
    }
  }
});
