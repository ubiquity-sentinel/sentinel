import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { reservation } from "../state/helpers.ts";
import {
  assertUnavailable,
  blockedWork,
  chargedReservation,
  chargedReservations,
  detail,
  ENCODER,
  extendedRepairSnapshot,
  FINISHED,
  HOUR,
  makeRoot,
  MAX_DISPATCH_BYTES,
  MAX_TEXT,
  produce,
  produceSnapshot,
  repairSnapshot,
  reservationAggregates,
  StatusState,
  WEEK,
  work,
  workAggregates,
} from "./local-status-helpers.ts";
import { expectRecorded } from "./local-status-renderer-helpers.ts";

// ---------------------------------------------------------------------------
// Producer: complete aggregates and bounded detail
// ---------------------------------------------------------------------------

Deno.test("status projection: 0/199/200/201 records keep complete totals", async () => {
  const root = await makeRoot("sentinel-local-status-");
  try {
    for (const size of [0, 199, 200, 201]) {
      const workRecords = Array.from(
        { length: size },
        (_value, index) =>
          work(`w-${String(index).padStart(4, "0")}`, "work", index + 1),
      );
      const reservations = Array.from(
        { length: size },
        (_value, index) =>
          chargedReservation(
            `r-${String(index).padStart(4, "0")}`,
            FINISHED - 1000,
          ),
      );
      const produced = await produceSnapshot(
        repairSnapshot(workRecords, reservations),
        root,
      );
      const W = workAggregates(produced.status);
      const R = reservationAggregates(produced.status);
      const workDetail = detail(produced.status, "work");
      const reservationDetail = detail(produced.status, "reservations");
      // Complete totals come from the known input size, never from the lists.
      assert.equal(W.total, size);
      assert.equal(W.byNextStep.work, size);
      assert.equal(W.byNextStep.blocked, 0);
      assert.equal(W.blocked, 0);
      assert.equal(W.unknownSteps, 0);
      assert.equal(W.omittedBlocked, 0);
      assert.equal(W.omitted, size - workDetail.length);
      assert.equal(R.total, size);
      assert.equal(R.open, size);
      assert.equal(R.settled, 0);
      assert.equal(R.omitted, size - reservationDetail.length);
      // Independent bounds: detail stays at or below 200 items and the
      // serialized status still fits every text/envelope bound even when the
      // byte cap constrains the retained detail below 200.
      assert.ok(workDetail.length <= 200, `work detail ${workDetail.length}`);
      assert.ok(
        reservationDetail.length <= 200,
        `reservation detail ${reservationDetail.length}`,
      );
      assert.ok(produced.fileText.length <= MAX_TEXT);
      assert.ok(ENCODER.encode(produced.fileText).length <= MAX_TEXT);
      assert.ok(
        ENCODER.encode(
          JSON.stringify({ inputs: { status: produced.fileText } }),
        ).length <= MAX_DISPATCH_BYTES,
      );
      assert.equal(
        produced.status.summary,
        W.omitted === 0 && R.omitted === 0 ? "complete" : "truncated",
      );
      assert.equal(
        produced.status.state,
        undefined,
        "available state omits state",
      );
      if (size === 0) {
        assert.equal(R.chargedHour, 0);
        assert.equal(R.chargedSevenDays, 0);
      } else {
        assert.equal(R.chargedHour, size);
        assert.equal(R.chargedSevenDays, size);
      }
      // Admission is explicitly uncapped: the rolling counts stay complete
      // while no size ever records a next eligible start.
      assert.equal(produced.status.nextEligibleStartAt, null);
      if (size === 199 || size === 201) {
        const rendered = await expectRecorded(
          produced.fileText,
          "GREEN",
          `${size} total`,
        );
        assert.ok(
          rendered.summary.includes(
            produced.status.summary === "truncated"
              ? "Report detail: truncated"
              : "Report detail: complete",
          ),
          rendered.summary,
        );
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status projection: 10000 lifetime reservations stay complete and bounded", async () => {
  const root = await makeRoot("sentinel-local-large-");
  try {
    const reservations = Array.from(
      { length: 10_000 },
      (_value, index) =>
        chargedReservation(
          `res-${String(index).padStart(5, "0")}`,
          FINISHED - 21 * 24 * 3_600_000 + index,
        ),
    );
    const workRecords = Array.from(
      { length: 500 },
      (_value, index) =>
        work(`w-${String(index).padStart(4, "0")}`, "work", index + 1),
    );
    const produced = await produceSnapshot(
      extendedRepairSnapshot(workRecords, reservations),
      root,
    );
    const W = workAggregates(produced.status);
    const R = reservationAggregates(produced.status);
    const workDetail = detail(produced.status, "work");
    const reservationDetail = detail(produced.status, "reservations");
    // This container is an intentionally synthetic injected stress snapshot:
    // it is above the frozen 2048-record container cap and assembled from
    // individually parsed reservations, not read from a serialized state file.
    assert.equal(W.total, 500);
    assert.equal(W.omitted, 500 - workDetail.length);
    assert.ok(workDetail.length <= 200);
    assert.equal(R.total, 10_000);
    assert.equal(R.open, 10_000);
    assert.equal(R.omitted, 10_000 - reservationDetail.length);
    assert.ok(R.omitted >= 9_800);
    assert.ok(reservationDetail.length <= 200);
    assert.equal(R.chargedHour, 0);
    assert.equal(R.chargedSevenDays, 0);
    assert.equal(produced.status.summary, "truncated");
    assert.equal(produced.status.nextEligibleStartAt, null);
    // Truncation alone is not a failure: the real renderer stays GREEN.
    await expectRecorded(
      produced.fileText,
      "GREEN",
      "Report detail: truncated",
    );
    await expectRecorded(produced.fileText, "GREEN", "10000 total");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: exact budget semantics
// ---------------------------------------------------------------------------

Deno.test("status projection: rolling usage accounting is retained while admission is uncapped", async () => {
  const root = await makeRoot("sentinel-local-budget-");
  try {
    const status = async (reservations: BudgetReservationV1[]) =>
      await produceSnapshot(repairSnapshot([], reservations), root);

    const none = await status([]);
    assert.equal(reservationAggregates(none.status).chargedHour, 0);
    assert.equal(none.status.nextEligibleStartAt, null);

    // 119 charges still count as rolling usage.
    const underHour = await status(
      chargedReservations("hour-under", 119, FINISHED - 1000),
    );
    const underHourAgg = reservationAggregates(underHour.status);
    assert.equal(underHourAgg.chargedHour, 119);
    assert.equal(underHourAgg.chargedSevenDays, 119);
    assert.equal(underHour.status.nextEligibleStartAt, null);

    // 120 charges reach the retired hourly threshold: the count is retained, but
    // uncapped admission records no retry.
    const atHour = await status(
      chargedReservations("hour-at", 120, FINISHED - 1000),
    );
    const atHourAgg = reservationAggregates(atHour.status);
    assert.equal(atHourAgg.chargedHour, 120);
    assert.equal(atHourAgg.chargedSevenDays, 120);
    assert.equal(atHour.status.nextEligibleStartAt, null);

    // 121 charges stay fully counted even past the retired threshold.
    const overHour = await status([
      chargedReservation("hour-new", FINISHED - 100),
      ...chargedReservations("hour-mid", 119, FINISHED - 2000),
      chargedReservation("hour-old", FINISHED - 5000),
    ]);
    const overHourAgg = reservationAggregates(overHour.status);
    assert.equal(overHourAgg.chargedHour, 121);
    assert.equal(overHourAgg.chargedSevenDays, 121);
    assert.equal(overHour.status.nextEligibleStartAt, null);

    // Window is (finishedAt - HOUR, finishedAt]: the exact lower bound is out.
    const atBoundary = await status(
      chargedReservations("hour-boundary", 120, FINISHED - HOUR),
    );
    assert.equal(reservationAggregates(atBoundary.status).chargedHour, 0);
    assert.equal(atBoundary.status.nextEligibleStartAt, null);
    const justOutside = await status(
      chargedReservations("hour-outside", 120, FINISHED - HOUR - 1),
    );
    assert.equal(reservationAggregates(justOutside.status).chargedHour, 0);
    const justInside = await status(
      chargedReservations("hour-inside", 120, FINISHED - HOUR + 1),
    );
    assert.equal(reservationAggregates(justInside.status).chargedHour, 120);
    assert.equal(justInside.status.nextEligibleStartAt, null);

    // Exactly the observation timestamp is inside both windows.
    const atNow = await status(
      chargedReservations("hour-now", 120, FINISHED),
    );
    const atNowAgg = reservationAggregates(atNow.status);
    assert.equal(atNowAgg.chargedHour, 120);
    assert.equal(atNowAgg.chargedSevenDays, 120);
    assert.equal(atNow.status.nextEligibleStartAt, null);

    // 167/168/169 charges inside the week but outside the hour: retained as
    // historical seven-day usage only, never a weekly deferral.
    const weekly = (count: number) =>
      Array.from({ length: count }, (_value, index) =>
        chargedReservation(
          `week-${String(index).padStart(3, "0")}`,
          FINISHED - HOUR - 1000 - index * 60_000,
        ));
    const under = await status(weekly(167));
    assert.equal(reservationAggregates(under.status).chargedSevenDays, 167);
    assert.equal(under.status.nextEligibleStartAt, null);
    const atWeek = await status(weekly(168));
    const atWeekAgg = reservationAggregates(atWeek.status);
    assert.equal(atWeekAgg.chargedSevenDays, 168);
    assert.equal(atWeekAgg.chargedHour, 0);
    assert.equal(atWeek.status.nextEligibleStartAt, null);
    const overWeek = await status(weekly(169));
    assert.equal(reservationAggregates(overWeek.status).chargedSevenDays, 169);
    // Retained historical usage never defers anything under uncapped
    // admission.
    assert.equal(overWeek.status.nextEligibleStartAt, null);
    assert.equal(
      overWeek.status.nextEligibleStartAt,
      atWeek.status.nextEligibleStartAt,
    );
    // The embedded renderer renders that historical usage as uncapped, with an
    // explicit null-free label and no deferral claim.
    const overWeekRendered = await expectRecorded(
      overWeek.fileText,
      "GREEN",
      "Rolling usage: 0 charged in the last hour; 169 charged in the last seven days (historical usage, no admission caps)",
    );
    assert.ok(
      overWeekRendered.summary.includes(
        "Next eligible local start (UTC): none recorded (admission is uncapped)",
      ),
      overWeekRendered.summary,
    );
    assert.ok(
      !overWeekRendered.summary.includes("of null"),
      overWeekRendered.summary,
    );

    // Weekly lower bound: (finishedAt - WEEK, finishedAt].
    const weekBoundary = (createdAt: number) =>
      Array.from(
        { length: 168 },
        (_value, index) =>
          chargedReservation(`wk-${String(index).padStart(3, "0")}`, createdAt),
      );
    const weekUnderBoundary = await status(
      weekBoundary(FINISHED - WEEK + 1).slice(0, 167),
    );
    assert.equal(
      reservationAggregates(weekUnderBoundary.status).chargedSevenDays,
      167,
    );
    assert.equal(weekUnderBoundary.status.nextEligibleStartAt, null);
    const weekAtBoundary = await status(weekBoundary(FINISHED - WEEK));
    assert.equal(
      reservationAggregates(weekAtBoundary.status).chargedSevenDays,
      0,
    );
    assert.equal(weekAtBoundary.status.nextEligibleStartAt, null);
    const weekOutsideBoundary = await status(weekBoundary(FINISHED - WEEK - 1));
    assert.equal(
      reservationAggregates(weekOutsideBoundary.status).chargedSevenDays,
      0,
    );
    assert.equal(weekOutsideBoundary.status.nextEligibleStartAt, null);
    const weekInsideBoundary = await status(weekBoundary(FINISHED - WEEK + 1));
    assert.equal(
      reservationAggregates(weekInsideBoundary.status).chargedSevenDays,
      168,
    );
    assert.equal(
      reservationAggregates(weekInsideBoundary.status).chargedHour,
      0,
    );
    assert.equal(weekInsideBoundary.status.nextEligibleStartAt, null);
    // 168 historical charges exactly at the observation time are all counted in
    // the rolling hour; uncapped admission still records no retry.
    const weekAtNow = await status(weekBoundary(FINISHED));
    const weekAtNowAgg = reservationAggregates(weekAtNow.status);
    assert.equal(weekAtNowAgg.chargedHour, 168);
    assert.equal(weekAtNowAgg.chargedSevenDays, 168);
    assert.equal(weekAtNow.status.nextEligibleStartAt, null);

    // In-hour charges inside a large weekly history keep both counts while no
    // admission bound exists.
    const both = await status([
      ...chargedReservations("both-hour", 120, FINISHED - 4000),
      ...weekly(168),
    ]);
    const bothAgg = reservationAggregates(both.status);
    assert.equal(bothAgg.chargedHour, 120);
    assert.equal(bothAgg.chargedSevenDays, 288);
    assert.equal(both.status.nextEligibleStartAt, null);

    // Outcomes: only a confirmed non-submission is refunded. One hundred and
    // twenty charged outcomes stay counted; the refunded entry does not count.
    const outcomes = await status([
      chargedReservation("out-reserved", FINISHED - 1000),
      chargedReservation("out-submitted", FINISHED - 1000, {
        outcome: "submitted",
        settledAt: FINISHED - 500,
      }),
      chargedReservation("out-ambiguous", FINISHED - 1000, {
        outcome: "ambiguous",
        settledAt: FINISHED - 500,
      }),
      ...chargedReservations("out-charged", 117, FINISHED - 1000),
      chargedReservation("out-refunded", FINISHED - 1000, {
        outcome: "confirmed_not_submitted",
        settledAt: FINISHED - 500,
        proofRef: "artifact://proof/refunded.json",
      }),
    ]);
    const outcomesAgg = reservationAggregates(outcomes.status);
    assert.equal(outcomesAgg.total, 121);
    assert.equal(outcomesAgg.open, 118);
    assert.equal(outcomesAgg.settled, 3);
    assert.equal(outcomesAgg.chargedHour, 120);
    assert.equal(outcomes.status.nextEligibleStartAt, null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: blocked visibility and stable bounded selection
// ---------------------------------------------------------------------------

Deno.test("status projection: blocked detail survives truncation and is order-stable", async () => {
  const root = await makeRoot("sentinel-local-blocked-");
  try {
    const blocked = Array.from(
      { length: 250 },
      (_value, index) =>
        blockedWork(`blk-${String(index).padStart(3, "0")}`, index + 1),
    );
    const done = Array.from(
      { length: 80 },
      (_value, index) =>
        work(`done-${String(index).padStart(3, "0")}`, "done", index + 1),
    );
    const active = Array.from(
      { length: 10 },
      (_value, index) =>
        work(`act-${String(index).padStart(3, "0")}`, "work", index + 1),
    );
    const orderedWork = [...active, ...done, ...blocked];

    const forward = await produceSnapshot(
      repairSnapshot(orderedWork, []),
      root,
    );
    const W = workAggregates(forward.status);
    assert.equal(W.total, 340);
    assert.equal(W.blocked, 250);
    assert.equal(W.byNextStep.blocked, 250);
    assert.equal(W.omitted, 140);
    assert.equal(W.omittedBlocked, 50);
    assert.equal(forward.status.summary, "truncated");
    const visible = detail(forward.status, "work").map((entry) => entry.id);
    assert.equal(visible.length, 200);
    assert.ok(visible.every((id) => String(id).startsWith("blk-")));
    assert.deepEqual(
      visible,
      blocked.slice(0, 200).map((record) => record.id),
    );

    const reversed = await produceSnapshot(
      repairSnapshot([...orderedWork].reverse(), []),
      root,
    );
    assert.deepEqual(
      detail(reversed.status, "work").map((entry) => entry.id),
      visible,
      "selection does not depend on input order",
    );

    const rendered = await expectRecorded(
      forward.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(rendered.summary.includes("250 total"), rendered.summary);
    assert.ok(
      rendered.summary.includes("50 omitted from the bounded detail"),
      rendered.summary,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: deterministic reduction of oversize optional detail
// ---------------------------------------------------------------------------

Deno.test("status projection: oversize detail is reduced deterministically", async () => {
  const root = await makeRoot("sentinel-local-reduce-");
  try {
    const longId = (index: number) => {
      const base = `blk-${String(index).padStart(3, "0")}-`;
      return base + "x".repeat(256 - base.length);
    };
    const records = Array.from(
      { length: 200 },
      (_value, index) => blockedWork(longId(index), index + 1),
    );
    const produced = await produceSnapshot(repairSnapshot(records), root);
    const W = workAggregates(produced.status);
    const visible = detail(produced.status, "work");
    assert.equal(W.total, 200);
    assert.equal(W.blocked, 200);
    assert.ok(visible.length < 200, "optional detail was reduced to fit");
    assert.equal(W.omitted, 200 - visible.length);
    assert.equal(W.omittedBlocked, 200 - visible.length);
    assert.equal(produced.status.summary, "truncated");
    // Deterministic: the surviving detail is the lexical prefix of the
    // blocked-first ordering.
    assert.deepEqual(
      visible.map((entry) => entry.id),
      records.slice(0, visible.length).map((record) => record.id),
    );

    const repeated = await produceSnapshot(repairSnapshot(records), root);
    assert.deepEqual(
      detail(repeated.status, "work"),
      visible,
      "reduction is deterministic across identical runs",
    );

    const rendered = await expectRecorded(
      produced.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(rendered.summary.includes("200 total"), rendered.summary);
    assert.ok(
      rendered.summary.includes(
        `${200 - visible.length} omitted from the bounded detail`,
      ),
      rendered.summary,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status projection: blocked work survives byte pressure before reservation history", async () => {
  const root = await makeRoot("sentinel-local-mixed-");
  try {
    const longTaskId = (index: number) => {
      const base = `task:r-${String(index).padStart(3, "0")}-`;
      return base + "y".repeat(256 - base.length);
    };
    const reservations = Array.from(
      { length: 200 },
      (_value, index) =>
        chargedReservation(
          `r-${String(index).padStart(3, "0")}`,
          FINISHED - 1000,
          { taskId: longTaskId(index) },
        ),
    );
    const blocked = Array.from(
      { length: 60 },
      (_value, index) =>
        blockedWork(`blk-${String(index).padStart(3, "0")}`, index + 1),
    );
    const done = Array.from(
      { length: 60 },
      (_value, index) =>
        work(`done-${String(index).padStart(3, "0")}`, "done", index + 1),
    );
    const produced = await produceSnapshot(
      repairSnapshot([...done, ...blocked], reservations),
      root,
    );
    const W = workAggregates(produced.status);
    const R = reservationAggregates(produced.status);
    const visibleWork = detail(produced.status, "work");
    const visibleReservations = detail(produced.status, "reservations");
    const visibleBlocked = visibleWork.filter((entry) =>
      entry.nextStep === "blocked"
    ).length;
    assert.equal(W.total, 120);
    assert.equal(W.blocked, 60);
    assert.equal(W.byNextStep.blocked, 60);
    assert.equal(W.omitted, 120 - visibleWork.length);
    assert.equal(W.omittedBlocked, 60 - visibleBlocked);
    assert.equal(R.total, 200);
    assert.equal(R.omitted, 200 - visibleReservations.length);
    // Optional reservation history is dropped first under byte pressure, so
    // every work record, including every blocked one, is still visible.
    assert.ok(
      visibleReservations.length < 200,
      "optional reservation history was reduced",
    );
    assert.equal(visibleWork.length, 120);
    assert.equal(visibleBlocked, 60);
    assert.equal(R.open, 200);
    assert.equal(R.chargedHour, 200);
    assert.equal(R.chargedSevenDays, 200);
    assert.equal(produced.status.summary, "truncated");
    // Uncapped admission still records no next eligible start under pressure.
    assert.equal(produced.status.nextEligibleStartAt, null);
    const rendered = await expectRecorded(
      produced.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("NOT RECORDED"), rendered.summary);
    assert.ok(rendered.summary.includes("200 total"), rendered.summary);
    assert.ok(rendered.summary.includes("60 total"), rendered.summary);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Producer: unknown steps and malformed state
// ---------------------------------------------------------------------------

Deno.test("status projection: unknown steps are labeled and malformed state is unavailable", async () => {
  const root = await makeRoot("sentinel-local-unknown-");
  try {
    const futureStep = {
      ...work("w-future"),
      nextStep: "mystery",
    } as unknown as WorkRecordV1;
    const unknownSnapshot = {
      ...repairSnapshot([work("w-known")]),
      work: [futureStep],
    } as unknown as RepairStateSnapshotV1;
    const unknown = await produceSnapshot(unknownSnapshot, root);
    const W = workAggregates(unknown.status);
    assert.equal(W.total, 1);
    assert.equal(W.unknownSteps, 1);
    assert.equal(W.byNextStep.work, 0);
    const entry = detail(unknown.status, "work")[0];
    assert.equal(entry.nextStep, "unknown");
    assert.ok(
      !unknown.fileText.includes("mystery"),
      "no raw unknown step text",
    );
    await expectRecorded(
      unknown.fileText,
      "RED",
      "unrecognized work steps are present",
    );

    const failedRead = await produce(new StatusState(null, true), root);
    assertUnavailable(failedRead);

    const malformedSnapshot = {
      ...repairSnapshot(),
      work: "not-an-array",
    } as unknown as RepairStateSnapshotV1;
    assertUnavailable(await produceSnapshot(malformedSnapshot, root));

    const malformedReservation = {
      ...repairSnapshot(),
      reservations: [{ ...reservation("bad-1"), createdAt: "yesterday" }],
    } as unknown as RepairStateSnapshotV1;
    assertUnavailable(await produceSnapshot(malformedReservation, root));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("status projection: invalid identity, limits and chronology fail unavailable", async () => {
  const root = await makeRoot("sentinel-local-invalid-");
  try {
    const longInvocation = "i".repeat(400);
    const badIdentity = await produceSnapshot(
      repairSnapshot([work("w-1")]),
      root,
      {
        invocationId: longInvocation,
        controllerSha: "not-a-sha" as unknown as GitSha,
      },
    );
    assertUnavailable(badIdentity);
    assert.equal(badIdentity.status.invocationId, "unavailable");
    assert.equal(badIdentity.status.controllerSha, null);
    assert.ok(!badIdentity.fileText.includes(longInvocation));
    assert.ok(badIdentity.fileText.length < 2000);

    const unordered = await produceSnapshot(
      repairSnapshot(),
      root,
      { startedAt: FINISHED + 1000, finishedAt: FINISHED },
    );
    assertUnavailable(unordered);
    assert.equal(unordered.status.startedAt, null);
    assert.equal(unordered.status.finishedAt, null);

    const nanTime = await produceSnapshot(
      repairSnapshot(),
      root,
      { startedAt: Number.NaN },
    );
    assertUnavailable(nanTime);

    const badLimits = await produceSnapshot(repairSnapshot(), root, {
      config: { ...createLocalRepositoryConfig(), liveStartLimits: null },
    });
    assertUnavailable(badLimits);

    const futureCharge = await produceSnapshot(
      repairSnapshot([], [chargedReservation("future", FINISHED + 1)]),
      root,
    );
    assertUnavailable(futureCharge);

    const futureSettlement = await produceSnapshot(
      repairSnapshot([], [
        chargedReservation("future-settled", FINISHED - 1000, {
          outcome: "submitted",
          settledAt: FINISHED + 1,
        }),
      ]),
      root,
    );
    assertUnavailable(futureSettlement);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
