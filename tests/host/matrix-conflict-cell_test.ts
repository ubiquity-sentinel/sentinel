/**
 * The hosted shape of a conflict resolution: a matrix cell. The trusted
 * planner grants it only on an open route (a runtime whose rollback target
 * consumes the cell). Generation 78 kept the hosted route closed because
 * generation 77 refuses the cell; generation 78's consumer accepts exactly the
 * bound cell (`matrix-conflict-gen78_test.ts` runs its own code), so this tree
 * opens the hosted route (`HOSTED_CONFLICT_RESOLUTIONS`) with generation 78 as
 * its rollback target. At most `HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE`
 * conflict resolutions are in flight (at `work`, charge `reserved`), the most
 * one rollback can isolate; an isolated one frees its slot, and so does one
 * admitted past its cell artifact's retention plus a day.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { MatrixHistoricalRuntimeMismatch } from "../../src/host/matrix-artifact-port.ts";
import { markBlocked } from "../../src/repair/transitions.ts";
import { createActionsMatrixArtifactTransport } from "../../src/host/matrix-artifacts.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import { CONFLICT_RESOLUTION_CAP_REASON as CONFLICT_CAP_REASON } from "../../src/host/matrix-planner.ts";
import { HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS } from "../../ops/hosted-autonomy-policy.ts";
import {
  CONFLICT_CELL_EVIDENCE_EXPIRY_MS,
  conflictMarker,
  conflictMarkerBase,
  conflictResolutionInFlight,
  HOSTED_CONFLICT_RESOLUTIONS,
  HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
  pendingConflictResolution,
} from "../../src/repair/conflict-resolution.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  assertGen78Parses,
  gen77Available,
  gen78Available,
  loadGen77Modules,
} from "../state/gen77-contracts.ts";
import { bytes, fixture, ISO, RUN, zip } from "./matrix-artifact-fixtures.ts";
import { makeRig, seedSnapshot, snapshot } from "./matrix-runtime-fixtures.ts";

const MERGE = "4".repeat(40) as GitSha;
const BRANCH = "sentinel/repair/issue-401";

/** A pending resolution of the published H=SHA2 on B0=SHA1 at the rig base. */
async function pendingRig() {
  const rig = await makeRig([401], 1);
  const operationKey = implementationIntentKey("cd".repeat(32));
  const record = workRecord("issue-401", {
    source: { kind: "issue", id: "401", revision: rig.base },
    related: { incidentId: null, issueNumber: 401 },
    target: {
      base: SHA1,
      branch: BRANCH,
      checkpoint: null,
      head: SHA2,
      pr: 7,
      candidateState: {
        preserved: {
          operationKey,
          base: SHA1,
          head: SHA2,
          ref: await candidatePreservationRef(
            REPO,
            "issue-401" as never,
            operationKey,
          ),
        },
        publishedHead: SHA2,
      },
    },
    nextStep: "work",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(7, SHA2, rig.base),
      startedAt: T0,
      branch: BRANCH,
      expectedHead: SHA2,
      observedBase: rig.base,
      pr: 7,
      requestId: null,
      resultId: null,
      failure: conflictMarker(rig.base, T0),
    },
    firstSeenAt: T0 - 60_000,
  });
  const written = await rig.store.writeRepair(
    parseRepairStateSnapshotV1(seedSnapshot([record])),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  rig.github.candidateRefs.set(`refs/heads/${BRANCH}`, SHA2);
  return rig;
}

