/**
 * Issue #205: a settlement that loses its compare-and-swap to a
 * cooldown-only write (the shared cooldown gate writes through the same
 * store) is recomputed on the fresh head; any other movement still answers
 * `conflict`, so the caller fails closed.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { T0 } from "../state/helpers.ts";
import { FakeClock, MemoryRepairState, reserveRequest } from "./helpers.ts";
import { budget } from "./controller-fixtures.ts";

const COOLDOWN = {
  installationId: 0,
  retryNotBefore: T0 + 60_000,
  observedAt: T0,
  observationId: "a".repeat(64),
  secondaryBackoff: 0,
};

/** Land `interloper` just before the next `count` settlement writes. */
function interleave(
  state: MemoryRepairState,
  interloper: (current: RepairStateSnapshotV1) => RepairStateSnapshotV1,
  count = 1,
) {
  const original = state.writeRepair.bind(state);
  let left = count;
  state.writeRepair = async (next, expectedHead) => {
    if (left > 0) {
      left--;
      const { snapshot, head } = state.current();
      const landed = await original(
        parseRepairStateSnapshotV1({
          ...interloper(snapshot!),
          stateHead: head,
          sequence: snapshot!.sequence + 1,
        }),
        head,
      );
      assert.ok(landed.ok && landed.value.status === "applied");
    }
    return await original(next, expectedHead);
  };
}

async function reserved() {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const controller = budget(clock, state);
  const admitted = await controller.reserveModelStart(reserveRequest("task:s"));
  assert.equal(admitted.status, "admitted");
  if (admitted.status !== "admitted") throw new Error("unreachable");
  return { state, controller, id: admitted.reservation.id };
}

Deno.test("budget settlement: a CAS lost to a cooldown-only write is recomputed", async () => {
  const { state, controller, id } = await reserved();
  interleave(state, (current) => ({
    ...current,
    githubCooldowns: [COOLDOWN],
  }));
  const settled = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(settled.status, "settled", JSON.stringify(settled));
  const { snapshot, head } = state.current();
  assert.deepEqual(snapshot!.githubCooldowns, [COOLDOWN], "cooldown kept");
  assert.equal(snapshot!.reservations[0].outcome, "submitted");
  if (settled.status === "settled") assert.equal(settled.stateHead, head);
});

Deno.test("budget settlement: any other movement still answers conflict", async () => {
  const { state, controller, id } = await reserved();
  interleave(state, (current) => ({
    ...current,
    reservations: current.reservations.map((row) => ({
      ...row,
      outcome: "ambiguous" as const,
      settledAt: T0,
    })),
  }));
  const refused = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(refused.status, "conflict");
  assert.equal(
    state.current().snapshot!.reservations[0].outcome,
    "ambiguous",
    "nothing replayed over the other writer",
  );
});

Deno.test("budget settlement: repeated cooldown losses stop after the bounded attempts", async () => {
  const { state, controller, id } = await reserved();
  let n = 0;
  interleave(state, (current) => ({
    ...current,
    githubCooldowns: [{ ...COOLDOWN, retryNotBefore: T0 + 60_000 + ++n }],
  }), 3);
  const refused = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(refused.status, "conflict");
  assert.equal(state.current().snapshot!.reservations[0].outcome, "reserved");
});
