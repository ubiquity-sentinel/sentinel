/**
 * The base-repair CI-fix cap (`BASE_REPAIR_CI_FIX_CAP`, 3 until the owner
 * confirms a number) through the trusted HOSTED matrix planner, which admits
 * a CI fix at the same `prepareImplementationStart` as the serial loop: a
 * base-repair task (the App's issue with the marker on its first line) whose
 * head and base are both red is granted its third charged fix as a matrix
 * cell, and at three fixes the next one parks it, uncharged, with no cell.
 * An ordinary task past three CI fixes is still granted its cell (owner
 * directive 2026-10-30). The review of the cap found this planner path
 * untested; tests/repair/base-repair-ci-fix-cap_test.ts covers the serial
 * loop.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type GitHubCheckV1,
  type GitHubIssueV1,
  portOk,
} from "../../src/contracts/ports.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import {
  BASE_REPAIR_AUTHOR,
  BASE_REPAIR_CI_FIX_CAP,
  baseRepairMarker,
} from "../../src/repair/base-repair.ts";
import {
  CI_BASE_REPAIR_FINDING_PREFIX,
  CI_CORRECTION_FINDING_PREFIX,
  isCiCorrectionFinding,
} from "../../src/repair/ci-rejection.ts";
import { ciFixMarker } from "../../src/repair/ci-first-policy.ts";
import { SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  issueRow,
  makeRig,
  seedSnapshot,
  snapshot,
} from "./matrix-runtime-fixtures.ts";

/** The fixed park, as an older runtime and the launcher read it. */
const CAP_PARK =
  "base-repair CI fix cap reached: 3 charged CI fixes spent; owner action required";

function check(
  name: string,
  head: GitSha,
  conclusion: GitHubCheckV1["conclusion"],
): GitHubCheckV1 {
  return {
    name,
    status: "completed",
    conclusion,
    head,
    startedAt: T0,
    completedAt: T0 + 1,
  };
}

/**
 * Issue 401's red head SHA2 on PR 7, on the development tip, with the CI fix
 * marker after `retries` charged CI fixes. A base-repair task's base is red
 * on the same check (its own failure); an ordinary task's base is green.
 */
async function markedRig(baseRepair: boolean, retries: number) {
  const rig = await makeRig([401], 1);
  const record = workRecord("issue-401", {
    source: { kind: "issue", id: "401", revision: rig.base },
    related: { incidentId: null, issueNumber: 401 },
    target: {
      base: rig.base,
      branch: "sentinel/repair/issue-401",
      checkpoint: null,
      head: SHA2,
      pr: 7,
    },
    nextStep: "work",
    wait: ciFixMarker(T0 - 60_000),
    counters: { attempts: retries + 1, retries, reviewRounds: 0 },
    firstSeenAt: T0 - 120_000,
  });
  const written = await rig.store.writeRepair(seedSnapshot([record]), null);
  assert.ok(written.ok && written.value.status === "applied");
  const checks: Record<string, GitHubCheckV1[]> = {
    [SHA2]: [check("validate", SHA2, "failure")],
    [rig.base]: [
      check("validate", rig.base, baseRepair ? "failure" : "success"),
    ],
  };
  rig.github.readChecks = (head: GitSha) =>
    Promise.resolve(portOk({ head, checks: checks[head] ?? [] }));
  const issue: GitHubIssueV1 = baseRepair
    ? {
      ...issueRow(401),
      title: "CI is failing on development",
      body: `${baseRepairMarker("development", rig.base)}\n\nCI is failing.`,
      author: BASE_REPAIR_AUTHOR,
    }
    : { ...issueRow(401), author: "someone" };
  rig.github.latest.set(401, issue);
  return rig;
}

/** One hosted planning wave; the plan, the record and the charges after it. */
async function plan(rig: Awaited<ReturnType<typeof markedRig>>) {
  const report = await planMatrixWave(
    { ...rig.deps, externalImplementations: true },
    rig.planOptions(),
  );
  const after = await snapshot(rig);
  return { cells: report.plan.cells, work: after.work[0], after };
}

Deno.test("matrix planner: a hosted base-repair task is granted its third charged CI fix cell", async () => {
  assert.equal(BASE_REPAIR_CI_FIX_CAP, 3);
  const rig = await markedRig(true, 2);
  try {
    const { cells, work, after } = await plan(rig);
    assert.equal(cells.length, 1, JSON.stringify(cells));
    const finding = cells[0].request.reviewFindings![0];
    assert.ok(isCiCorrectionFinding(finding));
    assert.ok(finding.message.startsWith(CI_BASE_REPAIR_FINDING_PREFIX));
    assert.equal(work.counters.retries, 3, "the third charged CI fix");
    assert.equal(work.intent?.kind, "implementation");
    assert.equal(after.reservations.length, 1);
    assert.equal(after.reservations[0].purpose, "retry");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix planner: a hosted base-repair task at three CI fixes parks at the next, with no cell and no charge", async () => {
  const rig = await markedRig(true, 3);
  try {
    const first = await plan(rig);
    assert.deepEqual(first.cells, [], "no fix cell past the cap");
    assert.equal(first.work.nextStep, "blocked");
    assert.equal(first.work.blocker?.kind, "other");
    assert.equal(first.work.blocker?.message, CAP_PARK);
    assert.equal(first.work.counters.retries, 3);
    assert.equal(first.work.intent, null);
    assert.deepEqual(first.after.reservations, [], "nothing charged");
    // A later wave neither grants nor charges anything.
    const second = await plan(rig);
    assert.deepEqual(second.cells, []);
    assert.deepEqual(second.work, first.work);
    assert.deepEqual(second.after.reservations, []);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix planner: an ordinary task past three CI fixes is still granted its cell", async () => {
  const rig = await markedRig(false, 3);
  try {
    const { cells, work, after } = await plan(rig);
    assert.equal(cells.length, 1, JSON.stringify(cells));
    const finding = cells[0].request.reviewFindings![0];
    assert.ok(finding.message.startsWith(CI_CORRECTION_FINDING_PREFIX));
    assert.equal(work.counters.retries, 4, "uncapped: a fourth charged fix");
    assert.equal(work.blocker, null);
    assert.equal(after.reservations.length, 1);
    assert.equal(after.reservations[0].purpose, "retry");
  } finally {
    await rig.cleanup();
  }
});
