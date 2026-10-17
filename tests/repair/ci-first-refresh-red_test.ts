/**
 * A REVIEWED record whose refreshed head turns red (generation 80 integration
 * review, issue #153): every refreshed head is a head no review has completed
 * on. Live, most refreshes onto 2756425c16, 973bb2f and ded498f failed
 * validate (prettier and eslint drift: 645, 646, 649, 1128, 583, 615, 617,
 * 629, 633).
 *
 * In a hosted generation-80 run (R80), where the pre-review CI fix route is
 * closed because R79 refused that cell, it parked `CI red before review;
 * awaiting a CI fix: ...` with no route out. Generation 81 has R80 as its
 * rollback target, and R80 isolates the cell (matrix-ci-first-gen79_test.ts),
 * so it opens the route (`HOSTED_PRE_REVIEW_CI_FIXES`): the runtime's gate
 * returns the red refreshed head to `work` with the CI fix marker, a charged
 * CI fix that is never a review round. A park R80 already wrote returns
 * through the launcher: on a moved base under any proven CI-first runtime
 * (R80 included) for the runtime's uncharged refresh, and on its unchanged
 * base through the fix rule once R81 is pinned in
 * `HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  CI_PRE_REVIEW_RED_PREFIX,
  HOSTED_PRE_REVIEW_CI_FIXES,
  isCiFixMarker,
} from "../../src/repair/ci-first-policy.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy-retries.ts";
import { healthyProof } from "../host/hosted-autonomy-rig.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { assertGen80Parses, gen80Available } from "../state/gen77-contracts.ts";
import {
  check,
  ciFirstRig,
  type CiFirstRigOptions,
  SHA4,
  taskRecord,
} from "./ci-first-rig.ts";

/** The generation-80 source is absent from shallow CI checkouts. */
const GEN80 = await gen80Available();
/** R80 exactly as pinned, under the launcher's production allowlists. */
const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
/** A stand-in for generation 81's own runtime, allowlisted by the test. */
const R81 = "8181818181818181818181818181818181818181" as GitSha;
const SHA5 = "5555555555555555555555555555555555555555" as GitSha;

function installed(revision: GitSha, generation: number) {
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: revision,
    generation,
    lastHealthyProof: healthyProof(revision, generation, "refresh-red"),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
  } as HostedRuntimeRecordV1;
}

/** The reviewed record of the integration review, refreshed onto SHA2. */
const REFRESHED_RED: CiFirstRigOptions = {
  hosted: true,
  reviewed: true,
  reviewRounds: 1,
  nextStep: "delivery",
  baseTip: SHA2,
  refreshTo: { [SHA3]: SHA4 },
  checks: {
    [SHA3]: [check("validate", SHA3, "success")],
    [SHA1]: [check("validate", SHA1, "success")],
    [SHA2]: [check("validate", SHA2, "success")],
    [SHA4]: [
      check("validate", SHA4, "failure"),
      check("verify-artifact", SHA4, "skipped"),
    ],
  },
};

Deno.test("CI first, hosted generation 81: a reviewed record's red refreshed head takes a charged CI fix, never a park", async () => {
  assert.equal(HOSTED_PRE_REVIEW_CI_FIXES, true, "generation 81 opens it");
  const { rig, writes, charges } = await ciFirstRig(
    "cf-refresh-red",
    structuredClone(REFRESHED_RED),
  );
  try {
    for (let run = 0; run < 6; run++) {
      await rig.run();
      if (isCiFixMarker(taskRecord(await rig.snapshot()).wait)) break;
      rig.clock.advance(10 * 60_000);
    }
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.target.head, SHA4, "the refreshed head is published");
    assert.equal(work.target.base, SHA2);
    assert.equal(work.nextStep, "work", "back at work for its CI fix");
    assert.equal(work.blocker, null, "no park");
    assert.ok(isCiFixMarker(work.wait), "the CI fix marker");
    assert.equal(work.counters.reviewRounds, 1, "no round spent on it");
    assert.equal(work.counters.retries, 0, "charged only at its admission");
    assert.deepEqual(after.reservations, charges, "nothing charged yet");
    assert.equal(rig.model.requests.length, 0, "a hosted fix is a cell");
    assert.equal(rig.github.reviewRequestIdentities.length, 0);
    if (GEN80) {
      for (const written of writes) await assertGen80Parses(written);
    }
  } finally {
    await rig.ctx.cleanup();
  }
});

