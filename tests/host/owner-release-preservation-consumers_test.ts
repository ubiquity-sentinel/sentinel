/**
 * The consumers of a refused-preservation record that the preservation
 * disposition re-enters and the ordinary retry grant returns to work (the
 * path the owner's one-park allowance for sentinel 249 takes once,
 * `OWNER_PRESERVATION_ALLOWANCES_2026_11_16`), run for real: a real matrix
 * wave admits and charges the start, the real cell produces a candidate, and
 * the real serial lifecycle's preservation is refused by the trusted
 * validator with 249's recorded check (`secret_shaped_text`).
 * - the producer request binding (`producerRequests`) holds at every
 *   persisted state;
 * - the original completed result replayed after the release is a duplicate:
 *   no write, nothing re-imported or re-settled;
 * - the runtime's next wave refreshes the moved base uncharged and charges
 *   exactly one ordinary start, the next attempt.
 * The cap decision itself runs over the live rows in
 * `owner-release-preservation_test.ts`.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { PUBLICATION_SECRET_DETAIL } from "../../src/github/snapshot-policy.ts";
import {
  ingestMatrixResults,
  type MatrixPlanReportV1,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  applyHostedRetries,
  hostedRepositoryKey,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import {
  disposePreservation,
  PRESERVATION_REFUSED_BLOCKER,
} from "../../ops/hosted-autonomy-preservation-disposition.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { producerRequests } from "../../ops/hosted-autonomy-producer-requests.ts";
import { REPEAT_FAILURE_DEFAULT_ROUTE } from "../../ops/hosted-autonomy-repeat-failure.ts";
import {
  execution,
  FIRST_RUN,
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

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const MOVED = "9".repeat(40) as GitSha;
const REFUSED = "candidate preservation validation refused: secret_shaped_text";

const fault = (message: string) =>
  new CurrentMatrixRecoveryIntegrityFailure(
    message,
    "e".repeat(40) as GitSha,
    null,
    null,
  );

const requestsOf = (snapshot: RepairStateSnapshotV1) =>
  producerRequests(snapshot, execution(FIRST_RUN + 1), new Set(), fault);

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

/** The wave's one cell, run for real, and its completed result ingested. */
async function refusedCandidate(rig: RigV1, wave: MatrixPlanReportV1) {
  assert.equal(wave.prepared, 1, JSON.stringify(wave));
  const cell = wave.plan.cells[0];
  const ctx = await rig.claimCell(cell);
  const result = await runMatrixCell(
    ctx.deps,
    { waveId: wave.plan.waveId, run: RUN, cell },
    ACTUAL,
    rig.clock.now(),
  );
  assert.equal(result.status, "completed", JSON.stringify(result));
  await rig.transfer([result], [ctx]);
  const ingested = await ingestMatrixResults(
    rig.deps,
    wave.plan,
    [result],
    rig.ingestOptions(),
  );
  assert.equal(ingested.ingested, 1, JSON.stringify(ingested.entries));
  // The serial lifecycle reconciles the preservation intent first: the
  // trusted validator's refusal parks the record (`loop-preservation.ts`).
  const cycle = await runRepairCycle(rig.deps, {
    deadline: rig.clock.now() + HOUR,
    stepLimit: 1,
  });
  assert.notEqual(cycle.status, "state_error", JSON.stringify(cycle));
  return result;
}

