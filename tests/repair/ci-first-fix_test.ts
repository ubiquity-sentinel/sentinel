/**
 * CI fixes under the owner's pipeline order (2026-10-16): a red head gets a
 * charged CI fix that never counts as a review round, at most three per
 * record (`counters.retries`), and every corrected head passes CI before its
 * next review. Each case runs the real repair loop in process over real Git
 * state with fake GitHub/model ports.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import { SHA1, SHA3, T0 } from "../state/helpers.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import {
  check,
  ciFirstRig,
  modelCharges,
  reviewCharges,
  SHA4,
  taskRecord,
} from "./ci-first-rig.ts";
import { ciRig } from "./ci-correction-rig.ts";

const SHA5 = "5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b5b" as GitSha;
const SHA6 = "6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c6c" as GitSha;
const CI_FINDING =
  /^Required CI checks failed on this candidate while the same checks passed on its base /;

function red(head: GitSha) {
  return [
    check("validate", head, "failure"),
    check("verify-artifact", head, "skipped"),
  ];
}
const GREEN_BASE = [
  check("validate", SHA1, "success"),
  check("verify-artifact", SHA1, "success"),
];

Deno.test("CI first: red -> CI fix -> green -> one review -> merge", async () => {
  const { rig } = await ciFirstRig("cf-path", {
    checks: { [SHA3]: red(SHA3), [SHA1]: GREEN_BASE },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(rig.model.requests.length, 1, "exactly one CI fix session");
    const request = rig.model.requests[0];
    assert.equal(request.checkoutBase, SHA3, "the fix continues the red head");
    assert.equal(request.base, SHA1);
    assert.match(request.reviewFindings?.[0]?.message ?? "", CI_FINDING);
    assert.match(request.reviewFindings![0].message, /validate \(failure\)/);
    let state = await rig.snapshot();
    let work = taskRecord(state);
    assert.equal(work.target.head, SHA4, "the fixed head is current");
    assert.equal(work.nextStep, "review", "the green fixed head is reviewed");
    assert.equal(work.counters.reviewRounds, 1, "the fix spent no round");
    assert.equal(work.counters.retries, 1, "one CI fix charged");
    assert.equal(work.counters.attempts, 2);
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((r) => r.expectedHead),
      [SHA4],
      "only the green head was ever reviewed",
    );
    const fix = modelCharges(state).filter((row) => row.purpose === "retry");
    assert.equal(fix.length, 1);
    assert.equal(fix[0].attempt, 2);
    assert.equal(fix[0].outcome, "submitted");

    rig.clock.advance(100_000_000 + 1);
    rig.github.completeReview([], rig.clock.now());
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "the reviewed green head merges",
    );
    state = await rig.snapshot();
    work = taskRecord(state);
    assert.equal(work.nextStep, "delivery");
    assert.equal(work.counters.reviewRounds, 1);
    assert.equal(work.counters.retries, 1);
    assert.equal(reviewCharges(state).length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

/** A completed verdict on SHA3 (round one) with one unresolved finding. */
async function verdictWithFinding(severity: "P0" | "P1") {
  return completedReceipt(7, SHA3, SHA1, {
    id: await reviewReceiptId(reviewOperationKey(7, SHA3, 1), SHA3),
    resultId: `${severity.toLowerCase()}-result`,
    findings: [{
      id: "github-review-1-finding-0",
      fingerprint: "e".repeat(64),
      severity,
      path: "src/app.ts",
      message: "the change breaks the documented contract",
      resolutionEvidence: null,
      resolved: false,
    }],
    unresolvedSeverities: [severity],
    submittedAt: T0,
    completedAt: T0 + 1000,
    observedAt: T0 + 1001,
  });
}

