import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  MAX_REPAIR_DELTA_BYTES,
  parseSignedRepairDelta,
  type RepairDeltaPlanV1,
  signRepairDelta,
} from "../../src/contracts/signed-repair-delta.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  planRepairFanout,
  runRepairDeltaCell,
} from "../../src/host/repair-fanout.ts";
import {
  finalizeRepairDeltas,
  type RepairDeltaSubmissionV1,
} from "../../src/host/repair-finalize.ts";
import { OPERATION_MARGIN_MS } from "../../src/repair/loop-bounds.ts";
import {
  appliedHead,
  makeCtx,
  repairSnapshot,
  storeAt,
} from "../state/git-state-fixtures.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";

const A = { owner: "repair-fixtures", name: "alpha", installationId: 17 };
const B = { owner: "repair-fixtures", name: "beta", installationId: 18 };
const C = { owner: "repair-fixtures", name: "done", installationId: 19 };
const START = T0 + 2000;
const DEADLINE = START + 60 * 60_000;
const RUN = "repair-fixture:1";
const snapshot = () =>
  repairSnapshot({
    work: [
      workRecord("work:a", { repository: A }),
      workRecord("work:a2", { repository: A }),
      workRecord("work:b", { repository: B }),
      workRecord("work:done", { repository: C, nextStep: "done" }),
    ],
  });
const plans = (head = SHA1, state = snapshot()) =>
  planRepairFanout({
    runId: RUN,
    head,
    snapshot: state,
    repositories: [A, B, C, { ...C, name: "empty" }],
    runDeadline: DEADLINE,
  });
const waiting = (record: WorkRecordV1): WorkRecordV1 => ({
  ...record,
  updatedAt: START,
  wait: { reason: "unavailable", since: START, until: START + 60_000 },
});
const options = () => ({
  runId: RUN,
  runStartedAt: START,
  runDeadline: DEADLINE,
  clock: { now: () => START + 50 },
});

async function keyPair() {
  const keys = await crypto.subtle.generateKey("Ed25519", false, [
    "sign",
    "verify",
  ]);
  assert("privateKey" in keys);
  return keys;
}

async function signed(
  plan: RepairDeltaPlanV1,
  compute: Parameters<typeof runRepairDeltaCell>[0]["compute"] = (
    { records },
  ) => Promise.resolve(records.map(waiting)),
  clock = { now: () => START },
): Promise<RepairDeltaSubmissionV1> {
  const keys = await keyPair();
  const artifact = await runRepairDeltaCell({
    plan,
    clock,
    compute,
    sign: async (bytes) =>
      new Uint8Array(
        await crypto.subtle.sign("Ed25519", keys.privateKey, bytes),
      ),
  });
  return { plan, publicKey: keys.publicKey, artifact };
}

function memoryState(initial = snapshot(), initialHead = SHA1) {
  let current = initial;
  let head = initialHead;
  const writes: { next: RepairStateSnapshotV1; expected: GitSha | null }[] = [];
  return {
    writes,
    readRepair: () =>
      Promise.resolve({
        ok: true as const,
        value: { status: "found" as const, snapshot: current, head, ref: null },
      }),
    writeRepair: (
      next: RepairStateSnapshotV1,
      expected: GitSha | null,
    ) => {
      writes.push({ next, expected });
      current = next;
      head = SHA2;
      return Promise.resolve({
        ok: true as const,
        value: { status: "applied" as const, head },
      });
    },
  };
}

