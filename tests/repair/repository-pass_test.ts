/**
 * Fan-out repository passes and the single trusted writer (issue #328).
 *
 * Each case runs the ACTUAL step loop per repository against one shared
 * in-memory state (concurrently, never writing it), then applies the sealed
 * deltas through the existing repair-state writer. No network, no model
 * call, no real waiting.
 */
import assert from "node:assert/strict";
import {
  canonicalDigestV1,
  REPAIR_DELTA_ENVELOPE_KIND,
  type RepairDeltaEnvelopeV1,
  sealRepairDeltaV1,
} from "../../src/contracts/repair-delta.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  FANOUT_SUMMARY_LINE_KIND,
  parseFanoutSummaryLine,
} from "../../src/repair/fanout-summary-line.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { PASS_SUMMARY_LINE_KIND } from "../../src/repair/pass-summary-line.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { applyRepairDeltas } from "../../src/repair/repair-delta-apply.ts";
import {
  delegatedRecordsV1,
  repairFanoutMatrixV1,
  type RepairFanoutPlanV1,
} from "../../src/repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../../src/repair/repository-pass.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import {
  captured,
  makeRig,
  MINUTE,
  pendingArtifact,
  plan,
  REPOS,
  reviewing,
  type Rig,
} from "./repository-pass-rig.ts";

const [ALPHA, BETA, GAMMA] = REPOS;

/** Delegable reviews in alpha and beta, one matrix-owned alpha record. */
function fleet(): WorkRecordV1[] {
  return [
    ...[0, 1, 2].map((index) => reviewing(ALPHA, index)),
    pendingArtifact(ALPHA, 9),
    ...[100, 101].map((index) => reviewing(BETA, index)),
    reviewing(GAMMA, 200, { nextStep: "done" }),
  ];
}

/** Every planned repository cell, started together. */
async function fanOut(rig: Rig) {
  const { plan: fanout, binding } = await plan(rig);
  const { value: results } = await captured(() =>
    Promise.all(
      fanout.cells.map((cell) =>
        runRepositoryRepairPass(rig.deps, {
          repository: cell.repository,
          binding,
          records: cell.records,
          deadline: rig.clock.now() + 90 * MINUTE,
          stepLimit: 1_000,
          modelStartsEnabled: true,
        })
      ),
    )
  );
  const envelopes = results.map((result) => {
    assert.equal(result.status, "sealed", JSON.stringify(result));
    return (result as { envelope: RepairDeltaEnvelopeV1 }).envelope;
  });
  return { fanout, binding, envelopes };
}

/** A correctly sealed envelope around an arbitrary (malformed) body. */
async function sealRawDelta(delta: unknown): Promise<unknown> {
  return {
    version: "v1",
    kind: REPAIR_DELTA_ENVELOPE_KIND,
    delta,
    digest: await canonicalDigestV1({
      kind: REPAIR_DELTA_ENVELOPE_KIND,
      delta,
    }),
  };
}

/** The plan cell of `name`, and every envelope as its own cell's artifact. */
function cellOf(fanout: RepairFanoutPlanV1, name: string) {
  const cell = fanout.cells.find((entry) => entry.repository.name === name);
  assert.ok(cell !== undefined, name);
  return cell;
}

function artifacts(fanout: RepairFanoutPlanV1, list: unknown[]) {
  return list.map((envelope) => ({
    cellId: cellOf(
      fanout,
      (envelope as RepairDeltaEnvelopeV1).delta.repository.name,
    ).cellId,
    envelope: structuredClone(envelope),
  }));
}

/** A record without its advisory #326 step stamp. */
function unstamped(record: WorkRecordV1): WorkRecordV1 {
  const { stepInputs: _stamp, ...rest } = record;
  return rest as WorkRecordV1;
}

function row(rig: Rig, id: string): WorkRecordV1 {
  const found = rig.state.repair!.work.find((record) => record.id === id);
  assert.ok(found !== undefined, id);
  return found;
}

