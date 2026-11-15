/**
 * The consumers of a record the owner's one-time release returns to work
 * (`ops/hosted-autonomy-owner-releases.ts`), run for real over a record the
 * real matrix wave, cell and ingester failed with "model run failed
 * (unavailable)" and the repeat-failure bound's own writer then parked:
 * - the producer request binding (`producerRequests`) holds at every
 *   persisted state, and the current-matrix walk (`recoverHostedCurrentMatrix`)
 *   reads no producer for the released record;
 * - the original failed result replayed through `ingestMatrixResults` after
 *   the release is a duplicate: no write, no second memory outcome;
 * - the runtime's next wave (`planMatrixWave`) takes the released record up
 *   and charges exactly one ordinary start, its next attempt, at the base it
 *   refreshes first when the tip moved (live 177's base is from 2026-10-18).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  ingestMatrixResults,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import {
  applyHostedRetries,
  hostedRepositoryKey,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import type { OwnerReleaseV1 } from "../../ops/hosted-autonomy-owner-releases.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { producerRequests } from "../../ops/hosted-autonomy-producer-requests.ts";
import {
  applyRepeatFailureParks,
  failureSignature,
  REPEAT_FAILURE_DEFAULT_ROUTE,
  repeatFailureParkMessage,
} from "../../ops/hosted-autonomy-repeat-failure.ts";
import {
  captured,
  execution,
  FIRST_RUN,
  walkRig,
} from "./hosted-autonomy-history-reach-fixtures.ts";
import {
  ACTUAL,
  freshIssue,
  LAUNCHER,
  makeRig,
  type RigV1,
  RUN,
  seedSnapshot,
  WAVE,
} from "./matrix-runtime-fixtures.ts";

const UNAVAILABLE = "model run failed (unavailable)";
const HOUR = 60 * 60_000;
const DIGEST = "c".repeat(64);
const PROMPT = "2".repeat(64);
const MOVED = "9".repeat(40) as GitSha;
/** Live 177's dead worker-local candidate head (2026-10-18). */
const DEAD_HEAD = "9dfdda6981da9b6bf6f37abc4075e5d25294211c" as GitSha;

const fault = (message: string) =>
  new CurrentMatrixRecoveryIntegrityFailure(
    message,
    "e".repeat(40) as GitSha,
    null,
    null,
  );

async function read(rig: RigV1) {
  const found = await rig.store.readRepair();
  assert.ok(found.ok && found.value.status === "found");
  return found.value;
}

/** One CAS write of `next` over `prior`. */
async function write(
  rig: RigV1,
  prior: Awaited<ReturnType<typeof read>>,
  next: RepairStateSnapshotV1,
) {
  const written = await rig.store.writeRepair({
    ...next,
    stateHead: prior.head,
    sequence: prior.snapshot.sequence + 1,
    updatedAt: rig.clock.now(),
  }, prior.head);
  assert.ok(written.ok && written.value.status === "applied");
}

/** The launcher planner over `snapshot` with `releases` named by the owner. */
function plan(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  tip: GitSha,
  now: number,
  releases: readonly OwnerReleaseV1[],
) {
  const denials = new Map<string, string>();
  const plans = planHostedRetries(
    snapshot,
    now,
    LAUNCHER,
    new Map([[hostedRepositoryKey(record.repository), tip]]),
    new Set(),
    (denial) => denials.set(denial.id, denial.reason),
    {
      repeatFailure: {
        route: REPEAT_FAILURE_DEFAULT_ROUTE,
        issueDigests: new Map([[record.id, DIGEST]]),
        prompt: PROMPT,
        ownerReleases: releases,
      },
    },
  );
  return { plans, denials };
}

const memoryCounts = (snapshot: RepairStateSnapshotV1) =>
  snapshot.attemptMemory.flatMap((row) => row.entries).map((entry) =>
    entry.count
  );

const requestsOf = (snapshot: RepairStateSnapshotV1) =>
  producerRequests(snapshot, execution(FIRST_RUN + 1), new Set(), fault);

/**
 * Issue `issue` failed by a real wave, parked by the bound's own writer with
 * the live park's shape, then released through the real planner and the
 * retry pass's own writer (`applyHostedRetries`) while the tip is `tip`.
 * `deadHead` gives the parked record live 177's dead worker-local candidate
 * (an unpublished head with no preserved descriptor, no PR).
 */
