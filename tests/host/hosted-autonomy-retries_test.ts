import { SHA1 as ATTEMPT_RUNTIME } from "../state/helpers.ts";
import assert from "node:assert/strict";
import {
  applyHostedRetries,
  HOSTED_AUTONOMY_MAX_RETRIES,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  finding,
  HEAD,
  selfTips,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

Deno.test(
  "hosted autonomy: a transient blocker is retried with a closed grant and a preserved budget",
  () => {
    const record = blockedRecord({
      counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()], [], [
      reservation("r-1", {
        taskId: TARGET,
        head: BASE,
        attempt: 1,
        purpose: "implementation",
        outcome: "submitted",
        settledAt: T0 + 2000,
      }),
      reservation("r-2", {
        taskId: TARGET,
        head: BASE,
        attempt: 2,
        purpose: "implementation",
        outcome: "ambiguous",
        settledAt: T0 + 2000,
      }),
    ]);
    const plans = planHostedRetries(
      snapshot,
      T0 + 5000,
      ATTEMPT_RUNTIME,
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].id, TARGET);
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].reviewRounds, null);
    const next = applyHostedRetries(snapshot, SHA1, plans, T0 + 5000);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "work");
    assert.equal(applied.blocker, null);
    // The preserved counters are history: only the attempt ceiling moves.
    assert.equal(applied.counters.retries, 0);
    assert.equal(applied.counters.attempts, 2);
    assert.equal(applied.counters.reviewRounds, 1);
    assert.equal(next.reservations.length, 2);
    assert.equal(next.sequence, snapshot.sequence + 1);
  },
);

Deno.test(
  "hosted autonomy: the retry budget is closed and non-transient blockers are untouched",
  () => {
    // The cap's unit is durable reservations (every purpose and outcome,
    // including one still `reserved`), not the preserved `retries` counter.
    const capFixture = (count: number) =>
      repairSnapshot(
        [
          blockedRecord({
            counters: { attempts: 2, retries: 0, reviewRounds: 1 },
          }),
        ],
        [authorizingReceipt()],
        [],
        Array.from({ length: count }, (_, index) =>
          reservation(`cap-${index + 1}`, {
            taskId: TARGET,
            head: BASE,
            attempt: index + 1,
            purpose: "continuation",
            outcome: index % 2 === 0 ? "reserved" : "submitted",
            settledAt: index % 2 === 0 ? null : T0 + 2000,
          })),
      );
    // One reservation below the cap still permits a grant; the cap is closed.
    assert.equal(
      planHostedRetries(
        capFixture(HOSTED_AUTONOMY_MAX_RETRIES - 1),
        T0 + 5000,
        ATTEMPT_RUNTIME,
      ).length,
      1,
    );
    assert.equal(
      planHostedRetries(
        capFixture(HOSTED_AUTONOMY_MAX_RETRIES),
        T0 + 5000,
        ATTEMPT_RUNTIME,
      )
        .length,
      0,
    );

    const reviewRounds = repairSnapshot([
      blockedRecord({
        blocker: {
          kind: "review_quota",
          message:
            "review rounds exhausted without an accepted verdict (structured review unavailable)",
          since: T0 + 3000,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 14 },
      }),
    ]);
    // Every review identity inside the runtime's own round allowance is spent
    // at this head, and the preserved counter is history: without a newer base
    // this pass fails closed instead of zeroing a charged counter or re-using
    // an identity the runtime would refuse as a duplicate.
    assert.equal(
      planHostedRetries(reviewRounds, T0 + 5000, ATTEMPT_RUNTIME).length,
      0,
    );
    const plans = planHostedRetries(
      reviewRounds,
      T0 + 5000,
      ATTEMPT_RUNTIME,
      selfTips(SHA1),
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "review");
    assert.equal(plans[0].advanceBase, true);
    assert.equal(plans[0].reviewRounds, 14);
    const next = applyHostedRetries(reviewRounds, SHA1, plans, T0 + 5000);
    assert.equal(next.work[0].nextStep, "review");
    assert.equal(next.work[0].counters.reviewRounds, 14);

    const budget = repairSnapshot([
      blockedRecord({
        blocker: {
          kind: "review_quota",
          message: "implementation attempt budget exhausted",
          since: T0 + 3000,
        },
        counters: { attempts: 4, retries: 0, reviewRounds: 1 },
      }),
    ]);
    const budgetPlans = planHostedRetries(
      budget,
      T0 + 5000,
      ATTEMPT_RUNTIME,
    );
    assert.equal(budgetPlans.length, 1);
    assert.equal(budgetPlans[0].grant, 0);
    const budgetNext = applyHostedRetries(budget, SHA1, budgetPlans, T0 + 5000);
    assert.equal(budgetNext.work[0].counters.attempts, 4);

    const foreign = repairSnapshot([
      blockedRecord({
        blocker: {
          kind: "missing_evidence",
          message: "something else entirely",
          since: T0 + 3000,
        },
      }),
    ]);
    assert.equal(
      planHostedRetries(foreign, T0 + 5000, ATTEMPT_RUNTIME).length,
      0,
    );
  },
);