function apply(
  rig: Rig,
  fanout: RepairFanoutPlanV1,
  list: { cellId: string; envelope: unknown }[],
  deadline = rig.clock.now() + 10 * MINUTE,
) {
  return captured(() =>
    applyRepairDeltas(rig.deps, { plan: fanout, artifacts: list, deadline })
  );
}

Deno.test("fan-out: two repositories step their delegated records concurrently and the trusted writer applies both in one write", async () => {
  const rig = makeRig(fleet());
  const { fanout, envelopes } = await fanOut(rig);
  // Done and matrix-owned records are never delegated.
  assert.deepEqual(
    fanout.cells.map((cell) => [cell.repository.name, cell.records]),
    [["alpha", ["issue-alpha-0", "issue-alpha-1", "issue-alpha-2"]], [
      "beta",
      ["issue-beta-100", "issue-beta-101"],
    ]].sort((left, right) =>
      fanout.cells.findIndex((cell) => cell.repository.name === left[0]) -
      fanout.cells.findIndex((cell) => cell.repository.name === right[0])
    ),
  );
  assert.equal(repairFanoutMatrixV1(fanout).include.length, 2);
  // The passes wrote nothing shared and performed no GitHub effect.
  assert.equal(rig.state.repairWrites, 0);
  assert.equal(rig.state.repairHead, SHA1);
  assert.deepEqual(rig.github.effects(), []);
  const alpha = envelopes.find((e) => e.delta.repository.name === "alpha")!
    .delta;
  const beta = envelopes.find((e) => e.delta.repository.name === "beta")!
    .delta;
  assert.equal(alpha.baseHead, SHA1);
  assert.deepEqual(alpha.transitions.map((t) => t.after.id), [
    "issue-alpha-0",
    "issue-alpha-1",
    "issue-alpha-2",
  ]);
  assert.deepEqual(beta.transitions.map((t) => t.after.id), [
    "issue-beta-100",
    "issue-beta-101",
  ]);
  for (const delta of [alpha, beta]) {
    assert.deepEqual(delta.deferredToTrusted, []);
    for (const transition of delta.transitions) {
      assert.equal(transition.after.wait?.reason, "review_pending");
    }
  }

  const { value: applied, lines } = await apply(
    rig,
    fanout,
    artifacts(fanout, envelopes),
  );
  assert.equal(applied.status, "applied");
  assert.deepEqual(applied.rejected, []);
  assert.equal(rig.state.repairWrites, 1, "one trusted write for both");
  for (const transition of [...alpha.transitions, ...beta.transitions]) {
    assert.deepEqual(row(rig, transition.after.id), transition.after);
  }
  // The matrix-owned record was not touched by its repository's cell.
  assert.deepEqual(row(rig, "issue-alpha-9"), pendingArtifact(ALPHA, 9));
  const summary = lines.filter((line) =>
    line.kind === FANOUT_SUMMARY_LINE_KIND
  );
  assert.equal(summary.length, 1);
  const parsed = parseFanoutSummaryLine(summary[0]);
  assert.ok(parsed !== null);
  assert.equal(parsed.deltasApplied, 2);
  assert.equal(parsed.transitionsApplied, 5);
  assert.equal(parsed.repositoryWallMs.length, 2);
});

Deno.test("fan-out: the serial pass never steps a delegated record", async () => {
  const rig = makeRig(fleet());
  const { plan: fanout } = await plan(rig);
  const { lines } = await captured(() =>
    runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
      excludeRecords: delegatedRecordsV1(fanout),
    })
  );
  const stepped = lines.filter((line) => line.kind === STEP_LINE_KIND)
    .map((line) => line.recordId);
  assert.deepEqual(stepped, ["issue-alpha-9"]);
  const pass = lines.find((line) => line.kind === PASS_SUMMARY_LINE_KIND);
  assert.equal(pass?.recordsStepped, 1);
});

