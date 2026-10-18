/**
 * Generation 81 opens the hosted pre-review CI fix route
 * (`HOSTED_PRE_REVIEW_CI_FIXES`): the trusted matrix planner grants a red
 * head no review has completed on (a never-reviewed candidate, or a reviewed
 * record's refreshed head) its CI fix as a matrix cell, after re-deriving the
 * failure from live check runs. The fix is charged in `counters.retries` (a
 * `retry` admission, never a review round) and the cell continues the exact
 * published head on the record's exact base with the live CI finding first:
 * the shape R80, generation 81's rollback target, isolates as an
 * authenticated runtime mismatch (matrix-ci-first-gen79_test.ts). The plan
 * and every snapshot also parse under R80's own parsers.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { type GitHubCheckV1, portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import { isCiCorrectionFinding } from "../../src/repair/ci-rejection.ts";
import {
  ciFixMarker,
  HOSTED_PRE_REVIEW_CI_FIXES,
} from "../../src/repair/ci-first-policy.ts";
import { SHA2, T0, workRecord } from "../state/helpers.ts";
import {
  assertGen80Parses,
  gen80Available,
  loadGen80Parsers,
} from "../state/gen77-contracts.ts";
import { completedReceipt } from "../repair/loop-review-fixtures.ts";
import { makeRig, seedSnapshot, snapshot } from "./matrix-runtime-fixtures.ts";

const GEN80 = await gen80Available();
/** The head a review completed on before the base moved. */
const EARLIER_HEAD = "9".repeat(40) as GitSha;

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

/** A red head SHA2 on PR 7 with the CI fix marker, reviewed or not before. */
async function markedRig(refreshed: boolean) {
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
    counters: { attempts: 1, retries: 0, reviewRounds: refreshed ? 1 : 0 },
    firstSeenAt: T0 - 120_000,
  });
  const seeded = parseRepairStateSnapshotV1({
    ...seedSnapshot([record]),
    reviews: refreshed ? [completedReceipt(7, EARLIER_HEAD, rig.base)] : [],
  });
  const written = await rig.store.writeRepair(seeded, null);
  assert.ok(written.ok && written.value.status === "applied");
  const checks: Record<string, GitHubCheckV1[]> = {
    [SHA2]: [check("validate", SHA2, "failure")],
    [rig.base]: [check("validate", rig.base, "success")],
  };
  rig.github.readChecks = (head: GitSha) =>
    Promise.resolve(portOk({ head, checks: checks[head] ?? [] }));
  return rig;
}

for (const refreshed of [false, true]) {
  const label = refreshed
    ? "a reviewed record's red refreshed head"
    : "a never-reviewed red head";
  Deno.test(`matrix planner: a hosted generation-81 run grants ${label} its charged CI fix cell`, async () => {
    assert.equal(HOSTED_PRE_REVIEW_CI_FIXES, true);
    const rig = await markedRig(refreshed);
    try {
      const report = await planMatrixWave(
        { ...rig.deps, externalImplementations: true },
        rig.planOptions(),
      );
      assert.equal(report.plan.cells.length, 1, JSON.stringify(report));
      const cell = report.plan.cells[0];
      const request = cell.request;
      // Exactly the shape R80's consumer isolates: the published head on the
      // record's exact base, the live CI finding first, no completed review
      // of that head, and a CI fix charged in `counters.retries`.
      assert.equal(request.checkoutBase, SHA2, "the fix continues SHA2");
      assert.equal(request.base, rig.base, "on the record's exact base");
      assert.equal(cell.expectedBase, rig.base);
      assert.ok(isCiCorrectionFinding(request.reviewFindings![0]));
      assert.match(request.reviewFindings![0].message, /validate \(failure\)/);
      const after = await snapshot(rig);
      const work = after.work[0];
      assert.equal(work.intent?.kind, "implementation");
      assert.equal(work.counters.retries, 1, "one charged CI fix");
      assert.equal(work.counters.attempts, 2);
      assert.equal(
        work.counters.reviewRounds,
        refreshed ? 1 : 0,
        "a CI fix is never a review round",
      );
      assert.equal(after.reservations.length, 1);
      assert.equal(after.reservations[0].purpose, "retry");
      assert.equal(after.reservations[0].outcome, "reserved");
      assert.equal(
        after.reviews.some((review) =>
          review.pullRequest.head === request.checkoutBase &&
          review.outcome === "completed"
        ),
        false,
      );
      if (GEN80) {
        await assertGen80Parses(after);
        const parsers = await loadGen80Parsers();
        parsers.parseMatrixPlanV1(JSON.parse(JSON.stringify(report.plan)));
      }
    } finally {
      await rig.cleanup();
    }
  });
}
