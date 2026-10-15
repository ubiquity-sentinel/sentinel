import { SHA1 as ATTEMPT_RUNTIME } from "../state/helpers.ts";
import assert from "node:assert/strict";
import { candidateBranch, reviewOperationKey } from "../../src/repair/keys.ts";
import {
  applyHostedRetries,
  HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS,
  hostedIssueKey,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { reservation, SHA1, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  BASE,
  blockedRecord,
  FOREIGN_REPO,
  HEAD,
  SELF_REPO,
  selfTips,
  TARGET,
  ZOMBIE,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

Deno.test(
  "hosted autonomy: a task whose source issue is closed is never retried",
  () => {
    const record = blockedRecord({
      counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    });
    const snapshot = repairSnapshot([record], [authorizingReceipt()]);
    assert.equal(
      planHostedRetries(snapshot, T0 + 5000, ATTEMPT_RUNTIME).length,
      1,
    );
    assert.equal(
      planHostedRetries(
        snapshot,
        T0 + 5000,
        ATTEMPT_RUNTIME,
        selfTips(null),
        new Set([hostedIssueKey(SELF_REPO, 48)]),
      ).length,
      0,
    );
    // The same number scoped to ANOTHER repository never stops this retry.
    assert.equal(
      planHostedRetries(
        snapshot,
        T0 + 5000,
        ATTEMPT_RUNTIME,
        selfTips(null),
        new Set([hostedIssueKey(FOREIGN_REPO, 48)]),
      ).length,
      1,
    );
  },
);

Deno.test(
  "hosted autonomy: a settled three-round review record advances the base instead of re-using a charged identity",
  () => {
    // The live shape: review admissions 1-3 are durably settled at the current
    // candidate head and the review-round counter was reset to 0, so re-entry
    // at the same head can only collide with attempt 1 again.
    const record = blockedRecord({
      blocker: {
        kind: "unavailable",
        message: "review admission already settled without an intent",
        since: T0 + 3000,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      target: {
        base: BASE,
        branch: "sentinel/repair/issue-ubiquity-sentinel-48",
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
    });
    const charges = [1, 2, 3].map((attempt) =>
      reservation(`review-${attempt}`, {
        taskId: TARGET,
        repository: SELF_REPO,
        head: HEAD,
        attempt,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 2000,
      })
    );
    const snapshot = repairSnapshot(
      [record],
      [authorizingReceipt()],
      [],
      charges,
    );
    const now = T0 + 5000;
    // Three charged identities are the whole space at this head and the base
    // has not moved: nothing may invent a fourth round at the same head.
    assert.equal(
      planHostedRetries(snapshot, now, ATTEMPT_RUNTIME, selfTips(BASE)).length,
      0,
    );
    const newerBase = SHA1;
    const plans = planHostedRetries(
      snapshot,
      now,
      ATTEMPT_RUNTIME,
      selfTips(newerBase),
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "review");
    assert.equal(plans[0].advanceBase, true);
    assert.equal(plans[0].observedBase, newerBase);
    // The floor is the highest settled review attempt at the current head,
    // never 0: a charged counter is history and is only ever raised.
    assert.equal(plans[0].reviewRounds, HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS);
    assert.equal(plans[0].grant, 0);
    const next = applyHostedRetries(snapshot, SHA1, plans, now);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "review");
    assert.equal(applied.blocker, null);
    assert.equal(applied.counters.reviewRounds, 3);
    assert.equal(applied.counters.attempts, 1);
    assert.equal(applied.counters.retries, 0);
    // The runtime's own base-refresh intent is persisted against the newer base
    // and the exact publication identity: the refresh supplies the new head and
    // with it the unused review identity.
    assert.ok(
      applied.intent !== null && applied.intent.kind === "base_refresh",
    );
    assert.equal(applied.intent?.key, `base_refresh:51:${HEAD}:${newerBase}`);
    assert.equal(applied.intent?.pr, 51);
    assert.equal(applied.intent?.expectedHead, HEAD);
    assert.equal(applied.intent?.observedBase, newerBase);
    // Charged history is untouched: every reservation, receipt and the target
    // identity stay exactly as they were.
    assert.deepEqual(next.reservations, snapshot.reservations);
    assert.deepEqual(next.reviews, snapshot.reviews);
    assert.deepEqual(applied.target, record.target);
    assert.equal(next.reservations.length, 3);
  },
);

Deno.test(
  "hosted autonomy: a settled ambiguous review intent restores its floor and continues at an unused identity",
  () => {
    // The live shape: one review request was admitted and settled `ambiguous`
    // (charge preserved), its intent is still preserved and the round counter
    // is 0. The floor restored from the settled charge makes the next
    // admission attempt 2, an identity nothing has charged yet.
    const record = blockedRecord({
      blocker: {
        kind: "unavailable",
        message: "review produced no verdict within the bounded review wait",
        since: T0 + 3000,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      target: {
        base: BASE,
        branch: candidateBranch(TARGET),
        checkpoint: null,
        head: HEAD,
        pr: 51,
      },
      intent: {
        kind: "review_request",
        // The canonical production key for the first review round of this
        // exact PR/head, exactly as the runtime persisted it.
        key: reviewOperationKey(51, HEAD),
        startedAt: T0 + 1000,
        branch: candidateBranch(TARGET),
        expectedHead: HEAD,
        // The actual base the production loop observed when it requested this
        // review: the record's own non-null target base.
        observedBase: BASE,
        pr: 51,
        requestId: "review-charge-1",
        resultId: null,
      },
    });
    const charge = reservation("review-charge-1", {
      taskId: TARGET,
      repository: SELF_REPO,
      head: HEAD,
      attempt: 1,
      purpose: "review_request",
      outcome: "ambiguous",
      settledAt: T0 + 2000,
    });
    const snapshot = repairSnapshot(
      [record],
      [authorizingReceipt()],
      [],
      [charge],
    );
    const now = T0 + 5000;
    const plans = planHostedRetries(
      snapshot,
      now,
      ATTEMPT_RUNTIME,
      selfTips(BASE),
    );
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "review");
    assert.equal(plans[0].advanceBase, false);
    assert.equal(plans[0].reviewRounds, 1);
    assert.equal(plans[0].grant, 0);
    const next = applyHostedRetries(snapshot, SHA1, plans, now);
    const applied = next.work[0];
    assert.equal(applied.nextStep, "review");
    assert.equal(applied.blocker, null);
    // The settled intent is closed only because its exact request charge is
    // proven settled; the charge itself stays exactly as it was.
    assert.equal(applied.intent, null);
    assert.equal(applied.counters.reviewRounds, 1);
    assert.equal(applied.counters.attempts, 1);
    assert.deepEqual(next.reservations, snapshot.reservations);
    // Identity 2 at this exact head is unused: the next request is a genuine
    // new admission, never a duplicate of the settled attempt 1.
    assert.ok(
      !next.reservations.some((entry) =>
        entry.taskId === TARGET && entry.head === HEAD &&
        entry.purpose === "review_request" && entry.attempt === 2
      ),
    );
  },
);

Deno.test(
  "hosted autonomy: a review intent is cleared only by its exact publication identity and canonical round key",
  () => {
    const reviewIntent = (overrides: Record<string, unknown> = {}) => ({
      kind: "review_request",
      // The canonical production key for round 1 of this exact PR/head.
      key: reviewOperationKey(51, HEAD),
      startedAt: T0 + 1000,
      branch: candidateBranch(TARGET),
      expectedHead: HEAD,
      observedBase: BASE,
      pr: 51,
      requestId: "review-charge-1",
      resultId: null,
      ...overrides,
    });
    const record = (
      intent: unknown,
      branch = candidateBranch(TARGET),
    ) =>
      blockedRecord({
        blocker: {
          kind: "unavailable",
          message: "review admission already settled without an intent",
          since: T0 + 3000,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
        target: {
          base: BASE,
          branch,
          checkpoint: null,
          head: HEAD,
          pr: 51,
        },
        intent,
      });
    const plan = (
      intent: unknown,
      charges: unknown[],
      branch?: string,
    ): number =>
      planHostedRetries(
        repairSnapshot(
          [record(intent, branch)],
          [authorizingReceipt()],
          [],
          charges,
        ),
        T0 + 5000,
        ATTEMPT_RUNTIME,
        selfTips(BASE),
      ).length;
    /** The exact review charge of one round, settled and still charged. */
    const settledCharge = (attempt = 1) =>
      reservation("review-charge-1", {
        taskId: TARGET,
        repository: SELF_REPO,
        head: HEAD,
        attempt,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 2000,
      });

    // Baseline: the exact publication identity the record currently carries and
    // the canonical key of the settled round are closable.
    assert.equal(plan(reviewIntent(), [settledCharge()]), 1);
    // The same binding at a later round stays closable: the key is derived from
    // the settled reservation's own attempt, not from a fixed round.
    assert.equal(
      plan(reviewIntent({ key: reviewOperationKey(51, HEAD, 2) }), [
        settledCharge(2),
      ]),
      1,
    );

    // Still `reserved`: the runtime's uncertainty handler owns that in-flight
    // admission and it must never be cleared or re-planned here.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: TARGET,
          repository: SELF_REPO,
          head: HEAD,
          attempt: 1,
          purpose: "review_request",
          outcome: "reserved",
        }),
      ]),
      0,
    );
    // The intent's expected head must be the record's current head: a stale
    // intent for another publication is never cleared by a current-head charge.
    assert.equal(
      plan(reviewIntent({ expectedHead: SHA1 }), [settledCharge()]),
      0,
    );
    // The intent's PR must be the record's PR.
    assert.equal(plan(reviewIntent({ pr: 52 }), [settledCharge()]), 0);
    // The intent's branch must be this task's deterministic candidate branch.
    assert.equal(
      plan(reviewIntent({ branch: candidateBranch(ZOMBIE) }), [
        settledCharge(),
      ]),
      0,
    );
    // ...and the record's own branch must be the branch the intent names.
    assert.equal(
      plan(reviewIntent(), [settledCharge()], candidateBranch(ZOMBIE)),
      0,
    );
    // The intent's observed base must be the record's non-null target base: a
    // null or moved base is never cleared by an otherwise matching charge.
    assert.equal(
      plan(reviewIntent({ observedBase: null }), [settledCharge()]),
      0,
    );
    assert.equal(
      plan(reviewIntent({ observedBase: SHA1 }), [settledCharge()]),
      0,
    );
    // The intent key must be the canonical key of the settled round: another
    // round's key (or an unknown key) never proves this admission settled.
    assert.equal(
      plan(reviewIntent({ key: reviewOperationKey(51, HEAD, 2) }), [
        settledCharge(),
      ]),
      0,
    );
    assert.equal(
      plan(reviewIntent({ key: `review:51:${HEAD}:attempt-9` }), [
        settledCharge(),
      ]),
      0,
    );
    // A settled reservation for another round than the key names is a
    // different identity and never settles this intent.
    assert.equal(plan(reviewIntent(), [settledCharge(2)]), 0);
    // A settled reservation bound to a different head proves nothing about
    // THIS head.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: TARGET,
          repository: SELF_REPO,
          head: SHA1,
          attempt: 1,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ]),
      0,
    );
    // A settled reservation in another repository is never borrowed.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: TARGET,
          repository: FOREIGN_REPO,
          head: HEAD,
          attempt: 1,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ]),
      0,
    );
    // A settled reservation under a different purpose is not a review charge.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: TARGET,
          repository: SELF_REPO,
          head: HEAD,
          attempt: 1,
          purpose: "implementation",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ]),
      0,
    );
    // A settled reservation for another task is never borrowed.
    assert.equal(
      plan(reviewIntent(), [
        reservation("review-charge-1", {
          taskId: ZOMBIE,
          repository: SELF_REPO,
          head: HEAD,
          attempt: 1,
          purpose: "review_request",
          outcome: "submitted",
          settledAt: T0 + 2000,
        }),
      ]),
      0,
    );
    // No matching reservation at all is unknown, not settled.
    assert.equal(plan(reviewIntent({ requestId: "review-charge-9" }), []), 0);
    assert.equal(plan(reviewIntent({ requestId: null }), []), 0);
  },
);
