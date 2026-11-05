import assert from "node:assert/strict";
import {
  advanceUpkeepDeferralStreak,
  parseUpkeepDeferralStreakV1,
  settleUpkeepDeferralStreak,
  UPKEEP_DEFERRAL_NOTICE_TITLE,
  type UpkeepDeferralNoticeV1,
  type UpkeepDeferralStreakStoreV1,
  type UpkeepDeferralStreakV1,
} from "../../src/host/upkeep-deferral-streak.ts";
import { upkeepDeferralReason } from "../../ops/hosted-autonomy-queue-output.ts";

/** Expected-head fake of the trusted writer; every write moves the head. */
function fakeStore(): UpkeepDeferralStreakStoreV1 & {
  value: UpkeepDeferralStreakV1 | null;
  head: number;
  writes: number;
  refuseNext: boolean;
} {
  const store = {
    value: null as UpkeepDeferralStreakV1 | null,
    head: 0,
    writes: 0,
    refuseNext: false,
    read: () =>
      Promise.resolve({ head: `h${store.head}`, streak: store.value }),
    write: (next: UpkeepDeferralStreakV1, expectedHead: string) => {
      if (store.refuseNext || expectedHead !== `h${store.head}`) {
        store.refuseNext = false;
        return Promise.resolve("conflict" as const);
      }
      store.value = structuredClone(next);
      store.head++;
      store.writes++;
      return Promise.resolve("applied" as const);
    },
  };
  return store;
}

function fakeNotice() {
  const sent: UpkeepDeferralNoticeV1[] = [];
  return {
    sent,
    publish: (notice: UpkeepDeferralNoticeV1) => {
      sent.push(structuredClone(notice));
      return Promise.resolve(true);
    },
  };
}

// The exact report line every 2026-11-03 maintenance run printed, as it is
// classified after the fix: the same incomplete pass now reports a skip.
const NOV3_DEFERRED = {
  kind: "hosted_autonomy",
  status: "skipped",
  reason: "deferred_historical_quarantine",
} as const;

Deno.test("upkeep deferral streak: third consecutive deferral emits exactly one notice", async () => {
  const store = fakeStore();
  const notice = fakeNotice();
  const reason = upkeepDeferralReason(NOV3_DEFERRED);
  assert.equal(reason, "deferred_historical_quarantine");
  const outcomes = [];
  for (let runId = 101; runId <= 106; runId++) {
    outcomes.push(
      await settleUpkeepDeferralStreak({
        store,
        notice,
        observation: { runId, reason },
      }),
    );
    if (runId === 102) assert.equal(notice.sent.length, 0);
  }
  assert.deepEqual(outcomes.map((row) => row.notified), [
    false,
    false,
    true,
    false,
    false,
    false,
  ]);
  assert.deepEqual(notice.sent, [{
    title: UPKEEP_DEFERRAL_NOTICE_TITLE,
    reason: "deferred_historical_quarantine",
    runId: 103,
  }]);
  // Non-sensitive: only title, closed reason code and run id.
  assert.deepEqual(Object.keys(notice.sent[0]).sort(), [
    "reason",
    "runId",
    "title",
  ]);
  assert.doesNotMatch(JSON.stringify(notice.sent), /https?:|token/i);
  assert.deepEqual(store.value, {
    version: 1,
    count: 6,
    notified: true,
    lastRunId: 106,
  });
});

Deno.test("upkeep deferral streak: a pass that did not defer resets, and a rerun never double-counts", async () => {
  const store = fakeStore();
  const notice = fakeNotice();
  const reason = "deferred_historical_quarantine" as const;
  await settleUpkeepDeferralStreak({
    store,
    notice,
    observation: { runId: 1, reason },
  });
  await settleUpkeepDeferralStreak({
    store,
    notice,
    observation: { runId: 2, reason },
  });
  // A rerun of run 2's finalize is unchanged and writes nothing.
  const writes = store.writes;
  assert.deepEqual(
    await settleUpkeepDeferralStreak({
      store,
      notice,
      observation: { runId: 2, reason },
    }),
    { status: "unchanged", notified: false },
  );
  assert.equal(store.writes, writes);
  await settleUpkeepDeferralStreak({
    store,
    notice,
    observation: { runId: 3, reason: null },
  });
  assert.equal(store.value?.count, 0);
  for (const runId of [4, 5]) {
    await settleUpkeepDeferralStreak({
      store,
      notice,
      observation: { runId, reason },
    });
  }
  assert.equal(notice.sent.length, 0);
  await settleUpkeepDeferralStreak({
    store,
    notice,
    observation: { runId: 6, reason: "deferred_matrix_history_budget" },
  });
  assert.deepEqual(notice.sent.map((row) => [row.runId, row.reason]), [
    [6, "deferred_matrix_history_budget"],
  ]);
});

Deno.test("upkeep deferral streak: refused expected-head write publishes nothing", async () => {
  const store = fakeStore();
  const notice = fakeNotice();
  const reason = "deferred_historical_quarantine" as const;
  await settleUpkeepDeferralStreak({
    store,
    notice,
    observation: { runId: 1, reason },
  });
  await settleUpkeepDeferralStreak({
    store,
    notice,
    observation: { runId: 2, reason },
  });
  store.refuseNext = true;
  assert.deepEqual(
    await settleUpkeepDeferralStreak({
      store,
      notice,
      observation: { runId: 3, reason },
    }),
    { status: "conflict", notified: false },
  );
  assert.equal(notice.sent.length, 0);
  // The next finalize counts from the durable value and claims the notice once.
  await settleUpkeepDeferralStreak({
    store,
    notice,
    observation: { runId: 4, reason },
  });
  assert.equal(notice.sent.length, 1);
});

Deno.test("upkeep deferral streak: strict bounded reader and closed reasons", () => {
  assert.equal(
    parseUpkeepDeferralStreakV1({ version: 1, count: 1, notified: false }),
    null,
  );
  assert.equal(
    parseUpkeepDeferralStreakV1({
      version: 1,
      count: 1_001,
      notified: false,
      lastRunId: 1,
    }),
    null,
  );
  assert.equal(
    parseUpkeepDeferralStreakV1({
      version: 1,
      count: 2,
      notified: false,
      lastRunId: 1,
      url: "x",
    }),
    null,
  );
  assert.equal(
    upkeepDeferralReason({
      status: "failed",
      reason: "historical_quarantine_incomplete",
    }),
    null,
  );
  assert.equal(
    upkeepDeferralReason({ status: "skipped", reason: "no_work" }),
    null,
  );
  const capped = advanceUpkeepDeferralStreak(
    { version: 1, count: 1_000, notified: true, lastRunId: 9 },
    { runId: 10, reason: "deferred_unexpected_error" },
  );
  assert.equal(capped.next.count, 1_000);
  assert.equal(capped.notice, null);
});
