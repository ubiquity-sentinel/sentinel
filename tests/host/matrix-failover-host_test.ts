/**
 * The runtime repair host threads its own trusted route failover model id
 * (actions-repair-host -> target cycles -> matrix aggregate -> ingester): an
 * authenticated cell whose port failed over (HTTP 429 on the primary) and
 * then failed exports a receipt naming the failover model, and the real
 * aggregate settles it as an ordinary failed implementation instead of
 * leaving the charged admission pending as `receipt_rejected`.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import { resolveModelRoute } from "../../src/host/model-route.ts";
import { ATTEMPT_DETAIL_INCOMPLETE } from "../../src/repair/attempt-policy.ts";
import { createFreshMatrixArchives } from "./matrix-actions-archive-fixtures.ts";
import { issue, PROVIDER, rig } from "./matrix-actions-fixtures.ts";

Deno.test("failover host: the repair host settles a failover-named failed cell through the aggregate", async () => {
  const r = await rig();
  try {
    const self = r.github.get("ubiquity-sentinel/sentinel")!;
    self.listOpenIssues = () => Promise.resolve(portOk([issue(93)]));
    self.readIssue = (number) => Promise.resolve(portOk(issue(number)));
    const foreign = r.github.get("ubiquity/ai.ubq.fi")!;
    foreign.listOpenIssues = () => Promise.resolve(portOk([]));
    foreign.readIssue = (number) => Promise.resolve(portOk(issue(number)));
    const noModel = {
      modelId: "gpt-reserve",
      runModel: () => {
        throw new Error("no inference is permitted");
      },
    };
    const planner = await runActionsMatrixHost({
      ...await r.job("failover-plan", "matrix_plan"),
      model: noModel,
    });
    assert.ok("plan" in planner);
    assert.equal(planner.plan.cells.length, 1);
    const cell = planner.plan.cells[0];
    assert.equal(cell.request.model, "gpt-reserve");
    // The route the fixture host resolves (no failover override).
    const failover = resolveModelRoute({}).failoverModel;
    const cellDeps = await r.job("failover-cell", "matrix_cell");
    const artifactRoot = cellDeps.workDir + "/../.sentinel-matrix";
    await Deno.mkdir(artifactRoot);
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planner.plan),
    );
    let portCalls = 0;
    const produced = await runActionsMatrixHost({
      ...cellDeps,
      carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
      model: {
        modelId: "gpt-reserve",
        runModel: () => {
          portCalls++;
          // The primary was throttled; the separate failover attempt then
          // failed for an ordinary runtime reason and is exported as-is.
          return Promise.resolve(portOk({
            invocationId: "codex-failover-host",
            outcome: "failed" as const,
            actual: {
              evidenceKind: "request-runtime" as const,
              provider: PROVIDER,
              threadId: "thread-failover-host",
              turnId: "turn-failover-host",
              terminalOrigin: "runtime" as const,
              observedTerminalStatus: "failed" as const,
              observedModel: failover,
              observedReasoning: "max",
              durationMs: 900,
              outputChars: 120,
            },
            candidate: null,
            error: "stream disconnected before completion",
          }));
        },
      },
    });
    assert.ok("cellId" in produced);
    const exported: MatrixCellResultV1 = produced;
    assert.equal(portCalls, 1);
    assert.equal(exported.status, "completed");
    assert.equal(exported.receipt?.actual.observedModel, failover);
    assert.equal(exported.receipt?.error, "runtime_error");
    const archives = await createFreshMatrixArchives(
      r,
      planner,
      [exported],
      r.root,
      false,
      false,
      true,
    );
    const deps = await r.job("failover-aggregate", "repair");
    const cwd = Deno.cwd();
    let beforeCharges: unknown;
    try {
      Deno.chdir(deps.workDir);
      await runActionsRepairHost({
        ...deps,
        artifactHttp: archives.artifactHttp(() => true),
        model: noModel,
        runTargetCycles: async (input) => {
          const read = await r.store.readRepair();
          assert.ok(read.ok && read.value.status === "found");
          beforeCharges = structuredClone(read.value.snapshot.reservations);
          return await runActionsMatrixAggregateCycles(
            { ...input, modelStartsEnabled: false },
            undefined,
            { planDigest: planner.planDigest },
            { maxWaitMs: 0 },
          );
        },
      });
    } finally {
      Deno.chdir(cwd);
    }
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    const record = after.value.snapshot.work.find((row) =>
      row.id === cell.taskId
    )!;
    const charge = after.value.snapshot.reservations.find((row) =>
      row.id === cell.reservationId
    )!;
    assert.equal(record.nextStep, "blocked", JSON.stringify(record));
    assert.equal(record.blocker?.message, ATTEMPT_DETAIL_INCOMPLETE);
    assert.equal(charge.outcome, "ambiguous", "charged, never refunded");
    assert.equal(charge.proofRef, null);
    const prior = beforeCharges as typeof after.value.snapshot.reservations;
    assert.equal(after.value.snapshot.reservations.length, prior.length);
    assert.deepEqual(
      after.value.snapshot.reservations.filter((row) =>
        row.id !== cell.reservationId
      ),
      prior.filter((row) => row.id !== cell.reservationId),
      "no other charge is created or changed",
    );
  } finally {
    await r.cleanup();
  }
});
