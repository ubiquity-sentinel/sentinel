// Original test registrations grouped by cohesive production behavior.
import assert from "node:assert/strict";
import { deriveReservationId, HOUR_WINDOW_MS } from "../../src/budget/mod.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import { REPO, T0 } from "../state/helpers.ts";
import {
  FakeClock,
  MemoryRepairState,
  REPO_2,
  repositoryConfig,
  reserveRequest,
  seededReservation,
} from "./helpers.ts";
import { budget, snapshot } from "./controller-fixtures.ts";

Deno.test("budget: admission applies exactly one durable reservation; duplicates reconcile", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const controller = budget(clock, state);
  const request = reserveRequest("task:1");

  const first = await controller.reserveModelStart(request);
  assert.equal(first.status, "admitted");
  if (first.status !== "admitted") throw new Error("unreachable");
  const id = await deriveReservationId(request);
  assert.equal(first.reservation.id, id);
  assert.equal(first.reservation.createdAt, T0);
  assert.equal(first.reservation.outcome, "reserved");
  assert.equal(first.stateHead, state.current().head);
  assert.equal(state.current().snapshot?.reservations.length, 1);

  // Same identity: reconciliation-needed, never a second start — even after a
  // settled refund.
  const second = await controller.reserveModelStart(request);
  assert.equal(second.status, "duplicate");
  if (second.status === "duplicate") {
    assert.equal(second.reservation.id, id);
  }

  const refund = await controller.settleModelStart({
    id,
    outcome: "confirmed_not_submitted",
    proofRef: "artifact://proof/task-1",
  });
  assert.equal(refund.status, "settled");

  const afterRefund = await controller.reserveModelStart(request);
  assert.equal(
    afterRefund.status,
    "duplicate",
    "refunded identity still blocks",
  );

  // A genuinely new retry uses its own incremented attempt.
  const retry = await controller.reserveModelStart({
    ...request,
    attempt: 2,
  });
  assert.equal(retry.status, "admitted");
  if (retry.status === "admitted") {
    assert.equal(retry.reservation.attempt, 2);
    assert.equal(retry.reservation.createdAt, T0);
  }
  // Two durable reservations: the original (refunded) plus the attempt-2 retry.
  assert.equal(state.current().snapshot?.reservations.length, 2);
});

Deno.test("budget: same logical identity under a different id is an invalid collision", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  // A legacy synthetic record with the same logical identity but a hand-made id.
  state.seed(snapshot({
    reservations: [seededReservation("legacy-7", {
      taskId: "task:collision" as WorkItemId,
      attempt: 1,
      head: "aafb7ee0598699bb7fb8a72ea133693ed64462da" as never,
      purpose: "implementation",
      createdAt: T0,
    })],
  }));
  const controller = budget(clock, state);
  const result = await controller.reserveModelStart(
    reserveRequest("task:collision"),
  );
  assert.equal(result.status, "invalid");
  assert.equal(state.current().snapshot?.reservations.length, 1);
});

Deno.test("budget: same derived id under a different identity is an invalid collision, not duplicate", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const controller = budget(clock, state);
  const request = reserveRequest("task:collision");
  const id = await deriveReservationId(request);
  // The exact derived id exists in state, but it belongs to a different
  // logical identity (a derivation/hash collision): this must never be
  // classified as a reconciliation-needed duplicate with a mismatched record.
  state.seed(snapshot({
    reservations: [seededReservation(id, {
      taskId: "task:other" as WorkItemId,
      createdAt: T0,
    })],
  }));
  const result = await controller.reserveModelStart(request);
  assert.equal(result.status, "invalid");
  assert.equal(state.current().snapshot?.reservations.length, 1);
  assert.equal(state.writes, 0);
});

