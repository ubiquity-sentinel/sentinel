// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import { T0 } from "../state/helpers.ts";
import {
  FakeClock,
  MemoryRepairState,
  reserveRequest,
  seededReservation,
} from "./helpers.ts";
import { budget, snapshot } from "./controller-fixtures.ts";

Deno.test("budget: settlement machine preserves createdAt, idempotence and immutability", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const controller = budget(clock, state);
  const reserved = await controller.reserveModelStart(reserveRequest("task:s"));
  assert.equal(reserved.status, "admitted");
  if (reserved.status !== "admitted") throw new Error("unreachable");
  const id = reserved.reservation.id;

  const ambiguous = await controller.settleModelStart({
    id,
    outcome: "ambiguous",
    proofRef: null,
  });
  assert.equal(ambiguous.status, "settled");
  if (ambiguous.status === "settled") {
    assert.equal(ambiguous.reservation.outcome, "ambiguous");
    assert.equal(ambiguous.reservation.createdAt, T0, "createdAt is preserved");
    assert.equal(ambiguous.reservation.settledAt, T0);
  }
  const writesAfterFirst = state.writes;

  // Equal repeated settlement: idempotent, no new state commit, no timestamp move.
  const repeated = await controller.settleModelStart({
    id,
    outcome: "ambiguous",
    proofRef: null,
  });
  assert.equal(repeated.status, "idempotent");
  if (repeated.status === "idempotent") {
    assert.equal(repeated.reservation.settledAt, T0);
  }
  assert.equal(state.writes, writesAfterFirst);

  // Ambiguous -> submitted must stay charged and may only move forward.
  const submitted = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(submitted.status, "settled");
  if (submitted.status === "settled") {
    assert.equal(submitted.reservation.outcome, "submitted");
    assert.equal(submitted.reservation.createdAt, T0);
  }

  const repeatedSubmitted = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(repeatedSubmitted.status, "idempotent");

  // Contradictory terminal outcome and changed proof are rejected.
  const contradictory = await controller.settleModelStart({
    id,
    outcome: "confirmed_not_submitted",
    proofRef: "artifact://proof/s",
  });
  assert.equal(contradictory.status, "invalid");

  const proofOnCharged = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: "artifact://proof/s",
  });
  assert.equal(proofOnCharged.status, "invalid");

  const unknown = await controller.settleModelStart({
    id: "no-such-id",
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(unknown.status, "invalid");

  const noProof = await controller.settleModelStart({
    id,
    outcome: "confirmed_not_submitted",
    proofRef: null,
  });
  assert.equal(noProof.status, "invalid");
});

Deno.test("budget: ambiguous resolves with proof; changed settled proof is rejected", async () => {
  const clock = new FakeClock(T0 + 10_000);
  const state = new MemoryRepairState();
  const controller = budget(clock, state);
  const reserved = await controller.reserveModelStart(
    reserveRequest("task:amb"),
  );
  assert.equal(reserved.status, "admitted");
  if (reserved.status !== "admitted") throw new Error("unreachable");
  const id = reserved.reservation.id;

  const ambiguous = await controller.settleModelStart({
    id,
    outcome: "ambiguous",
    proofRef: null,
  });
  assert.equal(ambiguous.status, "settled");

  const refunded = await controller.settleModelStart({
    id,
    outcome: "confirmed_not_submitted",
    proofRef: "artifact://proof/amb",
  });
  assert.equal(refunded.status, "settled");
  if (refunded.status === "settled") {
    assert.equal(refunded.reservation.proofRef, "artifact://proof/amb");
  }

  // A different proof for the already-confirmed refund is a rejection.
  const changedProof = await controller.settleModelStart({
    id,
    outcome: "confirmed_not_submitted",
    proofRef: "artifact://proof/other",
  });
  assert.equal(changedProof.status, "invalid");
  const sameProof = await controller.settleModelStart({
    id,
    outcome: "confirmed_not_submitted",
    proofRef: "artifact://proof/amb",
  });
  assert.equal(sameProof.status, "idempotent");
});

