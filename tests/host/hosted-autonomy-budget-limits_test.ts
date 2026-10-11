import assert from "node:assert/strict";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  chargedAttempts,
  deliveryRecord,
  finding,
  HEAD,
  pullFacts,
  selfTips,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  readRequests,
  repairSnapshot,
  run,
} from "./hosted-autonomy-rig.ts";

Deno.test(
  "hosted autonomy: a parked reviewed head whose review budget is spent is still delivered",
  async () => {
    // The runtime advances to a correction round for ANY unresolved finding,
    // so a P2-only verdict parks a record in `work`/`blocked`. Once every
    // review round is spent that correction can never become a verdict, and
    // the receipt in hand is the only honest basis for delivery.
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 1, reviewRounds: 3 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const receipt = authorizingReceipt({
      findings: [finding("P2")],
      unresolvedSeverities: ["P2"],
    });
    const { rig, github } = await makeRig("autonomy-parked-delivery", {
      repair: repairSnapshot([record], [receipt]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      afterMerge: pullFacts(),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 1);
    assert.equal(result.status, "applied");
    assert.ok(result.actions.some((action) => action.startsWith("merge:")));
    assert.equal((await readRequests(rig)).length, 1);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: a parked head with a review round left is never delivered early",
  async () => {
    const record = deliveryRecord({
      nextStep: "work",
      blocker: null,
      counters: { attempts: 2, retries: 1, reviewRounds: 1 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const { rig, github } = await makeRig("autonomy-parked-early", {
      repair: repairSnapshot([record], [authorizingReceipt()]),
      pull: pullFacts({ state: "open", merged: false, mergeCommitSha: null }),
      afterMerge: pullFacts(),
    });
    const result = await run(rig, github);
    assert.equal(rig.merges, 0);
    assert.equal(rig.writes, 0);
    assert.notEqual(result.status, "applied");
    assert.equal((await readRequests(rig)).length, 0);
    await Deno.remove(rig.tmp, { recursive: true });
  },
);

Deno.test(
  "hosted autonomy: an attempt-ceiling grant never re-plans a charged retry identity",
  () => {
    // The loop admits corrections with purpose `retry` and identity
    // (task, base, attempt, purpose); attempt 4 at this base is already
    // settled, so a grant of 1 would be refused as a duplicate admission.
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 1, reviewRounds: 1 },
    });
    const charged = reservation("charged-retry", {
      taskId: TARGET,
      head: BASE,
      attempt: 4,
      purpose: "retry",
      outcome: "submitted",
      settledAt: T0 + 1000,
    });
    const plans = planHostedRetries(
      repairSnapshot([record], [authorizingReceipt()], [], [charged]),
      T0 + 5000,
    );
    assert.equal(plans.length, 1);
    const remaining = 4 - plans[0].grant;
    assert.equal(remaining, 2);
    assert.notEqual(remaining + 1, 4);
  },
);

Deno.test(
  "hosted autonomy: no attempt-ceiling grant is spent once the review budget is spent",
  () => {
    const record = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "implementation attempt budget exhausted",
        since: T0 + 3000,
      },
      counters: { attempts: 4, retries: 1, reviewRounds: 3 },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()]);
    // Every review round is spent, so another implementation run can never
    // become a reviewed verdict: the grant is provably futile.
    assert.equal(planHostedRetries(snapshot, T0 + 5000).length, 0);
    // With a review round left the same blocker is still retryable.
    const earlier = repairSnapshot(
      [blockedRecord({
        blocker: {
          kind: "review_quota",
          message: "implementation attempt budget exhausted",
          since: T0 + 3000,
        },
        counters: { attempts: 4, retries: 1, reviewRounds: 2 },
      })],
      [authorizingReceipt()],
    );
    assert.equal(planHostedRetries(earlier, T0 + 5000).length, 1);
  },
);