Deno.test("budget: malformed request inputs are invalid at the boundary and write nothing", async () => {
  const cases: { name: string; request: ReturnType<typeof reserveRequest> }[] =
    [
      {
        name: "invalid repository identity",
        request: reserveRequest("task:b1", {
          repository: {
            owner: "UB!",
            name: "ai.ubq.fi",
            installationId: 7,
          } as never,
        }),
      },
      {
        name: "invalid taskId characters",
        request: reserveRequest("task:b2", { taskId: "bad id!" as never }),
      },
      {
        name: "taskId too long",
        request: reserveRequest("task:b3", {
          taskId: "a".repeat(257) as never,
        }),
      },
      {
        name: "invalid head",
        request: reserveRequest("task:b4", { head: "not-a-sha" as never }),
      },
      {
        name: "zero attempt",
        request: reserveRequest("task:b5", { attempt: 0 }),
      },
      {
        name: "fractional attempt",
        request: reserveRequest("task:b6", { attempt: 1.5 }),
      },
      {
        name: "unsafe attempt",
        request: reserveRequest("task:b7", {
          attempt: Number.MAX_SAFE_INTEGER + 1,
        }),
      },
      {
        name: "unknown purpose",
        request: reserveRequest("task:b8", { purpose: "boss" as never }),
      },
    ];
  for (const item of cases) {
    const clock = new FakeClock(T0);
    const state = new MemoryRepairState();
    const controller = budget(clock, state);
    const result = await controller.reserveModelStart(item.request);
    assert.equal(result.status, "invalid", item.name);
    assert.equal(state.writes, 0, `${item.name}: nothing written`);
    assert.equal(state.current().snapshot, null, item.name);
  }
});

Deno.test("budget: malformed settlement inputs are invalid at the boundary and write nothing", async () => {
  const cases: { name: string; settle: Record<string, unknown> }[] = [
    {
      name: "empty id",
      settle: { id: "", outcome: "submitted", proofRef: null },
    },
    {
      name: "overlong id",
      settle: {
        id: "a".repeat(257),
        outcome: "submitted",
        proofRef: null,
      },
    },
    {
      name: "unknown outcome",
      settle: { id: "r-1", outcome: "approved", proofRef: null },
    },
    {
      name: "url proof ref",
      settle: {
        id: "r-1",
        outcome: "confirmed_not_submitted",
        proofRef: "https://example.com/proof",
      },
    },
    {
      name: "missing required proof",
      settle: {
        id: "r-1",
        outcome: "confirmed_not_submitted",
        proofRef: null,
      },
    },
  ];
  for (const item of cases) {
    const clock = new FakeClock(T0);
    const state = new MemoryRepairState();
    const controller = budget(clock, state);
    const result = await controller.settleModelStart(
      item.settle as never,
    );
    assert.equal(result.status, "invalid", item.name);
    assert.equal(state.writes, 0, `${item.name}: nothing written`);
  }
});