/** The charged counters (a re-admission resets only the stall count). */
function charged(record: WorkRecordV1) {
  const { attempts, retries, reviewRounds } = record.counters;
  return { attempts, retries, reviewRounds };
}

/** The park R80 writes for the same refreshed head (rollback-proven below). */
function r80Park(
  snapshot: RepairStateSnapshotV1,
  now: number,
): RepairStateSnapshotV1 {
  return {
    ...snapshot,
    work: snapshot.work.map((record) =>
      markBlocked(
        record,
        "other",
        `${CI_PRE_REVIEW_RED_PREFIX}validate(failure)`,
        now,
      )
    ),
  };
}

Deno.test("CI first, hosted: an R80 park of a red refreshed head returns for a refresh on a moved base and for its fix under a pinned fix runtime", async () => {
  const { rig } = await ciFirstRig(
    "cf-refresh-red-park",
    structuredClone(REFRESHED_RED),
  );
  try {
    for (let run = 0; run < 6; run++) {
      await rig.run();
      if (isCiFixMarker(taskRecord(await rig.snapshot()).wait)) break;
      rig.clock.advance(10 * 60_000);
    }
    const parked = r80Park(await rig.snapshot(), rig.clock.now());
    const work = taskRecord(parked);
    assert.equal(work.nextStep, "blocked");
    assert.equal(work.target.head, SHA4);
    const settled = new Set([ciGreenHeadKey(work.repository, SHA4)]);
    const plan = (
      runtime: GitSha,
      generation: number,
      tip: GitSha,
      fix: boolean,
    ) =>
      planHostedRetries(
        parked,
        rig.clock.now(),
        runtime,
        new Map([[hostedRepositoryKey(work.repository), tip as string]]),
        new Set(),
        undefined,
        {
          ciRuntime: installed(runtime, generation),
          ciRerunSettled: settled,
          ciGreenHeads: new Set(),
          ...(runtime === R80 ? {} : {
            ciAllowlist: new Set([runtime]),
            ciFirstAllowlist: new Set([runtime]),
            ciFirstFixAllowlist: new Set(fix ? [runtime] : []),
          }),
        },
      );
    // R80 on the unchanged base: its route stays closed, so the park waits
    // for the fix runtime's pin (R80's own runtime would park it again).
    assert.deepEqual(plan(R80, 80, SHA2, false), []);
    // A moved base under R80 (a proven CI-first runtime): back to `work`
    // uncharged; the runtime refreshes it and gates the new head's CI first.
    for (
      const [runtime, generation, fix] of [[R80, 80, false], [
        R81,
        81,
        true,
      ]] as const
    ) {
      const moved = plan(runtime, generation, SHA5, fix);
      assert.equal(moved.length, 1, runtime);
      assert.equal(moved[0].nextStep, "work");
      assert.equal(moved[0].ciFixMarker, undefined);
      const next = applyHostedRetries(parked, SHA1, moved, rig.clock.now());
      const returned = taskRecord(next);
      assert.equal(returned.blocker, null);
      assert.equal(returned.wait, null);
      assert.deepEqual(charged(returned), charged(work), "nothing charged");
      if (GEN80) await assertGen80Parses(next);
    }
    // Generation 81 pinned as a fix runtime: back with the CI fix marker.
    const plans = plan(R81, 81, SHA2, true);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].ciFixMarker, true);
    const next = applyHostedRetries(parked, SHA1, plans, rig.clock.now());
    const readmitted = taskRecord(next);
    assert.equal(readmitted.blocker, null);
    assert.ok(isCiFixMarker(readmitted.wait));
    assert.deepEqual(charged(readmitted), charged(work), "nothing charged");
    if (GEN80) await assertGen80Parses(next);
  } finally {
    await rig.ctx.cleanup();
  }
});
