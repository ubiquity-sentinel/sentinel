import assert from "node:assert/strict";
import { nativeLifecycleRig } from "../repair/existing-pr-lifecycle-fixtures.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import {
  executeMerge,
  reconcileMergeIntent,
} from "../../src/repair/loop-merge.ts";
import { retireClosedPublication } from "../../src/repair/loop-records.ts";
import { createPullRequestFor } from "../../src/repair/loop-publication-state.ts";

Deno.test("adopted Sentinel self merge and closed publication keep original PR behind named owner holds", async () => {
  const r = await nativeLifecycleRig();
  try {
    let context = await r.reload();
    for (let n = 0; n < 3; n++) {
      const result = await routeExistingPr(
        r.deps,
        context,
        context.snapshot.work[0],
      );
      assert.ok(result.status === "step" && result.step.kind === "progress");
      context = await r.reload();
    }
    const before = context.snapshot.work[0];
    const callsBefore = r.requests.length;
    assert.deepEqual(await executeMerge(r.deps, context, before), {
      kind: "progress",
    });
    context = await r.reload();
    const held = context.snapshot.work[0];
    assert.equal(
      held.blocker?.message,
      "existing PR hold: self_merge_requires_owner",
    );
    assert.deepEqual(held.target, before.target);
    assert.deepEqual(held.evidence, before.evidence);
    assert.deepEqual(held.counters, before.counters);
    assert.deepEqual(context.snapshot.reservations, r.initial.reservations);
    assert.equal(
      (await reconcileMergeIntent(r.deps, context, held)).kind,
      "deferred",
    );
    assert.equal(
      r.requests.length,
      callsBefore,
      "no self-merge controller or target mutation ran",
    );
    const closed = retireClosedPublication(before, r.clock.now());
    assert.equal(
      closed.blocker?.message,
      "existing PR hold: closed_publication",
    );
    assert.deepEqual(closed.target, before.target);
    assert.equal(retireClosedPublication(closed, r.clock.now()), closed);
    const publish = await createPullRequestFor(
      r.deps,
      context,
      held,
      r.deps.configs[0],
    );
    assert.equal(publish.kind, "deferred");
    assert.equal(
      r.requests.some((request) =>
        request.method === "POST" && request.path.endsWith("/pulls")
      ),
      false,
    );
  } finally {
    await r.ctx.cleanup();
  }
});
