/**
 * A repository cell's delta binds only the records it kept (issue #328). A
 * record it hands back belongs to the trusted path from then on: the trusted
 * pass may step it in the same run without making the cell's delta stale, and
 * finalize drops the handed-back record's stamp whatever the trusted pass did
 * with it. A delta sealed before this rule (bound to the whole delegated
 * scope, carrying the stamp drop as a transition) still applies exactly as
 * before while nothing in that scope moved.
 *
 * The REAL step loop and the REAL trusted writer over in-memory state and a
 * fake repository; no network, no model call.
 */
import assert from "node:assert/strict";
import {
  canonicalDigestV1,
  type RepairDeltaEnvelopeV1,
  repairProjectionDigestV1,
  sealRepairDeltaV1,
} from "../../src/contracts/repair-delta.ts";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { applyRepairDeltas } from "../../src/repair/repair-delta-apply.ts";
import {
  delegatedRecordsV1,
  planRepairFanoutV1,
  repairFanoutBindingV1,
  type RepairFanoutPlanV1,
} from "../../src/repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../../src/repair/repository-pass.ts";
import { queueRig } from "./delivery-queue-rig.ts";
import { captured, OLD_STAMP } from "./repository-pass-rig.ts";
import { MINUTE, sha } from "./review-round-cap-rig.ts";

type Rig = Awaited<ReturnType<typeof queueRig>>;

/**
 * Three published heads on a moved base, each with a settled stamp, and the
 * batched live read, so every settled step is stamped.
 */
async function line(): Promise<Rig> {
  const rig = await queueRig(3, {
    tip: sha(0x777),
    shape: (records) =>
      records.map((record) => ({ ...record, stepInputs: OLD_STAMP })),
  });
  const github = rig.github;
  (github as GitHubPort).readLiveInputs = (request) =>
    Promise.resolve(portOk({
      issues: request.issues.map((number) => ({
        number,
        state: "open" as const,
      })),
      pulls: request.pulls.map((number) => {
        const pr = github.pulls.get(number);
        return {
          number,
          pull: pr === undefined ? null : {
            number,
            state: pr.mergeSha === null ? "open" as const : "merged" as const,
            head: github.heads.get(pr.branch)!,
            base: github.remoteBase,
            baseRef: "development",
            checks: "success" as const,
            latestReview: null,
          },
        };
      }),
      branches: request.branches.map((branch) => ({
        branch,
        tip: github.remoteBase,
      })),
    }));
  return rig;
}

async function fanOut(rig: Rig, runId = 41) {
  const fanout = await planRepairFanoutV1({
    snapshot: await rig.snapshot(),
    head: rig.state.repairHead!,
    configs: rig.deps.configs,
    runId,
    runAttempt: 1,
  });
  assert.equal(fanout.cells.length, 1);
  const cell = fanout.cells[0];
  const { value: result } = await captured(async () =>
    runRepositoryRepairPass(rig.deps, {
      repository: cell.repository,
      binding: await repairFanoutBindingV1(fanout),
      records: cell.records,
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
    })
  );
  assert.equal(result.status, "sealed", JSON.stringify(result));
  const envelope = (result as { envelope: RepairDeltaEnvelopeV1 }).envelope;
  return { fanout, cell, envelope };
}

function apply(
  rig: Rig,
  fanout: RepairFanoutPlanV1,
  cellId: string,
  envelope: unknown,
) {
  return captured(() =>
    applyRepairDeltas(rig.deps, {
      plan: fanout,
      artifacts: [{ cellId, envelope }],
      deadline: rig.clock.now() + 10 * MINUTE,
    })
  );
}

/** The trusted serial pass stepping only what the cell handed back. */
function takeOver(rig: Rig, fanout: RepairFanoutPlanV1, back: string[]) {
  const exclude = delegatedRecordsV1(fanout);
  for (const id of back) exclude.delete(id);
  return captured(() =>
    runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
      excludeRecords: exclude,
    })
  );
}

async function row(rig: Rig, id: string): Promise<WorkRecordV1> {
  const found = (await rig.snapshot()).work.find((record) => record.id === id);
  assert.ok(found !== undefined, id);
  return found;
}

/** The delta's transitions of the records its cell kept. */
function kept(envelope: RepairDeltaEnvelopeV1) {
  const back = new Set(envelope.delta.deferredToTrusted);
  return envelope.delta.transitions.filter((row) => !back.has(row.after.id));
}

async function delegatedNext(rig: Rig): Promise<string[]> {
  const next = await planRepairFanoutV1({
    snapshot: await rig.snapshot(),
    head: rig.state.repairHead!,
    configs: rig.deps.configs,
    runId: 99,
    runAttempt: 1,
  });
  return [...delegatedRecordsV1(next)].sort();
}

