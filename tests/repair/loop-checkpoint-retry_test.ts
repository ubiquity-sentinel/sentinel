/**
 * The loop's checkpoint shares the repair state store with the durable GitHub
 * cooldown gate, whose cooldown-only writes land from concurrent reviewer
 * requests. A checkpoint that loses its compare-and-swap to such a write is
 * recomputed on the fresh base; any other movement, an unchanged head or an
 * ambiguous outcome still fails closed with nothing applied.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { StateWriteResultV1 } from "../../src/contracts/ports-state.ts";
import type { PortResultV1 } from "../../src/contracts/ports.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { persistTransition } from "../../src/repair/loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import { FakeClock, MemoryState } from "./helpers.ts";

const COOLDOWN = {
  installationId: 0,
  retryNotBefore: T0 + 60_000,
  observedAt: T0,
  observationId: "a".repeat(64),
  secondaryBackoff: 0,
};

function seed(): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: [workRecord("issue-1")],
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

async function rig() {
  const state = new MemoryState();
  const seeded = await state.writeRepair(seed(), null);
  assert.ok(seeded.ok && seeded.value.status === "applied");
  const clock = new FakeClock(T0 + 10_000);
  const deps = { state, clock } as unknown as RepairCycleDepsV1;
  const context: LoopContextV1 = {
    snapshot: state.repair!,
    head: state.repairHead,
    bounds: { runDeadline: T0 + 3_600_000, modelCutoff: T0 + 3_600_000 },
    executionBaseline: null,
    legacyReviewCutoff: null,
  };
  return { state, clock, deps, context };
}

/**
 * Make the next write lose its compare-and-swap to an interloping write that
 * lands first: the store moves to `interloper`, and the loop's write is
 * answered `conflict` with that new head.
 */
function loseNextCas(
  state: MemoryState,
  interloper: (current: RepairStateSnapshotV1) => RepairStateSnapshotV1,
  movedHead: GitSha | null,
) {
  const original = state.writeRepair.bind(state);
  state.writeRepair = (
    next,
    expectedHead,
  ): Promise<PortResultV1<StateWriteResultV1>> => {
    state.writeRepair = original;
    state.repairWrites++;
    assert.equal(expectedHead, state.repairHead, "loop wrote its synced head");
    if (movedHead !== null) {
      state.repair = parseRepairStateSnapshotV1({
        ...interloper(state.repair!),
        stateHead: state.repairHead,
        sequence: state.repair!.sequence + 1,
      });
      state.repairHead = movedHead;
    }
    void next;
    return Promise.resolve(
      portOk({ status: "conflict", currentHead: state.repairHead }),
    );
  };
}

Deno.test("checkpoint: a CAS lost to a cooldown-only write is recomputed on the fresh base", async () => {
  const { state, deps, context } = await rig();
  loseNextCas(state, (current) => ({
    ...current,
    githubCooldowns: [COOLDOWN],
  }), SHA2);
  const result = await persistTransition(deps, context, (draft) => {
    draft.work = draft.work.map((record) => ({
      ...record,
      nextStep: "blocked",
      blocker: { kind: "other", message: "parked", since: T0 + 10_000 },
    }));
  });
  assert.deepEqual(result, { kind: "progress" });
  assert.equal(state.repairWrites, 3, "seed, lost CAS, recomputed write");
  assert.equal(state.repair!.work[0].nextStep, "blocked");
  assert.deepEqual(state.repair!.githubCooldowns, [COOLDOWN]);
  assert.equal(state.repair!.sequence, 3);
  assert.equal(context.head, state.repairHead);
  assert.equal(context.snapshot.work[0].nextStep, "blocked");
});

