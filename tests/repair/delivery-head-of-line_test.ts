/**
 * Just-in-time refresh at the head of the delivery line (sentinel #329). A
 * reviewed head keeps its reviewed base until it is next to land: only the
 * head of its repository's line (oldest first by `createdAt`, then id)
 * refreshes onto a moved tip, and it keeps the line while its refreshed head
 * is in flight on that tip. The others write, refresh, push and request
 * nothing, so their review and CI stay bound to the exact reviewed bytes, and
 * landing k reviewed records costs k refreshes, not O(k^2).
 *
 * Drives the REAL repair loop over one fake repository
 * (`delivery-queue-rig.ts`): five records, each reviewed clean and accepted
 * on its own head on the old base, then the base moves three times before the
 * line runs.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
} from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  DELIVERY_QUEUE_IDLE_MS,
  DELIVERY_QUEUE_STALL_LIMIT,
  deliveryQueueAhead,
} from "../../src/repair/delivery-queue.ts";
import { REPO, reservation, SHA1, T0, workRecord } from "../state/helpers.ts";
import { APP, queueRig } from "./delivery-queue-rig.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";
import { MINUTE, sha } from "./review-round-cap-rig.ts";

const RECORDS = 5;

async function cleanReview(
  record: WorkRecordV1,
  head: GitSha,
): Promise<ReviewReceiptV1> {
  const issueNumber = record.related.issueNumber!;
  return completedReceipt(record.target.pr!, head, SHA1, {
    id: `review-receipt:${record.id}:reviewed`,
    repository: REPO,
    resultId: `result-${record.id}`,
    expectedReviewer: APP,
    observedReviewer: APP,
    taskAcceptance: {
      issueNumber,
      taskDigest: await reviewTaskStatementDigest({
        issueNumber,
        title: `issue ${issueNumber}`,
        body: "",
      }),
      verdict: "fulfilled",
      evidence: ["the exact reviewed change implements the source issue"],
    },
  });
}

/** Five records reviewed clean on their own heads on SHA1, in `delivery`. */
async function reviewedLine() {
  const seed = await queueRig(RECORDS);
  const reservations: BudgetReservationV1[] = [];
  const reviews: ReviewReceiptV1[] = [];
  const shaped = seed.records.map((record) =>
    workRecord(record.id, {
      ...record,
      nextStep: "delivery",
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    })
  );
  for (const record of shaped) {
    reservations.push(reservation(`${record.id}-review-1`, {
      repository: REPO,
      taskId: record.id,
      attempt: 1,
      head: record.target.head!,
      purpose: "review_request",
      outcome: "submitted",
      createdAt: T0 - 30 * MINUTE,
      settledAt: T0 - 30 * MINUTE + 1,
    }));
    reviews.push(await cleanReview(record, record.target.head!));
  }
  const rig = await queueRig(RECORDS, {
    shape: () => shaped,
    reservations,
    reviews,
    reviewer: APP,
  });
  // The base moves three times (merges from outside the line) before the
  // line runs: nothing has refreshed yet.
  for (const move of [1, 2, 3]) rig.github.remoteBase = sha(0x7000 + move);
  return rig;
}

type Rig = Awaited<ReturnType<typeof reviewedLine>>;

/** Prepared refreshes per pull request (`pr:head:base` keys). */
function refreshesOf(rig: Rig, pr: number): number {
  return rig.github.preparedKeys.filter((key) => key.startsWith(`${pr}:`))
    .length;
}

/** One runtime cycle at a time until `pr` merged (bounded). */
async function driveUntilMerged(rig: Rig, pr: number, limit = 30) {
  for (let run = 0; run < limit && !rig.github.merged.includes(pr); run++) {
    await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 60 * MINUTE,
      stepLimit: 16,
    });
    rig.clock.advance(16 * MINUTE);
  }
  assert.ok(rig.github.merged.includes(pr), `PR ${pr} merged`);
}

/** The records not yet at the head of the line are untouched. */
async function untouched(rig: Rig, waiting: readonly number[]) {
  const snapshot = await rig.snapshot();
  for (const pr of waiting) {
    assert.equal(refreshesOf(rig, pr), 0, `PR ${pr} refreshed nothing`);
    const seeded = rig.records.find((record) => record.target.pr === pr)!;
    const now = snapshot.work.find((record) => record.id === seeded.id)!;
    assert.equal(now.target.head, seeded.target.head, `PR ${pr} head kept`);
    assert.equal(now.target.base, SHA1, `PR ${pr} keeps its reviewed base`);
    assert.equal(now.intent, null, `PR ${pr} holds no refresh intent`);
    assert.ok(
      rig.github.pushes.every((push) => !push.ref.endsWith(seeded.id)),
      `PR ${pr} pushed nothing`,
    );
    assert.ok(
      rig.github.reviewed.every((review) => review.pr !== pr),
      `PR ${pr} requested no new review`,
    );
  }
}

