/**
 * Base-repair filing bounds through the real maintenance pass
 * (`runHostedAutonomy`) with fake GitHub targets and an injected clock, as
 * the review of the 2026-11-15 enablement reproduced them.
 *
 * Hard bound (`BASE_REPAIR_ISSUE_LIMIT` = 1 within
 * `BASE_REPAIR_ISSUE_WINDOW_MS` = 14 days): a base-repair issue is one by its
 * first-line marker OR its exact title, open or closed, so a person closing
 * it, a person editing its first line, and a flaky check re-redding the base
 * after each merged fix never file a second one within the window.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  AI,
  DAY,
  H1,
  held,
  HOUR,
  maintain,
  MARKER,
  NOW,
  P1,
  PERMIT2,
  redTargets,
  TAG,
  U1,
  UUSD,
} from "./hosted-autonomy-base-repair-fixtures.ts";

/** The live records at `now`, the ai.ubq.fi one refreshed onto `tip`. */
function onTip(tip: string, now: number): WorkRecordV1[] {
  return [
    held(AI, 1176, H1, { base: tip, now }),
    held(UUSD, 40, U1, { now }),
    held(PERMIT2, 31, P1, { now }),
  ];
}

/** A new red tip of ai.ubq.fi that its held head fails too. */
function redTip(target: ReturnType<typeof redTargets>[string], tip: string) {
  target.tip = tip;
  target.failed[tip] = ["validate"];
}

const tipAt = (index: number) => index.toString(16).padStart(2, "e").repeat(20);

Deno.test("base repair limit: a person closing the issue lets no red tip file another within 14 days", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  const first = await maintain(onTip(ai.tip, NOW), targets);
  assert.deepEqual(first.baseRepair, [`${TAG}:filed=#9000`]);
  // A person closes it (any reason); each later red tip holds the record.
  const times = [NOW + HOUR, NOW + 2 * DAY, NOW + 7 * DAY, NOW + 14 * DAY];
  for (const [index, now] of times.entries()) {
    ai.items.find((item) => item.number === 9000)!.state = "closed";
    redTip(ai, tipAt(index + 1));
    const pass = await maintain(onTip(ai.tip, now), targets, now);
    assert.deepEqual(pass.baseRepair, [`${TAG}:recent=#9000`], `tip ${index}`);
  }
  assert.equal(ai.created.length, 1, "four red tips after a close: one issue");
  // The bound is a window: past it, the next red tip files exactly one.
  const later = NOW + 14 * DAY + 60_000;
  redTip(ai, tipAt(9));
  const after = await maintain(onTip(ai.tip, later), targets, later);
  assert.deepEqual(after.baseRepair, [`${TAG}:filed=#9001`]);
  const again = await maintain(onTip(ai.tip, later + HOUR), targets, later);
  assert.deepEqual(again.baseRepair, [`${TAG}:filed_before=#9001`]);
  assert.equal(ai.created.length, 2);
});

Deno.test("base repair limit: an edited first line or title leaves the issue recognised, so no second one is filed", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  await maintain(onTip(ai.tip, NOW), targets);
  const issue = ai.items.find((item) => item.number === 9000)!;
  // A person rewrites the marker line; the same tip stays red: by its title
  // it is still the one open base-repair issue.
  issue.firstLine = "Looking into this, see the linked branch.";
  const edited = await maintain(onTip(ai.tip, NOW + HOUR), targets, NOW + HOUR);
  assert.deepEqual(edited.baseRepair, [`${TAG}:open=#9000`]);
  // The title instead, on a new red tip: by its marker.
  issue.firstLine = MARKER;
  issue.title = "Fix the development build";
  redTip(ai, tipAt(1));
  const t2 = NOW + 2 * HOUR;
  const retitled = await maintain(onTip(ai.tip, t2), targets, t2);
  assert.deepEqual(retitled.baseRepair, [`${TAG}:open=#9000`]);
  // Edited and then closed: still within the bound's window.
  issue.firstLine = "Not needed.";
  issue.title = "CI is failing on development";
  issue.state = "closed";
  redTip(ai, tipAt(2));
  const closed = await maintain(onTip(ai.tip, NOW + DAY), targets, NOW + DAY);
  assert.deepEqual(closed.baseRepair, [`${TAG}:recent=#9000`]);
  assert.equal(ai.created.length, 1);
  assert.equal(ai.issues.length, 1, "never two open for one tip");
});

Deno.test("base repair limit: the bound holds across many red tips while each merged fix closes the issue", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  const actions: string[] = [];
  // A flaky check: every 36 hours the base turns red at a new tip, and the
  // open issue (if any) was closed by its merged fix in between.
  for (let index = 0; index < 9; index++) {
    const now = NOW + index * 36 * HOUR;
    for (const item of ai.issues) item.state = "closed";
    if (index > 0) redTip(ai, tipAt(index));
    const pass = await maintain(onTip(ai.tip, now), targets, now);
    actions.push(...pass.baseRepair);
  }
  assert.deepEqual(actions, [
    `${TAG}:filed=#9000`,
    ...Array.from({ length: 8 }, () => `${TAG}:recent=#9000`),
  ]);
  assert.equal(ai.created.length, 1, "nine red tips in 12 days: one issue");
});
