/** Hosted hosted-supervisor-authorization_test responsibility. */
import assert from "node:assert/strict";
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
  skippedProof,
  TASK_BODY,
  TASK_DIGEST,
} from "./actions-supervisor-fixture.ts";
import {
  bootstrapHealthy,
  driftedTask,
  ordinaryTurn,
  variantRequest,
} from "./actions-supervisor-lifecycle-fixture.ts";

Deno.test("hosted supervisor core: an exact ordinary not_started settlement restores due eligibility", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const identity = run(2);
    // Ordinary work is due on the next dispatch, with no hour cooldown.
    const ordinary = requireRun(await rig.prepare(identity));
    const originalDue = (await rig.snapshot()).hostedRuntimes[0].nextOrdinaryAt;
    assert.equal(originalDue, ordinary.createdAt);
    const skipped = skippedProof(ordinary);
    rig.evidence.settlements.set(ordinary.id, skipped);
    assert.equal((await rig.finalize(identity)).status, "idle");
    let state = await rig.snapshot();
    assert.equal(
      state.hostedRuntimes[0].lastExecutionProof?.outcome,
      "not_started",
    );
    assert.equal(state.hostedRuntimes[0].lastHealthyProof?.outcome, "healthy");
    assert.equal(state.hostedRuntimes[0].nextOrdinaryAt, skipped.observedAt);
    // Same run/attempt cannot resubmit.
    assert.equal((await rig.prepare(identity)).status, "idle");
    // A later run/attempt at the restored due instant retries.
    rig.clock.advance(skipped.observedAt - rig.clock.now() + 1);
    assert.ok(rig.clock.now() >= state.hostedRuntimes[0].nextOrdinaryAt);
    const retry = requireRun(await rig.prepare(run(3)));
    assert.equal(retry.purpose, "ordinary");
    state = await rig.snapshot();
    assert.equal(state.hostedRuntimes[0].execution?.id, retry.id);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: promotion preflight requires the exact frozen source request", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    await ordinaryTurn(rig, 9001);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    const prior = requireRun(await rig.prepare(run(2)));
    rig.evidence.settlements.set(prior.id, runProof(prior, "healthy"));
    await ordinaryTurn(rig, 9002);
    // The repair-side source is cancelled; the frozen hosted request no
    // longer canonical-equals it, so the promote intent must not persist.
    const cancelled = releaseRequest({
      status: "cancelled",
      failureReason: "cancelled by owner",
    });
    await rig.seedRepair([cancelled], [reviewReceipt(cancelled)]);
    const before = await rig.snapshot();
    await ordinaryTurn(rig, 3);
    const after = await rig.snapshot();
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    assert.equal(after.hostedRuntimes[0].execution, null);
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(after.hostedRuntimes[0].generation, 1);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: legacy, wrong-task or unreadable acceptance never selects a release", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    let nextRun = 2;
    const refuse = async (
      slug: string,
      receiptOverrides: Record<string, unknown> = {},
    ): Promise<void> => {
      const variant = variantRequest(slug, receiptOverrides);
      rig.evidence.requests.add(variant.request.id);
      await rig.seedRepair([variant.request], [variant.receipt]);
      const identity = run(nextRun);
      nextRun++;
      // The refused request never selects a release; with no hour cooldown the
      // dispatch starts the immediately-due ordinary work instead.
      const ordinary = requireRun(await rig.prepare(identity));
      assert.equal(ordinary.purpose, "ordinary");
      rig.evidence.settlements.set(ordinary.id, runProof(ordinary, "healthy"));
      assert.equal((await rig.finalize(identity)).status, "idle");
      const state = await rig.snapshot();
      assert.equal(state.hostedReleases.length, 0);
      assert.equal(state.hostedRuntimes[0].activeRevision, LAUNCHER);
    };
    // A legacy quality-only receipt parses and is otherwise green, yet it can
    // never select a release.
    await refuse("legacy", { taskAcceptance: null });
    // A fulfilled verdict bound to a digest that is not this issue's text.
    await refuse("wrong-digest", {
      taskAcceptance: {
        issueNumber: ISSUE,
        taskDigest: "e".repeat(64),
        verdict: "fulfilled",
        evidence: ["different task digest"],
      },
    });
    // An honest already-satisfied-at-base verdict is a non-delivery too.
    await refuse("satisfied", {
      taskAcceptance: {
        issueNumber: ISSUE,
        taskDigest: TASK_DIGEST,
        verdict: "already_satisfied_at_base",
        evidence: ["the base already satisfies the issue"],
      },
    });
    // A receipt for another issue number is refused as well.
    await refuse("other-issue", {
      taskAcceptance: {
        issueNumber: ISSUE + 1,
        taskDigest: TASK_DIGEST,
        verdict: "fulfilled",
        evidence: ["another issue"],
      },
    });
    // A self-consistent but non-App reviewer identity refuses as well.
    await refuse("other-reviewer", {
      expectedReviewer: "alternate-reviewer[bot]",
      observedReviewer: "alternate-reviewer[bot]",
    });
    // The exact-bound positive acceptance selects the release normally.
    const request = releaseRequest();
    rig.evidence.requests.add(request.id);
    await rig.seedRepair([request], [reviewReceipt(request)]);
    const prior = requireRun(await rig.prepare(run(nextRun)));
    assert.equal(prior.purpose, "prior");
    const state = await rig.snapshot();
    assert.equal(state.hostedReleases.length, 1);
    assert.equal(state.hostedReleases[0].phase, "requested");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: an unreadable trusted task context never selects a release", async () => {
  const rig = await makeRig();
  try {
    await bootstrapHealthy(rig);
    const request = releaseRequest();
    await rig.seedRepair([request], [reviewReceipt(request)]);
    rig.evidence.requests.add(request.id);
    // Transmission failure and an explicit null read both fail closed; the
    // immediately-due ordinary work is what each dispatch starts instead, so
    // the release pointer never moves.
    rig.evidence.taskFail = true;
    const firstOrdinary = requireRun(await rig.prepare(run(2)));
    assert.equal(firstOrdinary.purpose, "ordinary");
    rig.evidence.settlements.set(
      firstOrdinary.id,
      runProof(firstOrdinary, "healthy"),
    );
    assert.equal((await rig.finalize(run(2))).status, "idle");
    assert.equal((await rig.snapshot()).hostedReleases.length, 0);
    rig.evidence.taskFail = false;
    rig.evidence.tasks.set(ISSUE, null);
    const secondOrdinary = requireRun(await rig.prepare(run(3)));
    assert.equal(secondOrdinary.purpose, "ordinary");
    rig.evidence.settlements.set(
      secondOrdinary.id,
      runProof(secondOrdinary, "healthy"),
    );
    assert.equal((await rig.finalize(run(3))).status, "idle");
    assert.equal((await rig.snapshot()).hostedReleases.length, 0);
    rig.evidence.tasks.delete(ISSUE);
    assert.equal(requireRun(await rig.prepare(run(4))).purpose, "prior");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: promotion preflight rechecks the trusted acceptance immediately before promotion", async () => {
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
    // The live issue text moved after the prior verification: the frozen
    // request no longer binds the current task and the promote intent must not
    // be persisted.
    rig.evidence.tasks.set(ISSUE, await driftedTask(`${TASK_BODY} (edited)`));
    const before = await rig.snapshot();
    await ordinaryTurn(rig, 3);
    const after = await rig.snapshot();
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    assert.equal(after.hostedRuntimes[0].execution, null);
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    // An unavailable trusted read refuses the same promotion: the frozen
    // receipt and request records stay untouched and no intent is persisted.
    rig.evidence.tasks.set(ISSUE, null);
    await ordinaryTurn(rig, 4);
    assert.deepEqual(
      (await rig.snapshot()).hostedReleases,
      before.hostedReleases,
    );
    // The exact reviewed text and receipt still promote normally.
    rig.evidence.tasks.delete(ISSUE);
    const candidate = requireRun(await rig.prepare(run(5)));
    assert.equal(candidate.purpose, "candidate");
    assert.equal(candidate.revision, CANDIDATE);
    const promoted = await rig.snapshot();
    assert.equal(promoted.hostedReleases[0].phase, "verifying");
    assert.equal(promoted.hostedReleases[0].priorProof?.execution.id, prior.id);
    assert.equal(promoted.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(promoted.hostedRuntimes[0].generation, 2);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted supervisor core: issue text that drifts while the source verifier runs never promotes", async () => {
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
    // The live issue text changes exactly WHILE the trusted source verifier is
    // in flight: the authorization that permits the pointer move is the read
    // taken after that verifier settles, so this drift must refuse the
    // promotion and leave the durable state untouched.
    const drifted = await driftedTask(
      `${TASK_BODY} (edited during verification)`,
    );
    const verify = rig.evidence.verifyRequest.bind(rig.evidence);
    let driftedDuringVerify = false;
    rig.evidence.verifyRequest = (request) => {
      if (!driftedDuringVerify) {
        driftedDuringVerify = true;
        rig.evidence.tasks.set(ISSUE, drifted);
      }
      return verify(request);
    };
    const before = await rig.snapshot();
    await ordinaryTurn(rig, 3);
    assert.equal(driftedDuringVerify, true);
    const after = await rig.snapshot();
    assert.deepEqual(after.hostedReleases, before.hostedReleases);
    assert.equal(after.hostedRuntimes[0].execution, null);
    assert.equal(after.hostedRuntimes[0].activeRevision, LAUNCHER);
    assert.equal(after.hostedRuntimes[0].generation, 1);
    // The exact unchanged positive still promotes normally.
    rig.evidence.tasks.delete(ISSUE);
    const candidate = requireRun(await rig.prepare(run(4)));
    assert.equal(candidate.purpose, "candidate");
    assert.equal(candidate.revision, CANDIDATE);
    const promoted = await rig.snapshot();
    assert.equal(promoted.hostedRuntimes[0].activeRevision, CANDIDATE);
    assert.equal(promoted.hostedRuntimes[0].generation, 2);
    assert.equal(promoted.hostedReleases[0].phase, "verifying");
    assert.equal(promoted.hostedReleases[0].priorProof?.execution.id, prior.id);
  } finally {
    await rig.cleanup();
  }
});
