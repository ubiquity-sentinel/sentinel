import assert from "node:assert/strict";
import {
  existingPrLifecycleRig,
  nativeLifecycleRig,
  seedFreshTakeoverIssue,
} from "./existing-pr-lifecycle-fixtures.ts";

for (const author of ["human-owner", "chatgpt-codex-connector[bot]"]) {
  Deno.test(`existing PR serial: unresolved referenced ${author} never reserves or replaces`, async () => {
    const rig = existingPrLifecycleRig(author);
    await rig.run();
    const state = await rig.snapshot();
    assert.equal(rig.model.requests.length, 0, "no replacement model start");
    assert.equal(state.reservations.length, 0, "no replacement reservation");
    assert.equal(rig.github.calls.includes("createPr"), false);
    assert.match(state.work[0].blocker?.message ?? "", /association_unproven/);
    assert.ok(rig.calls.includes("discover"));
  });
}

import { SHA1 } from "../state/helpers.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { readTakeoverAnchor } from "../../src/github/existing-pr-takeover-provenance.ts";

Deno.test("existing PR custody: real V1 intent, immutable ref, ancestor and restart preserve original native head", async () => {
  const r = await nativeLifecycleRig();
  try {
    let context = await r.reload();
    for (let phase = 0; phase < 3; phase++) {
      const routed = await routeExistingPr(
        r.deps,
        context,
        context.snapshot.work[0],
      );
      assert.deepEqual(
        routed,
        { status: "step", step: { kind: "progress" } },
        `phase ${phase}`,
      );
      // Process restart: no object/closure from the previous coordinator invocation survives.
      context = await r.reload();
      const work = context.snapshot.work[0];
      assert.equal(work.target.pr, 7);
      assert.equal(work.target.branch, "human/issue-1");
      assert.deepEqual(work.target.candidateState, {
        preserved: null,
        publishedHead: r.ctx.head,
      });
      assert.deepEqual(context.snapshot.reservations, r.initial.reservations);
      assert.equal(context.snapshot.reviews.length, 0);
      assert.deepEqual(work.counters, r.initial.work[0].counters);
    }
    const work = context.snapshot.work[0];
    const anchor = await readTakeoverAnchor({
      state: r.state,
      record: work,
      snapshot: context.snapshot,
      expectedStateHead: context.head!,
    });
    assert.ok(anchor);
    assert.equal(await r.readHead(anchor.nativeRef), r.ctx.head);
    assert.equal(r.pushes.length, 1, "only one immutable ref push");
    assert.equal(r.pushes[0].expected, null);
    assert.equal(await r.readHead("refs/heads/human/issue-1"), r.ctx.head);
    assert.deepEqual(await routeExistingPr(r.deps, context, work), {
      status: "custody_ready",
    });
    assert.equal(
      r.requests.every((row) =>
        row.method === "GET" || row.path === "/graphql"
      ),
      true,
    );
  } finally {
    await r.ctx.cleanup();
  }
});

Deno.test("existing PR custody: revoked principal after intent leaves charged state and original branch untouched", async () => {
  const r = await nativeLifecycleRig();
  try {
    let context = await r.reload();
    assert.equal(
      (await routeExistingPr(r.deps, context, context.snapshot.work[0])).status,
      "step",
    );
    context = await r.reload();
    const before = structuredClone(context);
    r.controls.principal = false;
    const routed = await routeExistingPr(
      r.deps,
      context,
      context.snapshot.work[0],
    );
    assert.equal(routed.status, "step");
    assert.ok(routed.status === "step" && routed.step.kind === "deferred");
    assert.deepEqual(await r.reload(), before);
    assert.equal(r.pushes.length, 0);
    assert.equal(await r.readHead("refs/heads/human/issue-1"), r.ctx.head);
  } finally {
    await r.ctx.cleanup();
  }
});

Deno.test("existing PR custody: adoption state race never overwrites newer work or creates a native ref", async () => {
  const r = await nativeLifecycleRig();
  try {
    const context = await r.reload();
    let moved = false;
    r.controls.afterPrincipal = async () => {
      if (moved) return;
      moved = true;
      const next = structuredClone(context.snapshot);
      next.stateHead = context.head;
      next.sequence++;
      next.work[0].blocker = {
        kind: "other",
        message: "newer owner custody",
        since: r.clock.now(),
      };
      next.work[0].nextStep = "blocked";
      const write = await r.state.writeRepair(next, context.head);
      assert.ok(write.ok && write.value.status === "applied");
    };
    const routed = await routeExistingPr(
      r.deps,
      context,
      context.snapshot.work[0],
    );
    assert.equal(routed.status, "step");
    assert.ok(routed.status === "step" && routed.step.kind !== "progress");
    const current = await r.reload();
    assert.equal(
      current.snapshot.work[0].blocker?.message,
      "newer owner custody",
    );
    assert.equal(current.snapshot.work[0].target.pr, null);
    assert.deepEqual(current.snapshot.reservations, r.initial.reservations);
    assert.equal(r.pushes.length, 0);
  } finally {
    await r.ctx.cleanup();
  }
});