Deno.test("matrix planner: an open route grants one conflict-resolution cell continuing H with B to merge", async () => {
  const rig = await pendingRig();
  try {
    const report = await planMatrixWave(rig.deps, rig.planOptions());
    assert.equal(report.plan.cells.length, 1, JSON.stringify(report));
    const request = report.plan.cells[0].request;
    assert.equal(request.base, SHA1, "the durable reviewed base");
    assert.equal(request.checkoutBase, SHA2, "the published candidate");
    assert.equal(request.mergeBase, rig.base, "the conflicting base tip");
    assert.equal(request.reviewFindings, undefined);
    const after = await snapshot(rig);
    assert.equal(after.work[0].intent?.kind, "implementation");
    assert.equal(conflictMarkerBase(after.work[0].intent), rig.base);
    assert.equal(after.reservations.length, 1, "one charged resolution");
    assert.equal(after.reservations[0].purpose, "retry");
    assert.equal(after.reservations[0].head, SHA1);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix planner: a hosted run grants the same single conflict-resolution cell", async () => {
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS, true);
  const rig = await pendingRig();
  try {
    const report = await planMatrixWave(
      { ...rig.deps, externalImplementations: true },
      rig.planOptions(),
    );
    assert.equal(report.plan.cells.length, 1, JSON.stringify(report));
    const request = report.plan.cells[0].request;
    assert.equal(request.base, SHA1, "the durable reviewed base");
    assert.equal(request.checkoutBase, SHA2, "the published candidate");
    assert.equal(request.mergeBase, rig.base, "the conflicting base tip");
    const after = await snapshot(rig);
    assert.equal(conflictMarkerBase(after.work[0].intent), rig.base);
    assert.equal(after.reservations.length, 1, "one charged resolution");
    const again = await planMatrixWave(
      { ...rig.deps, externalImplementations: true },
      rig.planOptions(),
    );
    assert.equal(again.plan.cells.length, 0, "never a second cell");
    assert.deepEqual(await snapshot(rig), after);
  } finally {
    await rig.cleanup();
  }
});

/** One published candidate H=SHA2 on B0=SHA1 with its open PR and branch. */
async function publishedRecord(
  rig: Awaited<ReturnType<typeof makeRig>>,
  number: number,
  overrides: Partial<WorkRecordV1> = {},
): Promise<WorkRecordV1> {
  const id = `issue-${number}`;
  const branch = `sentinel/repair/${id}`;
  const operationKey = implementationIntentKey("cd".repeat(32));
  rig.github.candidateRefs.set(`refs/heads/${branch}`, SHA2);
  return workRecord(id, {
    source: { kind: "issue", id: String(number), revision: rig.base },
    related: { incidentId: null, issueNumber: number },
    target: {
      base: SHA1,
      branch,
      checkpoint: null,
      head: SHA2,
      pr: number,
      candidateState: {
        preserved: {
          operationKey,
          base: SHA1,
          head: SHA2,
          ref: await candidatePreservationRef(REPO, id as never, operationKey),
        },
        publishedHead: SHA2,
      },
    },
    nextStep: "work",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(number, SHA2, rig.base),
      startedAt: T0,
      branch,
      expectedHead: SHA2,
      observedBase: rig.base,
      pr: number,
      requestId: null,
      resultId: null,
      failure: conflictMarker(rig.base, T0),
    },
    firstSeenAt: T0 - 60_000,
    ...overrides,
  });
}

/**
 * A resolution admitted by an earlier wave: the marked implementation intent
 * of its one charge, settled as given (`reserved` until its receipt is
 * consumed, including a receipt `preserveConflictMerge` keeps unconsumed).
 */
async function admittedResolution(
  rig: Awaited<ReturnType<typeof makeRig>>,
  number: number,
  outcome: "reserved" | "submitted" | "ambiguous",
  overrides: Partial<WorkRecordV1> = {},
) {
  const charge = String(number).padStart(64, "e");
  const record = await publishedRecord(rig, number, {
    counters: { attempts: 2, retries: 1, reviewRounds: 1 },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(charge),
      startedAt: T0,
      branch: `sentinel/repair/issue-${number}`,
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: charge,
      resultId: null,
      failure: conflictMarker(rig.base, T0),
    },
    ...overrides,
  });
  return {
    record,
    charge: reservation(charge, {
      taskId: record.id,
      attempt: 2,
      head: SHA1,
      purpose: "retry",
      outcome,
      settledAt: outcome === "reserved" ? null : T0,
    }),
  };
}