Deno.test(
  "hosted autonomy: a wedged attempt budget advances the base through the runtime's own refresh intent",
  () => {
    // The live shape: attempts 4, retries 3, one review round spent, and every
    // attempt identity at the old base already charged. Incrementing `retries`
    // here used to make every grant invalid; the preserved counter now stays
    // put and only the attempt ceiling is lowered.
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 3, reviewRounds: 1 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    // The loop charges attempt 1 as `implementation` and every later attempt as
    // `retry`, so these are the identities a real base carries.
    const charges = [1, 2, 3, 4].map((attempt) =>
      reservation(`r-${attempt}`, {
        taskId: TARGET,
        head: BASE,
        attempt,
        purpose: attempt === 1 ? "implementation" : "retry",
        outcome: "submitted",
        settledAt: T0 + 2000,
      })
    );
    const p1Receipt = authorizingReceipt({
      findings: [finding("P1")],
      unresolvedSeverities: ["P1"],
    });
    const snapshot = repairSnapshot(
      [record],
      [p1Receipt],
      [],
      charges,
    );
    const now = T0 + 5000;
    // A fresh monotonic identity exists even at the same unchanged base.
    assert.equal(
      planHostedRetries(snapshot, now, ATTEMPT_RUNTIME, selfTips(BASE)).length,
      1,
    );
    // With a newer base the runtime's own refresh gives fresh identities.
    const newerBase = SHA1;
    const plans = planHostedRetries(
      snapshot,
      now,
      ATTEMPT_RUNTIME,
      selfTips(newerBase),
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].advanceBase, true);
    assert.equal(plans[0].grant, 0);
    assert.equal(plans[0].observedBase, newerBase);
    const next = applyHostedRetries(snapshot, SHA1, plans, now);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "work");
    assert.equal(applied.blocker, null);
    // Charged counters, retries and review rounds are untouched history.
    assert.equal(applied.counters.attempts, 4);
    assert.equal(applied.counters.retries, 3);
    assert.equal(applied.counters.reviewRounds, 1);
    assert.deepEqual(applied.target, record.target);
    assert.deepEqual(applied.evidence, record.evidence);
    assert.deepEqual(next.evidence, snapshot.evidence);
    assert.deepEqual(next.reviews, snapshot.reviews);
    assert.deepEqual(next.reservations, snapshot.reservations);
    assert.equal(
      applied.target.base,
      BASE,
      "the refresh advances the base, not this pass",
    );
    assert.ok(
      applied.intent !== null && applied.intent.kind === "base_refresh",
    );
    assert.equal(applied.intent?.expectedHead, HEAD);
    assert.equal(applied.intent?.observedBase, newerBase);
    assert.equal(applied.intent?.pr, 51);
    assert.equal(
      applied.intent?.key,
      `base_refresh:51:${HEAD}:${newerBase}`,
    );
    assert.equal(next.reservations.length, 4);
  },
);

Deno.test(
  "hosted autonomy: monotonic retry allocation preserves retries equal to attempts",
  () => {
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 4, reviewRounds: 1 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()]);
    // Keeping both counters at 4 preserves retries <= attempts and selects 5.
    assert.equal(
      planHostedRetries(snapshot, T0 + 5000, ATTEMPT_RUNTIME).length,
      1,
    );
    assert.equal(
      planHostedRetries(snapshot, T0 + 5000, ATTEMPT_RUNTIME, selfTips(SHA1))
        .length,
      1,
    );
    const next = applyHostedRetries(snapshot, SHA1, [], T0 + 5000);
    assert.equal(next.work[0].counters.attempts, 4);
    assert.equal(next.work[0].counters.retries, 4);
  },
);

/** The runtime's exact diagnosed candidate ref-identity blocker message. */
