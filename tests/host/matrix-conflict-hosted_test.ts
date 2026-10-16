/**
 * The OPEN hosted conflict-resolution route end to end, over real Git and the
 * real hosted pieces (`matrix-conflict-hosted-rig.ts`): the hosted repair
 * loop, the trusted matrix planner, one matrix cell whose model port is the
 * trusted merge preparer, committer and resolver around a scripted session,
 * the bundle exporter and the trusted importer's ancestry checks, then the
 * hosted loop again.
 *
 * refresh conflict -> pending (uncharged) -> one charged cell (`retry` at B0,
 * continuing H with B to merge) -> merge commit M with parents H and B, read
 * against B -> bundle ingest proving H and B are ancestors of M -> resolved
 * -> preserved and lease-pushed over H -> target advances to (M, B) -> review
 * of M requested on the same pull request. Every snapshot written on the way
 * parses under generation 78 (R78 474f87eb6), the rollback target of the
 * runtime that opens this route. Non-success cells stay charged and blocked
 * with the marker, never a second charge.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  conflictMarkerBase,
  HOSTED_CONFLICT_RESOLUTIONS,
} from "../../src/repair/conflict-resolution.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import { REPO } from "../state/helpers.ts";
import { assertGen78Parses, gen78Available } from "../state/gen77-contracts.ts";
import { BRANCH, PR, TASK } from "../repair/conflict-resolution-rig.ts";
import {
  hostedConflictRig,
  launcherRetries,
  moveBase,
  resolveHosted,
} from "./matrix-conflict-hosted-rig.ts";

const available = await gen78Available();

function charges(state: RepairStateSnapshotV1) {
  return state.reservations.filter((row) =>
    row.purpose === "implementation" || row.purpose === "retry"
  );
}

async function assertRollbackReadable(
  written: readonly RepairStateSnapshotV1[],
): Promise<void> {
  if (!available) return;
  for (const snapshot of written) await assertGen78Parses(snapshot);
}

Deno.test("hosted conflict resolution: refresh conflict -> pending -> charged cell -> merge (H, B) -> fast-forward publish -> review", async () => {
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS, true, "the hosted route is open");
  const rig = await hostedConflictRig();
  const { ctx, github, hosted } = rig;
  try {
    const key = baseRefreshIntentKey(PR, ctx.head, ctx.base);

    // 1. The hosted loop: the refresh conflicts and the record is pending
    // (the marked refresh intent, the PR identity kept), nothing charged.
    const first = await rig.runLoop();
    assert.notEqual(first.status, "state_error", JSON.stringify(first));
    const pending = (await hosted.snapshot()).work[0];
    assert.equal(pending.blocker, null, JSON.stringify(pending.blocker));
    assert.equal(pending.nextStep, "work");
    assert.equal(pending.target.pr, PR);
    assert.equal(pending.intent?.kind, "base_refresh");
    assert.equal(pending.intent?.key, key);
    assert.equal(pending.intent?.resultId, null);
    assert.equal(conflictMarkerBase(pending.intent), ctx.base);
    assert.deepEqual((await hosted.snapshot()).reservations, []);
    assert.deepEqual(github.pushes, []);

    // 2. The trusted planner admits ONE charged cell continuing H with B.
    const planned = await rig.plan();
    assert.equal(planned.plan.cells.length, 1, JSON.stringify(planned));
    const cell = planned.plan.cells[0];
    assert.equal(cell.request.base, ctx.b0, "the durable reviewed base");
    assert.equal(cell.request.checkoutBase, ctx.head);
    assert.equal(cell.request.mergeBase, ctx.base);
    assert.equal(cell.request.reviewFindings, undefined);
    const admitted = await hosted.snapshot();
    assert.equal(admitted.work[0].intent?.kind, "implementation");
    assert.equal(conflictMarkerBase(admitted.work[0].intent), ctx.base);
    assert.equal(admitted.reservations.length, 1, "one charge");
    assert.equal(admitted.reservations[0].purpose, "retry");
    assert.equal(admitted.reservations[0].head, ctx.b0);
    assert.equal(admitted.reservations[0].outcome, "reserved");
    const again = await rig.plan();
    assert.equal(again.plan.cells.length, 0, "never a second cell");

    // 3. The cell: the trusted merge of (H, B), committed with exactly the
    // parents H and B and read against B, carried by a bounded bundle.
    const { result, model } = await rig.runCell(planned.plan, cell);
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(model.requests.length, 1, "exactly one model session");
    assert.deepEqual(model.conflicted, ["src/app.ts"]);
    const merged = result.bundle!.head;
    assert.deepEqual(
      result.receipt?.candidate?.changedPaths,
      ["src/app.ts", "src/feature.ts"],
      "the candidate's own change set against B, never the base's history",
    );

    // 4. Ingest into the trusted mirror: the import proves H and B are both
    // ancestors of M, M is preserved under the refresh binding of (PR, H, B)
    // BEFORE the receipt is consumed (a later job's fresh mirror publishes it
    // from there, `matrix-conflict-fresh-mirror_test.ts`), then the charge
    // settles submitted and M is resolved.
    const ref = await candidatePreservationRef(REPO, TASK, key);
    const preservation = {
      taskId: TASK,
      candidate: { operationKey: key, base: ctx.base, head: merged, ref },
      publishedHead: ctx.head,
    };
    const ingested = await rig.ingest(planned.plan, [result]);
    assert.equal(ingested.ingested, 1, JSON.stringify(ingested));
    assert.deepEqual(github.preservationRequests, [preservation]);
    assert.deepEqual(await ctx.parents(merged), [ctx.head, ctx.base]);
    const resolved = await hosted.snapshot();
    const resolvedWork = resolved.work[0];
    assert.equal(resolvedWork.nextStep, "work");
    assert.equal(resolvedWork.intent?.kind, "base_refresh");
    assert.equal(resolvedWork.intent?.key, key);
    assert.equal(resolvedWork.intent?.resultId, merged);
    assert.equal(conflictMarkerBase(resolvedWork.intent), ctx.base);
    assert.equal(resolvedWork.target.head, ctx.head, "H until published");
    assert.equal(resolved.reservations[0].outcome, "submitted");
    assert.deepEqual(github.pushes, [], "nothing published by the ingest");

    // 5. The hosted loop publishes M exactly like a prepared refresh result.
    hosted.clock.advance(60_000);
    const second = await rig.runLoop();
    assert.notEqual(second.status, "state_error", JSON.stringify(second));
    assert.deepEqual(
      github.preservationRequests,
      [preservation, preservation],
      "the publication reconciles the exact operation the ingest preserved",
    );
    assert.deepEqual(github.pushes, [{
      ref: `refs/heads/${BRANCH}`,
      sha: merged,
      expected: ctx.head,
    }], "one fast-forward push of M over H with the normal lease");
    const state = await hosted.snapshot();
    const work = state.work[0];
    assert.equal(work.blocker, null, JSON.stringify(work.blocker));
    assert.equal(work.nextStep, "review");
    assert.equal(work.target.pr, PR, "the open PR updated in place");
    assert.equal(work.target.base, ctx.base);
    assert.equal(work.target.head, merged);
    assert.equal(work.intent, null);
    assert.equal(github.reviewRequestIdentities.length, 1);
    assert.equal(github.reviewRequestIdentities[0].expectedHead, merged);
    assert.equal(github.reviewRequestIdentities[0].prNumber, PR);
    assert.equal(charges(state).length, 1, "one charge for the base tip");
    assert.equal(charges(state)[0].outcome, "submitted", "never refunded");

    // Every state this route wrote is readable by the rollback target.
    assert.ok(hosted.written.length >= 5);
    await assertRollbackReadable(hosted.written);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("hosted conflict resolution: a failed, unstarted or protected cell stays charged and blocked with the marker", async (t) => {
  for (
    const [name, options, outcome, message] of [
      [
        "incomplete session",
        { failed: true },
        "ambiguous",
        /^model run did not complete/,
      ],
      [
        "never started",
        { notStarted: true },
        "ambiguous",
        /^implementation start is past the model cutoff/,
      ],
      [
        "touches a protected path",
        { extra: { "src/handler.ts": "export const handled = true;\n" } },
        "submitted",
        /^candidate touches a protected path$/,
      ],
    ] as const
  ) {
    await t.step(name, async () => {
      const rig = await hostedConflictRig();
      try {
        await resolveHosted(rig, options);
        for (let run = 0; run < 2; run++) {
          rig.hosted.clock.advance(5 * 60_000);
          const outcome = await rig.runLoop();
          assert.notEqual(outcome.status, "state_error");
          assert.equal((await rig.plan()).plan.cells.length, 0);
        }
        const state = await rig.hosted.snapshot();
        const work = state.work[0];
        assert.equal(work.nextStep, "blocked", JSON.stringify(work));
        assert.match(work.blocker?.message ?? "", message);
        assert.equal(conflictMarkerBase(work.intent), rig.ctx.base);
        assert.equal(work.target.head, rig.ctx.head, "H is kept");
        assert.equal(charges(state).length, 1, "never a second charge");
        assert.equal(charges(state)[0].outcome, outcome, "never refunded");
        assert.deepEqual(rig.github.pushes, []);
        await assertRollbackReadable(rig.hosted.written);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("hosted conflict resolution: the launcher refuses the spent tip and re-pends at a moved tip, one charge per tip", async () => {
  const rig = await hostedConflictRig();
  try {
    await resolveHosted(rig, { failed: true });
    await rig.runLoop();
    const blocked = await rig.hosted.snapshot();
    assert.equal(blocked.work[0].nextStep, "blocked");
    assert.equal(conflictMarkerBase(blocked.work[0].intent), rig.ctx.base);
    // The tip the one charge was spent on is never retried.
    assert.deepEqual(await launcherRetries(rig, rig.ctx.base), {
      plans: [],
      denials: ["conflict_resolution_spent"],
    });
    assert.deepEqual(await rig.hosted.snapshot(), blocked);

    // The base moves to B2, which conflicts with H too: a plain refresh.
    const moved = await moveBase(rig);
    const rebased = await launcherRetries(rig, moved);
    assert.equal(rebased.plans.length, 1, JSON.stringify(rebased));
    const returned = await rig.hosted.snapshot();
    assert.equal(returned.work[0].nextStep, "work");
    assert.equal(returned.work[0].intent?.kind, "base_refresh");
    assert.equal(returned.work[0].intent?.observedBase, moved);
    assert.equal(conflictMarkerBase(returned.work[0].intent), null);
    assert.equal(returned.work[0].target.pr, PR);
    assert.deepEqual(returned.reservations, blocked.reservations);

    // The runtime re-observes the conflict at B2: pending, still uncharged.
    rig.hosted.clock.advance(60_000);
    await rig.runLoop();
    const pending = await rig.hosted.snapshot();
    assert.equal(pending.work[0].nextStep, "work");
    assert.equal(conflictMarkerBase(pending.work[0].intent), moved);
    assert.equal(pending.work[0].intent?.resultId, null);
    assert.deepEqual(pending.reservations, blocked.reservations);

    // One charged resolution at B2, never a second one at B.
    const planned = await rig.plan();
    assert.equal(planned.plan.cells.length, 1);
    assert.equal(planned.plan.cells[0].request.mergeBase, moved);
    const charged = charges(await rig.hosted.snapshot());
    assert.deepEqual(
      charged.map((row) => [row.attempt, row.outcome]),
      [[2, "ambiguous"], [3, "reserved"]],
      "one charge per base tip",
    );
    assert.equal((await rig.plan()).plan.cells.length, 0);
    await assertRollbackReadable(rig.hosted.written);
  } finally {
    await rig.cleanup();
  }
});
