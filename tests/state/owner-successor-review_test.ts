import assert from "node:assert/strict";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { installedSupersession } from "../host/owner-install-supersession-fixtures.ts";
import { driveOwnerTaskAcceptance } from "../host/owner-install-supersession-acceptance-fixtures.ts";

Deno.test("owner successor real Git journal refuses invented completion and immutable custody changes", async () => {
  const rig = await installedSupersession();
  try {
    const before = await rig.repair.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    assert.equal(
      Object.hasOwn(before.value.snapshot, "ownerSuccessorReviews"),
      false,
    );
    const { journal } = await driveOwnerTaskAcceptance(rig);
    const read = await rig.repair.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const candidate = parseRepairStateSnapshotV1({
      ...read.value.snapshot,
      stateHead: read.value.head,
      sequence: read.value.snapshot.sequence + 1,
      updatedAt: Date.now(),
      ownerSuccessorReviews: [...read.value.snapshot.ownerSuccessorReviews!, {
        ...journal,
        id: "invented-completed-owner-review",
      }],
    });
    const forged = await rig.repair.writeRepair(candidate, read.value.head);
    assert.equal(
      forged.ok,
      false,
      "a caller-built completed record must never be introduced as a new owner journal",
    );
    assert.deepEqual(await rig.repair.readRepair(), read);
    for (
      const change of [
        {
          ...journal,
          binding: { ...journal.binding, taskSha256: "0".repeat(64) },
        },
        { ...journal, resultSha256: "0".repeat(64) },
        {
          ...journal,
          phase: "running",
          readyExecution: null,
          result: null,
          resultSha256: null,
          close: null,
          reservation: {
            ...journal.reservation,
            outcome: "reserved",
            settledAt: null,
          },
        },
      ]
    ) {
      let refused = false;
      try {
        const next = parseRepairStateSnapshotV1({
          ...read.value.snapshot,
          stateHead: read.value.head,
          sequence: read.value.snapshot.sequence + 1,
          updatedAt: Date.now(),
          ownerSuccessorReviews: [change],
        });
        refused = !(await rig.repair.writeRepair(next, read.value.head)).ok;
      } catch {
        refused = true;
      }
      assert.equal(refused, true);
      assert.deepEqual(await rig.repair.readRepair(), read);
    }
  } finally {
    await rig.close();
  }
});
