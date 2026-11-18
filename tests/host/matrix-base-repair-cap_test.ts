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
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { decompositionChildId } from "../../src/repair/transitions.ts";
import { SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
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

/** Part `index` of issue 401 split in two by a timeout. */
const part = (index: number) => decompositionChildId("issue-401", index, 2);

/**
 * Issue 401's red head SHA2 on PR 7, on the development tip, with the CI fix
 * marker after `retries` charged CI fixes. A base-repair task's base is red
 * on the same check (its own failure); an ordinary task's base is green.
 * With `split`, a timeout split the issue in two first: the marked record is
 * its second part, and the first part (its dependency) is done after `split`
 * charged CI fixes of its own.
 */
async function markedRig(
  baseRepair: boolean,
  retries: number,
  split?: number,
) {
  const rig = await makeRig([401], 1);
  const issueTask = {
    source: { kind: "issue", id: "401", revision: rig.base },
    related: { incidentId: null, issueNumber: 401 },
    firstSeenAt: T0 - 120_000,
  };
  const id = split === undefined ? "issue-401" : part(2);
  const record = workRecord(id, {
    ...issueTask,
    target: {
      base: rig.base,
      branch: split === undefined
        ? "sentinel/repair/issue-401"
        : candidateBranch(asWorkItemId(id)),
      checkpoint: null,
      head: SHA2,
      pr: 7,
    },
    dependencies: split === undefined ? [] : [part(1)],
    nextStep: "work",
    wait: ciFixMarker(T0 - 60_000),
    counters: { attempts: retries + 1, retries, reviewRounds: 0 },
  });
  const family = split === undefined ? [] : [
    // The whole issue, superseded by its parts after one timeout.
    workRecord("issue-401", {
      ...issueTask,
      target: {
        base: rig.base,
        branch: "sentinel/repair/issue-401",
        checkpoint: null,
        head: null,
        pr: null,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0, timeouts: 1 },
    }),
    workRecord(part(1), {
      ...issueTask,
      target: {
        base: rig.base,
        branch: candidateBranch(asWorkItemId(part(1))),
        checkpoint: null,
        head: SHA3,
        pr: 6,
      },
      nextStep: "done",
      counters: { attempts: split + 1, retries: split, reviewRounds: 1 },
    }),
  ];
  const written = await rig.store.writeRepair(
    seedSnapshot([...family, record]),
    null,
  );
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
    // An ordinary task: the admitted owner's issue (2026-11-17).
    : { ...issueRow(401) };
  rig.github.latest.set(401, issue);
  return rig;
}

/**
 * One hosted planning wave; the plan, the marked record (`id`) and the
 * charges after it.
 */
async function plan(
  rig: Awaited<ReturnType<typeof markedRig>>,
  id = "issue-401",
) {
  const report = await planMatrixWave(
    { ...rig.deps, externalImplementations: true },
    rig.planOptions(),
  );
  const after = await snapshot(rig);
  const work = after.work.find((record) => record.id === id)!;
  return { cells: report.plan.cells, work, after };
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

Deno.test("matrix planner: the parts of a split base-repair task share one cap", async () => {
  // Part 1 spent two fixes: part 2 is granted the issue's third, its own
  // first, as a charged cell.
  const third = await markedRig(true, 0, 2);
  try {
    const { cells, work, after } = await plan(third, part(2));
    assert.equal(cells.length, 1, JSON.stringify(cells));
    assert.equal(work.counters.retries, 1, "the issue's third charged fix");
    assert.equal(after.reservations.length, 1);
    assert.equal(after.reservations[0].purpose, "retry");
  } finally {
    await third.cleanup();
  }
  // Part 1 spent all three: part 2 parks at its first fix, with no cell and
  // no charge, although it has spent none of its own.
  const spent = await markedRig(true, 0, BASE_REPAIR_CI_FIX_CAP);
  try {
    const { cells, work, after } = await plan(spent, part(2));
    assert.deepEqual(cells, [], "no fix cell past the issue's cap");
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.blocker?.message, CAP_PARK);
    assert.equal(work.counters.retries, 0);
    assert.deepEqual(after.reservations, [], "nothing charged");
  } finally {
    await spent.cleanup();
  }
  // An ordinary task's parts stay uncapped.
  const ordinary = await markedRig(false, 0, BASE_REPAIR_CI_FIX_CAP);
  try {
    const { cells, work } = await plan(ordinary, part(2));
    assert.equal(cells.length, 1, JSON.stringify(cells));
    assert.equal(work.counters.retries, 1);
  } finally {
    await ordinary.cleanup();
  }
});
