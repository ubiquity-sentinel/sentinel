import assert from "node:assert/strict";
import {
  BRANCH,
  conflictGithub,
  conflictRig,
  makeConflictGit,
  PR,
  publishedCandidate,
} from "./conflict-resolution-rig.ts";
import { REPO, SHA1 } from "../state/helpers.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type ImplementationPort,
  portError,
} from "../../src/contracts/ports.ts";
import { baseRefreshIntentKey } from "../../src/repair/keys.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import { planHostedRetries } from "../../ops/hosted-autonomy-retries.ts";

// Repair state is simulated in memory here; git_budget_test.ts covers real Git persistence.

Deno.test("admission gap: an interrupted conflict admission keeps its exact reservation recoverable after restart", async () => {
  const ctx = await makeConflictGit();
  let modelCalls = 0;
  const model: ImplementationPort = {
    runModel() {
      modelCalls++;
      throw new Error("SETUP: this probe must never invoke an implementation");
    },
  };
  try {
    const github = conflictGithub(ctx);
    const original = conflictRig(github, model);
    const work = await publishedCandidate(ctx, {
      counters: { attempts: 6, retries: 3, reviewRounds: 0 },
    });
    work.intent = {
      kind: "base_refresh",
      key: baseRefreshIntentKey(PR, ctx.head, ctx.base),
      startedAt: original.clock.now(),
      branch: BRANCH,
      expectedHead: ctx.head,
      observedBase: ctx.base,
      pr: PR,
      requestId: null,
      resultId: null,
      failure: conflictMarker(ctx.base, original.clock.now()),
    };
    await original.seed([work]);

    // Interruption is after the real budget persisted attempt seven and before
    // the repair loop can read it back to persist its implementation intent.
    const read = original.state.readRepair.bind(original.state);
    let injected = false;
    original.state.readRepair = () => {
      if (
        !injected &&
        original.state.repair?.reservations.some((row) =>
          row.taskId === work.id && row.attempt === 7 &&
          row.purpose === "retry" && row.outcome === "reserved"
        )
      ) {
        injected = true;
        return Promise.resolve(
          portError("unavailable", "injected post-admission read failure"),
        );
      }
      return read();
    };
    const interrupted = await original.run();
    assert.equal(
      injected,
      true,
      "SETUP: interruption must reach the post-reservation boundary",
    );
    assert.equal(
      interrupted.status,
      "state_error",
      "SETUP: injected read failure must stop this run",
    );
    const saved = structuredClone(await original.snapshot());
    const savedHead = original.state.repairHead;
    const charge = saved.reservations.find((row) =>
      row.taskId === work.id && row.attempt === 7
    );
    assert.ok(charge, "SETUP: real budget must persist attempt seven");
    assert.equal(saved.reservations.length, 1);
    assert.equal(charge.head, ctx.b0);
    assert.equal(charge.outcome, "reserved");
    assert.equal(charge.proofRef, null);
    assert.equal(charge.settledAt, null);
    assert.equal(modelCalls, 0);

    // New runtime objects resume only the durable snapshot. These are safety
    // controls, not evidence that the historical real reservation was unsent.
    const controls: unknown[] = [];
    for (const outcome of ["submitted", "ambiguous"] as const) {
      const control = conflictRig(github, model);
      const copy = structuredClone(saved);
      copy.reservations[0] = {
        ...copy.reservations[0],
        outcome,
        settledAt: control.clock.now(),
      };
      control.state.repair = copy;
      control.state.repairHead = savedHead;
      control.clock.advance(60_000);
      const result = await control.run();
      const after = await control.snapshot();
      assert.deepEqual(
        after.reservations,
        copy.reservations,
        `${outcome} charge must never be reset or refunded`,
      );
      assert.equal(
        after.work[0].counters.attempts,
        saved.work[0].counters.attempts,
        "no replacement start identity",
      );
      assert.equal(modelCalls, 0, "no duplicate external start");
      assert.deepEqual(github.pushes, [], "no publication effect");
      controls.push({ outcome, result, blocker: after.work[0].blocker });
    }

    const restarted = conflictRig(github, model);
    restarted.state.repair = structuredClone(saved);
    restarted.state.repairHead = savedHead;
    restarted.clock.advance(60_000);
    const resumed = await restarted.run();
    assert.notEqual(
      resumed.status,
      "state_error",
      "SETUP: restart must reach the real duplicate branch",
    );
    const after = await restarted.snapshot();
    assert.equal(after.reservations.length, 1, "no replacement admission");
    assert.equal(after.reservations[0].id, charge.id);
    assert.equal(after.reservations[0].createdAt, charge.createdAt);
    assert.notEqual(
      after.reservations[0].outcome,
      "confirmed_not_submitted",
      "a restart never invents refund proof",
    );
    assert.equal(
      after.work[0].counters.attempts,
      saved.work[0].counters.attempts,
      "restart buys no new attempt",
    );
    assert.equal(modelCalls, 0);
    assert.deepEqual(github.pushes, []);
    const plans = planHostedRetries(
      after,
      restarted.clock.now(),
      SHA1,
      new Map([[hostedRepositoryKey(REPO), ctx.base as GitSha]]),
    );
    console.log(
      JSON.stringify({
        kind: "admission_gap_probe",
        charge: charge.id,
        modelCalls,
        nextStep: after.work[0].nextStep,
        blocker: after.work[0].blocker,
        retryPlans: plans.length,
      }),
    );

    // Expected RED: the successful reserve must already contain the counted
    // recoverable intent at the crash checkpoint, before another state read.
    // These assertions request custody of identity, never permission to start.
    assert.equal(
      saved.work[0].counters.attempts,
      charge.attempt,
      "BEHAVIOR_DEFECT: durable reserve must atomically retain the counted attempt",
    );
    assert.equal(
      saved.work[0].intent?.requestId,
      charge.id,
      "BEHAVIOR_DEFECT: durable reserve must atomically retain the exact recoverable admission intent",
    );
  } finally {
    await ctx.cleanup();
  }
});
