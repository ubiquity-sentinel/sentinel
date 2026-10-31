/**
 * A legacy record whose final round is open, at the review-round ceiling on a
 * moved base, on a red head its own change did not break (round-2 recheck
 * P3). With the generic `CI checks failed: ...` blocker the launcher's
 * correction rule re-admitted it as a CI correction on every pass and R80's
 * delivery step declined the fix every time (no candidate attribution): one
 * correction slot per pass, no progress. The runtime keeps such a head away
 * from the correction rule and awaits a base check still running, bounded.
 *
 * Issue #155: the reviewed base B0 never turns green, so the head never does
 * either, and on a moved base no launcher rule re-runs or re-admits it. Once
 * the tip is complete and green the head takes the uncharged mechanical
 * refresh a green spent head takes (carrying its review); while the tip is
 * red it waits, bounded. A head its review does not authorize to carry, or
 * one still waiting at the bound, parks with a precise blocker (the red
 * reviewed base, or no base evidence) that the launcher reports every pass.
 *
 * Driven through the REAL R80 loop and the REAL launcher retry planner with
 * R80 pinned as the CI-first runtime; every snapshot the loop writes parses
 * under the generation-79 rollback runtime.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { HostedRuntimeRecordV1 } from "../../src/contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { isCarriedMergeMarker } from "../../src/repair/carried-review.ts";
import { CI_BASE_RED_DETAIL } from "../../src/repair/ci-rejection.ts";
import { CARRIED_WAIT_BOUND_MS } from "../../src/repair/loop-carried-delivery.ts";
import { planHostedRetries } from "../../ops/hosted-autonomy-retries.ts";
import { legacyHeldHeadActions } from "../../ops/hosted-autonomy-retry-pass.ts";
import { ciGreenHeadKey } from "../../ops/hosted-autonomy-ci-retries.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import { SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { assertGen79Parses, gen79Available } from "../state/gen77-contracts.ts";
import { healthyProof } from "../host/hosted-autonomy-rig.ts";
import { check, ciFirstRig, taskRecord } from "./ci-first-rig.ts";
import { completedReceipt } from "./loop-review-fixtures.ts";

const GEN79 = await gen79Available();
const AIUBQ = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
const CUT = T0;
const ID = "issue-ubiquity-ai.ubq.fi-595";
const PREP3 = "3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a3a" as GitSha;
/** A later development tip whose own CI is green. */
const TIP2 = "5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c5c" as GitSha;
const R80 = "8080808080808080808080808080808080808080" as GitSha;
const HOUR = 60 * 60_000;
const TIPS = new Map([[hostedRepositoryKey(AIUBQ), SHA2 as string]]);

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
    TIPS,
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

/** The latest review of SHA3 on SHA1 accepted the live task 595. */
async function acceptedReview() {
  return completedReceipt(7, SHA3, SHA1, {
    id: "review-receipt:595-latest",
    repository: AIUBQ,
    taskAcceptance: {
      issueNumber: 595,
      taskDigest: await reviewTaskStatementDigest({
        issueNumber: 595,
        title: "issue 595",
        body: "",
      }),
      verdict: "fulfilled",
      evidence: ["the exact reviewed change implements the source issue"],
    },
  });
}

/**
 * The 595 legacy shape (pin 4, final round open) at `delivery`, its red head
 * SHA3 reviewed on SHA1, the base moved to SHA2. `tip` is the tip's own CI
 * (green by default); `carriable` gives it a task-accepting review and a port
 * that proves the carried patch.
 */
async function legacyRig(
  name: string,
  base: ReturnType<typeof check>[],
  options: { tip?: ReturnType<typeof check>[]; carriable?: boolean } = {},
) {
  const made = await ciFirstRig(name, {
    identity: { repository: AIUBQ, id: ID, issue: 595 },
    legacyReviewCutoff: CUT,
    ...(options.carriable === true
      ? { reviews: [await acceptedReview()] }
      : { reviewed: true }),
    reviewRounds: 4,
    attempts: 3,
    nextStep: "delivery",
    baseTip: SHA2,
    refreshTo: { [SHA3]: PREP3 },
    checks: {
      [SHA3]: [check("validate", SHA3, "failure")],
      [SHA1]: base,
      [SHA2]: options.tip ?? [check("validate", SHA2, "success")],
      [TIP2]: [check("validate", TIP2, "success")],
      [PREP3]: [check("validate", PREP3, "success")],
    },
  });
  if (options.carriable === true) {
    const digest = "c".repeat(64);
    made.rig.github.proveCarriedPatch = (request) =>
      Promise.resolve(portOk({
        reviewedMergeBase: request.reviewedBase,
        reviewedPatch: digest,
        refreshedMergeBase: request.base,
        refreshedPatch: digest,
        refreshedFrom: request.head === PREP3 ? SHA3 : null,
        refreshes: request.head === PREP3 ? 1 : 0,
      }));
  }
  return made;
}