Deno.test("hand-back: the trusted pass steps the handed-back front in the same run and the cell's delta still lands", async () => {
  const rig = await line();
  const { fanout, cell, envelope } = await fanOut(rig);
  const delta = envelope.delta;
  assert.deepEqual(delta.deferredToTrusted, ["issue-1"]);

  await takeOver(rig, fanout, delta.deferredToTrusted);
  assert.equal(rig.github.refreshes, 1, "the trusted pass refreshed it");
  const stepped = await row(rig, "issue-1");
  assert.notEqual(stepped.target.head, sha(0x101), "issue-1 moved");

  const { value: result } = await apply(rig, fanout, cell.cellId, envelope);
  assert.equal(result.status, "applied");
  assert.deepEqual(result.rejected, []);
  // Only the records the cell kept are bound: the held heads, restamped.
  assert.deepEqual(delta.transitions.map((row) => row.after.id), [
    "issue-2",
    "issue-3",
  ]);
  assert.deepEqual(result.applied, [{
    repository: cell.repository,
    transitions: 2,
  }]);
  for (const transition of delta.transitions) {
    assert.ok(transition.after.stepInputs !== undefined);
    assert.notDeepEqual(transition.after.stepInputs, OLD_STAMP);
    assert.deepEqual(await row(rig, transition.after.id), transition.after);
  }
  // The handed-back record keeps the trusted pass's row, without a stamp.
  const { stepInputs: _stamp, ...trusted } = stepped;
  assert.deepEqual(await row(rig, "issue-1"), trusted);
  assert.equal(result.handedBack, 1);
  assert.deepEqual(await delegatedNext(rig), ["issue-2", "issue-3"]);
});

Deno.test("hand-back: a delta bound to the whole delegated scope still lands while that scope is unchanged", async () => {
  const rig = await line();
  const { fanout, cell, envelope } = await fanOut(rig);
  const planned = await row(rig, "issue-1");
  const { stepInputs: _stamp, ...unstamped } = planned;
  // The shape an earlier cell sealed: the stamp drop as a transition, the
  // digest of the whole delegated scope.
  const legacy = await sealRepairDeltaV1({
    ...envelope.delta,
    baseDigest: await repairProjectionDigestV1(
      await rig.snapshot(),
      cell.repository,
      new Set(cell.records),
    ),
    transitions: [{
      before: await canonicalDigestV1(planned),
      after: unstamped as WorkRecordV1,
    }, ...kept(envelope)],
  });
  const { value: result } = await apply(rig, fanout, cell.cellId, legacy);
  assert.equal(result.status, "applied", JSON.stringify(result.rejected));
  assert.deepEqual(await row(rig, "issue-1"), unstamped);
  assert.deepEqual(await delegatedNext(rig), ["issue-2", "issue-3"]);

  // Bound to the whole scope, it is stale once the handed-back record moved.
  const again = await line();
  const second = await fanOut(again);
  const moved = await sealRepairDeltaV1({
    ...second.envelope.delta,
    baseDigest: await repairProjectionDigestV1(
      await again.snapshot(),
      second.cell.repository,
      new Set(second.cell.records),
    ),
  });
  await takeOver(again, second.fanout, ["issue-1"]);
  const { value: stale } = await apply(
    again,
    second.fanout,
    second.cell.cellId,
    moved,
  );
  assert.deepEqual(stale.rejected.map((entry) => entry.reason), [
    "base_moved",
  ]);
});

Deno.test("hand-back: a whole-scope delta's row of a handed-back record may only drop its stamp", async () => {
  // Each passes the shared transition rule; none is the stamp drop that an
  // earlier cell emitted for a hand-back.
  const shapes: [string, (planned: WorkRecordV1) => WorkRecordV1][] = [
    ["moved", (planned) => ({ ...planned, updatedAt: planned.updatedAt + 1 })],
    ["dropped and moved", (planned) => {
      const { stepInputs: _stamp, ...unstamped } = planned;
      return { ...unstamped, updatedAt: planned.updatedAt + 1 };
    }],
    ["restamped", (planned) => ({
      ...planned,
      stepInputs: { ...OLD_STAMP, deadline: OLD_STAMP.deadline + MINUTE },
    })],
  ];
  for (const [name, shape] of shapes) {
    const rig = await line();
    const { fanout, cell, envelope } = await fanOut(rig);
    const planned = await row(rig, "issue-1");
    const legacy = await sealRepairDeltaV1({
      ...envelope.delta,
      baseDigest: await repairProjectionDigestV1(
        await rig.snapshot(),
        cell.repository,
        new Set(cell.records),
      ),
      transitions: [{
        before: await canonicalDigestV1(planned),
        after: shape(planned),
      }, ...kept(envelope)],
    });
    const before = structuredClone(await rig.snapshot());
    const { value: result } = await apply(rig, fanout, cell.cellId, legacy);
    assert.deepEqual(
      result.rejected.map((entry) => entry.reason),
      ["transition_refused"],
      name,
    );
    for (const record of before.work) {
      const { stepInputs: _stamp, ...rest } = await row(rig, record.id);
      const { stepInputs: _planned, ...expected } = record;
      assert.deepEqual(rest, expected, name + ": only stamp hand-backs land");
    }
  }
});

Deno.test("hand-back: a delta that keeps and hands back one record is refused", async () => {
  const rig = await line();
  const { fanout, cell, envelope } = await fanOut(rig);
  const planned = await row(rig, "issue-1");
  const both = await sealRepairDeltaV1({
    ...envelope.delta,
    transitions: [{
      before: await canonicalDigestV1(planned),
      after: { ...planned, updatedAt: planned.updatedAt + 1 },
    }, ...kept(envelope)],
  });
  const before = structuredClone(await rig.snapshot());
  const { value: result } = await apply(rig, fanout, cell.cellId, both);
  assert.deepEqual(result.rejected.map((entry) => entry.reason), [
    "transition_refused",
  ]);
  for (const record of before.work) {
    const { stepInputs: _stamp, ...rest } = await row(rig, record.id);
    const { stepInputs: _planned, ...expected } = record;
    assert.deepEqual(rest, expected, "nothing but stamp hand-backs lands");
  }
});
