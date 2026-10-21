/** Real fresh intake and overlapping isolated Git/model cells; no test registrations. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { MatrixCellResultV1 } from "../../src/contracts/matrix.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import {
  checked,
  issue,
  PROVIDER,
  type rig,
} from "./matrix-actions-fixtures.ts";

export async function runFreshMatrixCells(
  r: Awaited<ReturnType<typeof rig>>,
  noStart17: boolean,
) {
  if (noStart17) {
    for (
      const [slug, count] of [["Ubiquity-Sentinel/sentinel", 9], [
        "ubiquity/ai.ubq.fi",
        8,
      ]] as const
    ) {
      const rows = Array.from(
        { length: count },
        (_, index) => issue(index + 1),
      );
      const port = r.github.get(slug)!;
      port.listOpenIssues = () => Promise.resolve(portOk(rows));
      port.readIssue = (number) => {
        r.clock.advance(100);
        return Promise.resolve(portOk(rows[number - 1] ?? null));
      };
    }
    const write = r.store.writeRepair.bind(r.store);
    r.store.writeRepair = async (snapshot, expected) => {
      const result = await write(snapshot, expected);
      r.clock.advance(1000);
      return result;
    };
  }
  const initialPlanTime = r.clock.now();
  const expectedCells = noStart17 ? 17 : 2;
  let modelCalls = 0, active = 0, peak = 0;
  let unblock: () => void = () => {};
  const overlap = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const planner = await runActionsMatrixHost({
    ...await r.job("plan", "matrix_plan"),
    ...(noStart17 ? { state: r.store } : {}),
    model: {
      modelId: "gpt-reserve",
      runModel: () => {
        throw Error("planner must not run a model");
      },
    },
  });
  assert.ok("plan" in planner);
  assert.equal(
    planner.prepared,
    expectedCells,
    "fresh unseeded issues must reach actual matrix admission",
  );
  assert.equal(
    new Set(planner.plan.cells.map((cell) => cell.repository.name)).size,
    2,
  );
  const results: MatrixCellResultV1[] = [];
  const archive = r.root + "/archive";
  await Deno.mkdir(archive);
  // The planner phase's artificial age (per-read and per-write clock advances
  // above) stays in the frozen plannedAt and admission timestamps. It is NOT
  // carried into the cell phase: every cell is anchored at its own trusted
  // run origin with its own fresh bounded start window.
  for (const cell of planner.plan.cells) {
    await Deno.mkdir(r.root + "/cell-" + cell.cellId);
  }
  const settledCells = await Promise.allSettled(
    planner.plan.cells.map(async (cell) => {
      const name = "cell-" + cell.cellId;
      const deps = await r.job(name, "matrix_cell");
      const artifactRoot = r.root + "/" + name + "/.sentinel-matrix";
      await Deno.mkdir(artifactRoot);
      await Deno.writeTextFile(
        artifactRoot + "/plan.json",
        JSON.stringify(planner.plan),
      );
      const model: ImplementationPort = {
        modelId: "gpt-reserve",
        runModel: async (request: ModelRunRequestV1) => {
          modelCalls++;
          active++;
          peak = Math.max(peak, active);
          if (active === 2) unblock();
          await overlap;
          const source = deps.workDir + "/.sentinel-actions-state/" +
            (request.repository.name === "sentinel"
              ? "source"
              : "sources/ubiquity-ai.ubq.fi");
          await Deno.writeTextFile(
            source + "/repair.txt",
            request.repository.name,
          );
          await checked(source, ["add", "repair.txt"], r.env);
          await checked(source, ["commit", "-q", "-m", "repair"], r.env);
          const head = await checked(
            source,
            ["rev-parse", "HEAD"],
            r.env,
          ) as GitSha;
          active--;
          const receipt: ModelRunReceiptV1 = {
            invocationId: "invocation-" + cell.cellId,
            outcome: "completed",
            actual: {
              evidenceKind: "request-runtime",
              provider: PROVIDER,
              threadId: "thread-" + cell.cellId,
              turnId: "turn-" + cell.cellId,
              terminalOrigin: "runtime",
              observedTerminalStatus: "completed",
              observedModel: request.model,
              observedReasoning: "max",
              durationMs: 1,
              outputChars: 1,
            },
            candidate: {
              head,
              checkpointSha: null,
              changedPaths: ["repair.txt"],
            },
            error: null,
          };
          return portOk(receipt);
        },
      };
      const result = await runActionsMatrixHost({
        ...deps,
        // One shared repair transport for the clock scenario: the planner,
        // every cell, the budget and the aggregate all read and write the
        // same narrowed repair state; target Git and release stay real.
        ...(noStart17 ? { state: r.store } : {}),
        model,
        carrier: { planDigest: planner.planDigest, cellId: cell.cellId },
      });
      assert.ok("cellId" in result);
      results.push(result);
      // The planner phase deliberately advanced the clock through the per-read
      // and per-write fakes, so each admission (and the frozen plannedAt) is
      // authentic. The cell phase inherits no artificial wave age: every cell
      // gets its own fresh bounded start window and completes with a real
      // receipt and bundle.
      assert.equal(result.status, "completed");
      assert.ok(result.receipt);
      assert.ok(result.bundle);
      await Deno.copyFile(
        artifactRoot + "/" + result.bundle.file,
        archive + "/" + result.bundle.file,
      );
      await Deno.remove(r.root + "/" + name, { recursive: true });
      return result;
    }),
  );
  // Every cell promise is settled before any failure is reported or cleanup
  // runs: no live artifact writer is left behind, and the first real body
  // failure is retained instead of being replaced by a cleanup race.
  const firstCellFailure = settledCells.find((entry) =>
    entry.status === "rejected"
  );
  if (
    firstCellFailure !== undefined && firstCellFailure.status === "rejected"
  ) {
    throw firstCellFailure.reason;
  }
  assert.equal(
    modelCalls,
    expectedCells,
    "every admitted cell starts exactly one isolated model",
  );
  if (noStart17) {
    assert.ok(
      peak >= 2,
      "isolated cells overlap under the advanced planner clock",
    );
  } else {
    assert.equal(peak, 2);
  }

  return {
    initialPlanTime,
    expectedCells,
    planner,
    results,
    archive,
    get modelCalls() {
      return modelCalls;
    },
  };
}