Deno.test("repair fanout: concurrent repository cells finalize together through real Git CAS", async () => {
  const ctx = await makeCtx("repair-fanout");
  try {
    const writer = storeAt(ctx, "trusted", "repair");
    const initial = snapshot();
    const head = appliedHead(await writer.writeRepair(initial, null));
    const planned = plans(head, initial);
    assert.equal(
      planned.length,
      2,
      "only repositories with live records get cells",
    );
    let time = START;
    const clock = { now: () => time };
    let entered = 0;
    let release!: () => void;
    const bothEntered = new Promise<void>((resolve) => release = resolve);
    const submissions = await Promise.all(
      planned.map((plan) =>
        signed(plan, async (input) => {
          assert.deepEqual(Object.keys(input).sort(), [
            "operationDeadline",
            "records",
            "repository",
            "runDeadline",
          ]);
          assert.equal(input.runDeadline, DEADLINE);
          assert.equal(input.operationDeadline, DEADLINE - OPERATION_MARGIN_MS);
          assert(input.records.every((record) =>
            record.repository.name === plan.repository.name
          ));
          if (++entered === 2) {
            release();
          }
          // If cells are accidentally serialized, fail rather than hang the suite.
          await Promise.race([
            bothEntered,
            new Promise<never>((_, reject) => {
              const timer = setTimeout(() =>
                reject(new Error("cells did not overlap")), 1000);
              bothEntered.then(() =>
                clearTimeout(timer)
              );
            }),
          ]);
          time = START + 40;
          return input.records.map((record) => ({
            ...waiting(record),
            intent: plan.repository.name === "beta"
              ? {
                kind: "issue_closure" as const,
                key: "planned-closure:b",
                startedAt: START,
                branch: null,
                expectedHead: null,
                observedBase: null,
                pr: null,
                requestId: null,
                resultId: null,
              }
              : null,
          }));
        }, clock)
      ),
    );
    assert.equal(entered, 2);
    let writes = 0;
    const result = await finalizeRepairDeltas({
      ...options(),
      clock,
      submissions,
      state: {
        readRepair: () => {
          time += 4;
          return writer.readRepair();
        },
        writeRepair: (next, expected) => {
          writes++;
          assert.equal(expected, head);
          time += 6;
          return writer.writeRepair(next, expected);
        },
      },
    });
    assert.deepEqual(result.deltas.map((delta) => delta.status), [
      "applied",
      "applied",
    ]);
    assert.equal(
      writes,
      1,
      "all same-head siblings must share one atomic write",
    );
    assert.deepEqual(result.metrics, {
      repositories: 2,
      applied: 2,
      rejected: 0,
      maxRepositoryMs: 40,
      finalizeMs: 10,
      wallMs: 50,
    });
    const read = await storeAt(ctx, "fresh-reader", "repair").readRepair();
    assert(read.ok && read.value.status === "found");
    assert.equal(read.value.head, result.head);
    assert.equal(read.value.snapshot.sequence, 2);
    assert(
      read.value.snapshot.work.slice(0, 3).every((record) =>
        record.wait?.reason === "unavailable"
      ),
    );
    assert.equal(read.value.snapshot.work[2].intent?.kind, "issue_closure");
    assert.deepEqual(read.value.snapshot.work[3], initial.work[3]);
    assert.deepEqual(read.value.snapshot.reservations, initial.reservations);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("repair fanout: moved state head rejects the entire delta without partial writes", async () => {
  const ctx = await makeCtx("repair-stale");
  try {
    const writer = storeAt(ctx, "trusted", "repair");
    const initial = snapshot();
    const head = appliedHead(await writer.writeRepair(initial, null));
    const submission = await signed(plans(head, initial)[0]);
    const moved = {
      ...initial,
      stateHead: head,
      sequence: 2,
      updatedAt: START,
    };
    const movedHead = appliedHead(await writer.writeRepair(moved, head));
    let writes = 0;
    const result = await finalizeRepairDeltas({
      ...options(),
      submissions: [submission],
      state: {
        readRepair: () => writer.readRepair(),
        writeRepair: () => {
          writes++;
          throw new Error("stale delta reached writer");
        },
      },
    });
    assert.equal(writes, 0);
    assert.equal(result.head, movedHead);
    assert.equal(result.deltas[0].status, "stale");
    const read = await writer.readRepair();
    assert(read.ok && read.value.status === "found");
    assert.deepEqual(
      read.value.snapshot,
      moved,
      "neither of the stale repository's records may change",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("repair fanout: tampering, wrong signing key, scope, run and unknown fields fail closed", async () => {
  const [a, b] = plans();
  const valid = await signed(a);
  const other = await signed(b);
  const changedWire = JSON.parse(valid.artifact!);
  changedWire.delta.changes[0].wait.until++;
  const cases: RepairDeltaSubmissionV1[] = [
    { ...valid, artifact: JSON.stringify(changedWire) },
    { ...valid, publicKey: other.publicKey },
    { ...valid, plan: { ...a, repository: B } },
    { ...valid, plan: { ...a, runId: "other-run" } },
    {
      ...valid,
      artifact: JSON.stringify({ ...JSON.parse(valid.artifact!), extra: true }),
    },
  ];
  for (const submission of cases) {
    const state = memoryState();
    const result = await finalizeRepairDeltas({
      ...options(),
      state,
      submissions: [submission],
    });
    assert.equal(result.deltas[0].status, "invalid");
    assert.equal(state.writes.length, 0);
  }
  const state = memoryState();
  const duplicate = await finalizeRepairDeltas({
    ...options(),
    state,
    submissions: [valid, valid],
  });
  assert.deepEqual(duplicate.deltas.map((delta) => delta.status), [
    "invalid",
    "invalid",
  ]);
  assert.equal(state.writes.length, 0);
});

Deno.test("repair fanout: correctly signed foreign records and admissions are rejected", async () => {
  const [a, b] = plans();
  const valid = await signed(a);
  const parsed = parseSignedRepairDelta(valid.artifact!);
  const keys = await keyPair();
  const sign = async (bytes: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, bytes));
  const original = a.records[0];
  const invalidChanges = [
    [waiting(b.records[0])],
    [workRecord("work:invented", { repository: A })],
    [{ ...waiting(original), counters: { ...original.counters, attempts: 1 } }],
    [{
      ...waiting(original),
      source: { ...original.source, id: "different-source" },
    }],
    [waiting(original), { ...waiting(original), id: b.records[0].id }],
  ];
  for (const changes of invalidChanges) {
    const artifact = await signRepairDelta({ ...parsed.delta, changes }, sign);
    const state = memoryState();
    const result = await finalizeRepairDeltas({
      ...options(),
      state,
      submissions: [{ plan: a, publicKey: keys.publicKey, artifact }],
    });
    assert.equal(result.deltas[0].status, "invalid");
    assert.equal(
      state.writes.length,
      0,
      "valid first record cannot leak out of an invalid delta",
    );
  }
  await assert.rejects(() =>
    signed(a, () => Promise.resolve([waiting(b.records[0])]))
  );
});

Deno.test("repair fanout: wire bounds and duplicate records are enforced before application", async () => {
  assert.throws(
    () => parseSignedRepairDelta(" ".repeat(MAX_REPAIR_DELTA_BYTES + 1)),
    /artifact bound/,
  );
  // UTF-8 bytes, not UTF-16 code units.
  assert.throws(
    () => parseSignedRepairDelta("é".repeat(MAX_REPAIR_DELTA_BYTES / 2 + 1)),
    /artifact bound/,
  );
  const [a] = plans();
  const valid = await signed(a);
  const duplicate = JSON.parse(valid.artifact!);
  duplicate.delta.changes.push(duplicate.delta.changes[0]);
  assert.throws(
    () => parseSignedRepairDelta(JSON.stringify(duplicate)),
    /duplicate/,
  );
});

Deno.test("repair fanout: shared deadline keeps the five-minute margin in cells and finalize", async () => {
  const [a] = plans();
  const lateClock = { now: () => DEADLINE - OPERATION_MARGIN_MS };
  let computes = 0;
  await assert.rejects(() =>
    signed(a, () => {
      computes++;
      return Promise.resolve([]);
    }, lateClock), /margin/);
  assert.equal(computes, 0);
  let now = START;
  await assert.rejects(() =>
    signed(a, () => {
      now = DEADLINE - OPERATION_MARGIN_MS;
      return Promise.resolve([]);
    }, { now: () => now }), /deadline/);
  const submission = await signed(a);
  const state = memoryState();
  const result = await finalizeRepairDeltas({
    ...options(),
    clock: lateClock,
    state,
    submissions: [submission],
  });
  assert.equal(result.deltas[0].status, "deadline");
  assert.equal(state.writes.length, 0);
});

Deno.test("repair fanout: CAS conflict/ambiguity never rebases or retries sibling deltas", async () => {
  const submissions = await Promise.all(plans().map((plan) => signed(plan)));
  for (const status of ["conflict", "ambiguous"] as const) {
    const state = memoryState();
    let writes = 0;
    const result = await finalizeRepairDeltas({
      ...options(),
      submissions,
      state: {
        readRepair: state.readRepair,
        writeRepair: (_, expected) => {
          writes++;
          assert.equal(expected, SHA1);
          return Promise.resolve({
            ok: true as const,
            value: { status, currentHead: SHA2 },
          });
        },
      },
    });
    assert.equal(writes, 1);
    assert.deepEqual(result.deltas.map((delta) => delta.status), [
      status,
      status,
    ]);
    assert.equal(state.writes.length, 0);
  }
});

Deno.test("repair fanout: no-op deltas avoid writes and stale siblings do not suppress fresh ones", async () => {
  const [a, b] = plans();
  const noop = await signed(a, ({ records }) => Promise.resolve([...records]));
  const state = memoryState();
  const result = await finalizeRepairDeltas({
    ...options(),
    state,
    submissions: [noop],
  });
  assert.equal(result.deltas[0].status, "noop");
  assert.equal(state.writes.length, 0);
  const stale = await signed({ ...a, baseHead: SHA2 });
  const fresh = await signed(b);
  const mixed = await finalizeRepairDeltas({
    ...options(),
    state,
    submissions: [stale, fresh],
  });
  assert.deepEqual(mixed.deltas.map((delta) => delta.status), [
    "stale",
    "applied",
  ]);
  assert.equal(state.writes.length, 1);
  assert.deepEqual(state.writes[0].next.work[0], snapshot().work[0]);
  assert.equal(state.writes[0].next.work[2].wait?.reason, "unavailable");
});

Deno.test("repair fanout: real Git head moving after validation rejects both siblings atomically", async () => {
  const ctx = await makeCtx("repair-cas-race");
  try {
    const writer = storeAt(ctx, "trusted", "repair");
    const racer = storeAt(ctx, "racer", "repair");
    const initial = snapshot();
    const head = appliedHead(await writer.writeRepair(initial, null));
    const submissions = await Promise.all(
      plans(head, initial).map((plan) => signed(plan)),
    );
    const moved = {
      ...initial,
      stateHead: head,
      sequence: 2,
      updatedAt: START,
    };
    let writes = 0;
    let movedHead = head;
    const result = await finalizeRepairDeltas({
      ...options(),
      submissions,
      state: {
        readRepair: () => writer.readRepair(),
        writeRepair: async (next, expected) => {
          writes++;
          movedHead = appliedHead(await racer.writeRepair(moved, head));
          return writer.writeRepair(next, expected);
        },
      },
    });
    assert.equal(writes, 1);
    assert.deepEqual(result.deltas.map((delta) => delta.status), [
      "conflict",
      "conflict",
    ]);
    const read = await writer.readRepair();
    assert(read.ok && read.value.status === "found");
    assert.equal(read.value.head, movedHead);
    assert.deepEqual(read.value.snapshot, moved);
  } finally {
    await ctx.cleanup();
  }
});
