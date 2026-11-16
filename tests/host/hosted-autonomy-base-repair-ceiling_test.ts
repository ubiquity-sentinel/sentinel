/**
 * The base-repair open ceiling (`BASE_REPAIR_OPEN_LIMIT` open issues this
 * pass may have filed), through the real maintenance pass
 * (`runHostedAutonomy`) with fake GitHub targets and an injected clock. The
 * third review found two ways to more than one open base-repair issue: a
 * person rewrites both the title and the first line of the open one, so
 * nothing recognises it once the hard bound's window has passed, and a
 * create GitHub answers under another author never shows in the App
 * listing, so the next UTC day files again. Neither needs any issue's text
 * to stop now: the ceiling counts every open issue the App opened in the
 * target (but its review follow-ups) and every open issue a trusted
 * creator's create left with the marker, and it holds while two are open.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  BASE_REPAIR_OPEN_LIMIT,
  BASE_REPAIR_OPEN_WINDOW_MS,
} from "../../ops/hosted-autonomy-base-repair-bounds.ts";
import {
  AI,
  appIssue,
  DAY,
  type FakeItem,
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

const MINUTE = 60_000;

/** The live records at `now`, the ai.ubq.fi one on `tip`. */
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

/** A person rewrites both the title and the first line of issue `number`. */
function rewrite(target: ReturnType<typeof redTargets>[string], n: number) {
  const issue = target.items.find((item) => item.number === n)!;
  issue.title = "Investigating the development build";
  issue.firstLine = "Looking into this, see the linked branch.";
}

Deno.test("base repair ceiling: issues a person rewrote and left open stop the next filing, past every window", async () => {
  assert.equal(BASE_REPAIR_OPEN_LIMIT, 2);
  assert.equal(BASE_REPAIR_OPEN_WINDOW_MS, 14 * DAY);
  const targets = redTargets();
  const ai = targets[AI];
  const actions: string[] = [];
  // Each red tip comes once the hard bound's window has passed; each filed
  // issue is rewritten beyond recognition and left open.
  for (let index = 0; index < 4; index++) {
    const now = NOW + index * (14 * DAY + MINUTE);
    if (index > 0) redTip(ai, tipAt(index));
    const pass = await maintain(onTip(ai.tip, now), targets, now);
    actions.push(...pass.baseRepair);
    for (const item of ai.issues) rewrite(ai, item.number);
  }
  assert.deepEqual(actions, [
    `${TAG}:filed=#9000`,
    `${TAG}:filed=#9001`,
    `${TAG}:open_ceiling=#9001`,
    `${TAG}:open_ceiling=#9001`,
  ]);
  assert.equal(ai.created.length, 2, "two open, never a third");
  // Closing one lets the next red tip file.
  ai.items.find((item) => item.number === 9000)!.state = "closed";
  const later = NOW + 4 * (14 * DAY + MINUTE);
  redTip(ai, tipAt(9));
  const after = await maintain(onTip(ai.tip, later), targets, later);
  assert.deepEqual(after.baseRepair, [`${TAG}:filed=#9002`]);
});

Deno.test("base repair ceiling: creates answered under a member's login stop at two open, not one a day", async () => {
  const targets = redTargets({ create: "foreign" });
  const ai = targets[AI];
  const actions: string[] = [];
  for (let day = 0; day < 5; day++) {
    const now = NOW + day * DAY;
    actions.push(
      ...(await maintain(onTip(ai.tip, now), targets, now))
        .baseRepair,
    );
  }
  // The second, a day later, then nothing while both stay open.
  assert.deepEqual(actions, [
    `${TAG}:file_failed`,
    `${TAG}:file_failed`,
    `${TAG}:open_ceiling=#9001`,
    `${TAG}:open_ceiling=#9001`,
    `${TAG}:open_ceiling=#9001`,
  ]);
  assert.equal(ai.created.length, 2);
  // Past the window they no longer count: one more, then the ceiling again.
  const later = NOW + DAY + BASE_REPAIR_OPEN_WINDOW_MS + HOUR;
  const after = await maintain(onTip(ai.tip, later), targets, later);
  assert.deepEqual(after.baseRepair, [`${TAG}:file_failed`]);
  assert.equal(ai.created.length, 3);
});

