/**
 * The expected outcome of the modern scenario's "protected-refusal" case
 * (`hosted-autonomy-modern-scenario.ts`); this module registers no tests.
 */
import assert from "node:assert/strict";
import type {
  PortResultV1,
  StateReadResultV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { CANDIDATE_PROTECTED_BLOCKER } from "../../ops/hosted-autonomy-blocked-candidate.ts";
import type { HostedAutonomyResultV1 } from "../../ops/hosted-autonomy.ts";
import { ENV } from "./hosted-autonomy-fixtures.ts";
import { gitRun } from "../state/helpers.ts";

type RepairRead = PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>;

/**
 * The real walk over a parked candidate whose exact head edits a protected
 * path: the trusted preserver refuses it before any push, its deterministic
 * preservation ref reads back absent, and the pass records the runtime's own
 * terminal protected-path block for that one record and reports it. The
 * target, head and descriptor are kept, every charge is byte-identical, no
 * preservation ref appears, and a second pass has nothing left to restore.
 */
export async function expectProtectedRefusal(
  result: unknown,
  before: RepairRead,
  after: RepairRead,
  targetWork: string,
  rerun: () => Promise<HostedAutonomyResultV1>,
  read: () => Promise<RepairRead>,
): Promise<void> {
  assert(before.ok && before.value.status === "found");
  assert(after.ok && after.value.status === "found");
  assert.deepEqual((result as HostedAutonomyResultV1).actions, [
    "current-matrix:ingested:0",
    "current-matrix:preservation-protected:1",
  ]);
  const at = after.value.snapshot.updatedAt;
  const parked = before.value.snapshot.work.filter((row) =>
    row.intent?.kind === "candidate_preservation"
  );
  assert.equal(parked.length, 1);
  assert.deepEqual(
    after.value.snapshot.work,
    before.value.snapshot.work.map((row) =>
      row.id !== parked[0].id ? row : {
        ...row,
        blocker: {
          kind: "other",
          message: CANDIDATE_PROTECTED_BLOCKER,
          since: at,
        },
        intent: null,
        updatedAt: at,
      }
    ),
  );
  assert.deepEqual(
    after.value.snapshot.reservations,
    before.value.snapshot.reservations,
  );
  const ref = await gitRun(targetWork, [
    "rev-parse",
    "--verify",
    parked[0].intent!.branch!,
  ], ENV);
  assert.equal(ref.ok, false, "a refused candidate is never pushed");
  await rerun();
  assert.deepEqual(await read(), after, "nothing is left to restore");
}
