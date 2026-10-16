/**
 * The trusted matrix planner grants a CI correction only after re-deriving the
 * attribution from live check runs: the snapshot carries no CI evidence (the
 * generation-76 rollback contract), so a reviewed head back at `work` is only
 * ELIGIBLE, and anything but a live candidate-caused failure returns it to the
 * delivery gate uncharged.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { type GitHubCheckV1, portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import { isCiCorrectionFinding } from "../../src/repair/ci-rejection.ts";
import { SHA2, T0, workRecord } from "../state/helpers.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import { assertGeneration76Shapes } from "../repair/ci-correction-rig.ts";
import { makeRig, seedSnapshot, snapshot } from "./matrix-runtime-fixtures.ts";

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

async function reviewedRig(baseConclusion: GitHubCheckV1["conclusion"]) {
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
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    firstSeenAt: T0 - 60_000,
  });
  const seeded = parseRepairStateSnapshotV1({
    ...seedSnapshot([record]),
    reviews: [completedReceipt(7, SHA2, rig.base)],
  });
  const written = await rig.store.writeRepair(seeded, null);
  assert.ok(written.ok && written.value.status === "applied");
  const checks: Record<string, GitHubCheckV1[]> = {
    [SHA2]: [check("validate", SHA2, "failure")],
    [rig.base]: [check("validate", rig.base, baseConclusion)],
  };
  rig.github.readChecks = (head: GitSha) =>
    Promise.resolve(portOk({ head, checks: checks[head] ?? [] }));
  return rig;
}

Deno.test("matrix planner: a live candidate-caused CI failure is granted as a correction from the reviewed head", async () => {
  const rig = await reviewedRig("success");
  try {
    const report = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(report.plan.cells.length, 1, JSON.stringify(report));
    const request = report.plan.cells[0].request;
    assert.equal(request.checkoutBase, SHA2, "the correction continues SHA2");
    assert.equal(request.base, rig.base, "on its reviewed base");
    assert.ok(isCiCorrectionFinding(request.reviewFindings![0]));
    assert.match(request.reviewFindings![0].message, /validate \(failure\)/);
    const after = await snapshot(rig);
    assert.equal(after.work[0].intent?.kind, "implementation");
    assert.equal(after.reservations.length, 1, "one charged correction");
    assert.equal(after.reservations[0].purpose, "retry");
    assertGeneration76Shapes([after]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix planner: a reviewed head whose base turned red is returned to its delivery gate uncharged", async () => {
  const rig = await reviewedRig("failure");
  try {
    const report = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(report.plan.cells.length, 0, "no correction cell");
    const after = await snapshot(rig);
    assert.equal(after.work[0].nextStep, "delivery");
    assert.equal(after.work[0].intent, null);
    assert.equal(after.work[0].counters.attempts, 1);
    assert.deepEqual(after.reservations, [], "nothing charged");
    assertGeneration76Shapes([after]);
  } finally {
    await rig.cleanup();
  }
});