/** `count` pending resolutions, each on its own published candidate. */
async function pendingWaveRig(
  count: number,
  admitted: (rig: Awaited<ReturnType<typeof makeRig>>) => Promise<
    { record: WorkRecordV1; charge: BudgetReservationV1 }[]
  > = () => Promise.resolve([]),
) {
  const numbers = Array.from({ length: count }, (_, i) => 411 + i);
  const rig = await makeRig(numbers, 1);
  const pending = await Promise.all(
    numbers.map((number) => publishedRecord(rig, number)),
  );
  const earlier = await admitted(rig);
  const written = await rig.store.writeRepair(
    parseRepairStateSnapshotV1({
      ...seedSnapshot([...pending, ...earlier.map((row) => row.record)]),
      reservations: earlier.map((row) => row.charge),
    }),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  return rig;
}

/**
 * Conflict resolutions in flight: marked intents of `reserved` charges at
 * `work`, whatever their age (the planner's count also leaves out one
 * admitted `CONFLICT_CELL_EVIDENCE_EXPIRY_MS` or more ago).
 */
function inFlight(state: RepairStateSnapshotV1): string[] {
  return state.work.filter((work) =>
    work.nextStep === "work" &&
    conflictResolutionInFlight(work.intent) !== null &&
    state.reservations.some((row) =>
      row.id === work.intent!.requestId && row.outcome === "reserved"
    )
  ).map((work) => work.id);
}

Deno.test("matrix planner: one wave grants at most the per-wave cap of conflict-resolution cells; the rest stay pending, uncharged", async () => {
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE, 4);
  const rig = await pendingWaveRig(6);
  try {
    const deps = { ...rig.deps, externalImplementations: true };
    const first = await planMatrixWave(deps, rig.planOptions());
    assert.equal(first.plan.cells.length, 4, JSON.stringify(first));
    assert.ok(
      first.plan.cells.every((cell) => cell.request.mergeBase === rig.base),
    );
    const after = await snapshot(rig);
    assert.equal(after.reservations.length, 4, "four charged resolutions");
    const waiting = after.work.filter((work) =>
      pendingConflictResolution(work.intent) !== null
    );
    assert.equal(waiting.length, 2, "the rest stay pending, uncharged");
    // The first wave's four cells are still in flight: a later wave grants
    // none, so the in-flight total never exceeds the cap.
    const second = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-cap-2",
    });
    assert.equal(second.plan.cells.length, 0, JSON.stringify(second));
    assert.deepEqual(await snapshot(rig), after);
    // Two receipts are consumed (one resolved, one charged failure): two
    // slots open, and only two.
    const read = await rig.store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") throw new Error("state");
    const [resolvedId, failedId] = inFlight(read.value.snapshot);
    const consumed = read.value.snapshot.work.map((work): WorkRecordV1 => {
      if (work.id === resolvedId) {
        return {
          ...work,
          intent: {
            kind: "base_refresh",
            key: baseRefreshIntentKey(work.target.pr!, SHA2, rig.base),
            startedAt: T0,
            branch: work.target.branch,
            expectedHead: SHA2,
            observedBase: rig.base,
            pr: work.target.pr,
            requestId: null,
            resultId: MERGE,
            failure: conflictMarker(rig.base, T0),
          },
        };
      }
      return work.id === failedId
        ? {
          ...work,
          nextStep: "blocked",
          blocker: { kind: "other", message: "model run failed", since: T0 },
        }
        : work;
    });
    const settled = await rig.store.writeRepair({
      ...read.value.snapshot,
      stateHead: read.value.head,
      sequence: read.value.snapshot.sequence + 1,
      work: consumed,
      reservations: read.value.snapshot.reservations.map((row) =>
        row.taskId === resolvedId || row.taskId === failedId
          ? {
            ...row,
            outcome: row.taskId === resolvedId ? "submitted" : "ambiguous",
            settledAt: T0,
          }
          : row
      ),
    }, read.value.head);
    assert.ok(settled.ok && settled.value.status === "applied");
    assert.equal(inFlight(await snapshot(rig)).length, 2);
    const third = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-cap-3",
    });
    assert.equal(third.plan.cells.length, 2, JSON.stringify(third));
    assert.equal((await snapshot(rig)).reservations.length, 6);
    assert.equal(inFlight(await snapshot(rig)).length, 4);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix planner: resolutions already in flight count toward the cap before any new grant; an isolated one frees its slot", async () => {
  const rig = await pendingWaveRig(6, async (rig) => [
    // Admitted by an earlier wave, receipt not yet consumed.
    await admittedResolution(rig, 431, "reserved"),
    // A receipt the ingest keeps unconsumed while M is not yet preserved:
    // the same in-flight intent and `reserved` charge, its loop waiting.
    await admittedResolution(rig, 432, "reserved", {
      wait: { reason: "unavailable", since: T0, until: T0 + 300_000 },
    }),
    // Isolated by a rollback with its admission retained, charge reserved:
    // no rollback can isolate it again, so it holds no slot.
    await admittedResolution(rig, 433, "reserved", {
      nextStep: "blocked",
      blocker: {
        kind: "other",
        message: "authenticated historical matrix runtime mismatch",
        since: T0,
      },
    }),
    // Settled charges hold no slot: consumed, or a charged failure.
    await admittedResolution(rig, 434, "submitted"),
    await admittedResolution(rig, 435, "ambiguous", {
      nextStep: "blocked",
      blocker: { kind: "other", message: "model run failed", since: T0 },
    }),
  ]);
  try {
    const deps = { ...rig.deps, externalImplementations: true };
    assert.deepEqual(inFlight(await snapshot(rig)), [
      "issue-431",
      "issue-432",
    ]);
    const first = await planMatrixWave(deps, rig.planOptions());
    assert.equal(first.plan.cells.length, 2, JSON.stringify(first));
    const after = await snapshot(rig);
    const holders = inFlight(after);
    assert.equal(holders.length, HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE);
    assert.ok(!holders.includes("issue-433"), "the isolated one holds none");
    assert.equal(
      after.work.filter((work) =>
        pendingConflictResolution(work.intent) !== null
      ).length,
      4,
      "the rest stay pending, uncharged",
    );
    const second = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-inflight-2",
    });
    assert.equal(second.plan.cells.length, 0, JSON.stringify(second));
    assert.deepEqual(await snapshot(rig), after);
    // The zero-cell diagnostic names the cap and the records holding it.
    assert.deepEqual(second.diagnostic?.conflictResolutionCap, {
      cap: HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
      inFlight: holders,
    }, JSON.stringify(second.diagnostic));
    assert.equal(
      second.diagnostic?.notReadyByReason[CONFLICT_CAP_REASON],
      4,
      JSON.stringify(second.diagnostic),
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("matrix planner: a resolution whose cell evidence was lost holds its slot only while its cell artifact could still be retained", async () => {
  // The cell artifacts' `retention-days: 7` plus a day, the same horizon as
  // the launcher's evidence expiry.
  assert.equal(
    CONFLICT_CELL_EVIDENCE_EXPIRY_MS,
    HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS,
  );
  // Four resolutions admitted (charge `reserved`, marked intent at `work`)
  // whose cells never uploaded a result: cancelled, timed out, runner lost.
  // Their admission is one minute short of that horizon.
  const lostIds = ["issue-441", "issue-442", "issue-443", "issue-444"];
  const admittedAt = T0 - CONFLICT_CELL_EVIDENCE_EXPIRY_MS + 60_000;
  const rig = await pendingWaveRig(
    6,
    (rig) =>
      Promise.all([441, 442, 443, 444].map(async (number) => {
        const row = await admittedResolution(rig, number, "reserved");
        return {
          ...row,
          record: {
            ...row.record,
            intent: { ...row.record.intent!, startedAt: admittedAt },
          },
        };
      })),
  );
  const lost = (state: RepairStateSnapshotV1) =>
    JSON.stringify({
      work: state.work.filter((work) => lostIds.includes(work.id)),
      reservations: state.reservations.filter((row) =>
        lostIds.includes(row.taskId)
      ),
    });
  try {
    const deps = { ...rig.deps, externalImplementations: true };
    const before = await snapshot(rig);
    assert.equal(before.reservations.length, 4);
    assert.deepEqual(inFlight(before), lostIds);
    // Inside the horizon a consumer or a rollback could still authenticate
    // each cell, so the four hold the cap: nothing granted, nothing written.
    const inside = await planMatrixWave(deps, rig.planOptions());
    assert.equal(inside.plan.cells.length, 0, JSON.stringify(inside));
    assert.deepEqual(inside.diagnostic?.conflictResolutionCap, {
      cap: HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
      inFlight: lostIds,
    }, JSON.stringify(inside.diagnostic));
    assert.equal(
      inside.diagnostic?.notReadyByReason[CONFLICT_CAP_REASON],
      6,
      JSON.stringify(inside.diagnostic),
    );
    assert.deepEqual(await snapshot(rig), before);
    // Past it no consumer and no rollback can authenticate or isolate those
    // cells: they leave the count, and the cap bounds the fresh grants.
    rig.clock.advance(60_000);
    const past = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-lost-evidence-past",
    });
    assert.equal(
      past.plan.cells.length,
      HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
      JSON.stringify(past),
    );
    const after = await snapshot(rig);
    // Leaving the count is not a retirement: the four records and their
    // `reserved` charges are byte-identical, never settled or refunded.
    assert.equal(lost(after), lost(before));
    assert.equal(after.reservations.length, 8, "one charge per resolution");
    assert.equal(
      after.work.filter((work) =>
        pendingConflictResolution(work.intent) !== null
      ).length,
      2,
      "the rest stay pending, uncharged",
    );
    const fresh = inFlight(after).filter((id) => !lostIds.includes(id));
    assert.equal(fresh.length, HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE);
    // The fresh four now hold the cap, and only they are named.
    const full = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-lost-evidence-full",
    });
    assert.equal(full.plan.cells.length, 0, JSON.stringify(full));
    assert.deepEqual(full.diagnostic?.conflictResolutionCap, {
      cap: HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
      inFlight: fresh,
    }, JSON.stringify(full.diagnostic));
    assert.deepEqual(await snapshot(rig), after);
  } finally {
    await rig.cleanup();
  }
});

