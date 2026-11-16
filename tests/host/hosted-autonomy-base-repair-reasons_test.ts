/**
 * Base-repair refusals that are permanent conditions, not read faults, get
 * their own fixed codes (the second review of the 2026-11-15 enablement),
 * through the real maintenance pass (`runHostedAutonomy`) with fake GitHub
 * targets and an injected clock:
 *
 * - `held_pull_foreign`: a held record's own pull request is missing from
 *   the App listing and GitHub names another author for it, so the listing
 *   proof can never pass while that record is held (was
 *   `listing_unproven`);
 * - `issues_over_bound`: the App has more issues and pull requests in the
 *   target than the bounded listing reads (was `issues_unreadable`).
 *
 * The check-read codes (`checks_over_bound`, `head_checks_over_bound`) are
 * pinned with the real launcher check read in
 * hosted-autonomy-base-repair-jobs_test.ts. Each code files nothing, as
 * before; a read that fails keeps its transient code.
 */
import assert from "node:assert/strict";
import type { HostedAutonomyPullV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  AI,
  APP,
  H2,
  held,
  LIVE,
  maintain,
  pullOf,
  redTargets,
  TAG,
} from "./hosted-autonomy-base-repair-fixtures.ts";

/** Open pull request `number` of ai.ubq.fi as GitHub reads it, by `author`. */
function pull(number: number, author: string): HostedAutonomyPullV1 {
  return {
    number,
    state: "open",
    merged: false,
    mergeCommitSha: null,
    headSha: H2,
    baseRef: "development",
    baseSha: null,
    author,
    parents: [],
    revisionOnBaseBranch: false,
    baseAncestorOfRevision: false,
  };
}

Deno.test("base repair reasons: a held pull request another author opened is held_pull_foreign; otherwise the listing stays unproven", async () => {
  const cases: [string, HostedAutonomyPullV1 | null, string][] = [
    ["another author", pull(pullOf(1210), "a-person"), "held_pull_foreign"],
    ["the App's own", pull(pullOf(1210), APP), "listing_unproven"],
    ["unreadable", null, "listing_unproven"],
  ];
  for (const [label, answer, reason] of cases) {
    const targets = redTargets();
    const ai = targets[AI];
    // The listing answers the first held record's pull request, so the
    // filter works, but not the second record's.
    ai.appListing = (app) => app.filter((item) => item.number !== pullOf(1210));
    const reads: number[] = [];
    (ai.surface as { readPull: unknown }).readPull = (number: number) => {
      reads.push(number);
      return Promise.resolve(number === pullOf(1210) ? answer : null);
    };
    const pass = await maintain([...LIVE(), held(AI, 1210, H2)], targets);
    assert.deepEqual(pass.baseRepair, [`${TAG}:${reason}`], label);
    assert.deepEqual(reads, [pullOf(1210)], `only the missing one: ${label}`);
    assert.equal(ai.created.length, 0, label);
  }
});

Deno.test("base repair reasons: an App listing past its bound is issues_over_bound; an unreadable one stays issues_unreadable", async () => {
  const cases: ["over_bound" | null, string][] = [
    ["over_bound", "issues_over_bound"],
    [null, "issues_unreadable"],
  ];
  for (const [answer, reason] of cases) {
    const targets = redTargets();
    targets[AI].appListing = () => answer;
    const pass = await maintain(LIVE(), targets);
    assert.deepEqual(pass.baseRepair, [`${TAG}:${reason}`], String(answer));
    assert.equal(targets[AI].created.length, 0);
  }
});