Deno.test("CI first: a P0 correction must pass CI before the next review", async () => {
  const rejection = await verdictWithFinding("P0");
  const { rig } = await ciFirstRig("cf-p0-red", {
    reviewRounds: 1,
    reviews: [rejection],
    heads: [SHA4, SHA5],
    checks: { [SHA4]: red(SHA4), [SHA1]: GREEN_BASE },
  });
  try {
    for (let run = 0; run < 3; run++) {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      if (rig.github.reviewRequestIdentities.length > 0) break;
      rig.clock.advance(5 * 60_000 + 1);
    }
    assert.equal(rig.model.requests.length, 2, "correction, then one CI fix");
    const [correction, fix] = rig.model.requests;
    assert.equal(correction.checkoutBase, SHA3);
    assert.match(correction.reviewFindings?.[0]?.message ?? "", /contract/);
    assert.equal(fix.checkoutBase, SHA4, "the red correction is fixed");
    assert.match(fix.reviewFindings?.[0]?.message ?? "", CI_FINDING);
    const state = await rig.snapshot();
    const work = taskRecord(state);
    assert.equal(work.target.head, SHA5);
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.reviewRounds, 2, "round 2 is the green head's");
    assert.equal(work.counters.retries, 1, "only the CI fix is a retry");
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((r) => r.expectedHead),
      [SHA5],
      "the red correction was never reviewed",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: an unresolved P1 is no rejection: the reviewed green head merges without a correction", async () => {
  // Owner directive 2026-10-24: only an unresolved P0 blocks. The same verdict
  // with a P1 is a clean current-head review: no correction session, no CI
  // fix, no further review round, and the green head is delivered.
  const verdict = await verdictWithFinding("P1");
  const { rig, charges } = await ciFirstRig("cf-p1-clean", {
    reviewRounds: 1,
    reviews: [verdict],
    heads: [SHA4, SHA5],
    checks: { [SHA4]: red(SHA4), [SHA1]: GREEN_BASE },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "no correction for a P1");
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "the P1-reviewed green head merges",
    );
    const state = await rig.snapshot();
    const work = taskRecord(state);
    assert.equal(work.target.head, SHA3, "the reviewed head is delivered");
    assert.equal(work.nextStep, "delivery");
    assert.equal(work.counters.reviewRounds, 1, "no further round");
    assert.equal(work.counters.retries, 0, "no CI fix charged");
    assert.deepEqual(
      rig.github.reviewRequestIdentities,
      [],
      "the head is never re-reviewed",
    );
    assert.deepEqual(state.reservations, charges, "nothing charged");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: three CI fixes, then a precise park and no fourth charge", async () => {
  const { rig } = await ciFirstRig("cf-three", {
    heads: [SHA4, SHA5, SHA6],
    checks: {
      [SHA3]: red(SHA3),
      [SHA4]: red(SHA4),
      [SHA5]: red(SHA5),
      [SHA6]: red(SHA6),
      [SHA1]: GREEN_BASE,
    },
  });
  try {
    for (let run = 0; run < 8; run++) {
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      if (taskRecord(await rig.snapshot()).nextStep === "blocked") break;
      rig.clock.advance(5 * 60_000 + 1);
    }
    const state = await rig.snapshot();
    const work = taskRecord(state);
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      "CI fix attempts exhausted (3 of 3): validate(failure)",
    );
    assert.equal(work.target.head, SHA6);
    assert.equal(work.target.pr, 7, "the PR is kept for the coordinator");
    assert.equal(work.counters.retries, 3);
    assert.equal(work.counters.reviewRounds, 0, "no fix spent a round");
    assert.equal(rig.model.requests.length, 3, "exactly three fixes");
    assert.equal(modelCharges(state).length, 4, "1 implementation + 3 fixes");
    assert.equal(reviewCharges(state).length, 0, "no red head is reviewed");
    assert.equal(rig.github.calls.includes("requestReview"), false);
    // Later runs never spend anything on the parked record.
    rig.clock.advance(24 * 60 * 60_000);
    await rig.run();
    assert.equal(rig.model.requests.length, 3);
    assert.deepEqual((await rig.snapshot()).reservations, state.reservations);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a reviewed head whose CI fixes are spent gets the exhausted park at the merge gate", async () => {
  const { rig, charges } = await ciRig("cf-merge-exhausted", {
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: [check("validate", SHA1, "success")],
    },
  });
  try {
    // Three fixes already spent on this record.
    const seeded = await rig.snapshot();
    const head = await rig.store.readRepair();
    assert.ok(head.ok && head.value.status === "found");
    const record = seeded.work[0];
    const written = await rig.store.writeRepair({
      ...seeded,
      stateHead: head.value.head,
      sequence: seeded.sequence + 1,
      work: [{
        ...record,
        counters: { attempts: 4, retries: 3, reviewRounds: 1 },
      }],
    }, head.value.head);
    assert.ok(written.ok && written.value.status === "applied");
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "no fourth fix");
    const after = await rig.snapshot();
    assert.equal(after.work[0].nextStep, "blocked");
    assert.equal(
      after.work[0].blocker?.message,
      "CI fix attempts exhausted (3 of 3): validate(failure)",
    );
    assert.equal(rig.github.calls.includes("merge"), false, "never merged");
    assert.deepEqual(after.reservations, charges, "nothing charged");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a marked head that turned green is reviewed without a fix or a charge", async () => {
  // The launcher (under a fix runtime) or an earlier run left the CI fix
  // marker; the admission re-reads live CI first and spends nothing.
  const { rig, charges } = await ciFirstRig("cf-marker-green", {
    wait: { reason: "backoff", since: T0, until: T0 },
    checks: {},
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(rig.model.requests.length, 0, "no fix for a green head");
    const state = await rig.snapshot();
    const work = taskRecord(state);
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.retries, 0, "nothing charged as a fix");
    assert.equal(work.counters.reviewRounds, 1);
    assert.deepEqual(
      rig.github.reviewRequestIdentities.map((r) => r.expectedHead),
      [SHA3],
    );
    assert.deepEqual(
      modelCharges(state),
      modelCharges({
        ...state,
        reservations: charges,
      }),
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first: a marked head whose base turned red backs off uncharged", async () => {
  const { rig, charges } = await ciFirstRig("cf-marker-basered", {
    wait: { reason: "backoff", since: T0, until: T0 },
    checks: {
      [SHA3]: red(SHA3),
      [SHA1]: [
        check("validate", SHA1, "failure"),
        check("verify-artifact", SHA1, "success"),
      ],
    },
  });
  try {
    await rig.run();
    assert.equal(rig.model.requests.length, 0);
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.nextStep, "work");
    assert.equal(work.wait?.reason, "backoff");
    assert.equal(work.wait!.until! - work.wait!.since, 30 * 60_000);
    assert.equal(work.counters.retries, 0);
    assert.deepEqual(after.reservations, charges);
  } finally {
    await rig.ctx.cleanup();
  }
});
