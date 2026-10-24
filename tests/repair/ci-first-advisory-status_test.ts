/**
 * Sentinel issue #192 at the CI-first review gate: the head's check reads go
 * through the REAL GitHub client (`readChecks` over a scripted transport),
 * which folds the head's commit statuses into its check runs. A third-party
 * status stuck at `pending` used to hold a head whose check runs were all
 * green in `ci_pending` until the six-hour pre-review park. Now that status is
 * advisory once every check run has completed, so the review proceeds; a
 * failed status still counts as a failure, and a pending status while a check
 * run still runs still waits. Nothing is charged on a non-green path.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import { isCiFixMarker } from "../../src/repair/ci-first-policy.ts";
import {
  checkRunWire,
  checksPageWire,
  commitStatusWire,
  FakeClock,
  httpRespond,
  makePort,
  statusesPageWire,
} from "../github/helpers.ts";
import { SHA1, SHA3 } from "../state/helpers.ts";
import { ciFirstRig, reviewCharges, taskRecord } from "./ci-first-rig.ts";

interface CommitWire {
  runs: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
}

/**
 * Answer `github`'s strict check reads of each listed commit through its own
 * real port over that commit's scripted check runs and statuses, read afresh
 * on every call (so a test can change them between polls); every other
 * commit keeps the fake's answer.
 */
function routeCommits(github: GitHubPort, wires: Record<string, CommitWire>) {
  const fake = github.readChecks.bind(github);
  github.readChecks = (sha: GitSha, names?: ReadonlySet<string>) => {
    const wire = wires[sha];
    if (wire === undefined) return fake(sha, names);
    const commit = `/commits/${sha}`;
    const { port } = makePort({
      // An hour after the fixture runs complete (01:00): past the grace.
      clock: new FakeClock(Date.parse("2026-09-07T02:00:00Z")),
      script: [
        httpRespond(
          "GET",
          `${commit}/check-runs?per_page=100&page=1`,
          200,
          checksPageWire(wire.runs.map((run) => ({ ...run, head_sha: sha }))),
        ),
        httpRespond(
          "GET",
          `${commit}/statuses?per_page=100&page=1`,
          200,
          statusesPageWire(wire.statuses),
        ),
      ],
    });
    return port.readChecks(sha, names);
  };
}

const GREEN_RUNS = [
  checkRunWire({ name: "validate" }),
  checkRunWire({ name: "verify-artifact", conclusion: "skipped" }),
];

/** A preview deployment status that never reported. */
const STALE_PENDING = commitStatusWire({
  context: "preview/deploy",
  state: "pending",
  created_at: "2026-09-07T00:00:00Z",
  updated_at: "2026-09-07T00:00:00Z",
});

Deno.test("CI first (#192): green check runs with a stale pending status are reviewed, never held in ci_pending", async () => {
  const { rig, charges } = await ciFirstRig("cf-status-advisory", {
    checks: {},
  });
  try {
    routeCommits(rig.github, {
      [SHA3]: { runs: GREEN_RUNS, statuses: [STALE_PENDING] },
    });
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.blocker, null, JSON.stringify(work.blocker));
    assert.notEqual(work.wait?.reason, "ci_pending", JSON.stringify(work.wait));
    assert.equal(work.nextStep, "review");
    assert.equal(work.counters.reviewRounds, 1);
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      1,
    );
    assert.equal(reviewCharges(after).length, 1);
    assert.equal(after.reservations.length, charges.length + 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first (#192): a failed status still fails green check runs and the head is not reviewed", async () => {
  const { rig, charges } = await ciFirstRig("cf-status-failed", {
    hosted: true,
    checks: {},
  });
  try {
    routeCommits(rig.github, {
      [SHA3]: {
        runs: GREEN_RUNS,
        statuses: [
          commitStatusWire({
            context: "preview/deploy",
            state: "error",
            created_at: "2026-09-07T01:00:00Z",
            updated_at: "2026-09-07T01:00:00Z",
          }),
          STALE_PENDING,
        ],
      },
      // The same status passed on the base: the candidate broke it.
      [SHA1]: {
        runs: GREEN_RUNS,
        statuses: [commitStatusWire({ context: "preview/deploy" })],
      },
    });
    await rig.run();
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(reviewCharges(after).length, 0);
    assert.deepEqual(after.reservations, charges, "nothing charged");
    assert.equal(work.counters.reviewRounds, 0);
    // A candidate-caused failure: back at `work` with the CI fix marker.
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.ok(isCiFixMarker(work.wait), JSON.stringify(work.wait));
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("CI first (#192): a pending status while a check run still runs waits; once the runs complete the review proceeds", async () => {
  const head: CommitWire = {
    runs: [
      checkRunWire({ name: "validate" }),
      checkRunWire({
        name: "verify-artifact",
        status: "in_progress",
        conclusion: null,
        completed_at: null,
      }),
    ],
    statuses: [STALE_PENDING],
  };
  const { rig, charges } = await ciFirstRig("cf-status-running", {
    checks: {},
  });
  try {
    routeCommits(rig.github, { [SHA3]: head });
    await rig.run();
    let after = await rig.snapshot();
    let work = taskRecord(after);
    assert.equal(work.nextStep, "work");
    assert.equal(work.wait?.reason, "ci_pending");
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.deepEqual(after.reservations, charges, "nothing charged");
    // The run finishes green; the preview status still never reports.
    head.runs = GREEN_RUNS;
    rig.clock.advance(5 * 60_000 + 1);
    await rig.run();
    after = await rig.snapshot();
    work = taskRecord(after);
    assert.equal(work.nextStep, "review", JSON.stringify(work.wait));
    assert.equal(work.counters.reviewRounds, 1);
    assert.equal(reviewCharges(after).length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});
