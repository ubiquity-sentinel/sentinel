/**
 * Cross-lane (the round-cap ceiling parks and the spent-round delivery rule):
 * the runtime's REVIEWED and BASE_MOVED ceiling parks are delivered by the
 * spent-round rule, a BASE_MOVED park on a strict-ancestor base with a green
 * tip merges only under the moved-base rule (D3, shipped disabled), and the
 * other three parks never merge. Live record ai.ubq.fi#618 (PR 1071) at
 * sequence 37010.
 */
import assert from "node:assert/strict";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import {
  isDeliverableReviewRoundCeilingPark,
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_MESSAGES,
  REVIEW_ROUND_CEILING_REVIEWED,
} from "../../src/repair/review-round-cap.ts";
import { spentDeliveryAdmissible } from "../../ops/hosted-autonomy-spent-delivery.ts";
import { deliveryEligible } from "../../ops/hosted-autonomy-policy.ts";
import {
  deliveryOnly,
  LIVE_UPDATED_AT,
  liveReceipts,
  liveRecord,
  liveRig,
  liveSnapshot,
  liveSurface,
  type LiveSurfaceOptionsV1,
  liveTask,
  mergedPull,
  mergeSha,
  MOVED_BASE,
  NOW,
  openPull,
  readSnapshot,
  TIP,
} from "./hosted-autonomy-spent-fixtures.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { assertGen79Parses } from "../state/gen77-contracts.ts";
import { gen79Available, loadGen79Modules } from "./gen77-runtime-source.ts";

const r79 = await gen79Available();

/** R79's own Gateway release binding (src/repair/vps-delivery.ts). */
interface R79BindingV1 {
  gatewayRequestBindsDelivery(
    request: ReleaseRequestV1,
    record: WorkRecordV1,
    review: ReviewReceiptV1 | null,
    revision?: string,
  ): Promise<boolean>;
}

/**
 * The park the cap runtime writes from the reviewed head in `delivery`:
 * `markBlocked(kind other, fixed message)` with everything else kept. 618 is
 * a listed legacy record (pin 7); `rounds` 8 is its final round spent.
 */
function park(message: string, rounds = 8): WorkRecordV1 {
  const live = liveRecord(618);
  const delivery = parseWorkRecordV1({
    ...live,
    nextStep: "delivery",
    blocker: null,
    counters: { ...live.counters, reviewRounds: rounds },
  });
  return markBlocked(delivery, "other", message, LIVE_UPDATED_AT - 1);
}

function options(
  record: WorkRecordV1,
  receipts: readonly ReviewReceiptV1[],
  tip: string,
): LiveSurfaceOptionsV1 {
  return {
    tip,
    green: { [record.target.head!]: true, [tip]: true },
    pulls: { [record.target.pr!]: openPull(record) },
    afterMerge: { [record.target.pr!]: mergedPull(record, tip) },
    tasks: { 618: liveTask(618, receipts) },
  };
}

