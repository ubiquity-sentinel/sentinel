// The live reservation ledger is bounded; the trusted writer compacts its
// oldest settled rows into the durable archive so the next admission fits.
import assert from "node:assert/strict";
import { MaxItems } from "../../src/contracts/validation.ts";
import {
  findReservationV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { validateRepairTransition } from "../../src/state/state-repair-transition.ts";
import {
  compactReservationLedgerV1,
  ReservationLedgerCapacityError,
} from "../../src/state/state-reservation-archive.ts";
import {
  appliedHead,
  makeCtx,
  repairSnapshot,
  storeAt,
} from "./git-state-fixtures.ts";
import { reservation, SHA1, T0, workRecord } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const OLD = T0 - 8 * DAY;

function settled(id: string) {
  return reservation(id, {
    createdAt: OLD,
    outcome: "submitted" as const,
    settledAt: OLD + 1_000,
  });
}

function reserved(id: string) {
  return reservation(id, { createdAt: T0, outcome: "reserved" as const });
}

Deno.test("state: reservation compaction archives oldest settled rows and admits the overflow", async () => {
  const ctx = await makeCtx("archive");
  try {
    const store = storeAt(ctx, "a", "repair");
    const settledRows = Array.from(
      { length: MaxItems.snapshotRecords - 2 },
      (_, index) => settled(`r:${String(index).padStart(5, "0")}`),
    );
    const liveRows = [reserved("r:live-0"), reserved("r:live-1")];
    const head1 = appliedHead(
      await store.writeRepair(
        repairSnapshot({ reservations: [...settledRows, ...liveRows] }),
        null,
      ),
    );

    // The 2049th reservation: oldest settled first, never an unsettled row.
    const overflow = await store.writeRepair(
      repairSnapshot({
        stateHead: head1,
        sequence: 2,
        updatedAt: T0 + 1_000,
        reservations: [...settledRows, ...liveRows, reserved("r:live-2")],
      }),
      head1,
    );
    assert.ok(overflow.ok, JSON.stringify(overflow));
    if (!overflow.ok) return;
    assert.equal(overflow.value.status, "applied");
    const head2 = overflow.ok && overflow.value.status === "applied"
      ? overflow.value.head
      : null;
    assert.ok(head2);

    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found", JSON.stringify(read));
    if (!read.ok || read.value.status !== "found") return;
    const snapshot = read.value.snapshot;
    assert.equal(snapshot.reservations.length, MaxItems.snapshotRecords);
    assert.deepEqual(
      snapshot.reservationArchive?.map((row) => row.id),
      ["r:00000"],
      "exactly the oldest settled row moved",
    );
    for (const id of ["r:live-0", "r:live-1", "r:live-2"]) {
      assert.ok(
        snapshot.reservations.some((row) => row.id === id),
        `unsettled ${id} stays live`,
      );
    }
    assert.deepEqual(
      findReservationV1(snapshot, "r:00000"),
      snapshot.reservationArchive?.[0],
      "the reader resolves an archived reservation id",
    );

    // The following overflow archives the next-oldest settled row.
    const next = await store.writeRepair(
      repairSnapshot({
        stateHead: head2,
        sequence: 3,
        updatedAt: T0 + 2_000,
        reservations: [...snapshot.reservations, reserved("r:live-3")],
        reservationArchive: snapshot.reservationArchive,
      }),
      head2,
    );
    assert.ok(next.ok);
    if (!next.ok) return;
    assert.equal(next.value.status, "applied");
    const readAgain = await store.readRepair();
    assert.ok(readAgain.ok && readAgain.value.status === "found");
    if (!readAgain.ok || readAgain.value.status !== "found") return;
    assert.deepEqual(
      readAgain.value.snapshot.reservationArchive?.map((row) => row.id),
      ["r:00000", "r:00001"],
      "oldest-first ordering across commits",
    );
    assert.equal(
      readAgain.value.snapshot.reservations.length,
      MaxItems.snapshotRecords,
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: a settled ambiguous reservation is never archived", () => {
  const ambiguous = reservation("r:ambiguous", {
    createdAt: OLD,
    outcome: "ambiguous" as const,
    settledAt: OLD + 1_000,
  });
  const terminal = Array.from(
    { length: MaxItems.snapshotRecords - 1 },
    (_, index) => settled(`r:${String(index).padStart(5, "0")}`),
  );
  // The ambiguous row is the oldest, but only terminal rows are eligible.
  const compacted = compactReservationLedgerV1(repairSnapshot({
    updatedAt: T0,
    reservations: [
      ambiguous,
      ...terminal,
      reserved("r:live"),
    ],
  }));
  assert.equal(compacted.reservations.length, MaxItems.snapshotRecords);
  assert.ok(
    compacted.reservations.some((row) => row.id === "r:ambiguous"),
    "a resolvable ambiguous charge stays live",
  );
  assert.deepEqual(
    compacted.reservationArchive?.map((row) => row.id),
    ["r:00000"],
    "the oldest terminal row is archived instead",
  );
});

Deno.test("state: a ledger holding only non-archivable rows refuses precisely", () => {
  const rows = Array.from(
    { length: MaxItems.snapshotRecords + 1 },
    (_, index) =>
      reservation(`r:${String(index).padStart(5, "0")}`, {
        createdAt: OLD,
        outcome: "ambiguous" as const,
        settledAt: OLD + 1_000,
      }),
  );
  assert.throws(
    () =>
      compactReservationLedgerV1(repairSnapshot({
        updatedAt: T0,
        reservations: rows,
      })),
    (error) =>
      error instanceof ReservationLedgerCapacityError &&
      /capacity refused/.test(error.message) &&
      /ambiguous|non-terminal/.test(error.message),
  );
});

Deno.test("state: a full recent ledger refuses, then admits after the retention window", async () => {
  const ctx = await makeCtx("retry-capacity");
  try {
    const store = storeAt(ctx, "a", "repair");
    const recent = T0 - 60 * 60 * 1000;
    const rows = Array.from(
      { length: MaxItems.snapshotRecords },
      (_, index) =>
        reservation(`r:${String(index).padStart(5, "0")}`, {
          createdAt: OLD,
          outcome: "submitted" as const,
          settledAt: recent,
        }),
    );
    const withOverflow = [...rows, reserved("r:live")];
    const refused = await store.writeRepair(
      repairSnapshot({ updatedAt: T0, reservations: withOverflow }),
      null,
    );
    assert.equal(refused.ok, false, JSON.stringify(refused));
    if (!refused.ok) {
      assert.equal(refused.error.kind, "invalid");
      assert.match(refused.error.detail, /capacity refused/);
    }

    // Seven days later the same rows are past the attempt-memory window, so
    // the trusted writer compacts one oldest terminal row and applies the
    // identical overflow admission.
    const applied = await store.writeRepair(
      repairSnapshot({
        updatedAt: T0 + 7 * DAY,
        reservations: withOverflow,
      }),
      null,
    );
    assert.ok(applied.ok, JSON.stringify(applied));
    if (!applied.ok) return;
    assert.equal(applied.value.status, "applied");
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") return;
    assert.equal(
      read.value.snapshot.reservations.length,
      MaxItems.snapshotRecords,
    );
    assert.deepEqual(
      read.value.snapshot.reservationArchive?.map((row) => row.id),
      ["r:00000"],
    );
    assert.ok(
      read.value.snapshot.reservations.some((row) => row.id === "r:live"),
      "the admitted reservation stays live",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: a reservation referenced by work intent is never archived", () => {
  const referencedId = "r:00000";
  const terminal = Array.from(
    { length: MaxItems.snapshotRecords },
    (_, index) =>
      reservation(`r:${String(index).padStart(5, "0")}`, {
        createdAt: OLD,
        outcome: "submitted" as const,
        settledAt: OLD + 1_000 + index,
      }),
  );
  const work = workRecord("issue-referenced", {
    intent: {
      kind: "implementation",
      key: "impl:referenced",
      startedAt: T0,
      branch: null,
      expectedHead: SHA1,
      observedBase: SHA1,
      pr: null,
      requestId: referencedId,
      resultId: null,
    },
  });
  const compacted = compactReservationLedgerV1(repairSnapshot({
    updatedAt: T0,
    work: [work],
    reservations: [...terminal, reserved("r:live")],
  }));
  assert.ok(
    compacted.reservations.some((row) => row.id === referencedId),
    "the referenced reservation stays live",
  );
  assert.deepEqual(
    compacted.reservationArchive?.map((row) => row.id),
    ["r:00001"],
    "the next-oldest unreferenced terminal row is archived instead",
  );
});

Deno.test("state: archive retirement never drops a referenced terminal row", () => {
  const referencedId = "r:referenced";
  const archiveRows = [
    ...Array.from(
      { length: MaxItems.reservationArchiveRecords - 1 },
      (_, index) =>
        reservation(`r:recent-${String(index).padStart(5, "0")}`, {
          createdAt: OLD,
          outcome: "submitted" as const,
          settledAt: T0 - 60 * 60 * 1000,
        }),
    ),
    reservation(referencedId, {
      createdAt: OLD - 1_000,
      outcome: "submitted" as const,
      settledAt: OLD - 500,
    }),
  ];
  const live = Array.from(
    { length: MaxItems.snapshotRecords },
    (_, index) =>
      reservation(`r:live-${String(index).padStart(5, "0")}`, {
        createdAt: OLD,
        outcome: "submitted" as const,
        // Older than the 6h attempt-memory window but still inside the
        // seven-day accounting window: eligible to archive, not to retire.
        settledAt: T0 - 2 * DAY + index,
      }),
  );
  const work = workRecord("issue-retained", {
    intent: {
      kind: "implementation",
      key: "impl:retained",
      startedAt: T0,
      branch: null,
      expectedHead: SHA1,
      observedBase: SHA1,
      pr: null,
      requestId: referencedId,
      resultId: null,
    },
  });
  assert.throws(
    () =>
      compactReservationLedgerV1(repairSnapshot({
        updatedAt: T0,
        work: [work],
        reservations: [...live, reserved("r:overflow")],
        reservationArchive: archiveRows,
      })),
    (error) =>
      error instanceof ReservationLedgerCapacityError &&
      /capacity refused/.test(error.message),
    "the referenced row and the in-window rows cannot be retired",
  );
});

Deno.test("state: a full archive retires retained history, not the row just moved from live", async () => {
  const oldest = settled("r:oldest-live");
  const live = [
    oldest,
    ...Array.from(
      { length: MaxItems.snapshotRecords - 1 },
      (_, index) => reserved(`r:live-${index}`),
    ),
  ];
  const archive = Array.from(
    { length: MaxItems.reservationArchiveRecords },
    (_, index) => ({
      ...settled(`r:archive-${String(index).padStart(5, "0")}`),
      settledAt: oldest.settledAt! + 1_000 + index,
    }),
  );
  const prior = repairSnapshot({
    reservations: live,
    reservationArchive: archive,
  });
  const overflow = {
    ...prior,
    sequence: prior.sequence + 1,
    updatedAt: prior.updatedAt + 1_000,
    reservations: [...live, reserved("r:overflow")],
  };
  const next = compactReservationLedgerV1(overflow);

  assert.equal(next.reservations.length, MaxItems.snapshotRecords);
  assert.equal(
    next.reservationArchive?.length,
    MaxItems.reservationArchiveRecords,
  );
  assert.deepEqual(findReservationV1(next, oldest.id), oldest);
  assert.equal(findReservationV1(next, archive[0].id), undefined);
  assert.equal(validateRepairTransition(prior, next), null);

  // Exercise the trusted writer's compaction, transition validation and
  // durable archive reader together, not only the compaction helper.
  const ctx = await makeCtx("archive-full");
  try {
    const store = storeAt(ctx, "a", "repair");
    const head = appliedHead(await store.writeRepair(prior, null));
    appliedHead(
      await store.writeRepair({ ...overflow, stateHead: head }, head),
    );
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") return;
    assert.deepEqual(findReservationV1(read.value.snapshot, oldest.id), oldest);
    assert.equal(
      findReservationV1(read.value.snapshot, archive[0].id),
      undefined,
    );
    assert.deepEqual(
      findReservationV1(read.value.snapshot, "r:overflow"),
      reserved("r:overflow"),
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("state: archived reservations are immutable and never return live", () => {
  const archived = settled("r:archived");
  const prior = repairSnapshot({
    updatedAt: T0,
    reservations: [],
    reservationArchive: [archived],
  });
  assert.match(
    validateRepairTransition(prior, {
      ...prior,
      updatedAt: T0 + 1_000,
      reservations: [{ ...archived, settledAt: archived.settledAt! + 1 }],
      reservationArchive: [],
    }) ?? "",
    /cannot return to the live ledger/,
  );
  assert.match(
    validateRepairTransition(prior, {
      ...prior,
      updatedAt: T0 + 1_000,
      reservationArchive: [{
        ...archived,
        outcome: "confirmed_not_submitted" as const,
        proofRef: "artifact://proof/rewritten",
      }],
    }) ?? "",
    /immutable/,
  );
  assert.match(
    validateRepairTransition(prior, {
      ...prior,
      updatedAt: T0 + 1_000,
      reservationArchive: [],
    }) ?? "",
    /cannot disappear below the archive bound/,
  );
});

Deno.test("state: the archive parser rejects a settled ambiguous row", () => {
  const ambiguous = reservation("r:ambiguous-archived", {
    createdAt: OLD,
    outcome: "ambiguous" as const,
    settledAt: OLD + 1_000,
  });
  assert.throws(
    () =>
      parseRepairStateSnapshotV1(repairSnapshot({
        updatedAt: T0,
        reservationArchive: [ambiguous],
      })),
    /only a terminal reservation may be archived|terminal/,
  );
});