Deno.test("head of line: only the oldest reviewed record refreshes; the four waiting records refresh nothing", async () => {
  const rig = await reviewedLine();
  await driveUntilMerged(rig, 101);
  assert.equal(refreshesOf(rig, 101), 1, "the head of the line refreshes once");
  assert.equal(
    rig.github.preparedKeys[0],
    `101:${rig.records[0].target.head}:${sha(0x7003)}`,
    "onto the current tip, after all three moves",
  );
  await untouched(rig, [102, 103, 104, 105]);
});

Deno.test("head of line: after the head merges the next oldest record refreshes once", async () => {
  const rig = await reviewedLine();
  await driveUntilMerged(rig, 101);
  await driveUntilMerged(rig, 102);
  assert.equal(refreshesOf(rig, 101), 1);
  assert.equal(refreshesOf(rig, 102), 1, "the next head refreshes once");
  await untouched(rig, [103, 104, 105]);
  // To the end: every record lands with exactly one refresh, k in all.
  for (const pr of [103, 104, 105]) await driveUntilMerged(rig, pr);
  assert.deepEqual(rig.github.merged, [101, 102, 103, 104, 105]);
  for (const pr of [101, 102, 103, 104, 105]) {
    assert.equal(refreshesOf(rig, pr), 1, `PR ${pr} refreshed once`);
  }
  assert.equal(rig.github.refreshes, RECORDS);
});

Deno.test("head of line: a base move during the admitted head's CI does not refresh its siblings", async () => {
  const rig = await reviewedLine();
  const original = rig.records[0];
  let head = original;
  for (
    let run = 0;
    run < 20 && head.target.head === original.target.head;
    run++
  ) {
    await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 60 * MINUTE,
      stepLimit: 1,
    });
    head = (await rig.snapshot()).work.find((row) => row.id === original.id)!;
    rig.clock.advance(1);
  }
  assert.notEqual(
    head.target.head,
    original.target.head,
    "the line's head refreshed",
  );
  assert.equal(
    head.nextStep,
    "work",
    "the refreshed head is awaiting CI/review",
  );
  rig.github.checksByHead.set(head.target.head!, [{
    name: "validate",
    head: head.target.head!,
    status: "in_progress",
    conclusion: null,
    startedAt: rig.clock.now(),
    completedAt: null,
  }]);
  for (const move of [4, 5, 6]) {
    rig.github.remoteBase = sha(0x7000 + move);
    await runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 60 * MINUTE,
      stepLimit: 16,
    });
    await untouched(rig, [102, 103, 104, 105]);
    rig.clock.advance(2 * MINUTE);
  }
  rig.github.checksByHead.delete(head.target.head!);
  await driveUntilMerged(rig, 101);
  await untouched(rig, [102, 103, 104, 105]);
});

Deno.test("head of line: an admitted refresh keeps priority across tip moves until stalled, idle or held by its red base", async () => {
  const rig = await reviewedLine();
  const snapshot = await rig.snapshot();
  const now = rig.clock.now();
  const waiting = snapshot.work[0];
  // This younger record took the line while the older one was not ready.
  const admitted = snapshot.work[1];
  const head: WorkRecordV1 = {
    ...admitted,
    nextStep: "work",
    target: { ...admitted.target, head: sha(0x5001), base: sha(0x7002) },
    wait: { reason: "ci_pending", since: now, until: now + 2 * MINUTE },
    updatedAt: now,
  };
  const view = (replacement: WorkRecordV1) => ({
    ...snapshot,
    work: snapshot.work.map((row) => row.id === head.id ? replacement : row),
  });
  assert.equal(
    deliveryQueueAhead(view(head), waiting, rig.github.remoteBase, now)?.id,
    head.id,
    "the admitted head holds an older ready sibling on a moved tip",
  );
  assert.equal(
    deliveryQueueAhead(view(head), head, rig.github.remoteBase, now),
    null,
    "the admitted head can advance rather than waiting behind its siblings",
  );
  const released: WorkRecordV1[] = [
    {
      ...head,
      counters: { ...head.counters, stalled: DELIVERY_QUEUE_STALL_LIMIT },
    },
    { ...head, updatedAt: now - DELIVERY_QUEUE_IDLE_MS },
    {
      ...head,
      wait: { reason: "backoff", since: now, until: now + 30 * MINUTE },
    },
  ];
  for (const record of released) {
    assert.equal(
      deliveryQueueAhead(view(record), waiting, rig.github.remoteBase, now),
      null,
      "existing escape bounds release even a moved-tip refresh",
    );
  }
});
