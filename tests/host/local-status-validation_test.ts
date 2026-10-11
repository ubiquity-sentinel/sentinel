import assert from "node:assert/strict";

import {
  chargedReservation,
  chargedReservations,
  FINISHED,
  HOUR,
  makeRoot,
  produceSnapshot,
  repairSnapshot,
  reservationAggregates,
  work,
} from "./local-status-helpers.ts";
import {
  expectRecorded,
  expectRejected,
  mutated,
} from "./local-status-renderer-helpers.ts";

Deno.test("embedded renderer: rejects incompatible or inconsistent shapes", async () => {
  const root = await makeRoot("sentinel-local-render-reject-");
  try {
    const base = await produceSnapshot(
      repairSnapshot([work("w-1", "work", 1)]),
      root,
    );
    await expectRecorded(base.fileText, "GREEN", "GREEN");

    await expectRejected(
      mutated(base, (status) => delete status.reportVersion),
      "reportVersion is not v2",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.reportVersion = "v1";
      }),
      "reportVersion is not v2",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.version = "v2";
      }),
      "version is not v1",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.kind = "sentinel_hosted_status";
      }),
      "kind is not sentinel_local_status",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.model = "gpt-5.6-mini";
      }),
      "model policy",
    );
    await expectRejected(
      mutated(base, (status) => {
        (status.limits as Record<string, unknown>).perHour = 2;
      }),
      "admission limits",
    );
    await expectRejected(
      mutated(base, (status) => {
        const aggregates = status.aggregates as {
          work: { omitted: number };
        };
        aggregates.work.omitted += 1;
      }),
      "work.omitted is inconsistent",
    );
    await expectRejected(
      mutated(base, (status) => {
        const aggregates = status.aggregates as {
          work: {
            byNextStep: Record<string, number>;
            total: number;
            unknownSteps: number;
          };
        };
        aggregates.work.byNextStep.work = 0;
        aggregates.work.total = 1;
        aggregates.work.unknownSteps = 1;
      }),
      "work detail exceeds the complete work count",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.summary = "truncated";
      }),
      "summary marker is inconsistent",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.state = "unavailable";
      }),
      "unavailable status must carry null aggregates",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.nextEligibleStartAt = FINISHED + 1000;
      }),
      "next eligible start is set while admission is uncapped",
    );

    // A heavy-usage report is still uncapped: the producer records no retry,
    // and a rewritten report cannot smuggle one in behind aggregate edits.
    const heavyUsage = await produceSnapshot(
      repairSnapshot([], chargedReservations("r-cap", 120, FINISHED - 1000)),
      root,
    );
    assert.equal(heavyUsage.status.nextEligibleStartAt, null);
    await expectRejected(
      mutated(heavyUsage, (status) => {
        status.nextEligibleStartAt = FINISHED + 1000;
      }),
      "next eligible start is set while admission is uncapped",
    );
    await expectRejected(
      mutated(heavyUsage, (status) => {
        status.nextEligibleStartAt = FINISHED + 1000;
        const aggregates = status.aggregates as {
          reservations: {
            total: number;
            open: number;
            settled: number;
            chargedHour: number;
            chargedSevenDays: number;
            omitted: number;
          };
        };
        status.reservations = [];
        aggregates.reservations.total = 120;
        aggregates.reservations.open = 0;
        aggregates.reservations.settled = 120;
        aggregates.reservations.omitted = 120;
        aggregates.reservations.chargedHour = 0;
        aggregates.reservations.chargedSevenDays = 0;
        status.summary = "truncated";
      }),
      "next eligible start is set while admission is uncapped",
    );
    await expectRejected(undefined, "status input is missing");
    await expectRejected("not json", "not valid JSON");
    await expectRejected("{}", "kind is not sentinel_local_status");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: rejects contradictory aggregate counts", async () => {
  const root = await makeRoot("sentinel-local-render-aggregate-");
  try {
    const base = await produceSnapshot(
      repairSnapshot(
        [work("w-1", "work", 1)],
        [
          chargedReservation("r-open", FINISHED - 1000),
          chargedReservation("r-settled", FINISHED - 2000, {
            outcome: "submitted",
            settledAt: FINISHED - 1500,
          }),
        ],
      ),
      root,
    );
    const R = reservationAggregates(base.status);
    assert.equal(R.total, 2);
    assert.equal(R.open, 1);
    assert.equal(R.settled, 1);
    assert.equal(R.chargedHour, 2);
    assert.equal(R.chargedSevenDays, 2);

    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { open: number; settled: number };
        }).reservations;
        reservations.open = 0;
        reservations.settled = 2;
      }),
      "reservation open counts are inconsistent with the bounded detail",
    );
    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { open: number; settled: number };
        }).reservations;
        reservations.open = 2;
        reservations.settled = 0;
      }),
      "reservation open counts are inconsistent with the bounded detail",
    );
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
    await expectRejected(
      mutated(base, (status) => {
        const reservations = (status.aggregates as {
          reservations: { chargedSevenDays: number };
        }).reservations;
        reservations.chargedSevenDays = 0;
      }),
      "rolling charged usage is inconsistent",
    );

    // A valid heavy-usage report records no retry and cannot be rewritten to
    // zero charged usage while hiding that rewrite.
    const recent = await produceSnapshot(
      repairSnapshot(
        [],
        chargedReservations("r-recent", 120, FINISHED - 1000),
      ),
      root,
    );
    assert.equal(recent.status.nextEligibleStartAt, null);
    await expectRejected(
      mutated(recent, (status) => {
        const reservations = (status.aggregates as {
          reservations: { chargedHour: number; chargedSevenDays: number };
        }).reservations;
        reservations.chargedHour = 0;
        reservations.chargedSevenDays = 0;
        status.nextEligibleStartAt = null;
      }),
      "rolling hour usage is inconsistent with the bounded detail",
    );
    await expectRejected(
      mutated(recent, (status) => {
        status.nextEligibleStartAt = FINISHED - 1000 + HOUR + 1;
      }),
      "next eligible start is set while admission is uncapped",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("embedded renderer: rejects malformed work, times and outcomes", async () => {
  const root = await makeRoot("sentinel-local-render-shape-");
  try {
    const base = await produceSnapshot(
      repairSnapshot(
        [work("w-1", "work", 1), work("w-2", "work", 2)],
        [
          chargedReservation("r-open", FINISHED - 1000),
          chargedReservation("r-settled", FINISHED - 2000, {
            outcome: "submitted",
            settledAt: FINISHED - 1500,
          }),
        ],
      ),
      root,
    );
    const workAt = (status: Record<string, unknown>, index: number) =>
      (status.work as Array<Record<string, unknown>>)[index];
    const reservationAt = (status: Record<string, unknown>, index: number) =>
      (status.reservations as Array<Record<string, unknown>>)[index];

    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).id = "";
      }),
      "a work id is not a bounded non-empty string",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).id = "x".repeat(257);
      }),
      "a work id is not a bounded non-empty string",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 1).id = workAt(status, 0).id;
      }),
      "work detail repeats a work identity",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).sourceKind = "mystery";
      }),
      "a work source kind is not a known value",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).issueNumber = 0;
      }),
      "a work issue number is not null or a positive safe integer",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).issueNumber = 1.5;
      }),
      "a work issue number is not null or a positive safe integer",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).pr = "7";
      }),
      "a work PR number is not null or a positive safe integer",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).pr = 0;
      }),
      "a work PR number is not null or a positive safe integer",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).head = "abc";
      }),
      "a work head is not null or 40 lowercase hex characters",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).head = "A".repeat(40);
      }),
      "a work head is not null or 40 lowercase hex characters",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).updatedAt = FINISHED + 1;
      }),
      "a work updatedAt is after the observation time",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).updatedAt = FINISHED - 0.5;
      }),
      "a work updatedAt is not a valid time",
    );
    await expectRejected(
      mutated(base, (status) => {
        workAt(status, 0).updatedAt = -1;
      }),
      "a work updatedAt is not a valid time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 0).createdAt = FINISHED + 1;
      }),
      "a reservation createdAt is after the observation time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 0).createdAt = -1;
      }),
      "a reservation createdAt is not a valid time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 0).createdAt = FINISHED - 1000.5;
      }),
      "a reservation createdAt is not a valid time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 0).settledAt = FINISHED - 500;
      }),
      "a reserved reservation carries a settlement time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 1).settledAt = null;
      }),
      "a settled reservation is missing a valid settlement time",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 1).settledAt =
          (reservationAt(status, 1).createdAt as number) - 1;
      }),
      "a reservation settled before it was created",
    );
    await expectRejected(
      mutated(base, (status) => {
        reservationAt(status, 1).settledAt = FINISHED + 1;
      }),
      "a reservation settled after the observation time",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.startedAt = -1;
      }),
      "startedAt and finishedAt are not valid observation times",
    );
    await expectRejected(
      mutated(base, (status) => {
        status.finishedAt = FINISHED - 0.5;
      }),
      "startedAt and finishedAt are not valid observation times",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