/**
 * R78's isolation write over `ids` (`recoverWithHistoricalIsolation`,
 * byte-identical at 474f87eb6, which `matrix-conflict-gen78_test.ts` runs on a
 * real conflict cell): each record still at `work` is blocked with the
 * runtime-mismatch message; its marked intent, target, counters and
 * `reserved` charge are kept, never refunded.
 */
async function isolateAsR78(
  rig: Awaited<ReturnType<typeof makeRig>>,
  ids: readonly string[],
): Promise<RepairStateSnapshotV1> {
  const now = rig.clock.now();
  const read = await rig.store.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("state");
  const state = read.value.snapshot;
  const next: RepairStateSnapshotV1 = {
    ...state,
    stateHead: read.value.head,
    sequence: state.sequence + 1,
    updatedAt: now,
    work: state.work.map((work) => {
      if (!ids.includes(work.id)) return work;
      assert.equal(work.nextStep, "work", "R78 isolates only records at work");
      return markBlocked(
        work,
        "other",
        `authenticated historical matrix runtime mismatch; producer=7:1; runtime=${SHA3}; plan=${
          "a".repeat(64)
        }; artifact=501; archive=sha256:${
          "b".repeat(64)
        }; planner=401; result=${"c".repeat(64)}; original admission retained`,
        now,
      );
    }),
  };
  const written = await rig.store.writeRepair(next, read.value.head);
  assert.ok(written.ok && written.value.status === "applied");
  return await snapshot(rig);
}

