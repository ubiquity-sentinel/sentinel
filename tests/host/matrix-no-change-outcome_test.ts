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
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import {
  type ModelRunReceiptV1,
  portError,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import {
  CANDIDATE_COMMIT_REFUSAL_DETAILS,
  candidateCommitRefusalDetail,
  LocalCandidateCommitter,
} from "../../src/repair/model-port-checkout.ts";
import { settlementClassification } from "../../src/host/matrix-ingest-state.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { decompositionChildId } from "../../src/repair/transitions.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
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

/** Part 1 of 2 of a decomposed issue carrying one consecutive timeout. */
function timedOutPart(issue: WorkRecordV1): WorkRecordV1 {
  const id = asWorkItemId(decompositionChildId(issue.id, 1, 2));
  return {
    ...issue,
    id,
    target: { ...issue.target, branch: candidateBranch(id) },
    counters: { ...issue.counters, timeouts: 1 },
  };
}

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
  return { cell, ctx, result, report, plan: planned.plan };
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
  "no-change outcome: exact accounted replay preserves the entire base-review hold",
  async () => {
    const rig = await makeRig([990303], 1);
    try {
      const seeded = await rig.store.writeRepair(
        seedSnapshot([freshIssue(990303, rig.base)]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const model = modelReturning(portError(
        "unavailable",
        CANDIDATE_COMMIT_REFUSAL_DETAILS.unchanged_base,
      ));
      const { plan, result, report } = await wave(rig, model.port);
      assert.equal(report.ingested, 1);
      const before = await rig.store.readRepair();
      assert.ok(before.ok && before.value.status === "found");
      assert.equal(before.value.snapshot.attemptMemory[0].entries[0].count, 1);
      const write = rig.store.writeRepair.bind(rig.store);
      let writes = 0;
      rig.store.writeRepair = (...args) => {
        writes++;
        return write(...args);
      };
      rig.clock.advance(60 * 60_000);
      for (
        const selected of [result, {
          ...result,
          completedAt: result.completedAt + 1,
        }]
      ) {
        const replay = await ingestMatrixResults(
          rig.deps,
          plan,
          [selected],
          rig.ingestOptions(),
        );
        const after = await rig.store.readRepair();
        assert.ok(after.ok && after.value.status === "found");
        console.log(JSON.stringify({
          replay: replay.entries,
          ingested: replay.ingested,
          writes,
          sequenceBefore: before.value.snapshot.sequence,
          sequenceAfter: after.value.snapshot.sequence,
          countBefore: before.value.snapshot.attemptMemory[0].entries[0].count,
          countAfter: after.value.snapshot.attemptMemory[0].entries[0].count,
        }));
        assert.equal(replay.entries[0].disposition, "duplicate");
        assert.equal(replay.ingested, 0);
        assert.equal(writes, 0);
        assert.deepEqual(after.value, before.value);
      }
      assert.equal(model.calls(), 1);
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "no-change outcome: replay completes an interrupted timeout reset without replaying the held effect",
  async () => {
    const rig = await makeRig([990315], 1);
    try {
      const seeded = await rig.store.writeRepair(
        seedSnapshot([timedOutPart(freshIssue(990315, rig.base))]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const planned = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(planned.prepared, 1, JSON.stringify(planned));
      const cell = planned.plan.cells[0];
      const ctx = await rig.claimCell(cell);
      const model = modelReturning(portError(
        "unavailable",
        CANDIDATE_COMMIT_REFUSAL_DETAILS.unchanged_base,
      ));
      // deno-lint-ignore no-explicit-any
      (ctx.deps as any).model = model.port;
      const result = await runMatrixCell(
        ctx.deps,
        { waveId: WAVE, run: RUN, cell },
        ACTUAL,
        rig.clock.now(),
      );
      await rig.transfer([result], [ctx]);
      let interruptedResets = 0;
      const interruptedDeps = {
        ...rig.deps,
        state: {
          readRepair: () => rig.store.readRepair(),
          readRelease: () => rig.store.readRelease(),
          writeRepair: (
            next: RepairStateSnapshotV1,
            expectedHead: GitSha | null,
          ) => {
            const pending = next.work.find((work) => work.id === cell.taskId);
            if (pending?.counters.timeouts === undefined) {
              interruptedResets++;
              return Promise.resolve(portError(
                "unavailable",
                "injected timeout reset storage failure",
              ));
            }
            return rig.store.writeRepair(next, expectedHead);
          },
        },
      };
      const interrupted = await ingestMatrixResults(
        interruptedDeps,
        planned.plan,
        [result],
        rig.ingestOptions(),
      );
      assert.equal(interruptedResets, 1, JSON.stringify(interrupted.entries));
      assert.equal(interrupted.entries[0].disposition, "state_error");
      assert.equal(
        interrupted.entries[0].detail,
        "receipt settled; timeout reset unavailable or conflicted",
      );
      const before = await rig.store.readRepair();
      assert.ok(before.ok && before.value.status === "found");
      assert.equal(before.value.snapshot.work[0].counters.timeouts, 1);
      assert.equal(
        before.value.snapshot.attemptMemory[0].entries[0].detail,
        NO_CHANGE,
      );
      assert.equal(before.value.snapshot.attemptMemory[0].entries[0].count, 1);
      const failureAtMs = before.value.snapshot.work[0].intent!.failure!.atMs;

      // The interrupted reset resumes much later. Clearing the timeout also
      // stamps `record.updatedAt`, so duplicate recognition must bind the
      // failure identity rather than that bookkeeping timestamp.
      rig.clock.advance(4 * 60 * 60_000);
      const resumedAt = rig.clock.now();
      const replay = await ingestMatrixResults(
        rig.deps,
        planned.plan,
        [result],
        rig.ingestOptions(),
      );
      const after = await rig.store.readRepair();
      assert.ok(after.ok && after.value.status === "found");
      assert.equal(replay.entries[0].disposition, "duplicate");
      assert.equal(replay.ingested, 0);
      assert.equal(after.value.snapshot.work[0].counters.timeouts, undefined);
      assert.equal(after.value.snapshot.work[0].updatedAt, resumedAt);
      assert.equal(
        after.value.snapshot.work[0].intent!.failure!.atMs,
        failureAtMs,
      );
      const { timeouts: _interrupted, ...counters } =
        before.value.snapshot.work[0].counters;
      const expectedWork = {
        ...before.value.snapshot.work[0],
        counters,
        updatedAt: resumedAt,
      };
      assert.equal(
        canonicalStringify(after.value.snapshot.work[0]),
        canonicalStringify(expectedWork),
        "only the timeout counter is cleared; the reset stamps its own time",
      );
      assert.deepEqual(
        after.value.snapshot.attemptMemory,
        before.value.snapshot.attemptMemory,
        "the semantic no-change effect is not applied again",
      );
      assert.deepEqual(
        after.value.snapshot.reservations,
        before.value.snapshot.reservations,
        "the charge is not settled again",
      );
      assert.equal(
        after.value.snapshot.sequence,
        before.value.snapshot.sequence + 1,
      );
      assert.equal(after.value.snapshot.updatedAt, resumedAt);
      assert.equal(model.calls(), 1);

      // A third identical replay after the reset must still be a duplicate:
      // no second settlement, no semantic failure-count increment, no hold
      // refresh and no write at all.
      const write = rig.store.writeRepair.bind(rig.store);
      let writes = 0;
      rig.store.writeRepair = (...args) => {
        writes++;
        return write(...args);
      };
      const third = await ingestMatrixResults(
        rig.deps,
        planned.plan,
        [result],
        rig.ingestOptions(),
      );
      const final = await rig.store.readRepair();
      assert.ok(final.ok && final.value.status === "found");
      assert.equal(
        third.entries[0].disposition,
        "duplicate",
        JSON.stringify({
          entries: third.entries,
          count: final.value.snapshot.attemptMemory[0].entries[0].count,
        }),
      );
      assert.equal(third.ingested, 0);
      assert.equal(writes, 0, "duplicate replay performs no state write");
      assert.deepEqual(
        final.value,
        after.value,
        "the held state is byte-identical after the duplicate replay",
      );
      assert.equal(final.value.snapshot.attemptMemory[0].entries[0].count, 1);
      assert.equal(final.value.snapshot.work[0].wait?.since, failureAtMs);
      assert.equal(final.value.snapshot.work[0].counters.timeouts, undefined);
    } finally {
      await rig.cleanup();
    }
  },
);

Deno.test(
  "no-change outcome: changed results and incomplete holds are not accounted duplicates",
  async (t) => {
    const scenarios: {
      name: string;
      result?: (result: MatrixCellResultV1) => MatrixCellResultV1;
      state?: (state: RepairStateSnapshotV1) => void;
      conflict?: boolean;
    }[] = [
      {
        name: "completion outside the original settlement window",
        result: (result) => ({
          ...result,
          completedAt: result.completedAt + 24 * 60 * 60_000,
        }),
      },
      {
        name: "different failure",
        result: (result) => ({ ...result, detail: UNAVAILABLE }),
      },
      {
        name: "never-started outcome",
        result: (result) => ({ ...result, status: "not_started" }),
      },
      {
        name: "different producer",
        result: (result) => ({
          ...result,
          run: { ...result.run, runId: result.run.runId + 1 },
        }),
      },
      {
        name: "changed request identity",
        result: (result) => ({ ...result, requestDigest: "f".repeat(64) }),
      },
      {
        name: "changed admission",
        result: (result) => ({ ...result, reservationId: "e".repeat(64) }),
      },
      {
        name: "unknown hold kind",
        state: (state) => {
          state.work[0].intent!.failure!.kind = "unavailable";
        },
      },
      {
        name: "unsettled charge",
        state: (state) => {
          state.reservations[0].outcome = "reserved";
          state.reservations[0].settledAt = null;
        },
      },
      {
        name: "missing semantic outcome",
        state: (state) => {
          state.attemptMemory = [];
        },
      },
      {
        name: "foreign producing runtime",
        state: (state) => {
          state.attemptMemory[0].entries[0].controllerSha = "7".repeat(
            40,
          ) as GitSha;
        },
      },
      {
        name: "finite wait is not the base-review hold",
        state: (state) => {
          state.work[0].wait!.until = state.updatedAt + 300_000;
        },
      },
      { name: "contradictory results", conflict: true },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      await t.step(scenario.name, async () => {
        const number = 990304 + index;
        const rig = await makeRig([number], 1);
        try {
          const seeded = await rig.store.writeRepair(
            seedSnapshot([
              freshIssue(number, rig.base),
            ]),
            null,
          );
          assert.ok(seeded.ok && seeded.value.status === "applied");
          const model = modelReturning(portError(
            "unavailable",
            CANDIDATE_COMMIT_REFUSAL_DETAILS.unchanged_base,
          ));
          const { plan, result } = await wave(rig, model.port);
          let deps = rig.deps;
          if (scenario.state) {
            const read = await rig.store.readRepair();
            assert.ok(read.ok && read.value.status === "found");
            const next = structuredClone(read.value.snapshot);
            scenario.state(next);
            // Inject a contradictory read view; immutable Git history must not
            // be rewritten to manufacture these negative observations.
            const value = read.value;
            deps = {
              ...rig.deps,
              state: {
                readRepair: () =>
                  Promise.resolve({
                    ...read,
                    value: { ...value, snapshot: next },
                  }),
                readRelease: () => rig.store.readRelease(),
                writeRepair: (...args) => rig.store.writeRepair(...args),
              },
            };
          }
          rig.clock.advance(60 * 60_000);
          const selected = scenario.result?.(result) ?? result;
          const replay = await ingestMatrixResults(
            deps,
            plan,
            scenario.conflict
              ? [result, { ...result, detail: UNAVAILABLE }]
              : [selected],
            rig.ingestOptions(),
          );
          assert.notEqual(
            replay.entries[0].disposition,
            "duplicate",
            scenario.name,
          );
          if (scenario.conflict) {
            assert.equal(replay.entries[0].disposition, "conflict");
          }
          assert.equal(model.calls(), 1);
        } finally {
          await rig.cleanup();
        }
      });
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
