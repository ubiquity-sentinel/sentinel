/**
 * A spent green head through the WHOLE maintenance chain (generation 80
 * integration review): the retry phase runs before the delivery phase, and
 * the delivery pass skips any record an earlier write of the same pass
 * settled. The retry pass's green CI rule therefore must never hand a green
 * head whose ordinary review rounds are spent to the runtime's `delivery`
 * step: the spent-round rule merges it in the same pass at its exact reviewed
 * base, and no runtime ever refreshes and reviews it a fourth time (R79) or
 * parks it on a base that moved before its step (R80).
 *
 * Live shapes: the owner's legacy 618, 698 and 879 (23:21Z, green after their
 * re-runs, tip equal to the reviewed base), and 583 and 629 (09:07Z, parked
 * `CI checks failed: ...` by generation 79 with every review charge in the
 * ledger, pinned at the table's cut), at their pin and past it (no round
 * left at all).
 */
import assert from "node:assert/strict";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  parseReviewReceiptV1,
  type ReviewReceiptV1,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import { parseBudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  ordinaryReviewRoundsSpent,
  reviewRoundsSpent,
} from "../../src/repair/review-round-cap.ts";
import {
  liveReceipts,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  liveTask,
  mergedPull,
  mergeSha,
  openPull,
  readSnapshot,
  runAt,
} from "./hosted-autonomy-spent-fixtures.ts";

const LIVE_0907 = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/spent-green-live-0907.json", import.meta.url),
  ),
);

/** Explicit synthetic statements for only the two older historical shapes. */
const TASKS_0907 = new Map(
  await Promise.all([583, 629].map(async (issueNumber) => {
    const text = {
      issueNumber,
      title: `Deliver synthetic historical candidate ${issueNumber}`,
      body:
        `Deliver the exact reviewed synthetic patch for issue ${issueNumber}.`,
    };
    return [issueNumber, {
      ...text,
      digest: await reviewTaskStatementDigest(text),
    }] as const;
  })),
);

interface ShapeV1 {
  record: WorkRecordV1;
  receipts: ReviewReceiptV1[];
  reservations: BudgetReservationV1[];
  task?: ReviewTaskStatementV1;
}

function shape2321(issue: number, overrides = {}): ShapeV1 {
  const record = liveRecord(issue, overrides);
  return { record, receipts: liveReceipts(record), reservations: [] };
}

function shape0907(issue: number): ShapeV1 {
  const task = TASKS_0907.get(issue);
  assert.ok(task !== undefined, "an explicitly named 0907 synthetic task");
  const raw = (LIVE_0907.records as { related: { issueNumber: number } }[])
    .find((row) => row.related.issueNumber === issue);
  assert.ok(raw !== undefined, `live 09:07Z record ${issue}`);
  const record = parseWorkRecordV1(structuredClone(raw));
  const receipts = (LIVE_0907.reviews as unknown[]).map((row) =>
    parseReviewReceiptV1(row)
  ).filter((review) =>
    review.pullRequest.number === record.target.pr &&
    review.pullRequest.head === record.target.head &&
    review.pullRequest.base === record.target.base
  ).map((review) =>
    review.taskAcceptance?.issueNumber === issue
      ? {
        ...review,
        taskAcceptance: { ...review.taskAcceptance, taskDigest: task.digest },
      }
      : review
  );
  const reservations = (LIVE_0907.reservations as unknown[]).map((row) =>
    parseBudgetReservationV1(row)
  ).filter((row) => row.taskId === record.id);
  return { record, receipts, reservations, task };
}