Deno.test(
  "hosted autonomy: a transient blocker at the attempt ceiling advances the base, never a zero grant",
  () => {
    const record = blockedRecord({
      counters: { attempts: 4, retries: 0, reviewRounds: 1 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const snapshot = repairSnapshot(
      [record],
      [authorizingReceipt()],
      [],
      chargedAttempts(),
    );
    const newerBase = SHA1;
    const plans = planHostedRetries(snapshot, T0 + 5000, selfTips(newerBase));
    assert.equal(plans.length, 1);
    // A grant of 0 would leave attempts at 4, exactly where the runtime refuses
    // admission: the grant must land below the ceiling through the runtime's
    // own base refresh instead of re-blocking the record unchanged.
    assert.equal(plans[0].grant, 1);
    assert.equal(plans[0].advanceBase, true);
    assert.equal(plans[0].nextStep, "work");
    const applied = applyHostedRetries(snapshot, SHA1, plans, T0 + 5000)
      .work[0];
    assert.equal(applied.counters.attempts, 3);
    assert.equal(applied.counters.retries, 0);
    assert.ok(
      applied.intent !== null && applied.intent.kind === "base_refresh",
    );
  },
);

Deno.test(
  "hosted autonomy: a work-returning grant is never planned once the review budget is spent",
  () => {
    const target = {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    };
    // The transient (non-budget) work rule is retryable while a review round is
    // left, even at the attempt ceiling with every identity charged...
    const earlier = repairSnapshot(
      [blockedRecord({
        counters: { attempts: 4, retries: 0, reviewRounds: 2 },
        target,
      })],
      [authorizingReceipt()],
      [],
      chargedAttempts(),
    );
    assert.equal(
      planHostedRetries(earlier, T0 + 5000, selfTips(SHA1)).length,
      1,
    );
    // ...but once every review round is spent another implementation run can
    // never become a reviewed verdict: no grant, base advance included.
    const spent = repairSnapshot(
      [blockedRecord({
        counters: { attempts: 4, retries: 0, reviewRounds: 3 },
        target,
      })],
      [authorizingReceipt()],
      [],
      chargedAttempts(),
    );
    assert.equal(planHostedRetries(spent, T0 + 5000, selfTips(SHA1)).length, 0);
    assert.equal(planHostedRetries(spent, T0 + 5000, selfTips(BASE)).length, 0);
  },
);

Deno.test(
  "hosted autonomy: a reserved retry identity is occupied while a reserved review request stays reconcilable",
  () => {
    const record = blockedRecord({
      counters: { attempts: 3, retries: 0, reviewRounds: 1 },
    });
    const reservedRetry = reservation("reserved-retry", {
      taskId: TARGET,
      head: BASE,
      attempt: 4,
      purpose: "retry",
      outcome: "reserved",
    });
    const snapshot = repairSnapshot(
      [record],
      [authorizingReceipt()],
      [],
      [reservedRetry],
    );
    const plans = planHostedRetries(snapshot, T0 + 5000);
    assert.equal(plans.length, 1);
    // Identity 4 is already reserved and the runtime refuses that duplicate
    // instead of starting a second session, so the grant must step to identity
    // 3 rather than re-plan 4 forever.
    assert.equal(plans[0].grant, 1);
    const applied = applyHostedRetries(snapshot, SHA1, plans, T0 + 5000)
      .work[0];
    assert.equal(applied.counters.attempts, 2);
    assert.equal(applied.counters.attempts + 1, 3);
    assert.ok(
      !snapshot.reservations.some((entry) =>
        entry.taskId === TARGET && entry.head === BASE &&
        entry.attempt === 3 && entry.purpose === "retry"
      ),
    );

    // Review rounds are spent and the only review admission at this head is
    // still `reserved`: the in-flight identity and its charge stay protected,
    // and only the runtime's own base refresh may continue the record.
    const reviewRecord = blockedRecord({
      blocker: {
        kind: "review_quota",
        message: "review rounds exhausted without an accepted verdict",
        since: T0 + 3000,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 3 },
    });
    const reservedReview = reservation("reserved-review", {
      taskId: TARGET,
      head: BASE,
      attempt: 2,
      purpose: "review_request",
      outcome: "reserved",
    });
    const reviewSnapshot = repairSnapshot(
      [reviewRecord],
      [authorizingReceipt()],
      [],
      [reservedReview],
    );
    assert.equal(planHostedRetries(reviewSnapshot, T0 + 5000).length, 0);
    const reviewPlans = planHostedRetries(
      reviewSnapshot,
      T0 + 5000,
      selfTips(SHA1),
    );
    assert.equal(reviewPlans.length, 1);
    assert.equal(reviewPlans[0].nextStep, "review");
    assert.equal(reviewPlans[0].advanceBase, true);
    assert.equal(reviewPlans[0].reviewRounds, 3);
    assert.equal(reviewPlans[0].grant, 0);
    const reviewNext = applyHostedRetries(
      reviewSnapshot,
      SHA1,
      reviewPlans,
      T0 + 5000,
    ).work[0];
    assert.equal(reviewNext.counters.reviewRounds, 3);
    assert.equal(reviewNext.counters.attempts, 1);
    assert.equal(reviewNext.counters.retries, 0);
  },
);