Deno.test("budget: clock regression defers reserve and settle; future timestamps block", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  state.seed(snapshot({
    updatedAt: T0 + 10_000,
    reservations: [
      seededReservation("future-1", { createdAt: T0 + 5_000 }),
      // Refunded entries still have their settlement time checked.
      seededReservation("future-2", {
        createdAt: T0 - 1_000,
        outcome: "confirmed_not_submitted",
        settledAt: T0 + 8_000,
        proofRef: "artifact://proof/future-2",
      }),
    ],
  }));
  const controller = budget(clock, state);

  const reserve = await controller.reserveModelStart(
    reserveRequest("task:reg"),
  );
  assert.equal(reserve.status, "deferred");
  if (reserve.status === "deferred") {
    assert.equal(reserve.reason, "clock_regression");
    assert.equal(reserve.retryAt, T0 + 10_000);
  }
  const settle = await controller.settleModelStart({
    id: "future-1",
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(settle.status, "deferred");
  assert.equal(state.current().snapshot?.reservations.length, 2);

  // Once the clock catches up, admission proceeds against registered state.
  clock.set(T0 + 10_000);
  const admitted = await controller.reserveModelStart(
    reserveRequest("task:reg"),
  );
  assert.equal(admitted.status, "admitted");
});

Deno.test("budget: missing, null, mismatched or unowned policies disable admission", async () => {
  const cfg = (
    repo: typeof REPO_2,
    limits: { perHour: number; perSevenDays: number | null },
    overrides: Record<string, unknown> = {},
  ) => repositoryConfig(repo as never, limits, overrides);
  const OTHER = {
    owner: "ubiquity",
    name: "unlisted-repo",
    installationId: 11,
  };

  const cases: {
    name: string;
    configs: ReturnType<typeof repositoryConfig>[];
    requestRepo: typeof REPO_2 | typeof OTHER;
  }[] = [
    {
      name: "empty config set",
      configs: [],
      requestRepo: REPO_2,
    },
    {
      name: "null liveStartLimits",
      configs: [cfg(REPO_2, { perHour: 2, perSevenDays: 3 }, {
        liveStartLimits: null,
      })],
      requestRepo: REPO_2,
    },
    {
      name: "null sessionBound",
      configs: [cfg(REPO_2, { perHour: 2, perSevenDays: 3 }, {
        sessionBound: null,
      })],
      requestRepo: REPO_2,
    },
    {
      name: "zero caps",
      configs: [cfg(REPO_2, { perHour: 0, perSevenDays: 0 })],
      requestRepo: REPO_2,
    },
    {
      name: "mismatched caps across the complete set",
      configs: [
        cfg(REPO_2, { perHour: 2, perSevenDays: 3 }),
        cfg(
          {
            owner: "Ubiquity-Sentinel",
            name: "sentinel",
            installationId: 9,
          } as typeof REPO_2,
          {
            perHour: 3,
            perSevenDays: 4,
          },
        ),
      ],
      requestRepo: REPO_2,
    },
    {
      name: "null weekly cap versus numeric weekly cap across the complete set",
      configs: [
        cfg(REPO_2, { perHour: 120, perSevenDays: null }),
        cfg(REPO_2, { perHour: 120, perSevenDays: 168 }),
      ],
      requestRepo: REPO_2,
    },
    {
      name: "requested repository is not configured",
      configs: [cfg(REPO_2, { perHour: 2, perSevenDays: 3 })],
      requestRepo: OTHER,
    },
  ];
  for (const item of cases) {
    const clock = new FakeClock(T0);
    const state = new MemoryRepairState();
    const controller = budget(clock, state, item.configs);
    const result = await controller.reserveModelStart({
      ...reserveRequest("task:disabled"),
      repository: item.requestRepo as never,
    });
    assert.equal(result.status, "disabled", item.name);
    assert.equal(
      state.current().snapshot,
      null,
      `${item.name}: nothing written`,
    );
    assert.equal(state.writes, 0, `${item.name}: no admission write`);
  }
});

Deno.test("budget: at cap the controller defers with the exact retryAt and writes nothing", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  state.seed(snapshot({
    reservations: [
      seededReservation("occupier", { createdAt: T0 - 1_000 }),
    ],
  }));
  const controller = budget(clock, state, [repositoryConfig(REPO as never, {
    perHour: 1,
    perSevenDays: 2,
  })]);
  const result = await controller.reserveModelStart(reserveRequest("task:cap"));
  assert.equal(result.status, "deferred");
  if (result.status === "deferred") {
    assert.equal(result.reason, "cap_limit");
    assert.equal(result.retryAt, T0 - 1_000 + 3_600_000);
  }
  assert.equal(state.writes, 0);
  assert.equal(state.current().snapshot?.reservations.length, 1);
});

Deno.test("budget: 120 per hour with a null weekly cap admits the 120th and preserves history", async () => {
  const LIMITS = { perHour: 120, perSevenDays: null } as const;
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const inHour = Array.from(
    { length: 119 },
    (_value, index) =>
      seededReservation(`in-hour-${String(index).padStart(3, "0")}`, {
        createdAt: T0 - 1_000,
      }),
  );
  // More charged history than the retired 168 weekly cap, all inside the week
  // but outside the hour: historical usage that never defers admission.
  const olderInWeek = Array.from(
    { length: 200 },
    (_value, index) =>
      seededReservation(`older-${String(index).padStart(3, "0")}`, {
        createdAt: T0 - 2 * HOUR_WINDOW_MS - index * 60_000,
      }),
  );
  const seeded = [...inHour, ...olderInWeek];
  state.seed(snapshot({ reservations: seeded }));
  // Two configured repositories share one charging set under the same policy.
  const controller = budget(clock, state, [
    repositoryConfig(REPO as never, LIMITS),
    repositoryConfig(REPO_2 as never, LIMITS),
  ]);

  const admitted = await controller.reserveModelStart(
    reserveRequest("task:budget-120", {
      repository: REPO_2 as never,
      purpose: "review_request",
    }),
  );
  assert.equal(admitted.status, "admitted", JSON.stringify(admitted));
  const current = state.current().snapshot;
  assert.equal(current?.reservations.length, seeded.length + 1);
  // Every historical charge stays present byte-for-byte; the new admission is
  // appended and no earlier record is rewritten.
  assert.deepEqual(
    current?.reservations.slice(0, seeded.length).map((entry) =>
      JSON.stringify(entry)
    ),
    seeded.map((entry) => JSON.stringify(entry)),
  );

  // The hour now holds exactly 120 charges (the 200 older ones are historical
  // usage only): the next start defers until the oldest relevant in-hour
  // charge exits at exactly its createdAt + one hour.
  const deferred = await controller.reserveModelStart(
    reserveRequest("task:budget-121"),
  );
  assert.equal(deferred.status, "deferred");
  if (deferred.status === "deferred") {
    assert.equal(deferred.reason, "cap_limit");
    assert.equal(deferred.retryAt, T0 - 1_000 + HOUR_WINDOW_MS);
  }
  assert.equal(
    state.current().snapshot?.reservations.length,
    seeded.length + 1,
  );
  clock.set(T0 - 1_000 + HOUR_WINDOW_MS);
  const afterExit = await controller.reserveModelStart(
    reserveRequest("task:budget-122"),
  );
  assert.equal(afterExit.status, "admitted", JSON.stringify(afterExit));
});

