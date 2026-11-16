/**
 * The base-repair bound policy (`BASE_REPAIR_BOUND_POLICY`), an open owner
 * decision: which App issues the 14-day hard bound counts. The third review
 * found that the strict bound (every App issue, whatever it says) also
 * counts the App's other issues in the target, one review follow-up per
 * finding, and on ai.ubq.fi's history would have left filing possible for
 * about 7 hours a month. The relaxed bound, the default until the owner
 * decides, counts only base-repair issues (marker, or exact title once the
 * marker is edited away). Both modes run here through the real pass with
 * fake GitHub targets and an injected clock: the default through the whole
 * maintenance pass (`maintain`), the strict one through the pass alone
 * (`fileUnder`), since the maintenance pass never names a mode.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { BASE_REPAIR_BOUND_POLICY } from "../../ops/hosted-autonomy-base-repair-bounds.ts";
import {
  AI,
  appIssue,
  DAY,
  type FakeItem,
  fileUnder,
  H1,
  held,
  HOUR,
  maintain,
  NOW,
  P1,
  PERMIT2,
  redTargets,
  TAG,
  U1,
  UUSD,
} from "./hosted-autonomy-base-repair-fixtures.ts";

/** The live records at `now`, the ai.ubq.fi one on `tip`. */
function onTip(tip: string, now: number): WorkRecordV1[] {
  return [
    held(AI, 1176, H1, { base: tip, now }),
    held(UUSD, 40, U1, { now }),
    held(PERMIT2, 31, P1, { now }),
  ];
}

/** A review follow-up the App opened `age` ago, closed by its own fix. */
const followUp = (age: number): FakeItem =>
  appIssue(
    8100,
    "<!-- sentinel:review-followup:v2 repo=ubiquity/ai.ubq.fi pr=1300 receipt=r finding=f depth=1 -->",
    {
      title: "[P2] Widen ps args before matching the queued gate marker",
      state: "closed",
      createdAt: NOW - age,
    },
  );

Deno.test("base repair policy: one named switch, relaxed until the owner decides", async () => {
  assert.equal(BASE_REPAIR_BOUND_POLICY, "relaxed");
  // The maintenance pass files under it: a follow-up of three days ago,
  // which the strict bound counts, holds nothing there.
  const targets = redTargets({ issues: [followUp(3 * DAY)] });
  const pass = await maintain(onTip(targets[AI].tip, NOW), targets);
  assert.deepEqual(pass.baseRepair, [`${TAG}:filed=#9000`]);
  const strict = redTargets({ issues: [followUp(3 * DAY)] });
  const held = await fileUnder("strict", onTip(strict[AI].tip, NOW), strict);
  assert.deepEqual(held.baseRepair, [`${TAG}:recent=#8100`]);
});

Deno.test("base repair policy: an unrelated App issue holds filing for 14 days under strict, and only its own day under relaxed", async () => {
  const cases: [string, number, string, string][] = [
    // Strict holds the window; relaxed files.
    ["13 days", 13 * DAY, `${TAG}:recent=#8100`, `${TAG}:filed=#9000`],
    ["15 days", 15 * DAY, `${TAG}:filed=#9000`, `${TAG}:filed=#9000`],
    // Opened today: the daily brake holds the day in either mode (strict
    // reaches it first through the hard bound).
    ["today", HOUR, `${TAG}:recent=#8100`, `${TAG}:filed_today=#8100`],
  ];
  for (const [label, age, strict, relaxed] of cases) {
    const a = redTargets({ issues: [followUp(age)] });
    const b = redTargets({ issues: [followUp(age)] });
    assert.deepEqual(
      (await fileUnder("strict", onTip(a[AI].tip, NOW), a)).baseRepair,
      [strict],
      `strict ${label}`,
    );
    assert.deepEqual(
      (await fileUnder("relaxed", onTip(b[AI].tip, NOW), b)).baseRepair,
      [relaxed],
      `relaxed ${label}`,
    );
  }
});

Deno.test("base repair policy: relaxed, a rewritten issue holds its own day, and the open ceiling what is left open", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  const step = async (now: number) =>
    (await maintain(onTip(ai.tip, now), targets, now)).baseRepair;
  const rewrite = (number: number) => {
    const issue = ai.items.find((item) => item.number === number)!;
    issue.title = "Investigating the development build";
    issue.firstLine = "Looking into this, see the linked branch.";
  };
  assert.deepEqual(await step(NOW), [`${TAG}:filed=#9000`]);
  rewrite(9000);
  // That day: nothing recognises it, but the App opened it today.
  assert.deepEqual(await step(NOW + HOUR), [`${TAG}:filed_today=#9000`]);
  // The next day the relaxed bound lets one more through while it is open.
  assert.deepEqual(await step(NOW + DAY), [`${TAG}:filed=#9001`]);
  // That one carries this tip's marker, so it holds every later pass.
  assert.deepEqual(await step(NOW + 2 * DAY), [`${TAG}:filed_before=#9001`]);
  // Rewritten too: two open issues of this pass, the ceiling holds.
  rewrite(9001);
  assert.deepEqual(await step(NOW + 3 * DAY), [`${TAG}:open_ceiling=#9001`]);
  assert.equal(ai.created.length, 2);
  // Strict would have held the same rewritten issue for 14 days instead.
  const strict = redTargets();
  await fileUnder("strict", onTip(strict[AI].tip, NOW), strict);
  const issue = strict[AI].items.find((item) => item.number === 9000)!;
  issue.title = "Investigating the development build";
  issue.firstLine = "Looking into this, see the linked branch.";
  const next = await fileUnder(
    "strict",
    onTip(strict[AI].tip, NOW + DAY),
    strict,
    NOW + DAY,
  );
  assert.deepEqual(next.baseRepair, [`${TAG}:recent=#9000`]);
});
