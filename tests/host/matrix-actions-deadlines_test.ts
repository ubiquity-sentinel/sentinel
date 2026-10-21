/** Planner cutoff and queued-cell bounded start-window coverage. */
import assert from "node:assert/strict";
import type { ModelRunReceiptV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import {
  OPERATION_MARGIN_MS,
  REPAIR_MODEL_CUTOFF_MS,
} from "../../src/repair/loop.ts";
import { T0 } from "../state/helpers.ts";
import { PROVIDER, rig } from "./matrix-actions-fixtures.ts";

for (
  const scenario of [
    {
      name: "source read reaches model cutoff",
      boundary: "source",
      elapsed: REPAIR_MODEL_CUTOFF_MS,
      starts: 0,
    },
    {
      name: "intent read leaves insufficient full session margin",
      boundary: "state",
      elapsed: 110 * 60_000 - 1_800_000 - OPERATION_MARGIN_MS + 1,
      starts: 0,
    },
    {
      name: "source read reaches absolute deadline",
      boundary: "source",
      elapsed: 110 * 60_000,
      starts: 0,
    },
    {
      name: "intent read leaves exactly full session margin",
      boundary: "state",
      elapsed: 110 * 60_000 - 1_800_000 - OPERATION_MARGIN_MS,
      starts: 1,
    },
    {
      name: "source read stays just inside session margin",
      boundary: "source",
      elapsed: 110 * 60_000 - 1_800_000 - OPERATION_MARGIN_MS - 1,
      starts: 1,
    },
  ]
) {
  Deno.test("matrix actions deadline: " + scenario.name, async () => {
    const r = await rig();
    try {
      const planned = await runActionsMatrixHost({
        ...await r.job("deadline-plan", "matrix_plan"),
        model: {
          modelId: "gpt-reserve",
          runModel: () => Promise.reject(new Error("planner cannot infer")),
        },
      });
      assert.ok("plan" in planned);
      const cell = planned.plan.cells.find((entry) =>
        entry.repository.name === "sentinel"
      )!;
      assert.ok(cell);
      const before = await r.store.readRepair();
      assert.ok(before.ok && before.value.status === "found");
      const deps = await r.job("deadline-cell", "matrix_cell");
      const artifactRoot = r.root + "/deadline-cell/.sentinel-matrix";
      await Deno.mkdir(artifactRoot);
      await Deno.writeTextFile(
        artifactRoot + "/plan.json",
        JSON.stringify(planned.plan),
      );
      const github = r.github.get("Ubiquity-Sentinel/sentinel")!;
      const readIssue = github.readIssue.bind(github);
      let armed = false, advanced = false, modelCalls = 0;
      const advance = () => {
        if (advanced) return;
        r.clock.advance(T0 + 10000 + scenario.elapsed - r.clock.now());
        advanced = true;
      };
      github.readIssue = async (number) => {
        const result = await readIssue(number);
        armed = true;
        if (scenario.boundary === "source") advance();
        return result;
      };
      const result = await runActionsMatrixHost({
        ...deps,
        state: {
          readRelease: () => r.store.readRelease(),
          writeRepair: (snapshot, expected) =>
            r.store.writeRepair(snapshot, expected),
          readRepair: async () => {
            const read = await r.store.readRepair();
            if (armed && scenario.boundary === "state") advance();
            return read;
          },
        },
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            modelCalls++;
            return Promise.resolve(
              portError("unavailable", "bounded fake model outcome"),
            );
          },
        },
        carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
      });
      assert.ok("cellId" in result);
      assert.ok(
        advanced,
        "the real cell awaited the advancing source/state boundary",
      );
      assert.equal(
        modelCalls,
        scenario.starts,
        "late cells must start zero model sessions",
      );
      assert.equal(
        result.status,
        scenario.starts === 0 ? "not_started" : "failed",
      );
      assert.equal(result.receipt, null);
      assert.equal(result.bundle, null);
      if (scenario.starts === 0) {
        assert.equal(result.completedAt, r.clock.now());
        assert.match(result.detail!, /cutoff|run bounds/);
      }
      assert.deepEqual(
        JSON.parse(await Deno.readTextFile(artifactRoot + "/result.json")),
        result,
      );
      assert.deepEqual(
        await r.store.readRepair(),
        before,
        "cell refusal preserves reservation, history and intent",
      );
    } finally {
      await r.cleanup();
    }
  });
}