async function deliver(
  name: string,
  record: WorkRecordV1,
  tip: string,
  movedBase: boolean,
) {
  const receipts = liveReceipts(record);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0]!.unresolvedSeverities, []);
  const { surface, calls } = liveSurface(options(record, receipts, tip));
  const rig = await liveRig(name, liveSnapshot([record], receipts), surface);
  try {
    const { actions } = await deliveryOnly(
      rig,
      NOW,
      movedBase ? MOVED_BASE : {},
    );
    return { actions, calls, rig, after: await readSnapshot(rig) };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

Deno.test("cross-lane: a Gateway BASE_MOVED park on a strict-ancestor base with a green tip is merged by the moved-base rule", async () => {
  const record = park(REVIEW_ROUND_CEILING_BASE_MOVED);
  const base = record.target.base!;
  assert.notEqual(base, TIP, "the base moved after the last review");
  const snapshot = liveSnapshot([record], liveReceipts(record));
  assert.equal(isDeliverableReviewRoundCeilingPark(record), true);
  assert.equal(deliveryEligible(record, snapshot), true);
  assert.equal(spentDeliveryAdmissible(record, snapshot), true);
  const { actions, calls, after } = await deliver("x-moved", record, TIP, true);
  assert.deepEqual(calls.merges, [1071], actions.join(" "));
  assert.deepEqual(calls.advancedReads, [`${base}...${TIP}`]);
  assert.ok(calls.greenReads.includes(TIP), "the tip's own CI is read");
  assert.deepEqual(after.work, [{
    ...record,
    nextStep: "delivery",
    wait: null,
    blocker: null,
    updatedAt: NOW,
  }]);
  assert.equal(after.releaseRequests.length, 1);
  assert.equal(after.releaseRequests[0]!.source.base, base);
  assert.equal(after.releaseRequests[0]!.revision, mergeSha(1071));
});

Deno.test("cross-lane: with the moved-base rule off (as shipped) the BASE_MOVED park waits, nothing merged or written", async () => {
  const record = park(REVIEW_ROUND_CEILING_BASE_MOVED);
  const { actions, calls, rig } = await deliver("x-off", record, TIP, false);
  assert.ok(
    actions.includes(`delivery:${record.id}:base_moved`),
    actions.join(" "),
  );
  assert.deepEqual(calls.merges, []);
  assert.equal(rig.writes, 0);
});

Deno.test("cross-lane: a REVIEWED park at its exact reviewed base merges without the moved-base rule", async () => {
  const record = park(REVIEW_ROUND_CEILING_REVIEWED);
  const { actions, calls, after } = await deliver(
    "x-reviewed",
    record,
    record.target.base!,
    false,
  );
  assert.deepEqual(calls.merges, [1071], actions.join(" "));
  assert.equal(after.work[0]!.nextStep, "delivery");
  assert.equal(after.releaseRequests.length, 1);
});

Deno.test("cross-lane: the other ceiling parks are never merged or read", async () => {
  for (const message of REVIEW_ROUND_CEILING_MESSAGES) {
    if (
      message === REVIEW_ROUND_CEILING_BASE_MOVED ||
      message === REVIEW_ROUND_CEILING_REVIEWED
    ) continue;
    const record = park(message);
    const snapshot = liveSnapshot([record], liveReceipts(record));
    assert.equal(deliveryEligible(record, snapshot), false, message);
    for (const tip of [TIP, record.target.base!]) {
      const { calls, rig } = await deliver("x-other", record, tip, true);
      assert.deepEqual(calls.merges, [], message);
      assert.deepEqual(calls.greenReads, [], message);
      assert.equal(rig.writes, 0);
    }
  }
});

Deno.test("cross-lane: a park whose ordinary rounds are not spent is never merged", async () => {
  // 618 at its pin (7) still holds its one final round and is admissible on
  // the ordinary count; at two rounds (no ledger) it is not.
  const record = park(REVIEW_ROUND_CEILING_BASE_MOVED, 2);
  const snapshot = liveSnapshot([record], liveReceipts(record));
  assert.equal(spentDeliveryAdmissible(record, snapshot), false);
  const { calls, rig } = await deliver("x-low", record, TIP, true);
  assert.deepEqual(calls.merges, []);
  assert.equal(rig.writes, 0);
});

Deno.test({
  name:
    "cross-lane R79 rollback: a park and its spent delivery parse and bind under R79's own code",
  ignore: !r79,
  async fn() {
    const loaded = await loadGen79Modules(["src/repair/vps-delivery.ts"]);
    try {
      const [vps] = loaded.modules as unknown as [R79BindingV1];
      for (const message of REVIEW_ROUND_CEILING_MESSAGES) {
        // Every park the cap runtime writes parses under R79.
        const parked = park(message);
        await assertGen79Parses(liveSnapshot([parked], liveReceipts(parked)));
      }
      const record = park(REVIEW_ROUND_CEILING_REVIEWED);
      const [receipt] = liveReceipts(record);
      const { after } = await deliver(
        "x-r79",
        record,
        record.target.base!,
        false,
      );
      await assertGen79Parses(after);
      const [written] = after.work;
      const [request] = after.releaseRequests;
      assert.equal(written.nextStep, "delivery");
      assert.equal(
        await vps.gatewayRequestBindsDelivery(request, written, receipt),
        true,
        "the delivered park binds under R79",
      );
      assert.equal(
        await vps.gatewayRequestBindsDelivery(request, record, receipt),
        false,
        "the park it replaces never binds",
      );
    } finally {
      await loaded.dispose();
    }
  },
});
