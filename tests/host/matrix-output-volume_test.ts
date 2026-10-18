/** New volume policy survives planning, cell execution, ingestion and R80 parsing. */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { T0 } from "../state/helpers.ts";
import { r80Available, withR80Parsers } from "./r80-contracts.ts";
import {
  ACTUAL,
  freshIssue,
  makeRig,
  RUN,
  seedSnapshot,
  snapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

Deno.test("matrix volume: production config and charged >4M completion parse under R80", async (t) => {
  const config = createLocalRepositoryConfig();
  const rig = await makeRig([81], 1, config.sessionBound!);
  try {
    const seeded = await rig.store.writeRepair(
      seedSnapshot([freshIssue(81, rig.base)]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const plan = (await planMatrixWave(rig.deps, rig.planOptions())).plan;
    assert.equal(plan.cells.length, 1);
    const cell = plan.cells[0];
    assert.equal(cell.request.maxDurationMs, 1_800_000);
    assert.equal(cell.request.maxOutputChars, Number.MAX_SAFE_INTEGER);
    const ctx = await rig.claimCell(cell);
    const runModel = ctx.deps.model.runModel.bind(ctx.deps.model);
    ctx.deps.model.runModel = async (request) => {
      const result = await runModel(request);
      if (!result.ok) return result;
      return portOk({
        ...result.value,
        actual: { ...result.value.actual, outputChars: 8_500_000 },
      });
    };
    const result = await runMatrixCell(
      ctx.deps,
      { waveId: WAVE, run: RUN, cell },
      ACTUAL,
      T0,
    );
    assert.equal(result.status, "completed");
    assert.equal(result.receipt?.outcome, "completed");
    assert.ok(result.bundle !== null);
    await rig.transfer([result], [ctx]);
    const report = await ingestMatrixResults(
      rig.deps,
      plan,
      [result],
      rig.ingestOptions(),
    );
    assert.equal(
      report.entries[0]?.disposition,
      "ingested",
      JSON.stringify(report),
    );
    const state = await snapshot(rig);
    assert.equal(state.reservations.length, 1);
    assert.equal(state.reservations[0].outcome, "submitted");
    assert.equal(state.work[0].target.head, result.receipt?.candidate?.head);
    await t.step({
      name:
        "R80 own strict parsers accept config, plan, cell, receipt and written state",
      ignore: !(await r80Available()),
      fn: () =>
        withR80Parsers((parsers) => {
          assert.deepEqual(parsers.parseRepositoryConfigV1(config), config);
          assert.deepEqual(parsers.parseMatrixPlanV1(plan), plan);
          assert.deepEqual(parsers.parseMatrixCellResultV1(result), result);
          assert.deepEqual(parsers.parseRepairStateSnapshotV1(state), state);
        }),
    });
  } finally {
    await rig.cleanup();
  }
});