Deno.test("matrix timing: queued cells keep their own bounded start window", async (t) => {
  const setup = async (name: string) => {
    const r = await rig();
    const planned = await runActionsMatrixHost({
      ...await r.job(name + "-plan", "matrix_plan"),
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      },
    });
    assert.ok("plan" in planned);
    const cell = planned.plan.cells.find((entry) =>
      entry.repository.name === "sentinel"
    )!;
    assert.ok(cell);
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    // Bind the narrowed found snapshot once: TypeScript does not retain the
    // assertion narrowing inside the step closures below.
    const beforeSnapshot: RepairStateSnapshotV1 = before.value.snapshot;
    const deps = await r.job(name + "-cell", "matrix_cell");
    const artifactRoot = r.root + "/" + name + "-cell/.sentinel-matrix";
    await Deno.mkdir(artifactRoot);
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planned.plan),
    );
    const state = {
      readRelease: () => r.store.readRelease(),
      writeRepair: (
        snapshot: Parameters<typeof r.store.writeRepair>[0],
        expected: Parameters<typeof r.store.writeRepair>[1],
      ) => r.store.writeRepair(snapshot, expected),
      readRepair: () => r.store.readRepair(),
    };
    return {
      r,
      planned,
      cell,
      before,
      beforeSnapshot,
      deps,
      artifactRoot,
      state,
    };
  };
  const completedReceipt = (model: string): ModelRunReceiptV1 => ({
    invocationId: "timing-invocation",
    outcome: "completed" as const,
    actual: {
      evidenceKind: "request-runtime" as const,
      provider: PROVIDER,
      threadId: "timing-thread",
      turnId: "timing-turn",
      terminalOrigin: "runtime" as const,
      observedTerminalStatus: "completed" as const,
      observedModel: model,
      observedReasoning: "max" as const,
      durationMs: 1,
      outputChars: 1,
    },
    candidate: { head: null, checkpointSha: null, changedPaths: [] },
    error: null,
  });

  await t.step(
    "long planning or queued runner delay starts exactly one model and one charge",
    async () => {
      const { r, planned, cell, beforeSnapshot, deps, state } = await setup(
        "timing-queued",
      );
      try {
        // The execution row predates the planner; this cell's own runner starts
        // 100 minutes later. It must still own its full bounded window from its
        // own trusted invocation origin.
        r.clock.advance(100 * 60_000);
        let modelCalls = 0;
        const result = await runActionsMatrixHost({
          ...deps,
          state,
          model: {
            modelId: "gpt-reserve",
            runModel: (request) => {
              modelCalls++;
              return Promise.resolve(portOk(completedReceipt(request.model)));
            },
          },
          carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
        });
        assert.ok("cellId" in result);
        assert.equal(modelCalls, 1, "the queued cell starts exactly one model");
        assert.equal(result.status, "completed");
        assert.ok(result.receipt !== null);
        assert.equal(result.bundle, null);
        const after = await r.store.readRepair();
        assert.ok(after.ok && after.value.status === "found");
        assert.deepEqual(
          after.value.snapshot.reservations.map((row) => [
            row.id,
            row.attempt,
            row.purpose,
          ]),
          beforeSnapshot.reservations.map((row) => [
            row.id,
            row.attempt,
            row.purpose,
          ]),
          "one start keeps exactly one reservation and charge",
        );
        assert.deepEqual(
          after.value.snapshot.work.map((row) => row.intent),
          beforeSnapshot.work.map((row) => row.intent),
          "the cell start keeps the exact admitted intent",
        );
      } finally {
        await r.cleanup();
      }
    },
  );

  await t.step(
    "own actual execution exhaustion still refuses with zero model starts",
    async () => {
      const { r, planned, cell, before, deps, state } = await setup(
        "timing-exhausted",
      );
      try {
        const github = r.github.get("Ubiquity-Sentinel/sentinel")!;
        const readIssue = github.readIssue.bind(github);
        const origin = r.clock.now();
        let armed = false;
        github.readIssue = async (number) => {
          const read = await readIssue(number);
          if (!armed) {
            armed = true;
            // The cell's OWN absolute deadline lands here, after its trusted
            // invocation origin, so its remaining window cannot fit a session.
            r.clock.advance(origin + 110 * 60_000 - r.clock.now());
          }
          return read;
        };
        let modelCalls = 0;
        const result = await runActionsMatrixHost({
          ...deps,
          state,
          model: {
            modelId: "gpt-reserve",
            runModel: () => {
              modelCalls++;
              return Promise.resolve(portOk(completedReceipt("gpt-reserve")));
            },
          },
          carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
        });
        assert.ok("cellId" in result);
        assert.equal(
          modelCalls,
          0,
          "an exhausted own window never starts a model",
        );
        assert.equal(result.status, "not_started");
        assert.equal(result.receipt, null);
        assert.equal(result.bundle, null);
        assert.match(result.detail!, /cutoff|run bounds/);
        assert.deepEqual(
          await r.store.readRepair(),
          before,
          "the refusal preserves reservation, intent and charge",
        );
      } finally {
        await r.cleanup();
      }
    },
  );

  await t.step(
    "wrong generation or stale runtime binding refuses before any model",
    async () => {
      const { r, planned, cell, before, deps, artifactRoot, state } =
        await setup(
          "timing-stale",
        );
      try {
        let modelCalls = 0;
        const model = {
          modelId: "gpt-reserve",
          runModel: () => {
            modelCalls++;
            return Promise.resolve(portOk(completedReceipt("gpt-reserve")));
          },
        };
        const rewritten = (change: Record<string, unknown>) =>
          JSON.stringify({
            ...planned.plan,
            cells: planned.plan.cells.map((entry) =>
              entry.cellId === cell.cellId ? { ...entry, ...change } : entry
            ),
          });
        await Deno.writeTextFile(
          artifactRoot + "/plan.json",
          rewritten({ generation: cell.generation + 1 }),
        );
        await assert.rejects(
          runActionsMatrixHost({
            ...deps,
            state,
            model,
            carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
          }),
          /matrix plan does not match the trusted native digest/,
        );
        await Deno.writeTextFile(
          artifactRoot + "/plan.json",
          rewritten({ runtimeSha: "f".repeat(40) }),
        );
        await assert.rejects(
          runActionsMatrixHost({
            ...deps,
            state,
            model,
            carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
          }),
          /matrix plan does not match the trusted native digest/,
        );
        assert.equal(modelCalls, 0, "a stale cell never starts a model");
        assert.deepEqual(
          await r.store.readRepair(),
          before,
          "a stale cell preserves reservation, intent and charge",
        );
      } finally {
        await r.cleanup();
      }
    },
  );
});
