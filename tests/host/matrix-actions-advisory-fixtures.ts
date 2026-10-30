/** Shared capture and assertions for an initial matrix provenance advisory. */
import assert from "node:assert/strict";
import type { StateReadView } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";

export type AggregateRun = { status: string; logs: string[] };

export async function captureAggregateRun<T extends { status: string }>(
  run: () => Promise<T | null>,
): Promise<(T & { logs: string[] }) | null> {
  const originalLog = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
    originalLog(...args);
  };
  try {
    const result = await run();
    return result === null ? null : { ...result, logs };
  } finally {
    console.log = originalLog;
  }
}

export function assertInitialAdvisory(run: AggregateRun | null): void {
  assert.ok(run, "aggregate result missing");
  assert.equal(run.status, "ran", "the ordinary lifecycle must still run");
  const parsed = run.logs.map((line) => {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  });
  const advisories = parsed.filter((line) =>
    line?.kind === "sentinel_matrix_artifact_refused"
  );
  assert.equal(advisories.length, 1, "one advisory refusal per scan");
  const advisory = advisories[0]!;
  assert.equal(advisory.scan, "initial");
  assert.ok(
    typeof advisory.requests === "number" &&
      Number.isSafeInteger(advisory.requests) && advisory.requests > 0,
    "the refusal names the charged requests it did not ingest",
  );
  assert.ok(
    parsed.some((line) => line?.kind === "sentinel_targets_diagnostic"),
    "the ordinary lifecycle ran after the advisory refusal",
  );
}

export async function readFoundRepair(
  state: StateReadView,
): Promise<RepairStateSnapshotV1> {
  const read = await state.readRepair();
  assert.ok(
    read.ok && read.value.status === "found",
    "repair state unavailable",
  );
  return read.value.snapshot;
}