Deno.test("budget: retry timestamp and sequence overflow fail typed and write nothing", async () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  // A charge whose retryAt computation would exceed the safe-integer range:
  // the controller returns a typed unavailable and never writes.
  const clock = new FakeClock(MAX - 1);
  const state = new MemoryRepairState();
  state.seed(snapshot({
    reservations: [
      seededReservation("overflow-1", { createdAt: MAX - HOUR_WINDOW_MS + 1 }),
    ],
  }));
  const atCap = budget(clock, state, [repositoryConfig(REPO as never, {
    perHour: 1,
    perSevenDays: 10,
  })]);
  const deferred = await atCap.reserveModelStart(
    reserveRequest("task:overflow"),
  );
  assert.equal(deferred.status, "unavailable");
  assert.equal(state.writes, 0);
  assert.equal(state.current().snapshot?.reservations.length, 1);

  // Exhausted sequence: a reservation would need an unsafe sequence increment.
  const seqClock = new FakeClock(T0);
  const seqState = new MemoryRepairState();
  seqState.seed(snapshot({ sequence: MAX }));
  const seqBudget = budget(seqClock, seqState);
  const seqReserve = await seqBudget.reserveModelStart(
    reserveRequest("task:seq"),
  );
  assert.equal(seqReserve.status, "unavailable");
  assert.equal(seqState.writes, 0);

  seqState.seed(snapshot({
    sequence: MAX,
    reservations: [seededReservation("seq-1", { createdAt: T0 })],
  }));
  const seqSettle = await seqBudget.settleModelStart({
    id: "seq-1",
    outcome: "submitted",
    proofRef: null,
  });
  assert.equal(seqSettle.status, "unavailable");
  assert.equal(seqState.writes, 0);
  assert.equal(
    seqState.current().snapshot?.reservations[0]?.outcome,
    "reserved",
    "no settlement was applied on overflow",
  );
});

Deno.test("budget: every purpose routes through the same global reservation set", async () => {
  const clock = new FakeClock(T0);
  const state = new MemoryRepairState();
  const controller = budget(clock, state, [repositoryConfig(REPO_2 as never, {
    perHour: 4,
    perSevenDays: 8,
  })]);
  const purposes = [
    "implementation",
    "continuation",
    "retry",
    "review_request",
  ] as const;
  for (const purpose of purposes) {
    const result = await controller.reserveModelStart(
      reserveRequest("task:purposes", {
        repository: REPO_2 as never,
        purpose,
        taskId: `task:${purpose}` as WorkItemId,
      }),
    );
    assert.equal(result.status, "admitted", purpose);
  }
  const full = await controller.reserveModelStart(
    reserveRequest("task:purposes", {
      repository: REPO_2 as never,
      taskId: "task:full" as WorkItemId,
    }),
  );
  assert.equal(full.status, "deferred");
  if (full.status === "deferred") assert.equal(full.reason, "cap_limit");
  assert.equal(state.current().snapshot?.reservations.length, 4);
});
