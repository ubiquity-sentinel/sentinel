/** A matrix cell cut off by its session bound decomposes on the next plan. */
import assert from "node:assert/strict";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { isDecompositionEligible } from "../../src/host/matrix-planner.ts";
import { isValidRef } from "../../src/github/git-executor.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { isDecompositionChildId } from "../../src/repair/transitions.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

function interruptedAt(durationMs: number) {
  return {
    modelId: "gpt-reserve",
    runModel: () =>
      Promise.resolve(portOk({
        invocationId: "matrix-invoke-exhausted",
        outcome: "interrupted" as const,
        actual: {
          evidenceKind: "request-runtime" as const,
          provider: "sentinel-host",
          threadId: "thread-exhausted",
          turnId: "turn-exhausted",
          terminalOrigin: "runtime" as const,
          observedTerminalStatus: "interrupted" as const,
          observedModel: "gpt-reserve",
          observedReasoning: "max",
          durationMs,
          outputChars: 500,
        },
        candidate: null,
        error: null,
      })),
  };
}

Deno.test("matrix session exhaustion: the next plan splits the whole issue", async () => {
  const rig = await makeRig([990077], 1);
  try {
    const issue = freshIssue(990077, rig.base);
    const seeded = await rig.store.writeRepair(seedSnapshot([issue]), null);
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const planned = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(planned.prepared, 1);
    const cell = planned.plan.cells[0];
    const ctx = await rig.claimCell(cell);
    const bound = ctx.deps.sessionBound!.maxDurationMs;
    // deno-lint-ignore no-explicit-any
    (ctx.deps as any).model = interruptedAt(bound);
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      rig.clock.now(),
    );
    await rig.transfer([result], [ctx]);
    const report = await ingestMatrixResults(
      rig.deps,
      planned.plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(report.ingested, 1, JSON.stringify(report.entries));
    const blocked = (await snapshot(rig)).work[0];
    assert.equal(blocked.nextStep, "blocked");
    assert.equal(
      blocked.counters.timeouts,
      1,
      "the ingester keeps the exhaustion instead of resetting the streak",
    );

    // Maintenance re-admits the transient blocker and keeps the count.
    const before = await rig.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const now = rig.clock.now();
    const plans = planHostedRetries(
      before.value.snapshot,
      now,
      cell.runtimeSha as GitSha,
    );
    assert.equal(plans.length, 1);
    const retried = await rig.store.writeRepair(
      applyHostedRetries(
        before.value.snapshot,
        before.value.head,
        plans,
        now,
      ),
      before.value.head,
    );
    assert.ok(retried.ok && retried.value.status === "applied");

    const next = await planMatrixWave(rig.deps, rig.planOptions());
    const state = await snapshot(rig);
    const parts = state.work.filter((work) => isDecompositionChildId(work.id));
    assert.equal(parts.length, 2, "one exhaustion splits into two parts");
    assert.ok(
      next.plan.cells.every((planned) => planned.taskId !== issue.id),
      "the whole issue is never granted again",
    );
    assert.equal(next.prepared, 1, "the first part is granted at once");
    assert.equal(next.plan.cells[0].taskId, `${issue.id}:part-1-of-2`);
    assert.ok(
      next.plan.cells[0].request.scopeNote?.includes("part 1 of 2"),
      "the part session is told to bound its scope",
    );
    // Each persisted part can actually publish: its candidate branch passes
    // the push validator (a ':' in the id would be refused at every push).
    for (const part of parts) {
      assert.ok(isValidRef(`refs/heads/${part.target.branch}`), part.id);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix session exhaustion: only a fresh whole issue is split", () => {
  const base = {
    id: "issue-990078",
    source: { kind: "issue" },
    counters: { timeouts: 1 },
    target: { head: null, pr: null },
  };
  const none = { work: [] };
  assert.equal(isDecompositionEligible(base, none), true);
  assert.equal(
    isDecompositionEligible({
      ...base,
      target: { head: "a".repeat(40), pr: 12 },
    }, none),
    false,
    "a correction that owns a candidate and pull request is never split",
  );
  assert.equal(
    isDecompositionEligible({ ...base, id: `${base.id}:part-1-of-2` }, none),
    false,
    "parts never split further",
  );
  assert.equal(
    isDecompositionEligible({ ...base, counters: {} }, none),
    false,
    "no exhaustion, no split",
  );
});
