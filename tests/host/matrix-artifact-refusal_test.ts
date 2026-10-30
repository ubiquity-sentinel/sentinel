/**
 * A charged historical wave whose provenance cannot be authenticated is a
 * fail-closed uncertainty, not a reason to kill the ordinary run. Live
 * 2026-10-30 (run 41111979827): one generic provenance refusal in the initial
 * charged scan escaped as an uncaught error and the whole repair job died.
 * The affected reservations must stay charged and the lifecycle must run.
 */
import assert from "node:assert/strict";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import {
  MatrixArtifactUnavailableError,
  MatrixMissingCellArtifactError,
} from "../../src/host/matrix-artifact-port.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { rig } from "./matrix-actions-fixtures.ts";

const GENERIC_REFUSAL = "matrix artifact provenance unavailable or conflicting";

async function chargedAggregate(
  failure: Error,
  withCarrier = false,
): Promise<{
  result: Awaited<ReturnType<typeof runActionsRepairHost>>;
  scans: number;
  cycles: string[];
  charged: string[];
  outcomes: (string | undefined)[];
  logs: string[];
  custody: {
    before: Pick<RepairStateSnapshotV1, "reservations" | "work">;
    after: Pick<RepairStateSnapshotV1, "reservations" | "work">;
  };
}> {
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
    const before = await r.store.readRepair();
    if (!before.ok || before.value.status !== "found") {
      throw new Error("repair state before scan unavailable");
    }
    const custodyBefore = {
      reservations: before.value.snapshot.reservations,
      work: before.value.snapshot.work,
    };
    const cycles: string[] = [];
    const logs: string[] = [];
    const carrier = withCarrier
      ? { planDigest: planned.planDigest }
      : undefined;
    let scans = 0;
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
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
              return Promise.reject(failure);
            },
          },
          carrier,
          { pollWait: () => Promise.resolve() },
        ),
    }).finally(() => {
      console.log = originalLog;
    });
    const after = await r.store.readRepair();
    if (!after.ok || after.value.status !== "found") {
      throw new Error("repair state readback unavailable");
    }
    const reservations = after.value.snapshot.reservations;
    const outcomes = charged.map((id) =>
      reservations.find((row) => row.id === id)?.outcome
    );
    return {
      result,
      scans,
      cycles,
      charged,
      outcomes,
      logs,
      custody: {
        before: custodyBefore,
        after: {
          reservations: after.value.snapshot.reservations,
          work: after.value.snapshot.work,
        },
      },
    };
  } finally {
    await r.cleanup();
  }
}

Deno.test("matrix consumer: a generic provenance refusal of a charged historical wave is advisory", async () => {
  const { result, scans, cycles, charged, outcomes, logs, custody } =
    await chargedAggregate(new Error(GENERIC_REFUSAL));
  assert.equal(result.status, "ran", JSON.stringify(result));
  assert.equal(
    scans,
    1,
    "a refused historical scan is not retried in this run",
  );
  assert.deepEqual(
    cycles.sort(),
    ["ubiquity-sentinel/sentinel", "ubiquity/ai.ubq.fi"],
    "every target's ordinary cycle still runs",
  );
  assert.ok(charged.length > 0);
  const advisory = logs.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }).find((line) => line?.kind === "sentinel_matrix_artifact_refused");
  assert.deepEqual(advisory, {
    kind: "sentinel_matrix_artifact_refused",
    scan: "initial",
    requests: charged.length,
  });
  assert.deepEqual(
    outcomes,
    charged.map(() => "reserved"),
    "nothing from a refused scan is settled or refunded",
  );
  assert.deepEqual(
    custody.after.reservations,
    custody.before.reservations,
    "every charged reservation is byte-identical after the refused scan",
  );
  assert.deepEqual(
    custody.after.work,
    custody.before.work,
    "every work record is byte-identical after the refused scan",
  );
});

Deno.test("matrix consumer: a generic provenance refusal with a current-run carrier stays fatal", async () => {
  await assert.rejects(
    () => chargedAggregate(new Error(GENERIC_REFUSAL), true),
    /provenance unavailable or conflicting/,
    "a scan that authenticates this execution's own cells keeps its refusal fatal",
  );
});

Deno.test("matrix consumer: a missing authenticated cell artifact remains fatal", async () => {
  const failure = new MatrixMissingCellArtifactError(
    {} as never,
    {} as never,
  );
  await assert.rejects(
    () => chargedAggregate(failure),
    /provenance unavailable or conflicting/,
    "the typed missing-cell refusal keeps its existing behavior",
  );
});

Deno.test("matrix consumer: artifact API unavailability keeps its existing advisory behavior", async () => {
  const { result, scans } = await chargedAggregate(
    new MatrixArtifactUnavailableError(),
  );
  assert.equal(result.status, "ran", JSON.stringify(result));
  assert.equal(scans, 1);
});
