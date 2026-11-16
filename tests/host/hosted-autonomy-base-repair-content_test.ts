/**
 * Base-repair filing bounds that no issue text can lift, through the real
 * maintenance pass (`runHostedAutonomy`) with fake GitHub targets and an
 * injected clock, as the second review of the 2026-11-15 enablement
 * reproduced them.
 *
 * Every earlier bound recognised an existing issue by its content (the
 * first-line marker or the exact title), so a person rewriting BOTH filed
 * again at the next pass: sustained edits gave 288 issues in a day, and each
 * deletion gave one more. The daily brake counts every issue the App opened
 * in the target since the UTC day's start (less the skew margin), whatever
 * its title or body, and a trusted creator's marked issue. In the strict
 * bound policy (`fileUnder("strict", ...)`) the hard bound counts every App
 * issue created within `BASE_REPAIR_ISSUE_WINDOW_MS` too; the relaxed
 * policy, the default, has its own tests
 * (hosted-autonomy-base-repair-policy_test.ts).
 *
 * One run attempts at most one create per repository and UTC day, whatever
 * GitHub answered and under however many installation ids its records are
 * held; a create GitHub answered under another author holds the rest of the
 * day too.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  AI,
  APP,
  appIssue,
  DAY,
  type FakeItem,
  fileUnder,
  H1,
  H2,
  held,
  HOUR,
  maintain,
  maintenanceDeps,
  MARKER,
  NOW,
  P1,
  PERMIT2,
  redTargets,
  runMaintenance,
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

Deno.test("base repair content: strict, a rewritten title and first line file no second issue that day, nor within 14 days", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  const first = await fileUnder("strict", onTip(ai.tip, NOW), targets);
  assert.deepEqual(first.baseRepair, [`${TAG}:filed=#9000`]);
  // A person rewrites both: neither the marker nor the title is left.
  const issue = ai.items.find((item) => item.number === 9000)!;
  issue.title = "Investigating the development build";
  issue.firstLine = "Looking into this, see the linked branch.";
  // The same tip, pass after pass that day: the App's issue still holds.
  for (const minutes of [5, 60, 600]) {
    const now = NOW + minutes * MINUTE;
    const pass = await fileUnder("strict", onTip(ai.tip, now), targets, now);
    assert.deepEqual(pass.baseRepair, [`${TAG}:recent=#9000`], `${minutes}`);
  }
  // New red tips on later days, the issue closed on the way: still held.
  for (const [index, days] of [1, 7, 14].entries()) {
    if (days === 7) issue.state = "closed";
    redTip(ai, tipAt(index + 1));
    const now = NOW + days * DAY;
    const pass = await fileUnder("strict", onTip(ai.tip, now), targets, now);
    assert.deepEqual(pass.baseRepair, [`${TAG}:recent=#9000`], `day ${days}`);
  }
  assert.equal(ai.created.length, 1, "one issue in the 14-day window");
  // Past the window the next red tip files exactly one more.
  const later = NOW + 14 * DAY + MINUTE;
  const after = await fileUnder("strict", onTip(ai.tip, later), targets, later);
  assert.deepEqual(after.baseRepair, [`${TAG}:filed=#9001`]);
  assert.equal(ai.created.length, 2);
});

Deno.test("base repair content: a deleted issue allows at most one more that UTC day", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  await maintain(onTip(ai.tip, NOW), targets);
  // A person deletes it: GitHub keeps no record of it that Sentinel reads.
  ai.items.splice(ai.items.findIndex((item) => item.number === 9000), 1);
  const actions: string[] = [];
  for (const minutes of [5, 10, 60, 600]) {
    const now = NOW + minutes * MINUTE;
    actions.push(
      ...(await maintain(onTip(ai.tip, now), targets, now)).baseRepair,
    );
  }
  assert.deepEqual(actions, [
    `${TAG}:filed=#9001`,
    ...Array.from({ length: 3 }, () => `${TAG}:filed_before=#9001`),
  ]);
  assert.equal(ai.created.length, 2, "one more after the deletion");
});

Deno.test("base repair content: strict, any issue the App opened in the target holds filing, whatever it says", async () => {
  // Another Sentinel issue (a review follow-up) the App opened.
  const followUp = (createdAt: number): FakeItem =>
    appIssue(88, "<!-- sentinel:follow-up:ubiquity/ai.ubq.fi#5176 -->", {
      title: "Follow up a review finding",
      createdAt,
    });
  const opened: [string, number][] = [
    ["today", NOW - 2 * HOUR],
    ["ten days ago", NOW - 10 * DAY],
  ];
  for (const [label, createdAt] of opened) {
    const targets = redTargets({ issues: [followUp(createdAt)] });
    const pass = await fileUnder(
      "strict",
      onTip(targets[AI].tip, NOW),
      targets,
    );
    assert.deepEqual(pass.baseRepair, [`${TAG}:recent=#88`], label);
    assert.equal(targets[AI].created.length, 0, label);
  }
  // In either mode: a listing blind to the App's issues, and the daily brake
  // still sees today's.
  const blind = redTargets({ issues: [followUp(NOW - 2 * HOUR)] });
  blind[AI].appListing = (app) => app.filter((item) => item.pullRequest);
  const braked = await maintain(onTip(blind[AI].tip, NOW), blind);
  assert.deepEqual(braked.baseRepair, [`${TAG}:filed_today=#88`]);
  assert.equal(blind[AI].created.length, 0);
  // Someone else's ordinary issue of today holds nothing.
  const other = redTargets({
    issues: [
      appIssue(89, "The deploy is slow since Monday.", {
        author: "someone",
        title: "Slow deploys",
        createdAt: NOW - HOUR,
      }),
    ],
  });
  const filed = await maintain(onTip(other[AI].tip, NOW), other);
  assert.deepEqual(filed.baseRepair, [`${TAG}:filed=#9000`]);
});

Deno.test("base repair content: an outsider's issue holds nothing, whatever it says; a trusted creator's marked one holds the day", async () => {
  // Today, before the pass: an issue that looks like the one it files.
  const opened = (association: string | null, marked = true) =>
    appIssue(8200, marked ? MARKER : "The development build is red.", {
      author: "someone",
      association,
      createdAt: NOW - HOUR,
    });
  const cases: [string, FakeItem, string][] = [
    // Any GitHub user (third review: this suppressed filing for a day).
    ["an outsider", opened("NONE"), `${TAG}:filed=#9000`],
    ["a past contributor", opened("CONTRIBUTOR"), `${TAG}:filed=#9000`],
    ["a first-timer", opened("FIRST_TIME_CONTRIBUTOR"), `${TAG}:filed=#9000`],
    // A member's own report, in its own words, holds nothing either.
    ["a member's own words", opened("MEMBER", false), `${TAG}:filed=#9000`],
    // A create GitHub answered under the owner's or a member's login.
    ["a member", opened("MEMBER"), `${TAG}:filed_today=#8200`],
    ["a collaborator", opened("COLLABORATOR"), `${TAG}:filed_today=#8200`],
    ["the owner", opened("OWNER"), `${TAG}:filed_today=#8200`],
    // A marked issue whose creator GitHub does not place proves nothing.
    ["no association", opened(null), `${TAG}:day_unproven`],
  ];
  for (const [label, item, expected] of cases) {
    const targets = redTargets({ issues: [item] });
    const pass = await maintain(onTip(targets[AI].tip, NOW), targets);
    assert.deepEqual(pass.baseRepair, [expected], label);
    assert.equal(
      targets[AI].created.length,
      expected.endsWith("#9000") ? 1 : 0,
      label,
    );
  }
});

Deno.test("base repair content: records held under two installation ids file one issue in a run", async () => {
  const targets = redTargets();
  const ai = targets[AI];
  // GitHub's listings lag a create: neither answers an issue created at this
  // pass's own instant.
  ai.appListing = (app) => app.filter((item) => item.createdAt < NOW);
  ai.dayListing = (all) => all.filter((item) => item.createdAt < NOW);
  const second = held(AI, 1210, H2);
  const records = [
    ...onTip(ai.tip, NOW),
    { ...second, repository: { ...second.repository, installationId: 8 } },
  ];
  const { baseRepair } = await maintain(records, targets);
  assert.deepEqual(baseRepair, [
    `${TAG}:filed=#9000`,
    `${TAG}:attempted_this_run`,
  ]);
  assert.equal(ai.created.length, 1, "one create for the repository");
});

Deno.test("base repair content: a create GitHub answers under another author is tried once that run and once that day", async () => {
  const targets = redTargets({ create: "foreign" });
  const ai = targets[AI];
  const { deps, state } = await maintenanceDeps(onTip(ai.tip, NOW), targets);
  const first = await runMaintenance(deps, state);
  assert.deepEqual(first.baseRepair, [`${TAG}:file_failed`]);
  // GitHub opened the issue under another login, so the App listing never
  // shows it. The same run tries nothing more.
  const opened = ai.items.find((item) => item.number === 9000)!;
  assert.notEqual(opened.author, APP);
  const again = await runMaintenance(deps, state);
  assert.deepEqual(again.baseRepair, [`${TAG}:attempted_this_run`]);
  // Later runs that day: its base-repair title and marker hold the day.
  for (const hours of [1, 4, 8]) {
    const now = NOW + hours * HOUR;
    const pass = await maintain(onTip(ai.tip, now), targets, now);
    assert.deepEqual(pass.baseRepair, [`${TAG}:filed_today=#9000`], `${hours}`);
  }
  assert.equal(ai.created.length, 1, "one create that day");
  // The worst case of this fault: one create a UTC day.
  const tomorrow = (Math.floor(NOW / DAY) + 1) * DAY + HOUR;
  const next = await maintain(onTip(ai.tip, tomorrow), targets, tomorrow);
  assert.deepEqual(next.baseRepair, [`${TAG}:file_failed`]);
  assert.equal(ai.created.length, 2);
});
