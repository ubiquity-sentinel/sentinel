/** Hosted hosted-supervisor-health_test responsibility. */
import assert from "node:assert/strict";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import { T0 } from "../state/helpers.ts";
import {
  CANDIDATE,
  ISSUE,
  LAUNCHER,
  makeRig,
  releaseRequest,
  requireRun,
  reviewReceipt,
  run,
  runProof,
  TASK_BODY,
  workRecordFor,
} from "./actions-supervisor-fixture.ts";
import {
  bootstrapHealthy,
  driftedTask,
  ordinaryTurn,
  persistPromotingIntent,
} from "./actions-supervisor-lifecycle-fixture.ts";

Deno.test("hosted supervisor core: a missing current health proof plans model-disabled verification and the next dispatch is due for ordinary work", async () => {
  const rig = await makeRig();
  try {
    rig.evidence.revisions.add(LAUNCHER);
    // The only legally reachable runtime without a current health proof is the
    // first generation: the store correctly refuses to clear a persisted
    // healthy proof, so the gap is exercised at its real origin rather than by
    // hand-clearing one.
    const planned = requireRun(await rig.prepare(run(1)));
    // Model work is started only by an `ordinary` execution.
    assert.notEqual(planned.purpose, "ordinary");
    assert.equal(planned.purpose, "bootstrap");
    assert.equal(planned.revision, LAUNCHER);
    let state = await rig.snapshot();
    const due = state.hostedRuntimes[0].nextOrdinaryAt;
    // No artificial cooldown is stamped: the verified gap, not the clock,
    // controls when ordinary work becomes due.
    assert.ok(due <= rig.clock.now());
    assert.equal(state.hostedRuntimes[0].lastHealthyProof, null);
    assert.equal(state.hostedRuntimes[0].execution?.id, planned.id);
    // A healthy verification settles and the next dispatch runs ordinary work
    // immediately; the verification neither consumes nor defers the cadence.
    rig.evidence.settlements.set(planned.id, runProof(planned, "healthy"));
    const ordinary = requireRun(await rig.prepare(run(2)));
    assert.equal(ordinary.purpose, "ordinary");
    assert.equal(ordinary.revision, LAUNCHER);
    state = await rig.snapshot();
    assert.equal(
      state.hostedRuntimes[0].lastHealthyProof?.execution.id,
      planned.id,
    );
    assert.equal(state.hostedRuntimes[0].nextOrdinaryAt, ordinary.createdAt);
    // Same run/attempt cannot start a second execution; a different run
    // cannot start one while the ordinary execution is active.
    assert.equal(requireRun(await rig.prepare(run(2))).id, ordinary.id);
    assert.equal((await rig.prepare(run(3))).status, "pending");
    assert.equal(
      (await rig.snapshot()).hostedRuntimes[0].execution?.id,
      ordinary.id,
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: a persisted promote intent is re-authorized immediately before the pointer moves", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    await ordinaryTurn(rig, 9001);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(await rig.prepare(run(2)));
    assert.equal(prior.purpose, "prior");
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    await ordinaryTurn(rig, 9002);
    // The real core persists the intent, then its pointer write is refused:
    // the durable state is the exact resumed intent a later prepare sees.
    await persistPromotingIntent(rig, run(3));
    // The live issue text changed after the intent was persisted: the resumed
    // Ordinary work may interleave, but cannot move the pointer or clear the intent.
    rig.evidence.tasks.set(ISSUE, await driftedTask(`${TASK_BODY} (edited)`));
    const before = await rig.snapshot();
    await ordinaryTurn(rig, 4);
    const after = await rig.snapshot();
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(after.hostedRuntimes[0].generation, 1);
    assert.equal(after.hostedReleases[0].phase, "promoting");
    assert.notEqual(after.hostedReleases[0].pointerIntent, null);
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    // An unavailable trusted read refuses the same move and keeps the intent.
    rig.evidence.tasks.delete(ISSUE);
    rig.evidence.taskFail = true;
    await ordinaryTurn(rig, 5);
    rig.evidence.taskFail = false;
    assert.deepEqual(
      (await rig.snapshot()).hostedReleases,
      before.hostedReleases,
    );
    // The exact unchanged positive still promotes through the persisted intent.
    const candidate = requireRun(await rig.prepare(run(6)));
    assert.equal(candidate.purpose, "candidate");
    assert.equal(candidate.revision, CANDIDATE);
    const promoted = await rig.snapshot();
    assert.equal(promoted.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(promoted.hostedRuntimes[0].generation, 2);
    assert.equal(promoted.hostedReleases[0].phase, "verifying");
    assert.equal(promoted.hostedReleases[0].pointerIntent, null);
    assert.equal(promoted.hostedReleases[0].priorProof?.execution.id, prior.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: a supported review_quota wait survives readRepair and prepare while an unknown reason refuses", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    await ordinaryTurn(rig, 9001);
    const request = releaseRequest();
    // The installed runtime's own bounded quota wait: nextStep review with a
    // budget-bound review_quota reason, exactly as the captured repair record
    // carries it.
    await rig.seedRepair([request], [reviewReceipt(request)], {
      nextStep: "review",
      wait: { reason: "review_quota", since: T0, until: T0 + 60_000 },
    });
    rig.evidence.requests.add(request.id);
    const before = await rig.repair.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    if (!before.ok || before.value.status !== "found") {
      throw new Error("repair state unreadable");
    }
    const seeded = before.value.snapshot.work[0];
    assert.equal(seeded.nextStep, "review");
    assert.equal(seeded.wait?.reason, "review_quota");
    assert.equal(seeded.wait?.until, T0 + 60_000);
    // The real readRepair view + prepare consume the supported wait without a
    // parser refusal, and leave the budget-bound wait untouched.
    assert.equal(
      requireRun(await rig.prepare(run(2))).purpose,
      "prior",
    );
    const after = await rig.repair.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    if (!after.ok || after.value.status !== "found") {
      throw new Error("repair state unreadable");
    }
    const held = after.value.snapshot.work[0];
    assert.equal(held.nextStep, "review");
    assert.equal(held.wait?.reason, "review_quota");
    assert.equal(held.wait?.until, T0 + 60_000);
    assert.equal(held.wait?.since, T0);
    // Any other wait reason is still refused by the frozen parser.
    assert.throws(() =>
      parseWorkRecordV1({
        ...workRecordFor(request),
        nextStep: "review",
        wait: { reason: "quota", since: T0, until: null },
      })
    );
  } finally {
    await rig.cleanup();
  }
});