async function released(
  rig: RigV1,
  issue: number,
  tip?: GitSha,
  deadHead?: GitSha,
) {
  const seeded = await rig.store.writeRepair(
    seedSnapshot([freshIssue(issue, rig.base)]),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  const wave = await planMatrixWave(rig.deps, rig.planOptions());
  assert.equal(wave.prepared, 1, JSON.stringify(wave));
  const cell = wave.plan.cells[0];
  const ctx = await rig.claimCell(cell);
  // deno-lint-ignore no-explicit-any
  const cellDeps = ctx.deps as any;
  cellDeps.model = {
    modelId: cellDeps.model.modelId,
    runModel: () =>
      Promise.resolve(portError("unavailable", "provider unavailable")),
  };
  const result = await runMatrixCell(
    ctx.deps,
    { waveId: WAVE, run: RUN, cell },
    ACTUAL,
    rig.clock.now(),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.detail, UNAVAILABLE);
  await rig.transfer([result], [ctx]);
  const ingested = await ingestMatrixResults(
    rig.deps,
    wave.plan,
    [result],
    rig.ingestOptions(),
  );
  assert.equal(ingested.ingested, 1, JSON.stringify(ingested.entries));
  const failed = await read(rig);
  const failedRecord = failed.snapshot.work[0];
  assert.equal(failedRecord.nextStep, "blocked");
  assert.equal(failedRecord.blocker?.message, UNAVAILABLE);
  const charge = failed.snapshot.reservations[0];
  assert.equal(charge.outcome, "ambiguous");
  rig.clock.advance(HOUR);
  const park = {
    count: 4,
    signature: failureSignature("other", UNAVAILABLE),
    issue: DIGEST.slice(0, 12),
    route: REPEAT_FAILURE_DEFAULT_ROUTE,
    prompt: PROMPT.slice(0, 12),
  };
  const shaped: RepairStateSnapshotV1 = deadHead === undefined
    ? failed.snapshot
    : {
      ...failed.snapshot,
      work: [{
        ...failedRecord,
        target: {
          ...failedRecord.target,
          head: deadHead,
          candidateState: { preserved: null, publishedHead: null },
        },
      }],
    };
  await write(
    rig,
    failed,
    applyRepeatFailureParks(shaped, [{
      id: failedRecord.id,
      repository: failedRecord.repository,
      message: repeatFailureParkMessage(park, UNAVAILABLE),
      park,
    }], rig.clock.now()),
  );
  const parked = await read(rig);
  const parkedRecord = parked.snapshot.work[0];
  const release: OwnerReleaseV1 = {
    repository: parkedRecord.repository,
    id: parkedRecord.id,
    blocker: parkedRecord.blocker!,
  };
  rig.clock.advance(HOUR);
  const now = rig.clock.now();
  const target = tip ?? rig.base;
  // Not named: parked. Named: one ordinary uncharged work grant.
  const kept = plan(parked.snapshot, parkedRecord, target, now, []);
  assert.equal(kept.plans.length, 0);
  assert.match(kept.denials.get(parkedRecord.id)!, /^repeat_failure_parked:/);
  const granted = plan(parked.snapshot, parkedRecord, target, now, [release]);
  assert.deepEqual(
    granted.plans.map((row) => row.detail),
    [
      `other:repeat_failure_rearmed:owner_release${
        tip === undefined ? "" : ":base-advance"
      }`,
    ],
  );
  await write(
    rig,
    parked,
    applyHostedRetries(parked.snapshot, parked.head, granted.plans, now),
  );
  const after = await read(rig);
  const record = after.snapshot.work[0];
  assert.equal(record.nextStep, "work");
  assert.equal(record.intent, null);
  // The target, every charge and every memory row stay as parked.
  assert.deepEqual(record.target, parkedRecord.target);
  assert.deepEqual(after.snapshot.reservations, parked.snapshot.reservations);
  assert.deepEqual(after.snapshot.attemptMemory, parked.snapshot.attemptMemory);
  // Released once: the record holds no park, so no later plan names it.
  assert.equal(
    plan(after.snapshot, record, target, now, [release]).plans.length,
    0,
  );
  return { wave, result, charge, failed, parked, released: after, record };
}

/** The runtime's next wave, planned within fresh run bounds. */
function nextWave(rig: RigV1, name: string) {
  rig.clock.advance(HOUR);
  return planMatrixWave(rig.deps, {
    ...rig.planOptions(),
    waveId: `${WAVE}-${name}`,
    plannedAt: rig.clock.now(),
    deadline: rig.clock.now() + HOUR,
  });
}

/** The one charge the released record's next start added, and its binding. */
async function oneOrdinaryStart(
  state: Awaited<ReturnType<typeof read>>,
  record: WorkRecordV1,
  charge: RepairStateSnapshotV1["reservations"][number],
  base: GitSha,
) {
  const fresh = state.snapshot.reservations.filter((row) =>
    row.id !== charge.id
  );
  assert.equal(fresh.length, 1);
  const { taskId, attempt, purpose, head, outcome } = fresh[0];
  assert.deepEqual({ taskId, attempt, purpose, head, outcome }, {
    taskId: record.id,
    attempt: charge.attempt + 1,
    purpose: "retry",
    head: base,
    outcome: "reserved",
  });
  assert.deepEqual(
    state.snapshot.reservations.find((row) => row.id === charge.id),
    charge,
  );
  assert.deepEqual(memoryCounts(state.snapshot), [1]);
  // The new start binds exactly for its own producer.
  assert.deepEqual(await requestsOf(state.snapshot), [{
    taskId: record.id,
    repository: record.repository,
    reservationId: fresh[0].id,
    intentKey: implementationIntentKey(fresh[0].id),
    expectedBase: base,
    attempt: charge.attempt + 1,
  }]);
}

Deno.test("owner release consumers: binding, walk and replay hold; the next wave charges one ordinary start", async () => {
  const rig = await makeRig([990177], 1);
  try {
    const f = await released(rig, 990177);
    // The producer binding holds at every persisted state; none asks for
    // the old charge.
    for (const state of [f.failed, f.parked, f.released]) {
      assert.deepEqual(await requestsOf(state.snapshot), []);
    }
    // The current-matrix walk has nothing pending: no producer is read.
    const walk = await walkRig({
      producers: 2,
      rows: [{ record: f.record, charge: f.charge }],
    });
    try {
      const outcome = await captured(walk.walk);
      assert.equal(outcome.error, null, String(outcome.error));
      assert.equal(outcome.value, null);
      assert.deepEqual(walk.calls.recovered, []);
      assert.deepEqual(walk.calls.listed, []);
    } finally {
      await walk.cleanup();
    }
    // The original failed result replayed after the release: a duplicate,
    // nothing written and no second outcome counted.
    const writeRepair = rig.store.writeRepair.bind(rig.store);
    let writes = 0;
    rig.store.writeRepair = (...args) => {
      writes++;
      return writeRepair(...args);
    };
    const replay = await ingestMatrixResults(
      rig.deps,
      f.wave.plan,
      [f.result],
      rig.ingestOptions(),
    );
    rig.store.writeRepair = writeRepair;
    assert.equal(replay.ingested, 0);
    assert.equal(replay.entries[0].disposition, "duplicate");
    assert.equal(writes, 0, "a duplicate replay writes nothing");
    assert.deepEqual(await read(rig), f.released);
    assert.deepEqual(memoryCounts(f.released.snapshot), [1]);
    // The runtime's next wave takes it up: one ordinary charged start.
    const next = await nextWave(rig, "next");
    assert.equal(next.prepared, 1, JSON.stringify(next));
    await oneOrdinaryStart(await read(rig), f.record, f.charge, rig.base);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("owner release consumers: live 177's dead candidate on a moved tip is refreshed, uncharged, before one fresh start", async () => {
  const rig = await makeRig([990178], 1);
  try {
    const f = await released(rig, 990178, MOVED, DEAD_HEAD);
    assert.equal(f.record.target.head, DEAD_HEAD);
    // Every state the runtime's wave persists, in order.
    const written: RepairStateSnapshotV1[] = [];
    const writeRepair = rig.store.writeRepair.bind(rig.store);
    rig.store.writeRepair = (next, head) => {
      written.push(structuredClone(next));
      return writeRepair(next, head);
    };
    // deno-lint-ignore no-explicit-any
    (rig.github as any).options.baseSha = MOVED;
    const next = await nextWave(rig, "start");
    rig.store.writeRepair = writeRepair;
    // The runtime refreshes the stale base first (its own uncharged
    // progress step), then admits one start at the tip in the same wave.
    assert.equal(next.prepared, 1, JSON.stringify(next));
    assert.deepEqual(next.deferredByReason, { progress: 1 });
    assert.equal(next.plan.cells[0].expectedBase, MOVED);
    // A fresh start from the tip: the dead candidate is never checked out.
    assert.equal(next.plan.cells[0].request.base, MOVED);
    assert.equal(next.plan.cells[0].request.checkoutBase, undefined);
    const [refreshed] = written;
    const record = refreshed.work[0];
    assert.deepEqual(record, {
      ...f.record,
      target: { ...f.record.target, base: MOVED },
      updatedAt: record.updatedAt,
    });
    assert.deepEqual(refreshed.reservations, f.released.snapshot.reservations);
    // The producer binding holds at every state the wave persisted.
    for (const snapshot of written) await requestsOf(snapshot);
    assert.deepEqual(await requestsOf(refreshed), []);
    await oneOrdinaryStart(await read(rig), f.record, f.charge, MOVED);
  } finally {
    await rig.cleanup();
  }
});