Deno.test("matrix planner: across a rollback and roll-forward, each rollback strands at most the cap and the isolated ones free their slots", async () => {
  const rig = await pendingWaveRig(7);
  try {
    const deps = { ...rig.deps, externalImplementations: true };
    const first = await planMatrixWave(deps, rig.planOptions());
    assert.equal(first.plan.cells.length, 4, JSON.stringify(first));
    const granted = inFlight(await snapshot(rig));
    assert.equal(granted.length, HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE);
    // Full: the next wave grants none, and its zero-cell diagnostic names
    // the cap and the four resolutions holding it.
    const held = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-rollback-held",
    });
    assert.equal(held.plan.cells.length, 0, JSON.stringify(held));
    assert.deepEqual(held.diagnostic?.conflictResolutionCap, {
      cap: HOSTED_CONFLICT_RESOLUTIONS_PER_WAVE,
      inFlight: granted,
    }, JSON.stringify(held.diagnostic));
    assert.equal(
      held.diagnostic?.notReadyByReason[CONFLICT_CAP_REASON],
      3,
      JSON.stringify(held.diagnostic),
    );
    // Generation 79 fails and rolls back: R78 isolates all four unconsumed
    // cells, the most one rollback can strand.
    const isolated = await isolateAsR78(rig, granted);
    if (await gen78Available()) await assertGen78Parses(isolated);
    assert.deepEqual(inFlight(isolated), []);
    const stranded = isolated.work.filter((work) => granted.includes(work.id));
    assert.ok(stranded.every((work) => work.nextStep === "blocked"));
    assert.ok(
      stranded.every((work) =>
        conflictResolutionInFlight(work.intent) !== null
      ),
      "the marked admission is retained",
    );
    // Rolled forward: the isolated four hold no slot, so the remaining three
    // pending resolutions are granted; the isolated records and their
    // `reserved` charges stay exactly as R78 left them.
    const forward = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-roll-forward",
    });
    assert.equal(forward.plan.cells.length, 3, JSON.stringify(forward));
    const after = await snapshot(rig);
    const flying = inFlight(after);
    assert.equal(flying.length, 3);
    assert.ok(flying.every((id) => !granted.includes(id)));
    assert.deepEqual(
      after.work.filter((work) => granted.includes(work.id)),
      stranded,
    );
    for (const id of granted) {
      const charges = after.reservations.filter((row) => row.taskId === id);
      assert.equal(charges.length, 1);
      assert.equal(charges[0].outcome, "reserved", "never refunded");
    }
    assert.equal(after.reservations.length, 7, "one charge per resolution");
    assert.equal(
      after.work.filter((work) =>
        pendingConflictResolution(work.intent) !== null
      ).length,
      0,
    );
    // A second rollback can strand only those three: at most the cap.
    const again = await isolateAsR78(rig, flying);
    if (await gen78Available()) await assertGen78Parses(again);
    assert.deepEqual(inFlight(again), []);
    const last = await planMatrixWave(deps, {
      ...rig.planOptions(),
      waveId: "wave-conflict-roll-forward-2",
    });
    assert.equal(last.plan.cells.length, 0, "nothing left pending");
    assert.equal(last.diagnostic?.conflictResolutionCap, undefined);
    assert.deepEqual(await snapshot(rig), again);
  } finally {
    await rig.cleanup();
  }
});