Deno.test("fan-out: a delta whose delegated base moved is rejected whole while the other applies", async () => {
  const rig = makeRig(fleet());
  const { fanout, envelopes } = await fanOut(rig);
  // Another trusted writer moves the NON-delegated alpha record: alpha's
  // delegated projection is unchanged, so both deltas still apply.
  const write = async (id: string) => {
    const work = rig.state.repair!.work.map((record) =>
      record.id === id ? { ...record, updatedAt: record.updatedAt + 1 } : record
    );
    const written = await rig.state.writeRepair(
      { ...rig.state.repair!, sequence: rig.state.repair!.sequence + 1, work },
      rig.state.repairHead,
    );
    assert.ok(written.ok && written.value.status === "applied");
  };
  await write("issue-alpha-9");
  await write("issue-gamma-200");
  const { value: both } = await apply(
    rig,
    fanout,
    artifacts(fanout, envelopes),
  );
  assert.equal(both.applied.length, 2, JSON.stringify(both.rejected));

  // A fresh fan-out, then the serial writer moves one DELEGATED alpha record.
  rig.clock.advance(20 * MINUTE);
  const second = await fanOut(rig);
  await write("issue-alpha-1");
  const before = structuredClone(rig.state.repair!);
  const writes = rig.state.repairWrites;
  const { value: result } = await apply(
    rig,
    second.fanout,
    artifacts(second.fanout, second.envelopes),
  );
  assert.equal(result.status, "applied");
  assert.deepEqual(result.applied.map((entry) => entry.repository.name), [
    "beta",
  ]);
  assert.deepEqual(result.rejected, [
    { repository: ALPHA, reason: "base_moved" },
  ]);
  assert.equal(rig.state.repairWrites, writes + 1);
  for (const id of ["issue-alpha-0", "issue-alpha-1", "issue-alpha-2"]) {
    // The stale delta contributed nothing; its records are only handed back
    // (their stamp removed) so the next plan keeps them trusted.
    assert.deepEqual(
      row(rig, id),
      unstamped(before.work.find((record) => record.id === id)!),
      "the stale delta contributed nothing",
    );
  }

  // Every delta stale now: nothing but stamp hand-backs can be written.
  const settled = structuredClone(rig.state.repair!);
  const { value: none } = await apply(
    rig,
    second.fanout,
    artifacts(second.fanout, second.envelopes),
  );
  assert.deepEqual(none.applied, []);
  assert.deepEqual(none.rejected.map((entry) => entry.reason), [
    "base_moved",
    "base_moved",
  ]);
  for (const record of settled.work) {
    assert.deepEqual(unstamped(row(rig, record.id)), unstamped(record));
  }
});

Deno.test("fan-out: unsealed, tampered, rebound, out-of-scope, charging and missing deltas are refused before any write", async () => {
  const rig = makeRig(fleet());
  const { fanout, binding, envelopes } = await fanOut(rig);
  const alpha = envelopes.find((e) => e.delta.repository.name === "alpha")!;
  const beta = envelopes.find((e) => e.delta.repository.name === "beta")!;
  const alphaCell = cellOf(fanout, "alpha").cellId;
  const betaCell = cellOf(fanout, "beta").cellId;
  const tampered = structuredClone(alpha);
  tampered.delta.transitions[0].after.nextStep = "done";
  const unsigned = structuredClone(alpha) as Partial<RepairDeltaEnvelopeV1>;
  delete unsigned.digest;
  // Validly resealed deltas that charge an attempt or step a record the
  // plan did not delegate are still refused.
  const charged = structuredClone(alpha.delta);
  charged.transitions[0].after.counters.attempts += 1;
  const outOfScope = structuredClone(alpha.delta);
  const pending = pendingArtifact(ALPHA, 9);
  outOfScope.transitions = [{
    before: await canonicalDigestV1(pending),
    after: { ...pending, updatedAt: pending.updatedAt + 1 },
  }];
  const otherAttempt = await sealRepairDeltaV1({
    ...structuredClone(beta.delta),
    binding: { ...binding, runAttempt: 2 },
  });
  const cases: [unknown, string, string][] = [
    [unsigned, alphaCell, "unauthenticated"],
    [alpha.delta, alphaCell, "unauthenticated"],
    [
      await sealRawDelta({ ...alpha.delta, extra: 1 }),
      alphaCell,
      "invalid",
    ],
    [tampered, alphaCell, "unauthenticated"],
    [{ ...alpha, digest: "0".repeat(64) }, alphaCell, "unauthenticated"],
    [alpha, betaCell, "unauthenticated"],
    [otherAttempt, betaCell, "unauthenticated"],
    [await sealRepairDeltaV1(charged), alphaCell, "transition_refused"],
    [await sealRepairDeltaV1(outOfScope), alphaCell, "transition_refused"],
    [null, alphaCell, "missing"],
  ];
  const pristine = { repair: rig.state.repair!, head: rig.state.repairHead };
  const reset = () => {
    rig.state.repair = pristine.repair;
    rig.state.repairHead = pristine.head;
  };
  for (const [envelope, cellId, reason] of cases) {
    reset();
    const { value: result } = await apply(rig, fanout, [{ cellId, envelope }]);
    assert.deepEqual(result.applied, [], reason);
    assert.deepEqual(result.rejected.map((entry) => entry.reason), [reason]);
    // Nothing of a refused delta lands; only the planned cells' stamps are
    // handed back to the trusted path.
    assert.equal(result.handedBack, 5, reason);
    for (const record of pristine.repair.work) {
      assert.deepEqual(unstamped(row(rig, record.id)), unstamped(record));
    }
  }
  reset();
  // Two deltas for one cell: the second is a duplicate.
  const { value: duplicate } = await apply(
    rig,
    fanout,
    artifacts(fanout, [beta, beta]),
  );
  assert.deepEqual(duplicate.rejected.map((entry) => entry.reason), [
    "duplicate",
  ]);
  assert.deepEqual(duplicate.applied.map((entry) => entry.repository.name), [
    "beta",
  ]);
});

