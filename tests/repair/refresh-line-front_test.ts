/**
 * The refresh line's front is the oldest record that can act now (live
 * ubiquity-sentinel/sentinel, 2026-11-13/14).
 *
 * A record on a moved base asks the line before its CI gate is read, and the
 * deferral writes nothing, so the wait it carries is whatever an earlier step
 * left: record 268 (PR 390), refreshed at 19:40Z and green since 19:47Z, kept
 * `ci_pending` from 19:40:12Z after the tip moved under it; 397 (PR 399), green
 * since 17:16Z, kept `ci_pending` from 17:10:08Z; 398 (PR 400) kept the expired
 * `unavailable` wait its pull request creation left at 18:16:17Z. Ordered by
 * that leftover wait (`ci_pending` last), the line put 271 ahead of 268 at
 * 20:39Z and, from 00:18Z, 398 ahead of both older green heads; past the
 * six-hour pre-review CI bound 397 held nobody at all. Record 312 (PR 313),
 * stalled at 180 executions without progress, was stepped after the younger
 * front 386 and refreshed onto the same tip at 23:00:17Z (two refreshes, then
 * two reviews at 00:12Z and 00:13Z in one repository). A stalled head on a
 * moved base keeps its place by age: its count is what its steps on an
 * earlier tip left, and its next step, the refresh, clears it (sent to the
 * back of the line instead, nothing ever released it).
 *
 * The REAL serial repair cycle over in-memory state and a fake repository; no
 * network, no model call.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DELIVERY_QUEUE_STALL_LIMIT } from "../../src/repair/delivery-queue.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { T0 } from "../state/helpers.ts";
import { queueRig } from "./delivery-queue-rig.ts";
import { captured } from "./repository-pass-rig.ts";
import { MINUTE, sha } from "./review-round-cap-rig.ts";

const HOUR = 60 * MINUTE;
const TIP = sha(0x777);

type Rig = Awaited<ReturnType<typeof queueRig>>;

/** The pull request of every prepared refresh, in order. */
function refreshed(rig: Rig): number[] {
  return rig.github.preparedKeys.map((key) => Number(key.split(":")[0]));
}

/**
 * `limit` runtime passes 16 minutes apart, or fewer once every pull request
 * of `prs` merged; after each one at most one record of the repository holds
 * a refresh or a review in flight.
 */
async function passes(rig: Rig, limit: number, prs: readonly number[] = []) {
  for (
    let run = 0;
    run < limit &&
    !(prs.length > 0 && prs.every((pr) => rig.github.merged.includes(pr)));
    run++
  ) {
    await captured(() =>
      runRepairCycle(rig.deps, {
        deadline: rig.clock.now() + 60 * MINUTE,
        stepLimit: 16,
      })
    );
    const busy = (await rig.snapshot()).work.filter((record) =>
      record.intent?.kind === "base_refresh" ||
      record.intent?.kind === "review_request" || record.nextStep === "review"
    ).map((record) => record.id);
    assert.ok(busy.length <= 1, `pass ${run}: ${busy}`);
    rig.clock.advance(16 * MINUTE);
  }
}

/** Every base tip took one record's refreshes and one record's reviews. */
function onePerTip(rig: Rig): void {
  const prs = new Map<string, Set<number>>();
  const add = (what: string, pr: number) =>
    prs.set(what, (prs.get(what) ?? new Set<number>()).add(pr));
  for (const key of rig.github.preparedKeys) {
    const [pr, , base] = key.split(":");
    add(`refresh onto ${base}`, Number(pr));
  }
  for (const { pr, base } of rig.github.reviewed) add(`review on ${base}`, pr);
  for (const [what, on] of prs) assert.equal(on.size, 1, `${what}: ${[...on]}`);
}

/** `pr` refreshed, pushed and requested nothing; its record is unchanged. */
async function untouched(rig: Rig, pr: number) {
  const seeded = rig.records.find((record) => record.target.pr === pr)!;
  const now = (await rig.snapshot()).work.find((row) => row.id === seeded.id);
  assert.deepEqual(now, seeded, `PR ${pr} kept its record`);
  assert.ok(!refreshed(rig).includes(pr), `PR ${pr} refreshed nothing`);
  assert.ok(
    rig.github.pushes.every((push) => !push.ref.endsWith(seeded.id)),
    `PR ${pr} pushed nothing`,
  );
  assert.ok(
    rig.github.reviewed.every((review) => review.pr !== pr),
    `PR ${pr} requested no review`,
  );
}

/** A wait whose two-minute poll window ended long ago. */
function leftover(
  reason: "ci_pending" | "unavailable",
  since: number,
): WorkRecordV1["wait"] {
  return { reason, since, until: since + 2 * MINUTE };
}

/** `count` published heads on a moved base, created a month ago in order. */
function agedLine(
  count: number,
  shape: (records: WorkRecordV1[]) => WorkRecordV1[],
) {
  return queueRig(count, {
    tip: TIP,
    shape: (records) =>
      shape(records.map((record, index) => ({
        ...record,
        firstSeenAt: T0 - 31 * 24 * HOUR,
        createdAt: T0 - 30 * 24 * HOUR + index,
      }))),
  });
}

/**
 * One serial pass over three published heads on a moved base, created a month
 * ago in issue order: the refreshed pull requests and every deferral. A
 * refreshed head's CI is still running, as live 386's was at 23:00:17Z.
 */
