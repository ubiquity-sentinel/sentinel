/**
 * In-flight preservation refused by the trusted validator. Live
 * (2026-11-12): sentinel-249, prospector-100 and prospector-112 were refused
 * on every maintenance run ("a newly exposed blob contains secret-shaped
 * text", "... exceeded its finite content bound"), stall counters at 230-470,
 * and nothing was ever recorded. Only the exact producer's rehydrated objects
 * can be preserved, so the in-flight restore is the one caller that ever sees
 * the validator's verdict on them. It now records that deterministic verdict
 * once, as the runtime's own refusal transition (loop-preservation.ts): the
 * intent clears and the record blocks with its head, descriptor and charge
 * kept, which the existing REFUSED disposition owns from there. Only that
 * disposition's unpublished shape is recorded: a published candidate, and
 * every transient or non-deterministic answer, still writes nothing and is
 * retried.
 */
import assert from "node:assert/strict";
import {
  type GitHubPort,
  portError,
  portOk,
} from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  PUBLICATION_INPUT_DETAIL,
  PUBLICATION_SECRET_DETAIL,
} from "../../src/github/snapshot-policy.ts";
import { clearIntent, markBlocked } from "../../src/repair/transitions.ts";
import {
  isInflightPreservation,
  PRESERVATION_VALIDATION_REFUSED,
  restoreInflightCandidate,
} from "../../ops/hosted-autonomy-blocked-candidate.ts";
import { SHA3, T0 } from "../state/helpers.ts";
import { preservationWalkRig } from "./hosted-autonomy-history-reach-fixtures.ts";
import {
  DAY,
  parkedFixture,
  runAt,
} from "./hosted-autonomy-preservation-cases.ts";
import {
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";

/** The validator's deterministic verdict on the live sentinel-249 head. */
const SECRET = portError("invalid", PUBLICATION_SECRET_DETAIL);

Deno.test("in-flight preservation: the trusted validator's deterministic refusal is recorded once, head and charge kept", async () => {
  const rig = await preservationWalkRig({
    verdict: (request) =>
      request.taskId === "inflight-older" ? SECRET : undefined,
  });
  const row = (taskId: string) =>
    rig.repair().snapshot.work.find((work) => work.id === taskId)!;
  const charge = () =>
    rig.repair().snapshot.reservations.find((reservation) =>
      reservation.id === rig.older.requestId
    );
  try {
    const before = row(rig.older.taskId);
    const charged = charge();
    const charges = rig.repair().snapshot.reservations.length;
    assert.equal(isInflightPreservation(before), true);
    // The first run consumes and preserves the newer producer's cell.
    assert.equal((await rig.walk())?.status, "applied");
    // The next reaches the older in-flight group and records the verdict.
    const second = await rig.walk();
    assert.equal(second?.status, "applied", JSON.stringify(second));
    assert.deepEqual(second?.actions, [
      "current-matrix:ingested:0",
      "current-matrix:preservation-refused:1",
    ]);
    const after = row(rig.older.taskId);
    assert.equal(isInflightPreservation(after), false);
    assert.equal(after.nextStep, "blocked");
    assert.deepEqual(after.blocker, {
      kind: "other",
      message: PRESERVATION_VALIDATION_REFUSED,
      since: after.updatedAt,
    });
    assert.equal(after.intent, null);
    assert.equal(after.wait, null);
    // The candidate head, its unpreserved descriptor and the counters stay.
    assert.deepEqual(after.target, before.target);
    assert.deepEqual(after.counters, before.counters);
    // The charge stays byte-identical: nothing refunded, nothing added.
    assert.deepEqual(charge(), charged);
    assert.equal(rig.repair().snapshot.reservations.length, charges);
    // Nothing is pending any more: no later run asks the validator again.
    assert.equal(await rig.walk(), null);
    assert.deepEqual(rig.calls.preserved, [rig.newer.ref, rig.older.ref]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("in-flight preservation: a transient or non-deterministic preserver answer writes nothing and is asked again", async () => {
  for (
    const [name, answer] of [
      ["unavailable", portError("unavailable", "preserver transport failed")],
      ["rate limited", portError("rate_limited", PUBLICATION_SECRET_DETAIL)],
      ["invalid input", portError("invalid", PUBLICATION_INPUT_DETAIL)],
    ] as const
  ) {
    const rig = await preservationWalkRig({
      verdict: (request) =>
        request.taskId === "inflight-older" ? answer : undefined,
    });
    try {
      assert.equal((await rig.walk())?.status, "applied");
      const before = rig.repair();
      for (let run = 0; run < 2; run++) {
        assert.equal(await rig.walk(), null, name);
        assert.deepEqual(rig.repair(), before, name);
      }
      assert.deepEqual(rig.calls.preserved, [
        rig.newer.ref,
        rig.older.ref,
        rig.older.ref,
      ], name);
      const older = rig.repair().snapshot.work.find((work) =>
        work.id === rig.older.taskId
      )!;
      assert.equal(isInflightPreservation(older), true, name);
    } finally {
      await rig.cleanup();
    }
  }
});

/** The live in-flight shape: work, no blocker, waiting `unavailable`. */
async function inflightFixture() {
  const { record: parked, charge } = await parkedFixture({ issue: 249 });
  const record: WorkRecordV1 = {
    ...parked,
    nextStep: "work",
    blocker: null,
    wait: { reason: "unavailable", since: T0 + 600, until: T0 + 120_600 },
    updatedAt: T0 + 600,
  };
  assert.equal(isInflightPreservation(record), true);
  const intent = record.intent!;
  const cell = {
    cellId: "cell-249",
    taskId: record.id,
    repository: record.repository,
    reservationId: intent.requestId,
    intentKey: intent.key,
    expectedBase: record.target.base,
  };
  const wave = {
    plan: { cells: [cell] },
    results: [{
      cellId: cell.cellId,
      taskId: record.id,
      reservationId: intent.requestId,
      receipt: { candidate: { head: record.target.head } },
      bundle: { head: record.target.head },
    }],
  };
  return { record, charge, wave };
}

/** The validator refuses deterministically; the exact ref reads absent. */
function refusingPreserver() {
  const seen = { preserved: 0, reads: [] as string[] };
  const github = {
    preserveCandidate: () => {
      seen.preserved++;
      return Promise.resolve(SECRET);
    },
    readRef: (name: string) => {
      seen.reads.push(name);
      return Promise.resolve(portOk(null));
    },
  } as unknown as GitHubPort;
  return { github, seen };
}

Deno.test("in-flight preservation: the recorded refusal is the runtime's own transition, which the REFUSED disposition owns", async () => {
  const { record, charge, wave } = await inflightFixture();
  // The real store's transition rules validate every write below.
  const state = new TransitionState(snapshotOf([record], [charge]));
  const at = T0 + 2000;
  const { github, seen } = refusingPreserver();
  const restored = await restoreInflightCandidate({
    record,
    wave: wave as never,
    state,
    github,
    clock: { now: () => at },
    readbackFailure: () => new Error("readback changed"),
  });
  assert.equal(restored, "refused");
  assert.equal(state.writes, 1);
  // Recorded only once its own deterministic preservation ref read absent.
  assert.deepEqual(seen.reads, [record.intent!.branch]);
  assert.deepEqual(
    state.snapshot.work,
    [markBlocked(
      clearIntent(record, at),
      "other",
      PRESERVATION_VALIDATION_REFUSED,
      at,
    )],
  );
  assert.deepEqual(state.snapshot.reservations, [charge]);
  // Within a day it stays blocked on its recorded reason; once a day passed
  // and the base advanced, the REFUSED class hands it to the retry authority
  // under that authority's own gates, every charge untouched.
  const early = await runAt(state, {}, at + DAY - 1);
  assert(
    early.actions.includes(`preservation:${record.id}:retained:pacing`),
    JSON.stringify(early),
  );
  const disposed = await runAt(state, {}, at + DAY + 1);
  assert(
    disposed.actions.includes(
      `preservation:${record.id}:unrecoverable:refused`,
    ),
    JSON.stringify(disposed),
  );
  assert.deepEqual(state.snapshot.reservations, [charge]);
});

Deno.test("in-flight preservation: a published candidate, which no disposition hands on, keeps custody on the same verdict", async () => {
  const { record: unpublished, charge, wave } = await inflightFixture();
  const record: WorkRecordV1 = {
    ...unpublished,
    target: {
      ...unpublished.target,
      pr: 1106,
      candidateState: { preserved: null, publishedHead: SHA3 },
    },
  };
  assert.equal(isInflightPreservation(record), true);
  const state = new TransitionState(snapshotOf([record], [charge]));
  const before = structuredClone(state.snapshot);
  const { github, seen } = refusingPreserver();
  const restored = await restoreInflightCandidate({
    record,
    wave: wave as never,
    state,
    github,
    clock: { now: () => T0 + 2000 },
    readbackFailure: () => new Error("readback changed"),
  });
  assert.equal(restored, null);
  assert.equal(seen.preserved, 1);
  assert.equal(state.writes, 0);
  assert.deepEqual(state.snapshot, before);
});
