/** A rejected model port must settle a charged cell, not crash its native job. */
import assert from "node:assert/strict";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import { tryParseMatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import { resolveMatrixLauncherResult } from "../../src/host/hosted-runtime-matrix.ts";
import { writeResult } from "../../src/host/matrix-actions-shared.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCellEntrypoint,
} from "../../src/host/matrix.ts";
import { T0 } from "../state/helpers.ts";
import { issue, rig as nativeRig } from "./matrix-actions-fixtures.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

for (const mode of ["throw", "reject"] as const) {
  Deno.test(`matrix cell: a model ${mode} emits a sanitized, ingestible failure`, async () => {
    const rig = await makeRig([386], 1);
    try {
      const seeded = await rig.store.writeRepair(
        seedSnapshot([freshIssue(386, rig.base)]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");
      const planned = await planMatrixWave(rig.deps, rig.planOptions());
      assert.equal(planned.prepared, 1);
      const cell = planned.plan.cells[0]!;
      const ctx = await rig.claimCell(cell);
      const before = await snapshot(rig);
      const grantPath = rig.tmp + "/grant.json";
      const resultPath = rig.tmp + "/cell-result.json";
      await Deno.writeTextFile(
        grantPath,
        JSON.stringify({ waveId: WAVE, run: RUN, cell }),
      );
      let starts = 0;
      let bundles = 0;
      const result = await runMatrixCellEntrypoint({
        deps: {
          ...ctx.deps,
          model: {
            modelId: ctx.deps.model.modelId,
            runModel: () => {
              starts++;
              rig.clock.advance(25);
              const error = new Error("PRIVATE_MODEL_FAILURE_386");
              if (mode === "throw") throw error;
              return Promise.reject(error);
            },
          },
          bundle: {
            create: () => {
              bundles++;
              return Promise.resolve(null);
            },
          },
        },
        actual: ACTUAL,
        cellPath: grantPath,
        resultPath,
      });
      assert.equal(
        starts,
        1,
        "a port error cannot start a replacement session",
      );
      assert.equal(bundles, 0);
      assert.equal(result.status, "failed");
      assert.equal(result.detail, "model run failed (unavailable)");
      assert.equal(result.receipt, null);
      assert.equal(result.bundle, null);
      assert.equal(result.completedAt, rig.clock.now());
      const wire = await Deno.readTextFile(resultPath);
      assert.ok(tryParseMatrixCellResultV1(JSON.parse(wire)).ok);
      assert.equal(wire.includes("PRIVATE_MODEL_FAILURE_386"), false);
      assert.deepEqual(await snapshot(rig), before, "the cell is read-only");

      // Exercise the actual native carrier writer and launcher validation.
      const lines: string[] = [];
      const log = console.log;
      try {
        console.log = (line: string) => lines.push(line);
        await writeResult(ctx.bundlesDir, result);
      } finally {
        console.log = log;
      }
      assert.equal(lines.length, 1);
      const launched = resolveMatrixLauncherResult(
        {
          outcome: "exited",
          exitCode: 0,
          stdout: new TextEncoder().encode(lines.join("\n")),
          stderr: new Uint8Array(),
          truncated: false,
          settled: true,
          detail: "settled test child",
        },
        parseHostedExecutionIntentV1({
          id: `${RUN.runId}:${RUN.runAttempt}:repair`,
          ...RUN,
          purpose: "ordinary",
          revision: ACTUAL.runtimeSha,
          generation: ACTUAL.generation,
          releaseId: null,
          createdAt: T0,
        }),
        "matrix_cell",
        JSON.stringify({
          planDigest: "d".repeat(64),
          cellId: cell.cellId,
        }),
      );
      assert.equal(launched.status, "healthy", JSON.stringify(launched));
      assert.equal(launched.matrixCarrier?.status, "failed");
      assert.equal(
        lines.join("\n").includes("PRIVATE_MODEL_FAILURE_386"),
        false,
      );

      const ingested = await ingestMatrixResults(
        rig.deps,
        planned.plan,
        [result],
        rig.ingestOptions(),
      );
      assert.equal(ingested.ingested, 1);
      const after = await snapshot(rig);
      assert.equal(after.reservations.length, before.reservations.length);
      assert.equal(after.reservations[0].outcome, "ambiguous");
      assert.notEqual(after.reservations[0].settledAt, null);
      const attempt = after.attemptMemory[0].entries.at(-1)!;
      assert.equal(attempt.stage, "model");
      assert.equal(attempt.failureClass, "transient_infrastructure");
      const replay = await ingestMatrixResults(
        rig.deps,
        planned.plan,
        [result],
        rig.ingestOptions(),
      );
      assert.equal(replay.ingested, 0);
      assert.deepEqual(await snapshot(rig), after);
    } finally {
      await rig.cleanup();
    }
  });
}

Deno.test("sentinel matrix lifecycle: native cell settles a rejected model without a job failure", async () => {
  const r = await nativeRig();
  try {
    r.github.get("ubiquity-sentinel/sentinel")!.row = issue(386);
    r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
      Promise.resolve(portOk([]));
    let starts = 0;
    const model = {
      modelId: "gpt-reserve",
      runModel: () => {
        starts++;
        return Promise.reject(new Error("PRIVATE_NATIVE_MODEL_FAILURE_386"));
      },
    };
    const planned = await runActionsMatrixHost({
      ...await r.job("model-failure-plan", "matrix_plan"),
      model,
    });
    assert.ok("plan" in planned);
    assert.equal(planned.prepared, 1);
    assert.equal(starts, 0);
    const cell = planned.plan.cells[0]!;
    assert.equal(cell.repository.owner, "ubiquity-sentinel");
    assert.equal(cell.repository.name, "sentinel");
    const deps = await r.job("model-failure-cell", "matrix_cell");
    const root = r.root + "/model-failure-cell/.sentinel-matrix";
    await Deno.mkdir(root);
    await Deno.writeTextFile(root + "/plan.json", JSON.stringify(planned.plan));
    const beforeRepair = await r.store.readRepair();
    const beforeRelease = await r.store.readRelease();
    const lines: string[] = [];
    const log = console.log;
    try {
      console.log = (line: string) => lines.push(line);
      const result = await runActionsMatrixHost({
        ...deps,
        carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
        model,
      });
      assert.ok("cellId" in result);
      assert.equal(result.status, "failed");
      assert.equal(result.detail, "model run failed (unavailable)");
      assert.deepEqual(
        JSON.parse(await Deno.readTextFile(root + "/result.json")),
        result,
      );
    } finally {
      console.log = log;
    }
    assert.equal(starts, 1);
    const carriers = lines.map((line) => JSON.parse(line)).filter((line) =>
      line.kind === "sentinel_matrix_cell"
    );
    assert.equal(carriers.length, 1);
    assert.equal(carriers[0].status, "failed");
    assert.equal(
      lines.join("\n").includes("PRIVATE_NATIVE_MODEL_FAILURE_386"),
      false,
    );
    assert.deepEqual(await r.store.readRepair(), beforeRepair);
    assert.deepEqual(await r.store.readRelease(), beforeRelease);
  } finally {
    await r.cleanup();
  }
});
