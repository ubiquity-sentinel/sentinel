/**
 * Owner decision 2026-10-24 ("you can have up to five reviews"): a
 * CI-first-era record parked by the runtime's ceiling gate at three rounds
 * returns to `work` uncharged while its durable ledger leaves a round; a
 * pre-era record, a record at five and a closed issue stay parked.
 */
import assert from "node:assert/strict";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  applyHostedRetries,
  hostedIssueKey,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { RAISED_CEILING_DETAIL_SUFFIX } from "../../ops/hosted-autonomy-raised-ceiling.ts";
import {
  LEGACY_REVIEW_CUTOFF,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_REVIEWED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_UNREVIEWED,
} from "../../src/repair/review-round-cap.ts";
import { reservation, SHA1, SHA2 } from "../state/helpers.ts";
import {
  blockedRecord,
  HEAD,
  SELF_REPO,
  selfTips,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

const ERA = LEGACY_REVIEW_CUTOFF.activatedNotBefore!;
const NOW = ERA + 10 * 60 * 60_000;

function charges(rounds: number, at = ERA + 60_000): BudgetReservationV1[] {
  return Array.from(
    { length: rounds },
    (_, index) =>
      reservation(`${TARGET}-review-${index + 1}`, {
        repository: SELF_REPO,
        taskId: TARGET,
        attempt: index + 1,
        head: HEAD,
        purpose: "review_request",
        outcome: "submitted",
        createdAt: at + index,
        settledAt: at + index + 1,
      }),
  );
}

function parked(message: string, rounds: number, createdAt = ERA + 1_000) {
  return blockedRecord({
    createdAt,
    updatedAt: NOW - 60_000,
    blocker: { kind: "other", message, since: NOW - 60_000 },
    counters: { attempts: 1, retries: 0, reviewRounds: rounds },
  });
}

function plan(
  record: WorkRecordV1,
  reservations: BudgetReservationV1[],
  closed: ReadonlySet<string> = new Set(),
) {
  const snapshot = repairSnapshot([record], [], [], reservations);
  return {
    snapshot,
    plans: planHostedRetries(snapshot, NOW, SHA1, selfTips(SHA2), closed),
  };
}

Deno.test("raised ceiling: an era record parked at three returns to work uncharged", () => {
  for (
    const message of [
      REVIEW_ROUND_CEILING_UNREVIEWED,
      REVIEW_ROUND_CEILING_REJECTED,
      REVIEW_ROUND_CEILING_UNACCEPTED,
    ]
  ) {
    const { snapshot, plans } = plan(parked(message, 3), charges(3));
    assert.equal(plans.length, 1, message);
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].grant, 0);
    assert.equal(plans[0].advanceBase, false);
    assert.equal(plans[0].detail, `other${RAISED_CEILING_DETAIL_SUFFIX}`);
    const applied = applyHostedRetries(snapshot, SHA1, plans, NOW);
    const work = applied.work[0];
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.deepEqual(work.counters, snapshot.work[0].counters);
    assert.deepEqual(applied.reservations, snapshot.reservations);
  }
});

Deno.test("raised ceiling: five spent rounds, a pre-era record, a closed issue and a reviewed head stay parked", () => {
  assert.deepEqual(
    plan(parked(REVIEW_ROUND_CEILING_UNREVIEWED, 5), charges(5)).plans,
    [],
    "five rounds spent",
  );
  assert.deepEqual(
    plan(
      parked(REVIEW_ROUND_CEILING_UNREVIEWED, 3, ERA - 1),
      charges(3, ERA - 10_000),
    ).plans,
    [],
    "pre-era record keeps three",
  );
  const record = parked(REVIEW_ROUND_CEILING_UNREVIEWED, 3);
  assert.deepEqual(
    plan(
      record,
      charges(3),
      new Set([
        hostedIssueKey(record.repository, record.related.issueNumber!),
      ]),
    ).plans,
    [],
    "closed issue",
  );
  assert.deepEqual(
    plan(parked(REVIEW_ROUND_CEILING_REVIEWED, 3), charges(3)).plans,
    [],
    "a reviewed head is the delivery rule's, not a new round",
  );
});
