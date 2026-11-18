/**
 * A base-repair task's charged CI fixes are capped (`BASE_REPAIR_CI_FIX_CAP`,
 * 3 until the owner names a number), through the real repair loop in process
 * over real Git state with fake GitHub/model ports and the rig's injected
 * clock. The review ran a base-repair task with the base and every new head
 * red: 12 charged fixes in a row, no review, no park. Now exactly three are
 * charged, the fourth fix parks the record with its own fixed blocker,
 * uncharged, and later cycles charge nothing. An ordinary task's CI fixes
 * stay uncapped (owner directive 2026-10-30).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { type GitHubIssueV1, portOk } from "../../src/contracts/ports.ts";
import { SHA1, SHA3 } from "../state/helpers.ts";
import { check, ciFirstRig, modelCharges, taskRecord } from "./ci-first-rig.ts";

/** The fixed park, as an older runtime and the launcher read it. */
const CAP_PARK =
  "base-repair CI fix cap reached: 3 charged CI fixes spent; owner action required";

/** The heads the model's successive fixes produce: every one still red. */
const HEADS = ["5", "6", "7", "8", "9", "b", "c", "d"].map((c) =>
  c.repeat(40) as GitSha
);

/** Issue #1: the App's base-repair issue, or a person's ordinary one. */
function issue(baseRepair: boolean): GitHubIssueV1 {
  return {
    number: 1,
    title: baseRepair ? "CI is failing on development" : "Fix the build",
    body: baseRepair
      ? `<!-- sentinel:base-repair:development@${SHA1} -->\n\nCI is failing.`
      : "The build fails on every pull request.",
    state: "open",
    author: baseRepair ? "ubiquity-sentinel[bot]" : "someone",
    labels: [],
    createdAt: 0,
    updatedAt: 0,
    closedAt: null,
  };
}

/**
 * `cycles` runs of the loop, 31 minutes apart, over issue #1's record (head
 * SHA3 on base SHA1, the development tip). The base is red (a base-repair
 * task) or green (an ordinary task), and every head is red on `deno`.
 */
async function run(baseRepair: boolean, cycles: number, retries = 0) {
  const red = (head: GitSha) => [check("deno", head, "failure")];
  const { rig } = await ciFirstRig(`base-repair-cap-${baseRepair}`, {
    hosted: false,
    retries,
    attempts: retries + 1,
    heads: HEADS,
    checks: {
      [SHA1]: baseRepair ? red(SHA1) : [check("deno", SHA1, "success")],
      [SHA3]: red(SHA3),
      ...Object.fromEntries(HEADS.map((head) => [head, red(head)])),
    },
  });
  rig.github.readIssue = () => Promise.resolve(portOk(issue(baseRepair)));
  const trail: string[] = [];
  try {
    for (let cycle = 0; cycle < cycles; cycle++) {
      const outcome = await rig.run();
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const work = taskRecord(await rig.snapshot());
      trail.push(
        `${work.counters.retries}:${work.nextStep}:${
          work.blocker?.message ?? "-"
        }`,
      );
      rig.clock.advance(31 * 60_000);
    }
    const state = await rig.snapshot();
    return {
      trail,
      requests: rig.model.requests.length,
      work: taskRecord(state),
      fixes: modelCharges(state).filter((row) => row.purpose === "retry"),
    };
  } finally {
    await rig.ctx.cleanup();
  }
}

Deno.test("base repair cap: a base-repair task with its base and every new head red takes three charged fixes, then parks", async () => {
  const { trail, requests, work, fixes } = await run(true, 8);
  assert.equal(requests, 3, `three fix sessions: ${trail.join(" | ")}`);
  assert.equal(fixes.length, 3, "three charged CI fixes");
  assert.equal(work.counters.retries, 3);
  assert.equal(work.nextStep, "blocked");
  assert.deepEqual(work.blocker?.kind, "other");
  assert.equal(work.blocker?.message, CAP_PARK);
  // Parked once, and every later cycle charged nothing more.
  const parked = trail.findIndex((line) => line.endsWith(CAP_PARK));
  assert.ok(parked >= 0 && parked < trail.length - 1, trail.join(" | "));
  for (const line of trail.slice(parked)) {
    assert.equal(line, `3:blocked:${CAP_PARK}`, trail.join(" | "));
  }
});

Deno.test("base repair cap: a base-repair task past the cap parks at its next fix without a charge", async () => {
  const { requests, work, fixes, trail } = await run(true, 3, 3);
  assert.equal(requests, 0, trail.join(" | "));
  assert.equal(fixes.length, 3, "only the three seeded fixes");
  assert.equal(work.counters.retries, 3);
  assert.equal(work.blocker?.message, CAP_PARK);
});

Deno.test("base repair cap: an ordinary task's CI fixes stay uncapped", async () => {
  // Three fixes already spent; the same red head on a green base. (A third
  // cycle would meet the separate identical-attempt guard: the fake model
  // repeats its patch.)
  const { requests, work, fixes, trail } = await run(false, 2, 3);
  assert.ok(requests >= 2, `more fixes past three: ${trail.join(" | ")}`);
  assert.equal(work.counters.retries, 3 + requests);
  assert.equal(fixes.length, 3 + requests, "every one charged");
  assert.equal(work.blocker, null, trail.join(" | "));
  assert.ok(trail.every((line) => !line.includes("cap reached")));
});