Deno.test("existing PR serial: unavailable native discovery never falls back to replacement work", async () => {
  const r = existingPrLifecycleRig();
  r.takeover.discover = () =>
    Promise.resolve({ status: "unavailable", reason: "pagination" });
  await r.run();
  assert.equal(r.model.requests.length, 0);
  assert.equal((await r.snapshot()).reservations.length, 0);
  assert.equal(r.github.calls.includes("createPr"), false);
});

Deno.test("existing PR serial: native queue check precedes discovery and custody writes for fresh PR-less work", async () => {
  const r = existingPrLifecycleRig();
  await r.run();
  assert.equal(r.calls[0], "queue");
  assert.ok(r.calls.indexOf("rules") < r.calls.indexOf("discover"));
  assert.ok(r.calls.indexOf("discover") < r.calls.indexOf("takeover_write"));
});

Deno.test("existing PR serial: unknown native queue is a non-expiring hold before discovery or admission", async () => {
  const r = existingPrLifecycleRig();
  r.queueControls.unavailable = true;
  await r.run();
  const work = (await r.snapshot()).work[0];
  assert.equal(r.calls[0], "queue");
  assert.equal(r.calls.includes("discover"), false);
  assert.equal(r.calls.includes("takeover_write"), false);
  assert.equal(work.wait?.reason, "backoff");
  assert.equal(work.wait?.until, null);
  assert.equal(work.target.pr, null);
  assert.equal(work.target.branch, null);
  assert.equal(r.model.requests.length, 0);
  assert.equal((await r.snapshot()).reservations.length, 0);
});

Deno.test("existing PR serial: complete native absence recovers its own preflight wait, never an unrelated wait", async () => {
  const r = existingPrLifecycleRig("human-owner", false);
  r.queueControls.unavailable = true;
  await r.run();
  const held = await r.snapshot();
  assert.equal(held.work[0].wait?.until, null);
  assert.equal(r.model.requests.length, 0);
  r.queueControls.unavailable = false;
  await r.run();
  assert.equal(r.model.requests.length, 1);
  const settled = await r.snapshot();
  assert.ok(settled.reservations.length > 0);

  const unrelated = existingPrLifecycleRig("human-owner", false);
  unrelated.state.repair = structuredClone(held);
  unrelated.state.repairHead = SHA1;
  unrelated.state.repair.work[0].blocker = {
    kind: "other",
    message: "unrelated owner hold",
    since: unrelated.clock.now(),
  };
  const before = structuredClone(unrelated.state.repair);
  await unrelated.run();
  assert.equal(unrelated.calls.includes("discover"), false);
  assert.equal(unrelated.model.requests.length, 0);
  assert.deepEqual((await unrelated.snapshot()).work, before.work);
});

Deno.test("existing PR serial: negative discovery cannot clear a preflight hold after a competing owner CAS", async () => {
  const r = existingPrLifecycleRig("human-owner", false);
  r.queueControls.unavailable = true;
  await r.run();
  const held = await r.snapshot();
  r.queueControls.unavailable = false;
  r.takeover.discover = async () => {
    const read = await r.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const next = structuredClone(read.value.snapshot);
    next.stateHead = read.value.head;
    next.sequence++;
    next.work[0].blocker = {
      kind: "other",
      message: "newer owner hold",
      since: r.clock.now(),
    };
    const write = await r.state.writeRepair(next, read.value.head);
    assert.ok(write.ok && write.value.status === "applied");
    return { status: "none", issueDigest: "f".repeat(64) };
  };
  assert.equal((await r.run()).status, "state_error");
  const current = await r.snapshot();
  assert.equal(current.work[0].blocker?.message, "newer owner hold");
  assert.deepEqual(current.work[0].counters, held.work[0].counters);
  assert.deepEqual(current.reservations, held.reservations);
  assert.equal(r.model.requests.length, 0);
});

