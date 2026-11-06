/** Hosted maintenance must retain charged history after ledger compaction. */
import assert from "node:assert/strict";
import {
  planHostedRetries,
  settledReviewAttempts,
  taskReservationCount,
  usedAttempts,
} from "../../ops/hosted-autonomy-retries.ts";
import { settledSince } from "../../ops/hosted-autonomy-continuation.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { reservation, SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  BASE,
  blockedRecord,
  HEAD,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

function compacted(snapshot: RepairStateSnapshotV1): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    ...snapshot,
    reservations: snapshot.reservations.filter((row) =>
      row.outcome === "reserved"
    ),
    reservationArchive: [
      ...(snapshot.reservationArchive ?? []),
      ...snapshot.reservations.filter((row) => row.outcome !== "reserved"),
    ],
  });
}

Deno.test("hosted reservation readers: archived attempts remain charged and occupied", () => {
  const record = blockedRecord({
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
  });
  const live = repairSnapshot([record], [], [], [
    reservation("implementation", {
      repository: record.repository,
      taskId: TARGET,
      head: BASE,
      attempt: 2,
      outcome: "submitted",
      settledAt: T0 + 2000,
    }),
    reservation("review", {
      repository: record.repository,
      taskId: TARGET,
      head: HEAD,
      attempt: 3,
      purpose: "review_request",
      outcome: "submitted",
      settledAt: T0 + 2000,
    }),
    reservation("pending", {
      repository: record.repository,
      taskId: TARGET,
      head: BASE,
      attempt: 4,
    }),
  ]);
  const archived = compacted(live);
  assert.equal(taskReservationCount(archived, TARGET), 3);
  assert.deepEqual(
    usedAttempts(archived, TARGET, BASE, "implementation"),
    new Set([4, 2]),
  );
  assert.deepEqual(settledReviewAttempts(archived, record), new Set([3]));
  assert.deepEqual(
    planHostedRetries(archived, T0 + 5000, SHA1),
    planHostedRetries(live, T0 + 5000, SHA1),
  );
});

Deno.test("hosted reservation readers: retry plans are invariant under compaction", () => {
  const record = blockedRecord({
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
  });
  const snapshot = repairSnapshot([record], [], [], [
    reservation("settled", {
      repository: record.repository,
      taskId: TARGET,
      head: BASE,
      attempt: 5,
      outcome: "submitted",
      settledAt: T0 + 2000,
    }),
  ]);
  const plans = planHostedRetries(snapshot, T0 + 5000, SHA1);
  assert.equal(plans.length, 1);
  assert.deepEqual(
    planHostedRetries(compacted(snapshot), T0 + 5000, SHA1),
    plans,
  );
});

Deno.test("hosted reservation readers: continuation observes a charge settled into the archive", () => {
  const record = workRecord("archived-settlement");
  const charge = reservation("settling", { taskId: record.id });
  const before = repairSnapshot([record], [], [], [charge]);
  const settled = parseRepairStateSnapshotV1({
    ...before,
    reservations: [],
    reservationArchive: [{
      ...charge,
      outcome: "submitted",
      settledAt: T0 + 2000,
    }],
  });
  assert.deepEqual(settledSince(before, settled), new Set([record.id]));
  const liveSettlement = {
    ...settled,
    reservations: settled.reservationArchive!,
    reservationArchive: [],
  };
  assert.deepEqual(settledSince(liveSettlement, settled), new Set());
});