async function pass(shape: (records: WorkRecordV1[]) => WorkRecordV1[]) {
  const rig = await agedLine(3, shape);
  for (const refreshed of [sha(0x5001), sha(0x5002), sha(0x5003)]) {
    rig.github.checksByHead.set(refreshed, [{
      name: "validate",
      status: "in_progress",
      conclusion: null,
      head: refreshed,
      startedAt: T0,
      completedAt: null,
    }]);
  }
  const { lines } = await captured(() =>
    runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
    })
  );
  const steps = lines.filter((entry) => entry.kind === STEP_LINE_KIND);
  return {
    refreshed: rig.github.preparedKeys.map((key) => Number(key.split(":")[0])),
    deferred: steps.filter((entry) => entry.outcome === "deferred")
      .map((entry) => [entry.recordId, entry.reason ?? null]),
  };
}

Deno.test("refresh line: the oldest head goes first whatever wait an earlier step left", async () => {
  // issue-1 is 268, issue-2 397 (its leftover CI wait past the six-hour
  // pre-review bound) and issue-3 398, oldest first.
  const out = await pass(([first, second, third]) => [
    { ...first!, wait: leftover("ci_pending", T0 - 4 * HOUR) },
    { ...second!, wait: leftover("ci_pending", T0 - 7 * HOUR) },
    {
      ...third!,
      wait: leftover("unavailable", T0 - 6 * HOUR),
      updatedAt: T0 - 5 * HOUR,
    },
  ]);
  assert.deepEqual(out.refreshed, [101], "one refresh: the oldest head's");
  assert.deepEqual(out.deferred, [
    ["issue-2", "ci_line"],
    ["issue-3", "ci_line"],
  ]);
});

Deno.test("refresh line: a stalled head on a moved base keeps its place instead of refreshing beside the front", async () => {
  // issue-1 is 312: the oldest, stalled at 180 on an earlier tip, its red
  // backoff long expired, stepped last (demoted); issue-2 (386) and issue-3
  // can act. It is the front by age, so nobody refreshes beside it.
  const out = await pass(([first, second, third]) => [
    {
      ...first!,
      counters: { ...first!.counters, stalled: 180 },
      wait: {
        reason: "backoff",
        since: T0 - 7 * 24 * HOUR,
        until: T0 - 20 * HOUR,
      },
      updatedAt: T0 - 20 * HOUR,
    },
    { ...second!, wait: leftover("unavailable", T0 - 22 * HOUR) },
    { ...third!, wait: leftover("ci_pending", T0 - 3 * HOUR) },
  ]);
  assert.deepEqual(out.refreshed, [101], "one refresh: the oldest head's");
  assert.deepEqual(out.deferred, [
    ["issue-2", "ci_line"],
    ["issue-3", "ci_line"],
  ]);
});

Deno.test("refresh line: a head stalled by its red base takes its turn by age once the base is repaired", async () => {
  // issue-1 was held on its old tip by a red base for six and a half hours
  // (12 re-arms of the 30-minute hold, the last due a minute ago) until a
  // direct push repaired the base. issue-2 and issue-3 can deliver; issue-4,
  // the youngest, is held by a native queue-custody hold that never ends, so
  // it never reaches the line and never refreshes.
  const rig = await agedLine(4, ([stalled, second, third, held]) => [
    {
      ...stalled!,
      counters: { ...stalled!.counters, stalled: DELIVERY_QUEUE_STALL_LIMIT },
      wait: {
        reason: "backoff",
        since: T0 - 31 * MINUTE,
        until: T0 - MINUTE,
      },
      updatedAt: T0 - 31 * MINUTE,
    },
    second!,
    third!,
    {
      ...held!,
      wait: { reason: "backoff", since: T0 - HOUR, until: null },
      updatedAt: T0 - HOUR,
    },
  ]);
  await passes(rig, 12, [101, 102, 103]);
  assert.deepEqual(rig.github.merged, [101, 102, 103], "oldest first");
  assert.deepEqual(refreshed(rig), [101, 102, 103], "one refresh each");
  onePerTip(rig);
  await untouched(rig, 104);
});

Deno.test("refresh line: an older head whose wait never ends yields its place once nothing wrote it for the idle bound", async () => {
  // issue-1, the oldest, took a native queue-custody hold (`backoff` with no
  // end) an hour ago: selection never steps it, so it never reaches the line.
  const rig = await agedLine(3, ([held, second, third]) => [
    {
      ...held!,
      wait: { reason: "backoff", since: T0 - HOUR, until: null },
      updatedAt: T0 - HOUR,
    },
    second!,
    third!,
  ]);
  // Inside the idle bound it keeps its place, so a hold released soon
  // refreshes first: four passes, 48 minutes, nothing refreshes.
  await passes(rig, 4);
  assert.deepEqual(refreshed(rig), []);
  // Past it the next oldest is the front and the line moves, one at a time;
  // the held record is neither parked nor charged, and nothing touched it.
  await passes(rig, 12, [102, 103]);
  assert.deepEqual(rig.github.merged, [102, 103]);
  assert.deepEqual(refreshed(rig), [102, 103], "one refresh each");
  onePerTip(rig);
  await untouched(rig, 101);
  assert.equal(
    (await rig.snapshot()).reservations.some((row) =>
      row.taskId === rig.records[0].id
    ),
    false,
    "nothing charged to the held record",
  );
});
