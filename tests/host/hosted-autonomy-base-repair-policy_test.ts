import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  AI,
  appIssue,
  DAY,
  H1,
  held,
  HOUR,
  maintain,
  marker,
  NOW,
  OLD_TIP,
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

Deno.test("base repair policy: a different red tip can file after #1370 closed nine days earlier", async () => {
  const now = Date.parse("2026-11-26T21:47:31Z");
  const targets = redTargets({
    issues: [
      appIssue(1370, marker(OLD_TIP), {
        state: "closed",
        createdAt: Date.parse("2026-11-17T00:09:09Z"),
      }),
    ],
  });
  const ai = targets[AI];
  assert.notEqual(ai.tip, OLD_TIP);
  const first = await maintain(onTip(ai.tip, now), targets, now);
  assert.deepEqual(first.baseRepair, [`${TAG}:filed=#9000`]);
  assert.equal(ai.created.length, 1);
});

Deno.test("base repair policy: rewritten open issues still count toward the open ceiling", async () => {
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
  // On the next UTC day the unrecognized open issue still counts toward the ceiling.
  assert.deepEqual(await step(NOW + DAY), [`${TAG}:filed=#9001`]);
  // That one carries this tip's marker, so it holds every later pass.
  assert.deepEqual(await step(NOW + 2 * DAY), [`${TAG}:filed_before=#9001`]);
  // Rewritten too: two open issues of this pass, the ceiling holds.
  rewrite(9001);
  assert.deepEqual(await step(NOW + 3 * DAY), [`${TAG}:open_ceiling=#9001`]);
  assert.equal(ai.created.length, 2);
});