import {
  gen80Available,
  loadGen80Modules,
} from "../host/gen77-runtime-source.ts";
import type { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";

Deno.test({
  name:
    "existing PR preflight hold and positive-evidence recovery parse under actual R80",
  ignore: !await gen80Available(),
  async fn() {
    const r = existingPrLifecycleRig("human-owner", false);
    r.queueControls.unavailable = true;
    await r.run();
    const held = await r.snapshot();
    r.queueControls.unavailable = false;
    r.deps.externalImplementations = true;
    await r.run();
    const resumed = await r.snapshot();
    const old = await loadGen80Modules(["src/contracts/state-snapshots.ts"]);
    try {
      const parse = old.modules[0]
        .parseRepairStateSnapshotV1 as typeof parseRepairStateSnapshotV1;
      assert.deepEqual(parse(held), held);
      assert.deepEqual(parse(resumed), resumed);
    } finally {
      await old.dispose();
    }
  },
});

for (const mode of ["unavailable", "throwing"] as const) {
  Deno.test(`existing PR serial pass refusal: ${mode} discovery never reaches replacement admission`, async () => {
    const r = existingPrLifecycleRig();
    await seedFreshTakeoverIssue(r);
    let discoveries = 0;
    r.takeover.discover = () => {
      discoveries++;
      if (mode === "throwing") throw new Error("offline discovery failure");
      return Promise.resolve({ status: "unavailable", reason: "pagination" });
    };
    await r.run();
    const after = await r.snapshot();
    assert.equal(r.model.requests.length, 0);
    assert.equal(after.reservations.length, 0);
    assert.equal(after.work[0].target.branch, null);
    assert.equal(
      discoveries,
      1,
      "the refused record is not ranked again in the same pass",
    );
  });
}

Deno.test("existing PR dormant factory: unmarked work has no coordinator observation or state effect", async () => {
  const r = await nativeLifecycleRig();
  try {
    r.factoryInput.policy.activated = false;
    const context = await r.reload();
    const before = structuredClone(context);
    const requests = r.requests.length;
    const gitCalls = r.calls.length;
    assert.deepEqual(
      await routeExistingPr(r.deps, context, context.snapshot.work[0]),
      { status: "ordinary_new_work_allowed" },
    );
    assert.deepEqual(await r.reload(), before);
    assert.equal(r.requests.length, requests);
    assert.equal(r.calls.length, gitCalls);
    assert.equal(r.pushes.length, 0);
  } finally {
    await r.ctx.cleanup();
  }
});

for (const phases of [1, 3]) {
  Deno.test(`existing PR dormant factory: retained native custody after phase ${phases} cannot fall back`, async () => {
    const r = await nativeLifecycleRig();
    try {
      let context = await r.reload();
      for (let phase = 0; phase < phases; phase++) {
        const routed = await routeExistingPr(
          r.deps,
          context,
          context.snapshot.work[0],
        );
        assert.ok(routed.status === "step" && routed.step.kind === "progress");
        context = await r.reload();
      }
      r.factoryInput.policy.activated = false;
      const before = structuredClone(context);
      const requests = r.requests.length;
      const gitCalls = r.calls.length;
      const pushes = r.pushes.length;
      const routed = await routeExistingPr(
        r.deps,
        context,
        context.snapshot.work[0],
      );
      assert.ok(routed.status === "step" && routed.step.kind === "deferred");
      assert.deepEqual(await r.reload(), before);
      assert.equal(r.requests.length, requests);
      assert.equal(r.calls.length, gitCalls);
      assert.equal(r.pushes.length, pushes);
    } finally {
      await r.ctx.cleanup();
    }
  });
}

Deno.test("existing PR dormant coordinator: a preflight hold returns to Sentinel's own repair once discovery is off", async () => {
  // Owner directive 2026-10-24: other people's pull requests never hold or
  // divert Sentinel's own repair. The takeover preflight hold is released and
  // Sentinel implements and opens its own PR without any discovery.
  const r = existingPrLifecycleRig("human-owner", false);
  r.queueControls.unavailable = true;
  await r.run();
  const before = await r.snapshot();
  assert.equal(
    before.work[0].blocker?.message,
    "existing PR preflight: native queue observation unavailable",
  );
  r.takeoverControls.activated = false;
  r.queueControls.unavailable = false;
  r.calls.length = 0;
  await r.run();
  const after = await r.snapshot();
  assert.equal(after.work[0].blocker, null);
  assert.equal(after.work[0].nextStep, "review");
  assert.equal(r.calls.includes("discover"), false);
  assert.equal(r.model.requests.length, 1);
  assert.equal(
    r.github.calls.filter((call) => call === "createPr").length,
    1,
  );
});

Deno.test("existing PR serial pass refusal: later complete negative discovery permits a fresh retry", async () => {
  const r = existingPrLifecycleRig("human-owner", false);
  await seedFreshTakeoverIssue(r);
  const discover = r.takeover.discover;
  r.takeover.discover = () =>
    Promise.resolve({ status: "unavailable", reason: "pagination" });
  await r.run();
  assert.equal(r.model.requests.length, 0);
  assert.equal((await r.snapshot()).reservations.length, 0);
  r.takeover.discover = discover;
  await r.run();
  assert.equal(r.model.requests.length, 1);
  assert.ok((await r.snapshot()).reservations.length > 0);
});