Deno.test("budget: read/CAS/ambiguity/persistence failures never admit; reread reconciles", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const controller = budget(clock, state);
  const request = reserveRequest("task:fail");
  // Invocation is simulated only for an admitted result.
  let starts = 0;
  const note = (result: { status: string }): void => {
    if (result.status === "admitted") starts++;
  };

  state.fault = "read_fail";
  const readFailure = await controller.reserveModelStart(request);
  assert.equal(readFailure.status, "unavailable");
  note(readFailure);

  state.fault = "write_fail";
  const writeFailure = await controller.reserveModelStart(request);
  assert.equal(writeFailure.status, "unavailable");
  note(writeFailure);

  // Ambiguous: the write may have applied; no start is granted from this
  // response. Rereading finds the durable reservation, so the same identity
  // reconciles and can never start again.
  state.fault = "write_ambiguous";
  const ambiguous = await controller.reserveModelStart(request);
  assert.equal(ambiguous.status, "ambiguous");
  note(ambiguous);

  // A different identity against the advanced head hits a CAS conflict; the
  // conflicting write must never grant a start either.
  state.fault = "write_conflict";
  const conflict = await controller.reserveModelStart(
    reserveRequest("task:conflict", { taskId: "task:conflict" as WorkItemId }),
  );
  assert.equal(conflict.status, "conflict");
  note(conflict);

  const duplicate = await controller.reserveModelStart(request);
  assert.equal(duplicate.status, "duplicate");
  if (duplicate.status === "duplicate") {
    assert.equal(duplicate.reservation.outcome, "reserved");
  }
  note(duplicate);

  assert.equal(starts, 0, "no non-admitted result grants a start");
  assert.equal(state.current().snapshot?.reservations.length, 1);
});

Deno.test("budget: rejected read and write promises are sanitized and never admit", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const controller = budget(clock, state);
  const request = reserveRequest("task:reject");
  let starts = 0;
  const note = (result: { status: string }): void => {
    if (result.status === "admitted") starts++;
  };

  // A rejected read promise must become a sanitized unavailable, never an
  // escaped raw rejection with transport text.
  state.fault = "read_throw";
  const readRejected = await controller.reserveModelStart(request);
  assert.equal(readRejected.status, "unavailable");
  assert.match(
    (readRejected as { detail: string }).detail,
    /no permission granted/,
  );
  note(readRejected);

  // A rejected write promise is ambiguous (the effect may have happened),
  // currentHead is null (no response identity), and no start is granted.
  state.fault = "write_throw";
  const writeRejected = await controller.reserveModelStart(request);
  assert.equal(writeRejected.status, "ambiguous");
  if (writeRejected.status === "ambiguous") {
    assert.equal(writeRejected.currentHead, null);
  }
  note(writeRejected);

  // The authoritative state never existed: a healthy run still applies once.
  const applied = await controller.reserveModelStart(request);
  assert.equal(applied.status, "admitted");
  note(applied);

  // Settlement rejects identically: read rejection is unavailable and a write
  // rejection is ambiguous with a null currentHead.
  const id = applied.status === "admitted" ? applied.reservation.id : "";
  state.fault = "read_throw";
  const settleRead = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(settleRead.status, "unavailable");
  state.fault = "write_throw";
  const settleWrite = await controller.settleModelStart({
    id,
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(settleWrite.status, "ambiguous");
  if (settleWrite.status === "ambiguous") {
    assert.equal(settleWrite.currentHead, null);
  }
  // The rejection happened before the state capability applied anything in
  // this fake, so the durable record is still reserved and only one start
  // was ever granted. A real transport may have applied the effect; either
  // way the caller reconciles by rereading.
  assert.equal(starts, 1, "only the confirmed apply granted a start");
});

Deno.test("budget: settle is blocked behind durable timestamps, including refunded ones", async () => {
  const clock = new FakeClock(T0 + 4_000);
  const state = new MemoryRepairState();
  state.seed(snapshot({
    updatedAt: T0,
    reservations: [
      seededReservation("amb-1", {
        outcome: "ambiguous",
        createdAt: T0 - 10_000,
        settledAt: T0 + 5_000,
      }),
      seededReservation("refund-1", {
        outcome: "confirmed_not_submitted",
        createdAt: T0 - 9_000,
        settledAt: T0 + 6_000,
        proofRef: "artifact://proof/refund-1",
      }),
    ],
  }));
  const controller = budget(clock, state);
  const result = await controller.settleModelStart({
    id: "amb-1",
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(result.status, "deferred");
  if (result.status === "deferred") {
    assert.equal(result.reason, "clock_regression");
    assert.equal(result.retryAt, T0 + 6_000);
  }
  clock.set(T0 + 6_000);
  const nowOk = await controller.settleModelStart({
    id: "amb-1",
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(nowOk.status, "settled");
});