type Rig = Awaited<ReturnType<typeof fixture>>;
type RecoverInput = Parameters<
  ReturnType<typeof createActionsMatrixArtifactTransport>["recover"]
>[0];
type Transport = { recover(input: RecoverInput): Promise<unknown> };

/** Re-bind the planner's conflict request and every digest over it. */
async function bindConflict(
  rig: Rig,
  options: { marker?: GitSha; findings?: boolean } = {},
) {
  const work = rig.repair.work[0];
  work.target.head = SHA2;
  work.target.pr = 12;
  work.createdAt = T0 - 10_000;
  work.intent!.failure = conflictMarker(options.marker ?? MERGE, T0);
  rig.cell.request.checkoutBase = SHA2;
  rig.cell.request.mergeBase = MERGE;
  if (options.findings === true) {
    rig.cell.request.reviewFindings = [{
      severity: "P1",
      path: null,
      message: "resolve",
    }];
  }
  rig.cell.requestDigest = await matrixDigestV1(rig.cell.request);
  rig.result.requestDigest = rig.cell.requestDigest;
  rig.result.bundle!.head = SHA3;
  rig.result.receipt!.candidate!.head = SHA3;
  rig.plannerMarker.planDigest = await matrixDigestV1(rig.plan);
  rig.logs.set(401, ISO + " " + JSON.stringify(rig.plannerMarker) + "\n");
  rig.cellMarker.resultDigest = await matrixDigestV1(rig.result);
  rig.logs.set(402, ISO + " " + JSON.stringify(rig.cellMarker) + "\n");
  await rig.setArchive(
    501,
    rig.planName,
    await zip([{ name: "plan.json", content: bytes(rig.plan) }]),
  );
  await rig.setArchive(
    502,
    rig.cellName,
    await zip([
      { name: "result.json", content: bytes(rig.result) },
      { name: rig.result.bundle!.file, content: rig.bundle },
    ]),
  );
}

