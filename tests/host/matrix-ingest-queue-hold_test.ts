/** A queue hold can write progress without consuming a matrix result. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { GitHubQueueDeliveryClient } from "../../src/github/client-queue-delivery.ts";
import { createNativeQueueGuard } from "../../src/github/native-queue-guard.ts";
import { createQueueDeliveryReader } from "../../src/github/queue-delivery-reader.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { ATTEMPT_DETAIL_NO_CHANGE } from "../../src/repair/attempt-policy.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { decompositionChildId } from "../../src/repair/transitions.ts";
import { createRunBounds, loadRepairContext } from "../../src/repair/loop.ts";
import { holdQueueRecord } from "../../src/repair/loop-queue-guard.ts";
import { QUEUE_REPO } from "../github/merge-queue-fixtures.ts";
import { POLICY } from "./merge-queue-proof-fixtures.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  PROVIDER,
  seedSnapshot,
  snapshot,
} from "./matrix-runtime-fixtures.ts";

type ResultKind = "failed" | "interrupted" | "completed";
type Observation = "held" | "unknown" | "inactive" | "late_unknown";

async function fixture(kind: ResultKind, observation: Observation) {
  const rig = await makeRig([990090], 1);
  try {
    const configs = rig.deps.configs.map((config) => ({
      ...config,
      repository: QUEUE_REPO,
    }));
    const deps = {
      ...rig.deps,
      configs,
      budget: new RollingStartBudget({
        state: rig.store,
        clock: rig.clock,
        configs,
      }),
    };
    // A decomposition part can carry a timeout streak without being split
    // again by the planner. Deferral must not clear that exact saved streak.
    const issue = freshIssue(990090, rig.base);
    const id = asWorkItemId(decompositionChildId(issue.id, 1, 2));
    const seeded = await rig.store.writeRepair(
      seedSnapshot([{
        ...issue,
        id,
        repository: QUEUE_REPO,
        target: { ...issue.target, branch: candidateBranch(id) },
        counters: { ...issue.counters, timeouts: 1 },
      }]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const planned = await planMatrixWave(deps, rig.planOptions());
    assert.equal(planned.prepared, 1);
    const cell = planned.plan.cells[0];
    let result: MatrixCellResultV1 = {
      version: "v1",
      kind: "matrix_cell_result",
      waveId: planned.plan.waveId,
      cellId: cell.cellId,
      taskId: cell.taskId,
      repository: cell.repository,
      run: planned.plan.run,
      runtimeSha: cell.runtimeSha,
      generation: cell.generation,
      reservationId: cell.reservationId,
      intentKey: cell.intentKey,
      requestDigest: cell.requestDigest,
      status: "failed",
      receipt: null,
      bundle: null,
      detail: "fixture terminal producer failure",
      completedAt: rig.clock.now(),
    };
    if (kind === "completed") {
      const context = await rig.claimCell(cell);
      result = await runMatrixCell(
        context.deps,
        { waveId: planned.plan.waveId, run: planned.plan.run, cell },
        ACTUAL,
        rig.clock.now(),
      );
      assert.equal(result.status, "completed");
      await rig.transfer([result], [context]);
    } else if (kind === "interrupted") {
      result = {
        ...result,
        status: "completed",
        detail: null,
        receipt: {
          invocationId: "fixture-interrupted",
          outcome: "interrupted",
          actual: {
            evidenceKind: "request-runtime",
            provider: PROVIDER,
            threadId: "fixture-thread",
            turnId: "fixture-turn",
            terminalOrigin: "runtime",
            observedTerminalStatus: "interrupted",
            observedModel: cell.request.model,
            observedReasoning: cell.request.reasoning,
            durationMs: 1,
            outputChars: cell.request.maxOutputChars + 1,
          },
          candidate: null,
          error: "fixture interrupted output",
        },
      };
    }
    if (observation === "held") {
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const held = await rig.store.writeRepair({
        ...read.value.snapshot,
        sequence: read.value.snapshot.sequence + 1,
        stateHead: read.value.head,
        work: read.value.snapshot.work.map((row) => ({
          ...row,
          target: { ...row.target, head: rig.base, pr: 7 },
          wait: { reason: "backoff", since: rig.clock.now(), until: null },
        })),
      }, read.value.head);
      assert.ok(held.ok && held.value.status === "applied");
    }
    let rules = 0;
    let unavailable = observation === "unknown";
    const client = new GitHubQueueDeliveryClient({
      repository: QUEUE_REPO,
      clock: rig.clock,
      cooldownGate: deps.githubCooldown!,
      apiBaseUrl: "https://api.github.com",
      auth: { authorizationHeader: () => Promise.resolve(portOk("fixture")) },
      http: () => {
        throw new Error(
          "the fixture authorizes only explicit rule observations",
        );
      },
    }, null);
    client.readBranchRules = (branch) => {
      assert.equal(branch, "development");
      rules++;
      if (observation === "late_unknown" && rules === 3) unavailable = true;
      return Promise.resolve(
        unavailable
          ? portError("unavailable", "fixture rule read")
          : portOk([]),
      );
    };
    const reader = createQueueDeliveryReader({
      repository: QUEUE_REPO,
      clock: rig.clock,
      client,
      policy: POLICY,
    });
    rig.github.nativeQueue = createNativeQueueGuard({
      repository: QUEUE_REPO,
      state: rig.store,
      clock: rig.clock,
      client,
      reader,
      mode: "off",
      proofActivated: false,
      policy: POLICY,
    });
    return {
      rig,
      deps,
      result,
      before: await snapshot(rig),
      ingest: () =>
        ingestMatrixResults(deps, planned.plan, [result], rig.ingestOptions()),
      recover: () => unavailable = false,
      rules: () => rules,
    };
  } catch (error) {
    await rig.cleanup();
    throw error;
  }
}

for (const kind of ["failed", "interrupted", "completed"] as const) {
  Deno.test(`matrix queue hold: ${kind} consumption distinguishes custody from settlement`, async (t) => {
    for (const observation of ["held", "unknown", "inactive"] as const) {
      await t.step(observation, async () => {
        const f = await fixture(kind, observation);
        try {
          const report = await f.ingest();
          const after = await snapshot(f.rig);
          if (observation === "inactive") {
            assert.equal(report.ingested, 1);
            assert.equal(report.entries[0].disposition, "ingested");
            assert.equal(
              after.reservations[0].outcome,
              kind === "completed" ? "submitted" : "ambiguous",
            );
            assert.notEqual(after.reservations[0].settledAt, null);
            assert.equal(after.work[0].counters.timeouts, undefined);
          } else {
            assert.equal(report.ingested, 0);
            assert.equal(report.entries[0].disposition, "deferred");
            assert.deepEqual(after.reservations, f.before.reservations);
            assert.deepEqual(after.work[0].intent, f.before.work[0].intent);
            assert.deepEqual(after.work[0].counters, f.before.work[0].counters);
            if (observation === "held") {
              assert.deepEqual(after, f.before);
              assert.equal(f.rules(), 0);
            } else {
              assert.equal(after.work[0].wait?.reason, "unavailable");
              assert.notEqual(after.work[0].wait?.until, null);
              assert.equal(
                (await f.ingest()).entries[0].disposition,
                "deferred",
              );
              assert.deepEqual(await snapshot(f.rig), after);
            }
          }
        } finally {
          await f.rig.cleanup();
        }
      });
    }
  });
}

Deno.test("matrix queue hold: custody arriving after budget settlement leaves the receipt unconsumed", async () => {
  const f = await fixture("completed", "late_unknown");
  try {
    const report = await f.ingest();
    const held = await snapshot(f.rig);
    assert.equal(report.ingested, 0);
    assert.equal(report.entries[0].disposition, "deferred");
    assert.equal(held.reservations[0].outcome, "submitted");
    assert.notEqual(held.reservations[0].settledAt, null);
    assert.deepEqual(held.work[0].intent, f.before.work[0].intent);
    assert.deepEqual(held.work[0].counters, f.before.work[0].counters);
    assert.equal(held.work[0].target.head, null);
    f.recover();
    const consumed = await f.ingest();
    assert.equal(consumed.ingested, 1);
    assert.equal(consumed.entries[0].disposition, "ingested");
    assert.deepEqual((await snapshot(f.rig)).reservations, held.reservations);
  } finally {
    await f.rig.cleanup();
  }
});

Deno.test("matrix queue hold: progress marker is private to the in-memory consumer", async () => {
  const f = await fixture("failed", "inactive");
  try {
    const bounds = createRunBounds(f.deps, f.rig.ingestOptions());
    const context = await loadRepairContext(f.deps, bounds);
    assert.ok(context !== null);
    const held = await holdQueueRecord(
      f.deps,
      context,
      context.snapshot.work[0],
    );
    assert.equal(held.kind, "progress", "ordinary loop progress is preserved");
    assert.equal(Reflect.get(held, "queueHold"), true);
    assert.equal(JSON.stringify(held), '{"kind":"progress"}');
    assert.deepEqual(structuredClone(held), { kind: "progress" });
    assert.equal(
      Object.getOwnPropertyDescriptor(held, "queueHold")?.enumerable,
      false,
    );
    assert.ok(!JSON.stringify(await snapshot(f.rig)).includes('"queueHold"'));
    assert.ok(!JSON.stringify(f.result).includes('"queueHold"'));
  } finally {
    await f.rig.cleanup();
  }
});

Deno.test("matrix queue hold: a consumed no-change result keeps its distinct base-review hold", async () => {
  const f = await fixture("failed", "inactive");
  try {
    f.result.detail = ATTEMPT_DETAIL_NO_CHANGE;
    const report = await f.ingest();
    const after = await snapshot(f.rig);
    assert.equal(report.ingested, 1);
    assert.equal(report.entries[0].disposition, "ingested");
    assert.equal(after.reservations[0].outcome, "ambiguous");
    assert.notEqual(after.reservations[0].settledAt, null);
    assert.equal(after.work[0].intent?.failure?.kind, "base_review");
    assert.equal(after.work[0].wait?.reason, "backoff");
    assert.equal(after.work[0].wait?.until, null);
  } finally {
    await f.rig.cleanup();
  }
});
