/**
 * GitHub's Actions API answering a server error (live 2026-10-24: a 502 on
 * one run's job listing crashed two repair jobs) is retried, and when it
 * persists it is unavailability, never a provenance verdict: the matrix
 * consumer leaves every charge unresolved and the ordinary lifecycle runs.
 */
import assert from "node:assert/strict";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { MatrixArtifactUnavailableError } from "../../src/host/matrix-artifact-port.ts";
import { fixture } from "./matrix-artifact-fixtures.ts";
import { rig } from "./matrix-actions-fixtures.ts";

Deno.test("matrix artifacts: one server error on a listing page is retried", async () => {
  const r = await fixture(true);
  try {
    r.pagination.serverErrors = 1;
    const { currentRun: _oldRun, ...input } = r.input;
    const waves = await r.transport.recover(input);
    assert.equal(waves.length, 1);
    assert.equal(waves[0].results.length, 1);
  } finally {
    await Deno.remove(r.tmp, { recursive: true });
  }
});

Deno.test("matrix artifacts: a persistent server error is unavailability, not a refusal", async () => {
  const r = await fixture(true);
  try {
    r.pagination.serverErrors = 1_000;
    const { currentRun: _oldRun, ...input } = r.input;
    await assert.rejects(
      () => r.transport.recover(input),
      MatrixArtifactUnavailableError,
    );
  } finally {
    await Deno.remove(r.tmp, { recursive: true });
  }
});

Deno.test("matrix consumer: unavailable artifacts leave charges unresolved and the lifecycle runs", async () => {
  const r = await rig();
  try {
    const planned = await runActionsMatrixHost({
      ...await r.job("earlier-plan", "matrix_plan"),
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("planner cannot infer")),
      },
    });
    assert.ok("plan" in planned);
    const charged = planned.plan.cells.map((cell) => cell.reservationId);
    assert.ok(charged.length > 0);
    r.clock.advance(60 * 60_000);
    await r.advanceRun(72);
    const deps = await r.job("current-aggregate", "repair");
    const cycles: string[] = [];
    let scans = 0;
    const result = await runActionsRepairHost({
      ...deps,
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("aggregate cannot infer")),
      },
      runTargetCycles: (input) =>
        runActionsMatrixAggregateCycles(
          {
            ...input,
            runCycle: (cycleDeps) => {
              const repository = cycleDeps.configs[0]!.repository;
              cycles.push(repository.owner + "/" + repository.name);
              return Promise.resolve({ status: "idle", detail: "fixture" });
            },
          },
          {
            recover: () => {
              scans++;
              return Promise.reject(new MatrixArtifactUnavailableError());
            },
          },
          undefined,
          { pollWait: () => Promise.resolve() },
        ),
    });
    assert.equal(result.status, "ran", JSON.stringify(result));
    assert.equal(scans, 1, "one scan, no polling on an unavailable API");
    assert.deepEqual(
      cycles.sort(),
      ["ubiquity-sentinel/sentinel", "ubiquity/ai.ubq.fi"],
      "every target's ordinary cycle still runs",
    );
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    for (const id of charged) {
      assert.equal(
        after.value.snapshot.reservations.find((row) => row.id === id)
          ?.outcome,
        "reserved",
        "nothing settled or refunded",
      );
    }
  } finally {
    await r.cleanup();
  }
});
