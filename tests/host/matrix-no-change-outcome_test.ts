/**
 * Root cause of ai.ubq.fi issue 300's 52 identical "model run failed
 * (unavailable)" blocks: every recent matrix cell's own diagnostic line reads
 * `reasonCode: model_candidate_unchanged_base` (run 39073338516, jobs
 * 117518580134 and 117509247393). The model session COMPLETED, found the task
 * already done at base (ai.ubq.fi 0c120c11f6 fixed tools/lint/package.json on
 * 2026-09-22, before the first charge) and left its checkout unchanged; the
 * trusted committer then refused `unchanged_base`, the port reported that as
 * `unavailable`, and the cell exported only the error kind. The blocker read as
 * a transient provider outage and the launcher re-granted it on every base
 * move.
 *
 * A completed run that left its checkout unchanged is a model outcome, never
 * provider unavailability: the cell exports its own closed detail, the
 * ingester holds it for exact-base review (still charged ambiguous, never
 * refunded), the launcher cannot retry it before that review, and
 * every other port error keeps its exact existing settlement.
 */
import assert from "node:assert/strict";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  type ModelRunReceiptV1,
  portError,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  CANDIDATE_COMMIT_REFUSAL_DETAILS,
  candidateCommitRefusalDetail,
  LocalCandidateCommitter,
} from "../../src/repair/model-port-checkout.ts";
import { settlementClassification } from "../../src/host/matrix-ingest-state.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { gitRun } from "../state/helpers.ts";
import { r80Available, withR80Parsers } from "./r80-contracts.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  type RigV1,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

const ignoreR80 = !await r80Available();

/** The closed detail a completed, change-free model run settles with. */
const NO_CHANGE = "model run completed without any change to its checkout";
const UNAVAILABLE = "model run failed (unavailable)";

function modelReturning(result: PortResultV1<ModelRunReceiptV1>) {
  let calls = 0;
  return {
    port: {
      modelId: "gpt-reserve",
      runModel: () => {
        calls++;
        return Promise.resolve(result);
      },
    },
    calls: () => calls,
  };
}

async function wave(
  rig: RigV1,
  model: { modelId: string; runModel: () => Promise<unknown> },
) {
  const planned = await planMatrixWave(rig.deps, rig.planOptions());
  assert.equal(planned.prepared, 1, JSON.stringify(planned));
  const cell = planned.plan.cells[0];
  const ctx = await rig.claimCell(cell);
  // deno-lint-ignore no-explicit-any
  (ctx.deps as any).model = model;
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
  return { cell, ctx, result, report };
}

async function readmit(rig: RigV1, runtimeSha: GitSha): Promise<number> {
  const before = await rig.store.readRepair();
  assert.ok(before.ok && before.value.status === "found");
  const now = rig.clock.now();
  const plans = planHostedRetries(before.value.snapshot, now, runtimeSha);
  if (plans.length === 0) return 0;
  const retried = await rig.store.writeRepair(
    applyHostedRetries(before.value.snapshot, before.value.head, plans, now),
    before.value.head,
  );
  assert.ok(retried.ok && retried.value.status === "applied");
  return plans.length;
}

Deno.test(
  "no-change outcome: the real committer refuses an untouched checkout with the exact unchanged-base detail",
  async () => {
    const rig = await makeRig([990300], 1);
    try {
      const repo = `${rig.tmp}/untouched`;
      assert.ok(
        (await gitRun(rig.tmp, ["clone", "-q", rig.mirrorRepo, repo], rig.env))
          .ok,
      );
      const committer = new LocalCandidateCommitter(repo);
      assert.equal(await committer.commit(rig.base), false);
      assert.equal(committer.refusalCode, "unchanged_base");
      // This is the exact port error detail every live 300 cell carried.
      assert.equal(
        candidateCommitRefusalDetail(committer),
        CANDIDATE_COMMIT_REFUSAL_DETAILS.unchanged_base,
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "no-change outcome: authenticated unchanged-base settles charged into an R80-inert base review hold",
  async () => {
    const rig = await makeRig([990301], 1);
    try {
      const issue = freshIssue(990301, rig.base);
      const seeded = await rig.store.writeRepair(seedSnapshot([issue]), null);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const model = modelReturning(
        portError(
          "unavailable",
          CANDIDATE_COMMIT_REFUSAL_DETAILS.unchanged_base,
        ),
      );
      const { cell, result, report } = await wave(rig, model.port);
      assert.equal(model.calls(), 1, "exactly one model session");
      assert.equal(result.status, "failed");
      assert.equal(result.detail, NO_CHANGE);
      assert.equal(result.receipt, null);
      assert.equal(report.ingested, 1, JSON.stringify(report.entries));
      const state = await snapshot(rig);
      const work = state.work[0];
      assert.equal(work.nextStep, "work");
      assert.equal(work.blocker, null);
      assert.equal(work.wait?.reason, "backoff");
      assert.equal(work.wait?.until, null);
      assert.equal(work.intent?.kind, "implementation");
      assert.equal(work.intent?.failure?.detail, NO_CHANGE);
      // The charge stays charged: ambiguous, never refunded.
      assert.deepEqual(state.reservations.map((row) => row.outcome), [
        "ambiguous",
      ]);
      const entries = state.attemptMemory.flatMap((memory) => memory.entries);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].detail, NO_CHANGE);
      assert.equal(entries[0].stage, "model");
      assert.equal(entries[0].failureClass, "semantic_no_progress");
      // Everything written parses under the R80 contracts (src/contracts is
      // unchanged since R80 e48e7e110), and under R80's own parsers.
      parseRepairStateSnapshotV1(JSON.parse(JSON.stringify(state)));
      if (!ignoreR80) {
        await withR80Parsers((r80) => {
          r80.parseRepairStateSnapshotV1(state);
          r80.parseMatrixCellResultV1(result);
        });
      }
      // Maintenance and matrix planning run before repair. Neither can spend
      // another implementation while the exact-base review remains pending.
      assert.equal(await readmit(rig, cell.runtimeSha as GitSha), 0);
      rig.clock.advance(24 * 60 * 60_000);
      assert.equal(
        (await planMatrixWave(rig.deps, rig.planOptions())).prepared,
        0,
      );
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "no-change outcome: every other port error keeps its exact unavailable settlement",
  async () => {
    const rig = await makeRig([990302], 1);
    try {
      const issue = freshIssue(990302, rig.base);
      const seeded = await rig.store.writeRepair(seedSnapshot([issue]), null);
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const model = modelReturning(
        portError(
          "unavailable",
          CANDIDATE_COMMIT_REFUSAL_DETAILS.dirty_descendant,
        ),
      );
      const { result } = await wave(rig, model.port);
      assert.equal(result.detail, UNAVAILABLE);
      const state = await snapshot(rig);
      assert.equal(state.work[0].blocker?.message, UNAVAILABLE);
      const entry = state.attemptMemory[0].entries[0];
      assert.equal(entry.failureClass, "transient_infrastructure");
      assert.equal(entry.stage, "model");
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test("no-change outcome: the ingester classifies the closed detail as a model no-progress outcome", () => {
  assert.deepEqual(settlementClassification("failed", NO_CHANGE), {
    stage: "model",
    failureClass: "semantic_no_progress",
  });
  assert.deepEqual(settlementClassification("failed", UNAVAILABLE), {
    stage: "model",
    failureClass: "transient_infrastructure",
  });
});
