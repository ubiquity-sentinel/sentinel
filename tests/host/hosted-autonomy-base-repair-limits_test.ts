/**
 * Base-repair filing bounds through the real maintenance pass
 * (`runHostedAutonomy`) with fake GitHub targets and an injected clock, as
 * the review of the 2026-11-15 enablement reproduced them.
 *
 * Same-tip deduplication and open-issue holds stay in place. A closed
 * repair for a different tip permits filing on a later UTC day.
 *
 * Listing proof: the App listing (`creator=ubiquity-sentinel[bot]`) had
 * never run live, and an empty answer counted as complete, so a filter that
 * matched nothing filed on every pass. It must now answer the held records'
 * own App pull requests, or nothing is filed (`listing_unproven`, printed
 * in the run's result line). Daily brake: GitHub's created-since listing,
 * without the filter, holds a second filing on the same UTC day, and one
 * run attempts at most one create per target and day.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  AI,
  APP,
  appIssue,
  DAY,
  type FakeItem,
  H1,
  H2,
  held,
  HOUR,
  maintain,
  maintenanceDeps,
  MARKER,
  marker,
  NOW,
  OLD_TIP,
  P1,
  PERMIT2,
  pullOf,
  redTargets,
  runMaintenance,
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
  // Closing the recognized issue permits a different red tip the next day.
  issue.firstLine = "Not needed.";
  issue.title = "CI is failing on development";
  issue.state = "closed";
  redTip(ai, tipAt(2));
  const closed = await maintain(onTip(ai.tip, NOW + DAY), targets, NOW + DAY);
  assert.deepEqual(closed.baseRepair, [`${TAG}:filed=#9001`]);
  assert.equal(ai.created.length, 2);
  assert.equal(ai.issues.filter((item) => item.state === "open").length, 1);
});

Deno.test("base repair limit: red tips on later days can file after the previous repair closes", async () => {
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
  assert.deepEqual(
    actions,
    Array.from({ length: 9 }, (_, index) => `${TAG}:filed=#${9000 + index}`),
  );
  assert.equal(ai.created.length, 9);
  assert.equal(ai.issues.filter((item) => item.state === "open").length, 1);
});

Deno.test("base repair proof: an empty App listing files nothing, pass after pass, with a fixed reason", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  // The `creator` filter matched nothing: GitHub answers an empty listing.
  ai.appListing = () => [];
  for (const minutes of [0, 5, 10]) {
    const now = NOW + minutes * 60_000;
    const pass = await maintain(onTip(ai.tip, now), targets, now);
    assert.deepEqual(pass.baseRepair, [`${TAG}:listing_unproven`]);
  }
  assert.equal(ai.created.length, 0, "three passes, no issue");
});

Deno.test("base repair proof: a listing without every held record's own pull request files nothing", async () => {
  const cases: [string, (app: FakeItem[]) => FakeItem[]][] = [
    ["only issues", (app) => app.filter((item) => !item.pullRequest)],
    [
      "not the first held",
      (app) => app.filter((item) => item.number !== pullOf(1176)),
    ],
    [
      "not the second held",
      (app) => app.filter((item) => item.number !== pullOf(1210)),
    ],
  ];
  for (const [label, listing] of cases) {
    const targets = redTargets({
      issues: [
        appIssue(77, marker(OLD_TIP), {
          state: "closed",
          createdAt: NOW - 30 * DAY,
        }),
      ],
    });
    targets[AI].appListing = listing;
    const records = [...onTip(targets[AI].tip, NOW), held(AI, 1210, H2)];
    const pass = await maintain(records, targets);
    assert.deepEqual(pass.baseRepair, [`${TAG}:listing_unproven`], label);
    assert.equal(targets[AI].created.length, 0, label);
  }
});

Deno.test("base repair proof: a listing proven live files exactly one issue, and many passes still one", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  const actions: string[] = [];
  for (let index = 0; index < 12; index++) {
    const now = NOW + index * 5 * 60_000;
    actions.push(
      ...(await maintain(onTip(ai.tip, now), targets, now))
        .baseRepair,
    );
  }
  assert.deepEqual(actions, [
    `${TAG}:filed=#9000`,
    ...Array.from({ length: 11 }, () => `${TAG}:filed_before=#9000`),
  ]);
  assert.equal(ai.created.length, 1);
});

Deno.test("base repair brake: a listing blind to the App's issues still files once per UTC day", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  // The filter answers the App's pull requests but none of its issues: the
  // App listing proof still holds; GitHub's own daily listing supplies the brake.
  ai.appListing = (app) => app.filter((item) => item.pullRequest);
  const actions: string[] = [];
  for (let index = 0; index < 6; index++) {
    const now = NOW + index * HOUR;
    actions.push(
      ...(await maintain(onTip(ai.tip, now), targets, now))
        .baseRepair,
    );
  }
  assert.deepEqual(actions, [
    `${TAG}:filed=#9000`,
    ...Array.from({ length: 5 }, () => `${TAG}:filed_today=#9000`),
  ]);
  // The residual of this fault: on the next UTC day only the brake is left.
  const tomorrow = (Math.floor(NOW / DAY) + 1) * DAY + HOUR;
  const next = await maintain(onTip(ai.tip, tomorrow), targets, tomorrow);
  assert.deepEqual(next.baseRepair, [`${TAG}:filed=#9001`]);
  assert.equal(ai.created.length, 2, "one a day, not one a pass");
});

Deno.test("base repair brake: one run files for a target at most once, whatever the listings say", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  // Both listings blind to the App's issues: only the run's own memory holds.
  ai.appListing = (app) => app.filter((item) => item.pullRequest);
  ai.dayListing = (all) =>
    all.filter((item) => item.author !== APP || item.pullRequest);
  const { deps, state } = await maintenanceDeps(onTip(ai.tip, NOW), targets);
  const first = await runMaintenance(deps, state);
  const second = await runMaintenance(deps, state);
  assert.deepEqual(first.baseRepair, [`${TAG}:filed=#9000`]);
  assert.deepEqual(second.baseRepair, [`${TAG}:attempted_this_run`]);
  assert.equal(ai.created.length, 1);
});

Deno.test("base repair brake: an unreadable day listing, or one that does not reach back past the day, files nothing", async () => {
  const cases: [string, (all: FakeItem[]) => FakeItem[] | null][] = [
    ["unreadable", () => null],
    ["empty", () => []],
    [
      "today only",
      (all) => all.filter((item) => item.createdAt >= NOW - 2 * HOUR),
    ],
  ];
  for (const [label, dayListing] of cases) {
    const targets = redTargets();
    // Someone else's issue of today, so "today only" is not empty.
    targets[AI].items.push(
      appIssue(77, "a question", { author: "someone", createdAt: NOW - HOUR }),
    );
    targets[AI].dayListing = dayListing;
    const pass = await maintain(onTip(targets[AI].tip, NOW), targets);
    assert.deepEqual(pass.baseRepair, [`${TAG}:day_unproven`], label);
    assert.equal(targets[AI].created.length, 0, label);
  }
});
