import assert from "node:assert/strict";
import { blockedRetryRig } from "./hosted-autonomy-blocked-implementation-fixtures.ts";

Deno.test("historical blocked implementation consumes its exact producer and rejects protected correction", async () => {
  const rig = await blockedRetryRig();
  try {
    const before = structuredClone(rig.state.snapshot);
    const outcome = await rig.run();
    assert.equal(outcome?.status, "applied");
    const after = rig.state.snapshot;
    assert.equal(after.reservations[0].outcome, "submitted");
    assert.notEqual(after.reservations[0].settledAt, null);
    assert.equal(
      after.work[0].blocker?.message,
      "candidate touches a protected path",
    );
    assert.equal(after.work[0].target.head, rig.candidate);
    assert.equal(
      after.work[0].target.candidateState?.publishedHead,
      rig.published,
    );
    assert.equal(after.work[0].target.pr, before.work[0].target.pr);
    assert.equal(after.work[0].intent, null);
    assert.deepEqual(
      rig.history[0].work[0].target.candidateState?.preserved,
      rig.original,
    );
    assert.equal(rig.imports(), 1);
    assert.deepEqual(rig.github.calls, []);
    const writes = rig.state.writes;
    assert.equal(await rig.run(), null);
    assert.equal(rig.state.writes, writes);
  } finally {
    await rig.cleanup();
  }
});

type Rig = Awaited<ReturnType<typeof blockedRetryRig>>;

async function interruptedAfterSettlement(rig: Rig) {
  const before = structuredClone(rig.state.snapshot.work[0]);
  rig.interruptCandidateWrites();
  try {
    await rig.run();
  } catch (error) {
    assert(error instanceof Error);
  }
  const charge = structuredClone(rig.state.snapshot.reservations[0]);
  assert.equal(charge.outcome, "submitted");
  assert.notEqual(charge.settledAt, null);
  assert.deepEqual(rig.state.snapshot.work[0], before);
  assert.equal(rig.imports(), 1);
  rig.resumeCandidateWrites();
  return charge;
}

Deno.test("historical blocked implementation resumes after durable submitted settlement", async () => {
  const rig = await blockedRetryRig();
  try {
    const charge = await interruptedAfterSettlement(rig);
    const pending = structuredClone(rig.state.snapshot.work[0]);
    rig.advanceClock(1000);
    assert.equal((await rig.run())?.status, "applied");
    const after = rig.state.snapshot;
    assert.deepEqual(after.reservations[0], charge);
    assert.equal(
      after.work[0].blocker?.message,
      "candidate touches a protected path",
    );
    assert.equal(after.work[0].target.head, rig.candidate);
    assert.equal(
      after.work[0].target.candidateState?.publishedHead,
      rig.published,
    );
    assert.deepEqual(after.work[0].source, pending.source);
    assert.deepEqual(after.work[0].controller, pending.controller);
    assert.equal(after.work[0].intent, null);
    assert.equal(rig.imports(), 2);
    assert.deepEqual(rig.github.calls, []);
    const writes = rig.state.writes;
    assert.equal(await rig.run(), null);
    assert.equal(rig.state.writes, writes);
    assert.deepEqual(rig.state.snapshot.reservations[0], charge);
  } finally {
    await rig.cleanup();
  }
});

const descriptor = (rig: Rig, key: string, value: string) => {
  const blocker = rig.state.snapshot.work[0].blocker!;
  blocker.message = blocker.message.replace(
    new RegExp("; " + key + "=[^;]+;"),
    "; " + key + "=" + value + ";",
  );
};

Deno.test("historical submitted retry refuses changed authenticated result without changing charge", async () => {
  const rig = await blockedRetryRig();
  try {
    const charge = await interruptedAfterSettlement(rig);
    descriptor(rig, "result", "0".repeat(64));
    const before = structuredClone(rig.state.snapshot);
    const writes = rig.state.writes;
    await assert.rejects(() => rig.run());
    assert.equal(rig.state.writes, writes);
    assert.equal(rig.imports(), 1);
    assert.deepEqual(rig.state.snapshot, before);
    assert.deepEqual(rig.state.snapshot.reservations[0], charge);
  } finally {
    await rig.cleanup();
  }
});

const controls: [string, (rig: Rig) => void][] = [
  ["malformed descriptor", (r) => {
    r.state.snapshot.work[0].blocker!.message += " altered";
  }],
  ["different producer", (r) => {
    r.state.snapshot.work[0].blocker!.message = r.state.snapshot.work[0]
      .blocker!.message.replace("producer=71:2", "producer=72:2");
  }],
  ["changed published predecessor", (r) => {
    r.state.snapshot.work[0].target.candidateState!.publishedHead = r.candidate;
  }],
  ["submitted charge without settlement", (r) => {
    r.state.snapshot.reservations[0].outcome = "submitted";
    r.state.snapshot.reservations[0].settledAt = null;
  }],
  ["reserved charge with settlement", (r) => {
    r.state.snapshot.reservations[0].settledAt = r.state.snapshot.updatedAt;
  }],
  ["ambiguous charge", (r) => {
    r.state.snapshot.reservations[0].outcome = "ambiguous";
    r.state.snapshot.reservations[0].settledAt = r.state.snapshot.updatedAt;
  }],
  ["submitted settlement before admission", (r) => {
    const charge = r.state.snapshot.reservations[0];
    charge.outcome = "submitted";
    charge.settledAt = charge.createdAt - 1;
  }],
  [
    "different artifact archive",
    (r) => descriptor(r, "archive", "sha256:" + "0".repeat(64)),
  ],
  ["different plan", (r) => descriptor(r, "plan", "0".repeat(64))],
  ["different planner", (r) => descriptor(r, "planner", "403")],
  ["different result", (r) => descriptor(r, "result", "0".repeat(64))],
  ["missing cell artifact", (r) => {
    r.f.artifacts.splice(r.f.artifacts.findIndex((a) => a.id === 502), 1);
  }],
  ["missing plan artifact", (r) => {
    r.f.artifacts.splice(r.f.artifacts.findIndex((a) => a.id === 501), 1);
  }],
  ["changed release custody", (r) => r.moveCustody()],
];

for (const [name, mutate] of controls) {
  Deno.test(
    "historical blocked implementation retains custody: " + name,
    async () => {
      const rig = await blockedRetryRig();
      try {
        mutate(rig);
        const before = structuredClone(rig.state.snapshot);
        try {
          await rig.run();
        } catch (error) {
          assert(error instanceof Error);
        }
        assert.equal(rig.state.writes, 0);
        assert.equal(rig.imports(), 0);
        assert.deepEqual(rig.state.snapshot, before);
        assert.deepEqual(rig.github.calls, []);
      } finally {
        await rig.cleanup();
      }
    },
  );
}