Deno.test("fan-out: a delegated step that needs a GitHub effect is handed back to the trusted path", async () => {
  // A produced candidate with no PR: its step would assign, push and publish.
  const publish = reviewing(ALPHA, 60, {
    nextStep: "work",
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-alpha-60",
      checkpoint: null,
      head: SHA2,
      pr: null,
    },
  });
  const rig = makeRig([...fleet(), publish]);
  const { fanout, envelopes } = await fanOut(rig);
  assert.ok(cellOf(fanout, "alpha").records.includes("issue-alpha-60"));
  assert.deepEqual(rig.github.effects(), [], "no effect reached GitHub");
  assert.equal(rig.state.repairWrites, 0);
  const alpha = envelopes.find((e) => e.delta.repository.name === "alpha")!
    .delta;
  assert.deepEqual(alpha.deferredToTrusted, ["issue-alpha-60"]);
  // Its only transition drops the stamp; the other records keep theirs.
  const handed = alpha.transitions.find((t) => t.after.id === "issue-alpha-60");
  const { stepInputs: _stamp, ...unstamped } = publish;
  assert.deepEqual(handed?.after, unstamped);
  const { value: result } = await apply(
    rig,
    fanout,
    artifacts(fanout, envelopes),
  );
  assert.equal(result.status, "applied");
  assert.deepEqual(row(rig, "issue-alpha-60"), unstamped);
  // The next plan leaves it with the trusted serial pass.
  const next = await plan(rig);
  assert.equal(
    delegatedRecordsV1(next.plan).has("issue-alpha-60"),
    false,
  );
});

Deno.test("fan-out: intake of a new issue stays with the trusted writer", async () => {
  const rig = makeRig(fleet(), {
    openIssues: [{ number: 999, title: "New failure", body: "Steps" }],
  });
  const { envelopes } = await fanOut(rig);
  assert.equal(rig.state.repairWrites, 0);
  for (const envelope of envelopes) {
    for (const transition of envelope.delta.transitions) {
      assert.ok(
        rig.state.repair!.work.some((row) => row.id === transition.after.id),
        "a delta never creates a record",
      );
    }
  }
});

Deno.test("fan-out: no write starts at or after the shared deadline", async () => {
  const rig = makeRig(fleet());
  const { fanout, envelopes } = await fanOut(rig);
  const { value: late } = await apply(
    rig,
    fanout,
    artifacts(fanout, envelopes),
    rig.clock.now(),
  );
  assert.equal(late.status, "none");
  assert.equal(rig.state.repairWrites, 0);
});
