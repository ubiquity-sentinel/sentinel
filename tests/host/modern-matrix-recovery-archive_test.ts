/**
 * A wave's settled cell charges live in the durable archive once the trusted
 * writer compacts the ledger; recovery must resolve them there, and an
 * unresolvable charge is a typed skip rather than a failed repair pass.
 */
import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import {
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  closedCWaveHandledReservations,
  closedCWaveNeedsRecovery,
  ClosedCWaveUnrecoverableSkipV1,
  ingestClosedCWave,
  recoverClosedCWave,
} from "../../src/host/modern-matrix-recovery.ts";
import type {
  ClosedCWaveBindingV1,
  ClosedCWaveRecoveryDepsV1,
} from "../../src/host/modern-matrix-recovery.ts";
import {
  REPO,
  reservation,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { releaseSnapshot, repairSnapshot } from "./hosted-autonomy-rig.ts";

const ARCHIVED = "1".repeat(64);
const LIVE = "2".repeat(64);
const ARCHIVED_TASK = "issue-ubiquity-ai.ubq.fi-11" as WorkItemId;
const LIVE_TASK = "issue-ubiquity-ai.ubq.fi-12" as WorkItemId;

const binding: ClosedCWaveBindingV1 = {
  runtimeSha: SHA1,
  generation: 1,
  run: { runId: 7, runAttempt: 1, launcherSha: SHA1 },
  repairCommit: SHA2,
  releaseCommit: SHA2,
  planDigest: "a".repeat(64),
  expectedProvider: "uos",
  cells: [
    {
      reservationId: ARCHIVED,
      taskId: ARCHIVED_TASK,
      repository: REPO,
      base: SHA1,
    },
    { reservationId: LIVE, taskId: LIVE_TASK, repository: REPO, base: SHA1 },
  ],
};

function wave(archive: boolean): RepairStateSnapshotV1 {
  const work = [ARCHIVED_TASK, LIVE_TASK].map((id) =>
    workRecord(id, { nextStep: "done" })
  );
  const live = reservation(LIVE, {
    taskId: LIVE_TASK,
    head: SHA1,
    outcome: "reserved",
    settledAt: null,
  });
  const snapshot = repairSnapshot(work, [], [], [live]);
  if (!archive) return snapshot;
  return parseRepairStateSnapshotV1({
    ...snapshot,
    sequence: snapshot.sequence + 1,
    updatedAt: T0,
    reservationArchive: [reservation(ARCHIVED, {
      taskId: ARCHIVED_TASK,
      head: SHA1,
      attempt: 1,
      outcome: "submitted",
      settledAt: T0 + 1000,
    })],
  });
}

/** Deps whose state reads resolve; no history reader and no write ability. */
function depsFor(snapshot: RepairStateSnapshotV1): ClosedCWaveRecoveryDepsV1 {
  const head = SHA2 as GitSha;
  return {
    state: {
      readRepair: () =>
        Promise.resolve(
          portOk({ status: "found" as const, head, ref: null, snapshot }),
        ),
      readRelease: () =>
        Promise.resolve(portOk({
          status: "found" as const,
          head,
          ref: null,
          snapshot: releaseSnapshot(),
        })),
      writeRepair: () => {
        throw new Error("a typed skip must not write repair state");
      },
    },
    clock: { now: () => T0 },
    configs: [],
    cycleFor: () => {
      throw new Error("an unresolvable wave must not build a cycle");
    },
    prepareTarget: () => {
      throw new Error("an unresolvable wave must not prepare a target");
    },
    importerFor: () => {
      throw new Error("an unresolvable wave must not import");
    },
    transportFor: () => {
      throw new Error("an unresolvable wave must not read history");
    },
    readExecution: () => {
      throw new Error("an unresolvable wave must not read native proof");
    },
    binding,
  };
}

Deno.test("closed C recovery: archived cell charges resolve for recovery", async () => {
  const snapshot = wave(true);
  assert.equal(
    closedCWaveNeedsRecovery(snapshot, binding),
    true,
    "the live cell still needs its recovered artifacts",
  );
  assert.equal(
    closedCWaveHandledReservations(snapshot, binding).has(ARCHIVED),
    true,
    "the compacted cell charge is still a positive protected disposition",
  );
  await assert.rejects(
    () => recoverClosedCWave(depsFor(snapshot)),
    /authenticated history reader unavailable/,
    "the archived charge resolves; recovery proceeds past the admission scope",
  );
});

Deno.test("closed C recovery: an unresolvable charge is a typed skip", async () => {
  const snapshot = wave(false);
  assert.equal(
    closedCWaveNeedsRecovery(snapshot, binding),
    true,
    "the missing charge stays reportable instead of silently retiring",
  );
  await assert.rejects(
    () => recoverClosedCWave(depsFor(snapshot)),
    ClosedCWaveUnrecoverableSkipV1,
  );
  const skipped = await ingestClosedCWave(depsFor(snapshot));
  if (!("skipped" in skipped)) assert.fail("expected a typed skip result");
  assert.deepEqual(skipped.skipped, {
    reason: "missing_reservation",
    reservationIds: [ARCHIVED],
  });
  assert.deepEqual(skipped.dispositions, []);
  assert.deepEqual(skipped.reports, []);
  assert.equal(skipped.repairHead, SHA2);
});

for (const archived of [false, true]) {
  Deno.test(
    `closed C recovery: ${
      archived ? "archived and absent" : "all-absent"
    } charges produce a typed skip`,
    async () => {
      const snapshot = { ...wave(archived), reservations: [] };
      const missing = archived ? [LIVE] : [ARCHIVED, LIVE];
      assert.equal(
        closedCWaveNeedsRecovery(snapshot, binding),
        true,
        "missing charges remain reportable even without any live charges",
      );
      await assert.rejects(
        () => recoverClosedCWave(depsFor(snapshot)),
        (error: unknown) => {
          assert.ok(error instanceof ClosedCWaveUnrecoverableSkipV1);
          assert.deepEqual(error.reservationIds, missing);
          return true;
        },
      );
      assert.deepEqual(await ingestClosedCWave(depsFor(snapshot)), {
        producer: binding.run,
        repairHead: SHA2,
        releaseHead: SHA2,
        dispositions: [],
        reports: [],
        skipped: {
          reason: "missing_reservation",
          reservationIds: missing,
        },
      });
    },
  );
}

Deno.test("closed C recovery: fully archived charges remain a no-op", async () => {
  const original = wave(true);
  const snapshot = parseRepairStateSnapshotV1({
    ...original,
    reservations: [],
    reservationArchive: [
      ...original.reservationArchive ?? [],
      {
        ...original.reservations[0],
        outcome: "submitted",
        settledAt: T0 + 1000,
      },
    ],
  });
  assert.equal(closedCWaveNeedsRecovery(snapshot, binding), false);
  assert.deepEqual(await ingestClosedCWave(depsFor(snapshot)), {
    producer: binding.run,
    repairHead: SHA2,
    releaseHead: SHA2,
    dispositions: [],
    reports: [],
  });
});
