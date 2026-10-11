/** Submitted preservation custody and bounded startup deferral scenarios. */
import assert from "node:assert/strict";
import { MatrixHistoricalRuntimeMismatch } from "../../src/host/matrix-artifact-port.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import { rig } from "./matrix-actions-fixtures.ts";

for (
  const scenario of [
    "scan expiry",
    "consumer expiry",
    "run expiry",
    "run already expired",
    "shortened retry",
  ] as const
) {
  Deno.test(
    "matrix actions: historical isolation deadline " + scenario,
    async () => {
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
        const captured = await r.store.readRepair();
        assert.ok(captured.ok && captured.value.status === "found");
        const capturedHead = captured.value.head;
        const original = captured.value.snapshot;
        const cell = planned.plan.cells.find((row) =>
          row.repository.name === "ai.ubq.fi"
        )!;
        const work = original.work.find((row) => row.id === cell.taskId)!;
        const reservation = original.reservations.find((row) =>
          row.id === cell.reservationId
        )!;
        const startedAt = r.clock.now();
        const elapsed = scenario === "shortened retry"
          ? 40_000
          : scenario === "scan expiry"
          ? 120_001
          : 5_001;
        const calls: { at: number; deadline?: number }[] = [];
        const running = runActionsRepairHost({
          ...await r.job("deadline-aggregate", "repair"),
          model: {
            modelId: "gpt-reserve",
            runModel: () => Promise.reject(new Error("aggregate cannot infer")),
          },
          runTargetCycles: (input) =>
            runActionsMatrixAggregateCycles(
              {
                ...input,
                modelStartsEnabled: false,
                ...(scenario === "run already expired"
                  ? { deadline: startedAt }
                  : scenario === "run expiry"
                  ? { deadline: startedAt + 5_000 }
                  : {}),
              },
              {
                recover(request) {
                  calls.push({
                    at: r.clock.now(),
                    deadline: (request as { deadline?: number }).deadline,
                  });
                  if (calls.length > 1) return Promise.resolve([]);
                  r.clock.advance(elapsed);
                  return Promise.reject(
                    new MatrixHistoricalRuntimeMismatch({
                      consumerRun: input.host!.run,
                      expectedRuntimeSha: input.controllerSha,
                      run: { ...input.host!.run, runId: 69 },
                      runtimeSha: "e".repeat(40) as GitSha,
                      generation: 1,
                      repairHead: capturedHead,
                      planDigest: planned.planDigest,
                      planArtifactId: 503,
                      planArchiveDigest: "sha256:" + "a".repeat(64),
                      plannerJobId: 405,
                      affected: [{
                        work,
                        reservation,
                        cell: {
                          cellId: cell.cellId,
                          taskId: cell.taskId,
                          reservationId: cell.reservationId,
                          status: "completed",
                          receiptNull: false,
                          bundleNull: false,
                          completedAt: startedAt,
                          resultDigest: "b".repeat(64),
                        },
                      }],
                    }),
                  );
                },
              },
              undefined,
              {
                maxWaitMs: scenario === "consumer expiry" ? 5_000 : 0,
                pollWait: () =>
                  Promise.reject(new Error("deadline test must never sleep")),
              },
            ),
        });
        if (scenario === "run expiry" || scenario === "run already expired") {
          await assert.rejects(running, /reached its run deadline/);
        } else {
          assert.equal((await running).status, "ran");
        }
        assert.equal(
          calls.length,
          scenario === "run already expired"
            ? 0
            : scenario === "shortened retry"
            ? 2
            : 1,
          "a rejected wave must not renew recovery after the shared scan, consumer or run budget expires",
        );
        if (scenario === "shortened retry") {
          assert.equal(calls[0].deadline, startedAt + 120_000);
          assert.equal(calls[1].deadline, calls[0].deadline);
          assert.equal(calls[1].deadline! - calls[1].at, 80_000);
        }
        const after = await r.store.readRepair();
        assert.ok(after.ok && after.value.status === "found");
        assert.deepEqual(
          after.value.snapshot.reservations,
          original.reservations,
        );
        if (scenario === "run already expired") {
          assert.deepEqual(
            after.value.snapshot,
            original,
            "an expired run cannot inspect or isolate any artifact wave",
          );
        }
        const sibling = original.work.find((row) =>
          row.repository.name === "sentinel"
        )!;
        assert.deepEqual(
          after.value.snapshot.work.find((row) => row.id === sibling.id),
          sibling,
          "unconsumed sibling remains unresolved with its exact admission",
        );
        assert.ok(
          [...r.github.values()].every((port) =>
            !port.calls.some((call) => call.startsWith("push:"))
          ),
        );
      } finally {
        await r.cleanup();
      }
    },
  );
}