Deno.test("base repair ceiling: a listing blind to the App's issues stops at two open", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  // The `creator` filter answers the App's pull requests and none of its
  // issues: only GitHub's created-since record shows what was filed.
  ai.appListing = (app) => app.filter((item) => item.pullRequest);
  const actions: string[] = [];
  for (let day = 0; day < 4; day++) {
    const now = NOW + day * DAY;
    actions.push(
      ...(await maintain(onTip(ai.tip, now), targets, now))
        .baseRepair,
    );
  }
  assert.deepEqual(actions, [
    `${TAG}:filed=#9000`,
    `${TAG}:filed=#9001`,
    `${TAG}:open_ceiling=#9001`,
    `${TAG}:open_ceiling=#9001`,
  ]);
  assert.equal(ai.created.length, 2);
});

Deno.test("base repair ceiling: the App's review follow-ups never count; its other open issues do", async () => {
  // Opened 20 days ago, past the hard bound's window, and still open.
  const old = NOW - 20 * DAY;
  const followUp = (number: number, repo = "ubiquity/ai.ubq.fi"): FakeItem =>
    appIssue(
      number,
      `<!-- sentinel:review-followup:v2 repo=${repo} pr=1300 receipt=r finding=f${number} depth=1 -->`,
      { title: "[P2] Tighten a check", createdAt: old },
    );
  const other = (number: number): FakeItem =>
    appIssue(number, "<!-- sentinel:skip -->", {
      title: "Sentinel needs an owner action",
      createdAt: old,
    });
  const cases: [string, FakeItem[], string][] = [
    [
      "three follow-ups",
      [followUp(81), followUp(82), followUp(83)],
      `${TAG}:filed=#9000`,
    ],
    ["one other open issue", [followUp(81), other(84)], `${TAG}:filed=#9000`],
    [
      "two other open issues",
      [other(84), other(85)],
      `${TAG}:open_ceiling=#85`,
    ],
    // A follow-up marker naming another target is no follow-up of this one.
    [
      "another target's marker",
      [other(84), followUp(86, "ubiquity/uusd.ubq.fi")],
      `${TAG}:open_ceiling=#86`,
    ],
    [
      "closed ones",
      [
        { ...other(84), state: "closed" },
        { ...other(85), state: "closed" },
      ],
      `${TAG}:filed=#9000`,
    ],
  ];
  for (const [label, issues, expected] of cases) {
    const targets = redTargets({ issues });
    const pass = await maintain(onTip(targets[AI].tip, NOW), targets);
    assert.deepEqual(pass.baseRepair, [expected], label);
  }
});

Deno.test("base repair ceiling: a listing that does not reach back past the window files nothing", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  // Past the day's start but not the window's: the brake is proven, the
  // ceiling is not.
  ai.dayListing = (all) =>
    all.filter((item) => item.createdAt >= NOW - 5 * DAY);
  ai.items.push(
    appIssue(77, "a question", { author: "someone", createdAt: NOW - 2 * DAY }),
  );
  const pass = await maintain(onTip(ai.tip, NOW), targets);
  assert.deepEqual(pass.baseRepair, [`${TAG}:ceiling_unproven`]);
  assert.equal(ai.created.length, 0);
  // A marked issue whose creator GitHub does not place, in the window.
  const unplaced = redTargets({
    issues: [
      appIssue(78, "<!-- sentinel:base-repair:development -->", {
        author: "someone",
        association: null,
        createdAt: NOW - 3 * DAY,
      }),
    ],
  });
  const second = await maintain(onTip(unplaced[AI].tip, NOW), unplaced);
  assert.deepEqual(second.baseRepair, [`${TAG}:ceiling_unproven`]);
});
