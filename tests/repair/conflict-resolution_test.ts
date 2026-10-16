/**
 * Base-refresh conflict resolution through the REAL in-process repair loop.
 *
 * A published, preserved candidate H whose refresh onto the moved base B
 * genuinely conflicts (the production adapter's `git merge-tree`) is no longer
 * parked: one charged resolution attempt runs on a checkout of H with B merged
 * in, its merge commit M (parents H and B) is preserved under the refresh
 * binding and published as a fast-forward of H with the normal lease, so the
 * open pull request updates in place and M is reviewed against B. Every
 * snapshot the path writes parses under the generation-77 rollback runtime.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import { REPO } from "../state/helpers.ts";
import { assertGen77Parses, gen77Available } from "../state/gen77-contracts.ts";
import {
  BRANCH,
  conflictGithub,
  ConflictModel,
  conflictRig,
  makeConflictGit,
  PR,
  publishedCandidate,
  TASK,
} from "./conflict-resolution-rig.ts";

const MARKER = /^base refresh contains conflicts at [0-9a-f]{40}$/;

/** Run the cycle until the record leaves the conflict lifecycle. */
async function settle(rig: ReturnType<typeof conflictRig>): Promise<void> {
  for (let run = 0; run < 4; run++) {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    const work = (await rig.snapshot()).work[0];
    if (work.nextStep === "blocked" || work.nextStep === "review") return;
    rig.clock.advance(60_000);
  }
}

function phases(written: readonly RepairStateSnapshotV1[]) {
  const records = written.map((snapshot) => snapshot.work[0]);
  return {
    pending: records.find((work) =>
      work.intent?.kind === "base_refresh" && work.intent.resultId === null &&
      MARKER.test(work.intent.failure?.detail ?? "")
    ),
    inFlight: records.find((work) =>
      work.intent?.kind === "implementation" &&
      MARKER.test(work.intent.failure?.detail ?? "")
    ),
    resolved: records.find((work) =>
      work.intent?.kind === "base_refresh" && work.intent.resultId !== null &&
      MARKER.test(work.intent.failure?.detail ?? "")
    ),
  };
}

Deno.test(
  "conflict resolution: a conflicting refresh is resolved by one charged attempt and published as a fast-forward merge",
  async () => {
    const ctx = await makeConflictGit();
    try {
      const github = conflictGithub(ctx);
      const model = new ConflictModel(ctx);
      const rig = conflictRig(github, model);
      await rig.seed([await publishedCandidate(ctx)]);

      await settle(rig);
      const state = await rig.snapshot();
      const work = state.work[0];
      // RED (generation 77): "base refresh has conflicts at <B>", pr null,
      // nothing charged and the open pull request abandoned at H.
      assert.equal(work.blocker, null, JSON.stringify(work.blocker));
      assert.equal(work.nextStep, "review");
      assert.equal(model.requests.length, 1, "exactly one resolution start");
      assert.equal(model.heads.length, 1, "one resolved merge commit");
      const merged = model.heads[0];

      // The charged request: the durable reviewed base stays B0, the checkout
      // continues the published candidate and the merge names the new base.
      const request = model.requests[0] as unknown as Record<string, unknown>;
      assert.equal(request.base, ctx.b0);
      assert.equal(request.checkoutBase, ctx.head);
      assert.equal(request.mergeBase, ctx.base);
      assert.equal(request.reviewFindings, undefined);
      const charges = state.reservations.filter((row) =>
        row.purpose === "implementation" || row.purpose === "retry"
      );
      assert.equal(charges.length, 1, "one implementation charge");
      assert.equal(charges[0].purpose, "retry");
      assert.equal(charges[0].head, ctx.b0);
      assert.equal(charges[0].attempt, 2);
      assert.equal(charges[0].outcome, "submitted", "charged, never refunded");

      // Preserved under the refresh binding BEFORE the lease push.
      const key = baseRefreshIntentKey(PR, ctx.head, ctx.base);
      const ref = await candidatePreservationRef(REPO, TASK, key);
      assert.deepEqual(github.preservationRequests, [{
        taskId: TASK,
        candidate: { operationKey: key, base: ctx.base, head: merged, ref },
        publishedHead: ctx.head,
      }]);
      assert.deepEqual(github.pushes, [{
        ref: `refs/heads/${BRANCH}`,
        sha: merged,
        expected: ctx.head,
      }], "one fast-forward push of M over H with the normal lease");

      // The open PR updated in place; the merge is reviewed against B.
      assert.equal(work.target.pr, PR);
      assert.equal(work.target.base, ctx.base);
      assert.equal(work.target.head, merged);
      assert.deepEqual(work.target.candidateState, {
        preserved: { operationKey: key, base: ctx.base, head: merged, ref },
        publishedHead: merged,
      });
      assert.equal(work.intent, null);
      assert.equal(github.reviewRequestIdentities.length, 1);
      assert.equal(github.reviewRequestIdentities[0].expectedHead, merged);
      assert.equal(github.reviewRequestIdentities[0].prNumber, PR);
      const review = state.reservations.filter((row) =>
        row.purpose === "review_request"
      );
      assert.equal(review.length, 1);
      assert.equal(review[0].head, merged);

      // M is a real merge commit: parents H then B, so publishing it is a
      // fast-forward of the published head.
      assert.deepEqual(await ctx.parents(merged), [ctx.head, ctx.base]);
      assert.ok(await ctx.isAncestor(ctx.head, merged));
      assert.ok(await ctx.isAncestor(ctx.base, merged));

      // The durable lifecycle: pending (no charge) -> in flight (charged) ->
      // resolved (settled, preserved before the push) -> advanced.
      const seen = phases(rig.written);
      assert.ok(seen.pending !== undefined, "pending resolution persisted");
      assert.equal(seen.pending.intent?.observedBase, ctx.base);
      assert.equal(seen.pending.intent?.key, key);
      assert.equal(seen.pending.target.pr, PR, "the PR identity is kept");
      assert.ok(seen.inFlight !== undefined, "charged resolution in flight");
      assert.equal(seen.inFlight.counters.attempts, 2);
      assert.ok(seen.resolved !== undefined, "resolved merge persisted");
      assert.equal(seen.resolved.intent?.resultId, merged);
      assert.equal(seen.resolved.target.head, ctx.head, "H until published");
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test({
  name:
    "rollback: every snapshot the conflict resolution writes parses under the generation-77 runtime",
  ignore: !(await gen77Available()),
  fn: async () => {
    const ctx = await makeConflictGit();
    try {
      const rig = conflictRig(conflictGithub(ctx), new ConflictModel(ctx));
      await rig.seed([await publishedCandidate(ctx)]);
      await settle(rig);
      const seen = phases(rig.written);
      assert.ok(seen.pending && seen.inFlight && seen.resolved);
      assert.ok(rig.written.length >= 4);
      for (const snapshot of rig.written) await assertGen77Parses(snapshot);
    } finally {
      await ctx.cleanup();
    }
  },
});
