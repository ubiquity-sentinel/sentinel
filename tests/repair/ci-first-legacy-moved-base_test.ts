/**
 * A legacy record whose final round is open, at the review-round ceiling on a
 * moved base, on a red head its own change did not break (round-2 recheck
 * P3). With the generic `CI checks failed: ...` blocker the launcher's
 * correction rule re-admitted it as a CI correction on every pass and R80's
 * delivery step declined the fix every time (no candidate attribution): one
 * correction slot per pass, no progress. The runtime now parks such a head
 * with its non-correctable `CI checks failed without base evidence: ...`
 * blocker, which only the green rule re-admits (the record stays in the
 * legacy class), and awaits a base check still running, bounded.
 *
 * Driven through the REAL R80 loop and the REAL launcher retry planner with
 * R80 pinned as the CI-first runtime; every snapshot the loop writes parses
 * under the generation-79 rollback runtime.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { CI_UNATTRIBUTED_DETAIL } from "../../src/repair/ci-rejection.ts";
import { CARRIED_WAIT_BOUND_MS } from "../../src/repair/loop-carried-delivery.ts";
import { legacyReviewRoundClassPin } from "../../src/repair/review-round-cap.ts";
import { planHostedRetries } from "../../ops/hosted-autonomy-retries.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { assertGen79Parses, gen79Available } from "../state/gen77-contracts.ts";
import { healthyProof } from "../host/hosted-autonomy-rig.ts";
import { check, ciFirstRig, taskRecord } from "./ci-first-rig.ts";

const GEN79 = await gen79Available();
const AIUBQ = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const CUT = T0;
const ID = "issue-ubiquity-ai.ubq.fi-595";
const PREP3 = "3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a" as GitSha;
const R80 = "8080808080808080808080808080808080808080" as GitSha;

function installed(): HostedRuntimeRecordV1 {
  return {
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: R80,
    generation: 80,
    lastHealthyProof: healthyProof(R80, 80, "ci-first-release"),
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
  } as HostedRuntimeRecordV1;
}

/** The launcher's plans for the record, R80 pinned everywhere. */
function launcherPlans(snapshot: RepairStateSnapshotV1, now: number) {
  const key = ciGreenHeadKey(AIUBQ, SHA3);
  return planHostedRetries(
    snapshot,
    now,
    R80,
    new Map([[hostedRepositoryKey(AIUBQ), SHA2]]),
    new Set(),
    undefined,
    {
      ciRuntime: installed(),
      ciAllowlist: new Set([R80]),
      ciFirstAllowlist: new Set([R80]),
      ciRerunSettled: new Set([key]),
      ciReadHeads: new Set([key]),
      ciGreenHeads: new Set<string>(),
      legacyReviewCutoff: CUT,
    } as Parameters<typeof planHostedRetries>[6],
  ).filter((plan) => plan.id === ID);
}

/** The 595 legacy shape (pin 4, final round open) at `delivery`, base moved. */
function legacyRig(name: string, base: ReturnType<typeof check>[]) {
  return ciFirstRig(name, {
    identity: { repository: AIUBQ, id: ID, issue: 595 },
    legacyReviewCutoff: CUT,
    reviewed: true,
    reviewRounds: 4,
    attempts: 3,
    nextStep: "delivery",
    baseTip: SHA2,
    refreshTo: { [SHA3]: PREP3 },
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: base,
      [SHA2]: [check("validate", SHA2, "success")],
    },
  });
}

Deno.test("legacy moved base: a red head on its red reviewed base parks non-correctable, so the launcher plans no correction slot for it", async () => {
  const { rig, writes } = await legacyRig("legacy-moved-red-base", [
    check("validate", SHA1, "failure"),
  ]);
  try {
    await rig.run();
    const snapshot = await rig.snapshot();
    const record = taskRecord(snapshot, ID);
    assert.equal(record.nextStep, "blocked");
    assert.equal(
      record.blocker?.message,
      `${CI_UNATTRIBUTED_DETAIL}: validate(failure)`,
    );
    assert.equal(rig.model.requests.length, 0, "no CI fix started");
    assert.deepEqual(rig.github.reviewRequestIdentities, []);
    // Still the owner's legacy class shape, so drift reporting keeps it.
    assert.notEqual(legacyReviewRoundClassPin(snapshot, record), null);
    // The correction rule never takes it; only the green rule would.
    assert.deepEqual(launcherPlans(snapshot, rig.clock.now()), []);
    // Next runs: the parked record is left alone, nothing charged.
    const reservations = snapshot.reservations.length;
    rig.clock.advance(15 * 60_000);
    await rig.run();
    const again = await rig.snapshot();
    assert.deepEqual(taskRecord(again, ID), record);
    assert.equal(again.reservations.length, reservations);
    if (GEN79) {
      for (const written of writes) await assertGen79Parses(written);
    }
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("legacy moved base: a failure no base evidence attributes parks non-correctable too", async () => {
  // The reviewed base never ran `validate` (no base evidence).
  const { rig } = await legacyRig("legacy-moved-unattributed", [
    check("lint", SHA1, "success"),
  ]);
  try {
    await rig.run();
    const snapshot = await rig.snapshot();
    const record = taskRecord(snapshot, ID);
    assert.equal(
      record.blocker?.message,
      `${CI_UNATTRIBUTED_DETAIL}: validate(failure)`,
    );
    assert.deepEqual(launcherPlans(snapshot, rig.clock.now()), []);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("legacy moved base: a base check still running is awaited, bounded, and never re-admitted as a correction meanwhile", async () => {
  const { rig, writes } = await legacyRig("legacy-moved-base-pending", [
    check("validate", SHA1, null, "in_progress"),
  ]);
  try {
    await rig.run();
    let record = taskRecord(await rig.snapshot(), ID);
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    assert.equal(record.wait?.reason, "ci_pending");
    const since = record.wait!.since;
    assert.deepEqual(launcherPlans(await rig.snapshot(), rig.clock.now()), []);
    for (
      let hour = 0;
      hour <= 7 && record.nextStep !== "blocked";
      hour++
    ) {
      rig.clock.advance(60 * 60_000);
      await rig.run();
      record = taskRecord(await rig.snapshot(), ID);
      if (record.nextStep !== "blocked") {
        assert.equal(record.wait?.since, since, "the wait keeps its start");
      }
    }
    assert.ok(rig.clock.now() - since >= CARRIED_WAIT_BOUND_MS);
    assert.equal(record.nextStep, "blocked");
    assert.equal(
      record.blocker?.message,
      `${CI_UNATTRIBUTED_DETAIL}: validate(failure)`,
    );
    assert.equal(rig.model.requests.length, 0);
    assert.deepEqual(launcherPlans(await rig.snapshot(), rig.clock.now()), []);
    if (GEN79) {
      for (const written of writes) await assertGen79Parses(written);
    }
  } finally {
    await rig.ctx.cleanup();
  }
});
