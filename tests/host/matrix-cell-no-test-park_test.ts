/**
 * Owner throughput t20 (#282): defensively, a matrix cell whose record was
 * deliberately parked for missing test evidence must settle a result artifact
 * (exit 0 with one carrier) instead of failing the job with carrier_count 0.
 */
import assert from "node:assert/strict";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { runActionsMatrixHost } from "../../src/host/matrix-actions.ts";
import {
  NO_CI_AND_NO_LOCAL_VERIFY_DETAIL,
} from "../../src/host/target-policy-generic.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import { MemoryState } from "../repair/helpers.ts";
import { workRecord } from "../state/helpers.ts";
import { issue, rig } from "./matrix-actions-fixtures.ts";

const REPOSITORY = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

Deno.test("matrix cell: an already-parked no-test-evidence record settles a result", async () => {
  const r = await rig();
  try {
    const memory = new MemoryState();
    const release = await r.store.readRelease();
    assert.ok(release.ok && release.value.status === "found");
    memory.setRelease(release.value.snapshot);
    const record = workRecord("issue-ubiquity-sentinel-1", {
      repository: REPOSITORY,
      source: { kind: "issue", id: "1", revision: r.sha },
      related: { incidentId: null, issueNumber: 1 },
      controller: { sha: r.sha },
      failingRevision: null,
      target: {
        base: r.sha,
        branch: "sentinel/repair/issue-ubiquity-sentinel-1",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const seeded = await memory.writeRepair(
      parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: r.clock.now(),
        incidents: [],
        evidence: [],
        work: [record],
        reservations: [],
        reviews: [],
        replays: [],
        releaseRequests: [],
        githubCooldowns: [],
        attemptMemory: [],
        lessons: [],
      }),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    r.github.get("ubiquity-sentinel/sentinel")!.listOpenIssues = () =>
      Promise.resolve(portOk([issue(1)]));
    r.github.get("ubiquity/ai.ubq.fi")!.listOpenIssues = () =>
      Promise.resolve(portOk([]));
    const planned = await runActionsMatrixHost({
      ...await r.job("no-evidence-cell-plan", "matrix_plan"),
      state: memory,
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("the planner cannot infer")),
      },
    });
    assert.ok("plan" in planned);
    assert.equal(planned.prepared, 1);
    const cell = planned.plan.cells[0]!;
    // A later admission (or an older plan) parks the exact record. The cell
    // must carry that transition as a settled non-start, not throw.
    const read = await memory.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const parked = await memory.writeRepair(
      parseRepairStateSnapshotV1({
        ...read.value.snapshot,
        stateHead: read.value.head,
        sequence: read.value.snapshot.sequence + 1,
        updatedAt: r.clock.now(),
        work: read.value.snapshot.work.map((row) =>
          row.id === cell.taskId
            ? markBlocked(
              row,
              "missing_evidence",
              NO_CI_AND_NO_LOCAL_VERIFY_DETAIL,
              r.clock.now(),
            )
            : row
        ),
      }),
      read.value.head,
    );
    assert.ok(parked.ok && parked.value.status === "applied");
    const deps = await r.job("no-evidence-cell", "matrix_cell");
    const artifactRoot = r.root + "/no-evidence-cell/.sentinel-matrix";
    await Deno.mkdir(artifactRoot);
    await Deno.writeTextFile(
      artifactRoot + "/plan.json",
      JSON.stringify(planned.plan),
    );
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((arg) => String(arg)).join(" "));
    };
    let result: Awaited<ReturnType<typeof runActionsMatrixHost>>;
    let modelCalls = 0;
    try {
      result = await runActionsMatrixHost({
        ...deps,
        state: memory,
        model: {
          modelId: "gpt-reserve",
          runModel: () => {
            modelCalls++;
            return Promise.reject(new Error("a parked cell cannot infer"));
          },
        },
        carrier: { planDigest: planned.planDigest, cellId: cell.cellId },
      });
    } finally {
      console.log = original;
    }
    assert.ok("cellId" in result);
    assert.equal(result.status, "not_started");
    assert.ok(result.detail?.startsWith("no_ci_and_no_local_verify"));
    assert.equal(modelCalls, 0);
    const carrier = lines.map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    }).find((line) => line?.kind === "sentinel_matrix_cell");
    assert.equal(carrier?.status, "not_started");
    assert.equal(carrier?.cellId, cell.cellId);
    const after = await memory.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    const still = after.value.snapshot.work.find((row) =>
      row.id === cell.taskId
    )!;
    assert.equal(still.nextStep, "blocked");
    assert.ok(still.blocker?.message.startsWith("no_ci_and_no_local_verify"));
  } finally {
    await r.cleanup();
  }
});