Deno.test("owner allowance consumers: a re-entered refused candidate keeps binding and replay; the next wave charges one start", async () => {
  const rig = await makeRig([990249], 1);
  // The trusted validator refuses every candidate of this task the way
  // 249's 2026-11-06 refusal was recorded.
  // deno-lint-ignore no-explicit-any
  (rig.github as any).lifecycle = {
    // deno-lint-ignore no-explicit-any
    ...(rig.github as any).lifecycle,
    preserveCandidate: () =>
      Promise.resolve(portError("invalid", PUBLICATION_SECRET_DETAIL)),
  };
  try {
    const seeded = await rig.store.writeRepair(
      seedSnapshot([freshIssue(990249, rig.base)]),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const wave = await planMatrixWave(rig.deps, rig.planOptions());
    const result = await refusedCandidate(rig, wave);
    const parked = await read(rig);
    const record = parked.snapshot.work[0];
    // The refused-class shape the disposition owns (live 249's, with the
    // check-named message): blocked, no intent, head and descriptor kept.
    assert.equal(record.nextStep, "blocked");
    assert.equal(record.blocker?.message, REFUSED);
    assert.equal(record.intent, null);
    assert.equal(record.target.head, result.receipt?.candidate?.head);
    assert.deepEqual(record.target.candidateState, {
      preserved: null,
      publishedHead: null,
    });
    const charge = parked.snapshot.reservations[0];
    assert.equal(parked.snapshot.reservations.length, 1);
    assert.equal(charge.outcome, "submitted");
    assert.deepEqual(await requestsOf(parked.snapshot), []);

    // The disposition's own transition a day later, then the ordinary
    // retry grant on the moved tip, each in its own CAS write.
    rig.clock.advance(DAY + HOUR);
    await write(rig, parked, {
      ...parked.snapshot,
      work: [
        disposePreservation(
          record,
          PRESERVATION_REFUSED_BLOCKER,
          rig.clock.now(),
        ),
      ],
    });
    const disposed = await read(rig);
    assert.deepEqual(await requestsOf(disposed.snapshot), []);
    rig.clock.advance(HOUR);
    const plans = planHostedRetries(
      disposed.snapshot,
      rig.clock.now(),
      LAUNCHER,
      new Map([[hostedRepositoryKey(record.repository), MOVED]]),
      new Set(),
      undefined,
      {
        repeatFailure: {
          route: REPEAT_FAILURE_DEFAULT_ROUTE,
          issueDigests: new Map(),
        },
      },
    );
    assert.deepEqual(plans.map((plan) => plan.detail), [
      "other:candidate preservation unrecoverable:base-advance",
    ]);
    await write(
      rig,
      disposed,
      applyHostedRetries(
        disposed.snapshot,
        disposed.head,
        plans,
        rig.clock.now(),
      ),
    );
    const released = await read(rig);
    const back = released.snapshot.work[0];
    assert.equal(back.nextStep, "work");
    assert.equal(back.intent, null);
    assert.equal(back.target.head, null);
    assert.equal(back.target.base, record.target.base);
    assert.deepEqual(
      released.snapshot.reservations,
      parked.snapshot.reservations,
    );
    assert.deepEqual(await requestsOf(released.snapshot), []);

    // The original completed result replayed after the release: a
    // duplicate, nothing written.
    const writeRepair = rig.store.writeRepair.bind(rig.store);
    let writes = 0;
    rig.store.writeRepair = (...args) => {
      writes++;
      return writeRepair(...args);
    };
    const replay = await ingestMatrixResults(
      rig.deps,
      wave.plan,
      [result],
      rig.ingestOptions(),
    );
    rig.store.writeRepair = writeRepair;
    assert.equal(replay.ingested, 0);
    assert.equal(replay.entries[0].disposition, "duplicate");
    assert.equal(writes, 0, "a duplicate replay writes nothing");
    assert.deepEqual(await read(rig), released);

    // The runtime's next wave refreshes the moved base (uncharged) and
    // charges exactly one start, the next attempt, bound for its producer.
    const persisted: RepairStateSnapshotV1[] = [];
    rig.store.writeRepair = (next, head) => {
      persisted.push(structuredClone(next));
      return writeRepair(next, head);
    };
    // deno-lint-ignore no-explicit-any
    (rig.github as any).options.baseSha = MOVED;
    rig.clock.advance(HOUR);
    const next = await planMatrixWave(rig.deps, {
      ...rig.planOptions(),
      waveId: `${WAVE}-next`,
      plannedAt: rig.clock.now(),
      deadline: rig.clock.now() + HOUR,
    });
    rig.store.writeRepair = writeRepair;
    assert.equal(next.prepared, 1, JSON.stringify(next));
    assert.deepEqual(next.deferredByReason, { progress: 1 });
    for (const snapshot of persisted) await requestsOf(snapshot);
    const started = await read(rig);
    const fresh = started.snapshot.reservations.filter((row) =>
      row.id !== charge.id
    );
    assert.equal(fresh.length, 1);
    const { attempt, purpose, head, outcome } = fresh[0];
    assert.deepEqual({ attempt, purpose, head, outcome }, {
      attempt: 2,
      purpose: "retry",
      head: MOVED,
      outcome: "reserved",
    });
    assert.deepEqual(await requestsOf(started.snapshot), [{
      taskId: record.id,
      repository: record.repository,
      reservationId: fresh[0].id,
      intentKey: implementationIntentKey(fresh[0].id),
      expectedBase: MOVED,
      attempt: 2,
    }]);
  } finally {
    await rig.cleanup();
  }
});