const RED_BASE = () => [check("validate", SHA1, "failure")];
const BASE_RED_PARK = `${CI_BASE_RED_DETAIL}: validate(failure)`;

Deno.test("legacy moved base: a red head on its red reviewed base is refreshed onto the green tip and re-reviewed, never parked for spent rounds", async () => {
  const { rig, writes } = await legacyRig("legacy-moved-red-base", RED_BASE());
  try {
    await rig.run();
    const snapshot = await rig.snapshot();
    const record = taskRecord(snapshot, ID);
    // Owner directive 2026-10-30: rounds are accounting, never a park. The
    // head is mechanically refreshed onto the green tip and its next review
    // is admitted instead of parking on the red reviewed base.
    assert.equal(record.nextStep, "review");
    assert.equal(record.blocker, null);
    assert.equal(record.target.base, SHA2);
    assert.equal(record.target.head, PREP3);
    assert.equal(record.wait?.reason, "review_pending");
    assert.equal(
      record.counters.reviewRounds,
      5,
      "the spent rounds stay counted",
    );
    assert.equal(rig.model.requests.length, 0, "no CI fix started");
    assert.equal(
      rig.github.reviewRequestIdentities.length,
      1,
      "one new review round is admitted",
    );
    // No launcher rule parks or re-admits it: it owns its ordinary path.
    assert.deepEqual(launcherPlans(snapshot, rig.clock.now()), []);
    assert.deepEqual(legacyHeldHeadActions(snapshot, CUT, TIPS), []);
    // Next run: still iterating on its review, never blocked.
    rig.clock.advance(15 * 60_000 + 1);
    await rig.run();
    const again = await rig.snapshot();
    const still = taskRecord(again, ID);
    assert.equal(still.nextStep, "review");
    assert.equal(still.blocker, null);
    assert.equal(rig.model.requests.length, 0);
    if (GEN79) {
      for (const written of writes) await assertGen79Parses(written);
    }
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("legacy moved base: a failure no base evidence attributes is refreshed onto the green tip and re-reviewed", async () => {
  // The reviewed base never ran `validate` (no base evidence).
  const { rig } = await legacyRig("legacy-moved-unattributed", [
    check("lint", SHA1, "success"),
  ]);
  try {
    await rig.run();
    const snapshot = await rig.snapshot();
    const record = taskRecord(snapshot, ID);
    assert.equal(record.nextStep, "review");
    assert.equal(record.blocker, null);
    assert.equal(record.target.base, SHA2);
    assert.equal(record.target.head, PREP3);
    assert.equal(record.counters.reviewRounds, 5);
    assert.deepEqual(launcherPlans(snapshot, rig.clock.now()), []);
    assert.deepEqual(legacyHeldHeadActions(snapshot, CUT, TIPS), []);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("legacy moved base: a base check still running is refreshed onto the green tip and re-reviewed, never re-admitted as a correction", async () => {
  const { rig, writes } = await legacyRig("legacy-moved-base-pending", [
    check("validate", SHA1, null, "in_progress"),
  ]);
  try {
    await rig.run();
    let record = taskRecord(await rig.snapshot(), ID);
    assert.equal(record.nextStep, "review");
    assert.equal(record.blocker, null);
    assert.equal(record.target.base, SHA2);
    assert.equal(record.target.head, PREP3);
    assert.equal(record.wait?.reason, "review_pending");
    assert.deepEqual(launcherPlans(await rig.snapshot(), rig.clock.now()), []);
    for (let hour = 0; hour < 3; hour++) {
      rig.clock.advance(HOUR);
      await rig.run();
      record = taskRecord(await rig.snapshot(), ID);
      assert.equal(record.nextStep, "review", `hour ${hour}`);
      assert.equal(record.blocker, null, `hour ${hour}`);
    }
    assert.equal(rig.model.requests.length, 0, "no CI fix started");
    assert.deepEqual(launcherPlans(await rig.snapshot(), rig.clock.now()), []);
    if (GEN79) {
      for (const written of writes) await assertGen79Parses(written);
    }
  } finally {
    await rig.ctx.cleanup();
  }
});

/** Run until the record holds the carried-merge marker (or `limit` runs). */
async function runToMarker(
  made: Awaited<ReturnType<typeof legacyRig>>,
  limit = 6,
) {
  const { rig } = made;
  let record = taskRecord(await rig.snapshot(), ID);
  for (let run = 0; run < limit; run++) {
    await rig.run();
    record = taskRecord(await rig.snapshot(), ID);
    if (isCarriedMergeMarker(record.wait)) break;
    rig.clock.advance(5 * 60_000 + 1);
  }
  return record;
}

/** The refreshed head carries the review to the launcher; nothing charged. */
async function assertCarried(
  made: Awaited<ReturnType<typeof legacyRig>>,
  tip: GitSha,
) {
  const { rig, refreshes } = made;
  const record = taskRecord(await rig.snapshot(), ID);
  assert.equal(record.nextStep, "work", JSON.stringify(record.blocker));
  assert.equal(record.target.head, PREP3);
  assert.equal(record.target.base, tip);
  assert.ok(isCarriedMergeMarker(record.wait), JSON.stringify(record.wait));
  assert.equal(refreshes.length, 1, "one mechanical refresh");
  assert.equal(rig.model.requests.length, 0, "no model run");
  assert.deepEqual(rig.github.reviewRequestIdentities, [], "no review");
  assert.equal(
    rig.github.calls.filter((call) => call === "merge").length,
    0,
    "the runtime never merges a carried head",
  );
  const snapshot = await rig.snapshot();
  assert.equal(record.counters.reviewRounds, 4, "no round spent");
  assert.equal(record.counters.retries, 0, "no CI fix spent");
  assert.deepEqual(
    snapshot.reservations,
    made.charges,
    "nothing reserved, settled or refunded",
  );
}

Deno.test("legacy moved base: a head red through its red reviewed base is refreshed onto a green tip, uncharged, carrying its review to the launcher's merge (#155)", async () => {
  const made = await legacyRig("legacy-moved-red-base-carried", RED_BASE(), {
    carriable: true,
  });
  try {
    await runToMarker(made);
    await assertCarried(made, SHA2);
    assert.deepEqual(
      legacyHeldHeadActions(await made.rig.snapshot(), CUT, TIPS),
      [],
      "nothing held",
    );
    if (GEN79) {
      for (const written of made.writes) await assertGen79Parses(written);
    }
  } finally {
    await made.rig.ctx.cleanup();
  }
});

Deno.test("legacy moved base: an unattributed red head is refreshed onto a green tip the same way", async () => {
  const made = await legacyRig(
    "legacy-moved-unattributed-carried",
    [check("lint", SHA1, "success")],
    { carriable: true },
  );
  try {
    await runToMarker(made);
    await assertCarried(made, SHA2);
  } finally {
    await made.rig.ctx.cleanup();
  }
});

Deno.test("legacy moved base: while the tip is red the head waits, holding nobody, and refreshes once a green tip arrives", async () => {
  const made = await legacyRig("legacy-moved-red-tip", RED_BASE(), {
    carriable: true,
    tip: [check("validate", SHA2, "failure")],
  });
  const { rig } = made;
  try {
    await rig.run();
    let record = taskRecord(await rig.snapshot(), ID);
    assert.equal(record.nextStep, "delivery");
    assert.equal(record.blocker, null);
    // `ci_pending`: the delivery line reads it as not deliverable now.
    assert.equal(record.wait?.reason, "ci_pending");
    const since = record.wait!.since;
    assert.equal(made.refreshes.length, 0, "never refreshed onto a red tip");
    assert.deepEqual(launcherPlans(await rig.snapshot(), rig.clock.now()), []);
    rig.clock.advance(HOUR);
    await rig.run();
    record = taskRecord(await rig.snapshot(), ID);
    assert.equal(record.wait?.since, since, "the wait keeps its start");
    // Development is fixed: the next tip is green.
    made.moveBase(TIP2);
    rig.clock.advance(HOUR);
    await runToMarker(made);
    await assertCarried(made, TIP2);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("legacy moved base: a tip red past the bound parks the head with the base-red blocker", async () => {
  const { rig, refreshes, charges } = await legacyRig(
    "legacy-moved-red-tip-bound",
    RED_BASE(),
    { carriable: true, tip: [check("validate", SHA2, "failure")] },
  );
  try {
    await rig.run();
    let record = taskRecord(await rig.snapshot(), ID);
    const since = record.wait!.since;
    for (let hour = 0; hour <= 7 && record.nextStep !== "blocked"; hour++) {
      rig.clock.advance(HOUR);
      await rig.run();
      record = taskRecord(await rig.snapshot(), ID);
    }
    assert.ok(rig.clock.now() - since >= CARRIED_WAIT_BOUND_MS);
    assert.equal(record.nextStep, "blocked");
    assert.equal(record.blocker?.message, BASE_RED_PARK);
    assert.equal(refreshes.length, 0);
    assert.equal(rig.model.requests.length, 0);
    const snapshot = await rig.snapshot();
    assert.deepEqual(snapshot.reservations, charges, "nothing charged");
    assert.deepEqual(legacyHeldHeadActions(snapshot, CUT, TIPS), [
      `retry:${ID}:denied:legacy_base_red`,
    ]);
  } finally {
    await rig.ctx.cleanup();
  }
});
