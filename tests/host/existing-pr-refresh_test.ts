import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import { createCandidatePreserver } from "../../src/host/actions-candidates-preserve.ts";
import { createPrepareBaseRefresh } from "../../src/host/local-base-refresh.ts";
import {
  ensureBaseRefreshIntent,
  executeBaseRefreshIntent,
} from "../../src/repair/loop-base-refresh.ts";
import { routeExistingPr } from "../../src/repair/loop-existing-pr.ts";
import { ensureReviewFreshness } from "../../src/repair/loop-task-context.ts";
import { nativeLifecycleRig } from "../repair/existing-pr-lifecycle-fixtures.ts";
import { commitIn, gitRun } from "./actions-candidates-fixture.ts";

Deno.test("existing PR refresh: native original head becomes a preserved deterministic successor without implementation charge", async () => {
  const r = await nativeLifecycleRig();
  try {
    r.host.port.prepareBaseRefresh = createPrepareBaseRefresh({
      clock: r.clock,
      git: r.host.git,
      repository: r.initial.work[0].repository,
      observer: r.host.port,
      baseBranch: "development",
      trustedPrAuthor: "sentinel[bot]",
    });
    r.host.port.preserveCandidate = createCandidatePreserver({
      ...r.factoryInput,
      state: r.state,
      http: r.http,
      ensureLocalCandidate: () => Promise.resolve(portOk(undefined)),
    });
    let context = await r.reload();
    for (let phase = 0; phase < 3; phase++) {
      const step = await routeExistingPr(
        r.deps,
        context,
        context.snapshot.work[0],
      );
      assert.ok(step.status === "step" && step.step.kind === "progress");
      context = await r.reload();
    }
    const original = context.snapshot.work[0];
    const work = `${r.ctx.tmp}/work`;
    assert.ok((await gitRun(work, ["checkout", "development"], r.ctx.env)).ok);
    const nextBase = await commitIn(work, r.ctx.env, "new-base");
    assert.ok(
      (await gitRun(work, ["push", "origin", "development"], r.ctx.env)).ok,
    );
    assert.ok(
      (await gitRun(
        r.sourcePath,
        ["fetch", "origin", "development"],
        r.ctx.env,
      )).ok,
    );
    r.nativeControls.base = nextBase;
    assert.deepEqual(await ensureBaseRefreshIntent(r.deps, context, original), {
      kind: "progress",
    });
    context = await r.reload();
    const refreshed = await executeBaseRefreshIntent(
      r.deps,
      context,
      context.snapshot.work[0],
    );
    assert.deepEqual(refreshed, { kind: "progress" });
    context = await r.reload();
    const record = context.snapshot.work[0];
    assert.equal(record.intent, null);
    assert.equal(record.target.pr, 7);
    assert.equal(record.target.branch, "human/issue-1");
    assert.equal(record.target.base, nextBase);
    assert.notEqual(record.target.head, original.target.head);
    assert.equal(
      record.target.candidateState?.preserved?.head,
      record.target.head,
    );
    assert.equal(
      await r.readHead("refs/heads/human/issue-1"),
      record.target.head,
    );
    assert.deepEqual(record.counters, original.counters);
    assert.deepEqual(context.snapshot.reservations, r.initial.reservations);
    assert.equal(r.nativeControls.author, "human-owner");
    const laterBase = await commitIn(work, r.ctx.env, "later-base");
    assert.ok(
      (await gitRun(work, ["push", "origin", "development"], r.ctx.env)).ok,
    );
    assert.ok(
      (await gitRun(
        r.sourcePath,
        ["fetch", "origin", "development"],
        r.ctx.env,
      )).ok,
    );
    r.nativeControls.base = laterBase;
    assert.deepEqual(await ensureReviewFreshness(r.deps, context, record, 7), {
      kind: "progress",
    });
    context = await r.reload();
    const realPush = r.host.port.pushHead.bind(r.host.port);
    r.host.port.pushHead = async (...args) => {
      const result = await realPush(...args);
      return args[0] === "refs/heads/human/issue-1" && result.ok &&
          result.value === "applied"
        ? portOk("ambiguous" as const)
        : result;
    };
    assert.equal(
      (await executeBaseRefreshIntent(
        r.deps,
        context,
        context.snapshot.work[0],
      )).kind,
      "progress",
    );
    context = await r.reload();
    const saved = context.snapshot.work[0];
    assert.ok(saved.intent?.resultId);
    assert.equal(
      saved.target.head,
      record.target.head,
      "lost acknowledgement preserves the previous target",
    );
    assert.equal(
      await r.readHead("refs/heads/human/issue-1"),
      saved.intent.resultId,
    );
    const advancedAgain = await commitIn(work, r.ctx.env, "advanced-again");
    assert.ok(
      (await gitRun(work, ["push", "origin", "development"], r.ctx.env)).ok,
    );
    assert.ok(
      (await gitRun(
        r.sourcePath,
        ["fetch", "origin", "development"],
        r.ctx.env,
      )).ok,
    );
    r.nativeControls.base = advancedAgain;
    r.host.port.pushHead = realPush;
    r.restartTakeover();
    const pushCount = r.pushes.length;
    assert.deepEqual(await executeBaseRefreshIntent(r.deps, context, saved), {
      kind: "progress",
    });
    context = await r.reload();
    const recovered = context.snapshot.work[0];
    assert.equal(recovered.intent, null);
    assert.equal(recovered.target.head, saved.intent.resultId);
    assert.equal(
      recovered.target.base,
      laterBase,
      "recovery retains the frozen prepared base",
    );
    assert.equal(
      r.pushes.length,
      pushCount,
      "no push is replayed after exact applied reconciliation",
    );
    assert.deepEqual(recovered.counters, original.counters);
    assert.deepEqual(context.snapshot.reservations, r.initial.reservations);
    assert.deepEqual(
      await ensureReviewFreshness(r.deps, context, recovered, 7),
      { kind: "progress" },
    );
    assert.equal(
      context.snapshot.work[0].intent?.observedBase,
      advancedAgain,
      "current base requires its own later refresh before review",
    );
  } finally {
    await r.ctx.cleanup();
  }
});