Deno.test("checkpoint: a CAS lost to a work movement fails closed without a replay", async () => {
  const { state, deps, context } = await rig();
  loseNextCas(state, (current) => ({
    ...current,
    work: current.work.map((record) => ({
      ...record,
      updatedAt: record.updatedAt + 1,
    })),
  }), SHA3);
  const result = await persistTransition(deps, context, (draft) => {
    draft.work = draft.work.map((record) => ({
      ...record,
      nextStep: "blocked",
      blocker: { kind: "other", message: "parked", since: T0 + 10_000 },
    }));
  });
  assert.deepEqual(result, {
    kind: "state_error",
    detail: "repair state moved with conflicting contents",
  });
  assert.equal(state.repairWrites, 2, "seed and the lost CAS only");
  assert.equal(state.repair!.work[0].nextStep, "work");
});

Deno.test("checkpoint: a refused write whose head did not move is never retried", async () => {
  const { state, deps, context } = await rig();
  state.conflictRepairNext = true;
  const result = await persistTransition(deps, context, (draft) => {
    draft.work = draft.work.map((record) => ({
      ...record,
      nextStep: "blocked",
      blocker: { kind: "other", message: "parked", since: T0 + 10_000 },
    }));
  });
  assert.deepEqual(result, {
    kind: "state_error",
    detail: "checkpoint CAS conflict or ambiguity",
  });
  assert.equal(state.repairWrites, 2);
  assert.equal(state.repair!.work[0].nextStep, "work");

  const ambiguous = await rig();
  ambiguous.state.ambiguousRepairNext = true;
  const outcome = await persistTransition(
    ambiguous.deps,
    ambiguous.context,
    (draft) => {
      draft.work = draft.work.map((record) => ({
        ...record,
        nextStep: "blocked",
        blocker: { kind: "other", message: "parked", since: T0 + 10_000 },
      }));
    },
  );
  assert.deepEqual(outcome, {
    kind: "state_error",
    detail: "checkpoint CAS conflict or ambiguity",
  });
  assert.equal(ambiguous.state.repairWrites, 2);
});

Deno.test("checkpoint: repeated cooldown-only losses stop after the bounded attempts", async () => {
  const { state, deps, context } = await rig();
  let losses = 0;
  const original = state.writeRepair.bind(state);
  state.writeRepair = (next, expectedHead) => {
    losses++;
    state.repairWrites++;
    state.repair = parseRepairStateSnapshotV1({
      ...state.repair!,
      stateHead: state.repairHead,
      sequence: state.repair!.sequence + 1,
      githubCooldowns: [{ ...COOLDOWN, observedAt: T0 + losses }],
    });
    state.repairHead = `${losses}`.padStart(40, "0") as GitSha;
    void next;
    void expectedHead;
    return Promise.resolve(
      portOk({ status: "conflict" as const, currentHead: state.repairHead }),
    );
  };
  const result = await persistTransition(deps, context, (draft) => {
    draft.work = draft.work.map((record) => ({
      ...record,
      nextStep: "review",
    }));
  });
  state.writeRepair = original;
  assert.deepEqual(result, {
    kind: "state_error",
    detail: "checkpoint CAS conflict or ambiguity",
  });
  assert.equal(losses, 3, "three bounded attempts, then fail closed");
  assert.equal(state.repair!.work[0].nextStep, "work");
});

Deno.test("checkpoint: a proof-bound CAS lost to a cooldown write defers at once (#206)", async () => {
  const { state, deps, context } = await rig();
  const proof = state.repairHead as GitSha;
  loseNextCas(state, (current) => ({
    ...current,
    githubCooldowns: [COOLDOWN],
  }), SHA2);
  let reads = 0;
  const read = state.readRepair.bind(state);
  state.readRepair = () => {
    reads++;
    return read();
  };
  const result = await persistTransition(deps, context, (draft) => {
    draft.work = draft.work.map((record) => ({
      ...record,
      nextStep: "blocked",
      blocker: { kind: "other", message: "parked", since: T0 + 10_000 },
    }));
  }, proof);
  assert.deepEqual(result, {
    kind: "deferred",
    detail: "state head moved after the trusted proof was established",
  });
  assert.equal(reads, 1, "no recomputation read after the lost CAS");
  assert.equal(state.repairWrites, 2, "seed and the one lost CAS only");
  assert.equal(state.repair!.work[0].nextStep, "work", "nothing applied");
});
