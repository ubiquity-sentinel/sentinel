import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  RepairHistoryViewV1,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { readProtectedOriginalCandidates } from "../../ops/hosted-autonomy-original-candidate.ts";
import { originalCandidateRig } from "./hosted-autonomy-original-candidate-fixtures.ts";

async function inputFor(f: Awaited<ReturnType<typeof originalCandidateRig>>) {
  const read = await f.rig.store.readRepair();
  assert(read.ok && read.value.status === "found");
  return {
    snapshot: read.value.snapshot,
    expectedHead: read.value.head,
    records: [f.blocked],
    clock: f.rig.clock,
    deadlineAt: f.rig.clock.now() + 120000,
  };
}

Deno.test("original view: native pinned view and absent-capability legacy fallback verify final state", async () => {
  const f = await originalCandidateRig();
  try {
    const input = await inputFor(f);
    let legacy = 0, fresh = 0, closed = 0;
    const readRepair = () => {
      fresh++;
      return f.rig.store.readRepair();
    };
    const openRepairHistory = async (
      anchor: { expectedHead: typeof input.expectedHead },
    ) => {
      const opened = await f.rig.store.openRepairHistory!(anchor);
      assert(opened.ok);
      return portOk({
        readAt: opened.value.readAt,
        close: async () => {
          closed++;
          await opened.value.close();
        },
      });
    };
    const proofs = await readProtectedOriginalCandidates({
      ...input,
      state: {
        readRepair,
        openRepairHistory,
        readRepairAt: () => {
          legacy++;
          throw new Error("view failure must not fall back");
        },
      },
    });
    assert.equal(proofs.length, 1);
    assert.equal(closed, 1);
    assert.equal(legacy, 0);
    assert.equal(fresh, 1);
    const fallback = await readProtectedOriginalCandidates({
      ...input,
      state: {
        readRepair,
        readRepairAt: f.rig.store.readRepairAt!.bind(f.rig.store),
      },
    });
    assert.equal(fallback.length, 1);
    assert.equal(fresh, 2);
    assert.deepEqual(await f.rig.snapshot(), input.snapshot);
  } finally {
    await f.rig.ctx.cleanup();
  }
});

Deno.test("original view: failures, movement and final full-snapshot refusal never return proofs", async (test) => {
  for (
    const scenario of [
      "open-failure",
      "open-throw",
      "before-open",
      "during-walk",
      "after-walk",
      "final-unavailable",
      "snapshot-mismatch",
      "read-failure",
      "deadline",
      "close-failure",
    ] as const
  ) {
    await test.step(scenario, async () => {
      const f = await originalCandidateRig();
      let closed = 0, fallback = 0;
      try {
        const input = await inputFor(f);
        const move = async () => {
          const live = await f.rig.store.readRepair();
          assert(live.ok && live.value.status === "found");
          const written = await f.rig.store.writeRepair({
            ...live.value.snapshot,
            stateHead: live.value.head,
            sequence: live.value.snapshot.sequence + 1,
            updatedAt: f.rig.clock.now(),
          }, live.value.head);
          assert(written.ok && written.value.status === "applied");
        };
        const state: Partial<StateReadView> = {
          readRepairAt: () => {
            fallback++;
            throw new Error("explicit failure may not fall back");
          },
          readRepair: async () => {
            if (scenario === "final-unavailable") {
              return portError("unavailable", "fixture final refusal");
            }
            const live = await f.rig.store.readRepair();
            if (
              scenario === "snapshot-mismatch" && live.ok &&
              live.value.status === "found"
            ) {
              return portOk({
                ...live.value,
                snapshot: {
                  ...live.value.snapshot,
                  updatedAt: live.value.snapshot.updatedAt + 1,
                },
              });
            }
            return live;
          },
          openRepairHistory: async (anchor) => {
            if (scenario === "open-failure") {
              return portError("conflict", "fixture head changed");
            }
            if (scenario === "open-throw") {
              throw new Error("fixture opening failed");
            }
            if (scenario === "before-open") await move();
            const opened = await f.rig.store.openRepairHistory!(anchor);
            if (!opened.ok) return opened;
            const original = opened.value;
            const view: RepairHistoryViewV1 = {
              readAt: async (commit) => {
                if (scenario === "read-failure") {
                  return portError("unavailable", "fixture historical refusal");
                }
                const result = await original.readAt(commit);
                if (scenario === "during-walk") await move();
                return result;
              },
              close: async () => {
                closed++;
                await original.close();
                if (scenario === "after-walk") await move();
                if (scenario === "deadline") f.rig.clock.advance(120001);
                if (scenario === "close-failure") {
                  throw new Error("fixture close failed");
                }
              },
            };
            return portOk(view);
          },
        };
        assert.deepEqual(
          await readProtectedOriginalCandidates({ ...input, state }),
          [],
        );
        assert.equal(fallback, 0);
        assert.equal(
          closed,
          ["open-failure", "open-throw", "before-open"].includes(scenario)
            ? 0
            : 1,
        );
        assert.deepEqual(
          (await f.rig.snapshot()).reservations,
          input.snapshot.reservations,
        );
        assert.deepEqual((await f.rig.snapshot()).work[0], f.blocked);
      } finally {
        await f.rig.ctx.cleanup();
      }
    });
  }
});