/** One full maintenance pass over one record at its reviewed base, green. */
async function chain(
  name: string,
  { record, receipts, reservations, task }: ShapeV1,
) {
  const pr = record.target.pr!;
  const tip = record.target.base!;
  const issue = record.related.issueNumber!;
  const { surface, calls } = liveSurface({
    tip,
    green: { [record.target.head!]: true, [tip]: true },
    pulls: { [pr]: openPull(record) },
    afterMerge: { [pr]: mergedPull(record, tip) },
    tasks: { [issue]: task ?? liveTask(issue, receipts) },
  });
  const rig = await liveRig(
    name,
    liveSnapshot([record], receipts, [], reservations),
    surface,
  );
  try {
    const result = await runAt(rig);
    return { result, calls, after: await readSnapshot(rig) };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

/** The shape with one more review charge: past its pin, no round left. */
function pastPin(shape: ShapeV1): ShapeV1 {
  const last = shape.reservations.reduce((a, b) =>
    a.attempt > b.attempt ? a : b
  );
  return {
    ...shape,
    reservations: [
      ...shape.reservations,
      parseBudgetReservationV1({
        ...last,
        id: "9".repeat(64),
        attempt: last.attempt + 1,
        createdAt: last.createdAt + 60_000,
        settledAt: (last.settledAt ?? last.createdAt) + 60_000,
      }),
    ],
  };
}

const SPENT: [string, () => ShapeV1][] = [
  ["legacy 618", () => shape2321(618)],
  ["legacy 698", () => shape2321(698)],
  ["legacy 879", () => shape2321(879)],
  ["583 at its pin", () => shape0907(583)],
  ["629 at its pin", () => shape0907(629)],
  ["583 past its pin", () => pastPin(shape0907(583))],
];

Deno.test("spent green chain: a green spent head merges in one full maintenance pass", async (t) => {
  for (const [label, make] of SPENT) {
    await t.step(label, async () => {
      const shape = make();
      const { record } = shape;
      assert.ok(
        ordinaryReviewRoundsSpent({ reservations: shape.reservations }, record),
        "every ordinary round spent",
      );
      const { result, calls, after } = await chain(
        `green-chain-${record.related.issueNumber}`,
        shape,
      );
      const actions = result.actions ?? [];
      assert.deepEqual(calls.merges, [record.target.pr], actions.join(" "));
      assert.ok(
        actions.includes(
          `merge:${record.id}:pr=${record.target.pr}:sha=${
            mergeSha(record.target.pr!)
          }`,
        ),
        actions.join(" "),
      );
      // The retry pass neither reads its CI nor plans it: no grant, and the
      // green rule's own refusal (planHostedRetries) is never even reached.
      assert.ok(
        !actions.some((action) =>
          action.startsWith(`retry:${record.id}:`) &&
          !action.includes(":denied:legacy_class_")
        ),
        actions.join(" "),
      );
      assert.ok(
        !actions.some((action) =>
          action.startsWith(`retry:${record.id}:grant`)
        ),
        "never handed to the runtime's delivery step",
      );
      const work = after.work[0];
      assert.equal(work.nextStep, "delivery");
      assert.equal(work.blocker, null);
      assert.deepEqual(work.counters, record.counters, "nothing charged");
      const byId = (rows: readonly BudgetReservationV1[]) =>
        [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      assert.deepEqual(
        byId(after.reservations),
        byId(shape.reservations),
        "every charge kept, none added",
      );
      assert.equal(after.releaseRequests.length, 1);
      assert.equal(
        after.releaseRequests[0].revision,
        mergeSha(record.target.pr!),
      );
      assert.deepEqual(after.releaseRequests[0].source, {
        pullRequest: record.target.pr,
        reviewRequestId: shape.receipts[0].requestId,
        reviewReceiptId: shape.receipts[0].id,
        head: record.target.head,
        base: record.target.base,
      });
    });
  }
});

Deno.test("spent green chain: a green head with a review round left still returns to the runtime's delivery step", async () => {
  // Control: below the ceiling the green rule is unchanged; the runtime's own
  // merge gate merges the head (or refreshes it within its rounds).
  const shape = shape2321(618, {
    counters: { attempts: 3, retries: 0, reviewRounds: 2 },
  });
  assert.equal(reviewRoundsSpent({ reservations: [] }, shape.record), 2);
  const { result, calls, after } = await chain("green-chain-unspent", shape);
  const actions = result.actions ?? [];
  assert.deepEqual(calls.merges, [], actions.join(" "));
  assert.ok(
    actions.includes(
      `retry:${shape.record.id}:grant=0:other:CI checks failed::green`,
    ),
    actions.join(" "),
  );
  assert.equal(after.work[0].nextStep, "delivery");
  assert.equal(after.releaseRequests.length, 0);
});
