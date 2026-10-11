import assert from "node:assert/strict";
import { readLocalRunStatus } from "../../src/host/local-release.ts";
import {
  blockedWork,
  chargedReservation,
  chargedReservations,
  detail,
  ENCODER,
  FINISHED,
  HOUR,
  makeRoot,
  MAX_TEXT,
  NOW,
  produceSnapshot,
  repairSnapshot,
  reservationAggregates,
  work,
  workAggregates,
} from "./local-status-helpers.ts";
import {
  expectRecorded,
  expectRejected,
  mutated,
  render,
} from "./local-status-renderer-helpers.ts";

Deno.test("embedded renderer: truncated detail keeps complete counts and bounded retry", async () => {
  const root = await makeRoot("sentinel-local-render-truncated-");
  try {
    const base = await produceSnapshot(
      repairSnapshot(
        [blockedWork("blk-1", 5)],
        [
          chargedReservation("r-000-oldest", FINISHED - 4000),
          chargedReservation("r-001-second", FINISHED - 3990),
          ...chargedReservations("r-100-mid", 118, FINISHED - 2000),
          chargedReservation("r-999-newest", FINISHED - 1000),
        ],
      ),
      root,
    );
    const R = reservationAggregates(base.status);
    assert.equal(R.total, 121);
    assert.equal(R.omitted, 0);
    assert.equal(R.chargedHour, 121);
    assert.equal(base.status.nextEligibleStartAt, null);

    // A valid truncated report: the newest charge is omitted from the bounded
    // detail while the complete counts stay in place and no retry exists.
    const truncated = mutated(base, (status) => {
      (status.aggregates as { reservations: { omitted: number } })
        .reservations.omitted = 1;
      (status.reservations as Array<Record<string, unknown>>).pop();
      status.summary = "truncated";
    });
    const rendered = await expectRecorded(
      truncated,
      "RED",
      "blocked work is present",
    );
    assert.ok(!rendered.summary.includes("NOT RECORDED"), rendered.summary);
    assert.ok(rendered.summary.includes("121 total"), rendered.summary);
    assert.ok(rendered.summary.includes("1 omitted"), rendered.summary);
    assert.ok(
      rendered.summary.includes("Rolling usage: 121 charged in the last hour"),
      rendered.summary,
    );

    // Missing detail must not be reported as zero charged usage.
    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { chargedHour: number; chargedSevenDays: number };
        }).reservations;
        reservations.chargedHour = 0;
        reservations.chargedSevenDays = 0;
        status.nextEligibleStartAt = null;
      }),
      "rolling hour usage is inconsistent with the bounded detail",
    );

    // No retry exists to prove or dispute: any non-null value is rejected.
    await expectRejected(
      mutated(base, (status) => {
        (status.aggregates as { reservations: { omitted: number } })
          .reservations.omitted = 1;
        (status.reservations as Array<Record<string, unknown>>).pop();
        status.summary = "truncated";
        status.nextEligibleStartAt = FINISHED - 4000 + HOUR - 1;
      }),
      "next eligible start is set while admission is uncapped",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.nextEligibleStartAt = FINISHED - 1000 + HOUR + 1;
      }),
      "next eligible start is set while admission is uncapped",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.nextEligibleStartAt = FINISHED;
      }),
      "next eligible start is set while admission is uncapped",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: rejects an omitted hourly charge hidden by visible weekly usage", async () => {
  const root = await makeRoot("sentinel-local-render-omitted-");
  try {
    const produced = await produceSnapshot(
      repairSnapshot([], [
        ...chargedReservations("r-hour", 120, FINISHED - 1),
        ...chargedReservations("r-wk", 60, FINISHED - 2 * HOUR),
      ]),
      root,
    );
    const R = reservationAggregates(produced.status);
    assert.equal(R.total, 180);
    assert.equal(R.open, 180);
    assert.equal(R.chargedHour, 120);
    assert.equal(R.chargedSevenDays, 180);
    assert.equal(produced.status.nextEligibleStartAt, null);
    const visibleIds = detail(produced.status, "reservations").map((entry) =>
      entry.taskId
    );
    assert.equal(visibleIds.length, 180);
    assert.equal(visibleIds[0], "task:r-hour-000");
    assert.equal(visibleIds[119], "task:r-hour-119");
    assert.equal(visibleIds[179], "task:r-wk-059");

    // Truncated dispatch: only the older weekly-only charges stay visible, the
    // newer hourly charges are omitted, and the weekly aggregate is lowered to
    // match the visible detail. Every per-category bound still passes, but the
    // pair is impossible because each omitted hourly charge must also be an
    // omitted weekly charge, so the weekly aggregate cannot drop to 120.
    const truncated = mutated(produced, (status) => {
      const visible = status.reservations as Array<Record<string, unknown>>;
      status.reservations = visible.filter((entry) =>
        entry.createdAt === FINISHED - 2 * HOUR
      );
      const reservations = (status.aggregates as {
        reservations: { omitted: number; chargedSevenDays: number };
      }).reservations;
      reservations.omitted = 120;
      reservations.chargedSevenDays = 120;
      status.summary = "truncated";
    });
    await expectRejected(
      truncated,
      "omitted rolling usage is inconsistent: every omitted hourly charge is also an omitted seven-day charge",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: isolated state_error and source_error outcomes are RED for that outcome", async () => {
  const root = await makeRoot("sentinel-local-render-outcome-");
  try {
    const cases = [
      {
        outcome: {
          status: "state_error" as const,
          detail: "isolated state failure",
        },
        snapshot: repairSnapshot(),
      },
      {
        outcome: {
          status: "source_error" as const,
          detail: "isolated source failure",
        },
        snapshot: repairSnapshot([work("w-1", "work", 1)]),
      },
    ];
    for (const item of cases) {
      const outcomeStatus = item.outcome.status;
      const produced = await produceSnapshot(item.snapshot, root, {
        outcome: item.outcome,
      });
      const W = workAggregates(produced.status);
      assert.equal(W.blocked, 0, "the parsed state carries no blocked work");
      assert.equal(
        W.unknownSteps,
        0,
        "the parsed state carries no unknown steps",
      );
      assert.equal(
        (produced.status.outcome as { status: string }).status,
        outcomeStatus,
        "the produced JSON preserves the original outcome status",
      );

      // The RED verdict comes from the recorded error outcome itself, not from
      // blocked or unknown parsed state.
      const rendered = await expectRecorded(
        produced.fileText,
        "RED",
        "the local run ended with " + outcomeStatus,
      );
      assert.ok(
        rendered.summary.includes(
          "Result: RECORDED - RED (the local run ended with " + outcomeStatus +
            ")",
        ),
        rendered.summary,
      );
      assert.ok(
        !rendered.summary.includes("blocked work is present"),
        rendered.summary,
      );
      assert.ok(
        !rendered.summary.includes("unrecognized work steps are present"),
        rendered.summary,
      );

      const receipt = await readLocalRunStatus(root);
      assert.ok(receipt.ok, "the produced envelope parses");
      if (!receipt.ok) throw new Error("unreachable");
      assert.ok(receipt.value !== null);
      if (receipt.value === null) throw new Error("unreachable");
      assert.equal(
        receipt.value.outcome,
        outcomeStatus,
        "the retained receipt preserves the original outcome status",
      );
      assert.equal(receipt.value.stateAvailable, true);
    }

    // A blocked report is RED because of the blocked work, not because
    // reporting invented a repair error: the idle outcome stays idle.
    const blockedOnly = await produceSnapshot(
      repairSnapshot([blockedWork("blk-1", 7)]),
      root,
    );
    const blockedRendered = await expectRecorded(
      blockedOnly.fileText,
      "RED",
      "blocked work is present",
    );
    assert.ok(
      !blockedRendered.summary.includes("the local run ended with"),
      blockedRendered.summary,
    );
    assert.equal(
      (blockedOnly.status.outcome as { status: string }).status,
      "idle",
    );
    const blockedReceipt = await readLocalRunStatus(root);
    assert.ok(blockedReceipt.ok);
    if (!blockedReceipt.ok) throw new Error("unreachable");
    assert.ok(blockedReceipt.value !== null);
    if (blockedReceipt.value === null) throw new Error("unreachable");
    assert.equal(blockedReceipt.value.outcome, "idle");
    assert.equal(blockedReceipt.value.stateAvailable, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: stale and future observations stay rejected", async () => {
  const root = await makeRoot("sentinel-local-render-time-");
  try {
    const base = await produceSnapshot(repairSnapshot(), root);
    const stale = await render(mutated(base, (status) => {
      status.startedAt = NOW - 4 * 3_600_000;
      status.finishedAt = NOW - 3 * 3_600_000;
    }));
    assert.equal(stale.code, 1);
    assert.ok(stale.summary.includes("NOT RECORDED - stale local status"));
    const future = await render(mutated(base, (status) => {
      status.startedAt = NOW + 5 * 60_000;
      status.finishedAt = NOW + 10 * 60_000;
    }));
    assert.equal(future.code, 1);
    assert.ok(future.summary.includes("finishedAt is in the future"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: 50000 code-unit and UTF-8 byte input bounds", async () => {
  const root = await makeRoot("sentinel-local-render-size-");
  try {
    const base = await produceSnapshot(repairSnapshot(), root);
    const text = base.fileText;
    assert.ok(text.length < MAX_TEXT);
    const padTo = (total: number) => text + " ".repeat(total - text.length);

    await expectRecorded(padTo(49_999), "GREEN", "GREEN");
    await expectRecorded(padTo(50_000), "GREEN", "GREEN");
    await expectRejected(padTo(50_001), "exceeds 50000 characters");

    // A bounded multibyte field keeps both units inside the bound.
    const unicodeWithin = mutated(base, (status) => {
      status.login = "中".repeat(50);
    });
    await expectRecorded(unicodeWithin, "GREEN", "GREEN");

    // Multibyte text can pass the code-unit bound and still exceed 50000 bytes.
    const byteOver = mutated(base, (status) => {
      status.login = "中".repeat(45_000);
    });
    assert.ok(byteOver.length <= MAX_TEXT, `code units ${byteOver.length}`);
    assert.ok(
      ENCODER.encode(byteOver).length > MAX_TEXT,
      "the byte bound is the binding one",
    );
    await expectRejected(byteOver, "exceeds 50000 UTF-8 bytes");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
