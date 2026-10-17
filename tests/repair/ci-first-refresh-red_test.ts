/**
 * A REVIEWED record whose refreshed head turns red (generation 80 integration
 * review): every refreshed head is a head no review has completed on, so in a
 * hosted generation-80 run, where the pre-review CI fix route stays closed
 * (`HOSTED_PRE_REVIEW_CI_FIXES`, because R79, the rollback target, refuses
 * that cell), it parks `CI red before review; awaiting a CI fix: ...` with no
 * generation-80 route out, exactly like a never-reviewed candidate. Live,
 * most refreshes onto 2756425c16, 973bb2f and ded498f failed validate
 * (prettier and eslint drift: 645, 646, 649, 1128, 583, 615, 617, 629, 633).
 * Generation 81 (R80 as its rollback target, the route open and its runtime
 * in `HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`) re-admits exactly this park
 * through the CI fix marker; that is a ship condition recorded in
 * docs/DECISIONS.md, pinned here.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  type HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import {
  CI_PRE_REVIEW_RED_PREFIX,
  HOSTED_PRE_REVIEW_CI_FIXES,
  isCiFixMarker,
} from "../../src/repair/ci-first-policy.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import {
  HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES,
  HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
} from "../../ops/hosted-autonomy-ci-first.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy-retries.ts";
import { healthyProof } from "../host/hosted-autonomy-rig.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { check, ciFirstRig, SHA4, taskRecord } from "./ci-first-rig.ts";

const R80 = "8080808080808080808080808080808080808080" as GitSha;
const R81 = "8181818181818181818181818181818181818181" as GitSha;

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

Deno.test("CI first, hosted: a reviewed record's red refreshed head parks before review; only a generation-81 fix runtime re-admits it", async () => {
  assert.equal(HOSTED_PRE_REVIEW_CI_FIXES, false, "generation 80 ships closed");
  assert.equal(HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES.size, 0);
  const { rig } = await ciFirstRig("cf-refresh-red", {
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
  });
  try {
    for (let run = 0; run < 6; run++) {
      await rig.run();
      if (taskRecord(await rig.snapshot()).nextStep === "blocked") break;
      rig.clock.advance(10 * 60_000);
    }
    const after = await rig.snapshot();
    const work = taskRecord(after);
    assert.equal(work.target.head, SHA4, "the refreshed head is published");
    assert.equal(work.target.base, SHA2);
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      `${CI_PRE_REVIEW_RED_PREFIX}validate(failure)`,
    );
    assert.equal(work.counters.reviewRounds, 1, "no round spent on it");
    assert.equal(work.counters.retries, 0, "no CI fix charged");
    assert.equal(rig.model.requests.length, 0, "no CI fix ran");
    assert.equal(rig.github.reviewRequestIdentities.length, 0);

    const tips = new Map([[hostedRepositoryKey(work.repository), SHA2]]);
    const settled = new Set([ciGreenHeadKey(work.repository, SHA4)]);
    const plan = (runtime: GitSha, generation: number, fix: GitSha[]) =>
      planHostedRetries(
        after,
        T0 + 9000,
        runtime,
        tips,
        new Set(),
        undefined,
        {
          ciRuntime: installed(runtime, generation),
          ciAllowlist: new Set([runtime]),
          ciFirstAllowlist: new Set([runtime]),
          ciFirstFixAllowlist: new Set(fix),
          ciRerunSettled: settled,
          ciGreenHeads: new Set(),
        },
      );
    // Generation 80, even pinned as a CI-first runtime: no route out.
    assert.deepEqual(plan(R80, 80, []), []);
    assert.equal(HOSTED_AUTONOMY_CI_FIRST_RUNTIMES.has(R80), false);
    // Generation 81 with the fix route: back to `work` with the fix marker.
    const plans = plan(R81, 81, [R81]);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].nextStep, "work");
    assert.equal(plans[0].ciFixMarker, true);
    const next = applyHostedRetries(after, SHA1, plans, T0 + 9000);
    const readmitted = taskRecord(next);
    assert.equal(readmitted.blocker, null);
    assert.ok(isCiFixMarker(readmitted.wait));
    assert.deepEqual(readmitted.counters, work.counters, "nothing charged");
  } finally {
    await rig.ctx.cleanup();
  }
});