/** A later consumer run of another runtime over the producer's wave. */
async function recoverWith(
  rig: Rig,
  factory: typeof createActionsMatrixArtifactTransport,
) {
  const transport = factory({
    state: rig.state,
    token: "fake-local-token",
    http: rig.http,
    clock: { now: () => T0 + 10_000 },
    artifactRoot: `${rig.tmp}/recovered`,
  }) as Transport;
  const cwd = Deno.cwd();
  Deno.chdir(`${rig.tmp}/checkout`);
  try {
    return await transport.recover({
      ...rig.input,
      currentRun: undefined,
      runtimeSha: SHA3,
      consumerRun: { ...RUN, runId: 99, runAttempt: 1 },
    });
  } catch (error) {
    return error;
  } finally {
    Deno.chdir(cwd);
  }
}

Deno.test("matrix consumer: a bound conflict cell passes the wave gate; a foreign marker or findings never do", async (t) => {
  for (
    const [name, options, accepted] of [
      ["bound cell", {}, true],
      ["marker names another base", { marker: SHA3 }, false],
      ["cell carries findings", { findings: true }, false],
    ] as const
  ) {
    await t.step(name, async () => {
      const rig = await fixture();
      try {
        await bindConflict(rig, options);
        const outcome = await recoverWith(
          rig,
          createActionsMatrixArtifactTransport,
        );
        if (accepted) {
          // Past the gate: only the authenticated runtime mismatch remains.
          assert.ok(
            outcome instanceof MatrixHistoricalRuntimeMismatch,
            String(outcome),
          );
        } else {
          assert.ok(outcome instanceof Error, String(outcome));
          assert.ok(!(outcome instanceof MatrixHistoricalRuntimeMismatch));
          assert.match(
            String(outcome),
            /provenance unavailable or conflicting/,
          );
        }
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    });
  }
});

Deno.test({
  name:
    "rollback: generation 77's consumer refuses a conflict cell outright (why generation 78 kept the hosted route closed)",
  ignore: !(await gen77Available()),
  async fn() {
    const gen77 = await loadGen77Modules([
      "src/host/matrix-artifacts.ts",
      "src/host/matrix-artifact-port.ts",
    ]);
    try {
      const factory77 = gen77.modules[0]
        .createActionsMatrixArtifactTransport as typeof createActionsMatrixArtifactTransport;
      const Mismatch77 = gen77.modules[1]
        .MatrixHistoricalRuntimeMismatch as typeof MatrixHistoricalRuntimeMismatch;
      const rig = await fixture();
      try {
        await bindConflict(rig);
        const refused = await recoverWith(rig, factory77);
        assert.ok(refused instanceof Error, String(refused));
        assert.ok(!(refused instanceof Mismatch77), "never isolatable");
      } finally {
        await Deno.remove(rig.tmp, { recursive: true });
      }
    } finally {
      await gen77.dispose();
    }
  },
});
