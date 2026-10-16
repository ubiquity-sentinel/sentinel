/**
 * Parked candidates' own producers are recovered oldest first. A pass that
 * may have written ends the walk, and one that deferred before any write does
 * not. A parked producer whose plan is expired or unlisted lists that plan
 * before any deferral, yet its completion read and native proof still run
 * first, and every refusal they apply still throws before any later pass.
 */
import assert from "node:assert/strict";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  APPLIED,
  ARCHIVE,
  blocked,
  captured,
  FIRST_RUN,
  proof,
  REFUSAL,
  walkLines,
  walkRig,
  working,
} from "./hosted-autonomy-history-reach-fixtures.ts";

Deno.test("parked candidates' producers are recovered oldest first, listing each plan before the completion read", async () => {
  // Every plan expired and no producer run is confirmed complete: each
  // parked producer is the unproved typed skip from its plan listing and its
  // completion read, oldest first, never a deferral.
  const rig = await walkRig({
    producers: 3,
    rows: [
      blocked("blocked-newest", FIRST_RUN + 2, 7003),
      blocked("blocked-middle", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: true }],
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: true }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
    completed: () => false,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    assert.deepEqual(rig.calls.listed, [
      FIRST_RUN,
      FIRST_RUN + 1,
      FIRST_RUN + 2,
    ]);
    assert.deepEqual(rig.calls.confirmed, [
      FIRST_RUN,
      FIRST_RUN + 1,
      FIRST_RUN + 2,
    ]);
    assert.deepEqual(rig.calls.native, []);
    assert.deepEqual(rig.calls.recovered, []);
    assert.deepEqual(rig.unrecoverable, ["expired", "expired", "expired"]);
    assert.deepEqual(walkLines(outcome.lines), []);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("the oldest parked producer applies and no other producer pass runs in that walk", async () => {
  // A newer parked producer and the in-flight producer are both listed and
  // would be reached by any further pass.
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-newer", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false }],
    ]),
    applies: (runId) => runId === FIRST_RUN,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    const result = outcome.value as { status: string; appliedHead: string };
    assert.equal(result.status, "applied");
    assert.equal(result.appliedHead, APPLIED);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN]);
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN]);
    assert.equal(rig.calls.ports, 1);
    assert.deepEqual(walkLines(outcome.lines), []);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a newer parked producer that applies after an older typed skip ends the walk before in-flight work", async () => {
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-newer", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
    applies: (runId) => runId === FIRST_RUN + 1,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal((outcome.value as { status: string }).status, "applied");
    assert.deepEqual(rig.unrecoverable, ["expired"]);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 1]);
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN, FIRST_RUN + 1]);
    assert.deepEqual(rig.calls.native, [FIRST_RUN, FIRST_RUN + 1]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a parked producer that defers before any write leaves the next parked producer running", async () => {
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-newer", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false }],
    ]),
    completed: (runId) => runId !== FIRST_RUN,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1002 blocked-newer");
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN, FIRST_RUN + 1]);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 1]);
    assert.deepEqual(walkLines(outcome.lines), ["deferred_producer"]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a parked producer that persistently defers before any write does not starve in-flight work", async () => {
  // Its job log aged out: the blocked pass defers having written nothing,
  // and the newest-first walk still recovers the newest producer.
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false }],
    ]),
    completed: (runId) => runId !== FIRST_RUN,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1003 work-in-flight");
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN, FIRST_RUN + 2]);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 2]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a parked producer that defers after invoking its writer ends the walk", async () => {
  // The completion read recorded a hold through the pass's own writer before
  // deferring: no other parked producer and no in-flight walk may follow.
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-newer", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false }],
    ]),
    writesOnConfirm: (runId) => runId === FIRST_RUN,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN]);
    assert.deepEqual(rig.calls.recovered, []);
    assert.deepEqual(walkLines(outcome.lines), ["deferred_producer"]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("without in-flight work the walk ends after the parked producers' passes", async () => {
  // Every pending record is parked and each found producer was just tried:
  // no newest-first walk repeats the deferring producer's pass.
  const rig = await walkRig({
    producers: 3,
    rows: [
      blocked("blocked-newer", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
    completed: (runId) => runId !== FIRST_RUN + 1,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    assert.deepEqual(rig.unrecoverable, ["expired"]);
    assert.deepEqual(rig.calls.listed, [FIRST_RUN, FIRST_RUN + 1]);
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN, FIRST_RUN + 1]);
    assert.deepEqual(rig.calls.native, [FIRST_RUN]);
    assert.deepEqual(rig.calls.recovered, []);
    assert.deepEqual(walkLines(outcome.lines), ["deferred_producer"]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("the parked traversal stops reading history once every parked producer is found", async () => {
  // Each local ancestry proof costs three seconds: reading on past the newest
  // producer to the root would spend the whole budget.
  const rig = await walkRig({
    producers: 120,
    rows: [blocked("blocked-newest", FIRST_RUN + 119, 7120)],
    plans: new Map([[FIRST_RUN + 119, {
      id: 7120,
      digest: ARCHIVE,
      expired: false,
    }]]),
    gitCost: (args) => args[0] === "merge-base" ? 3000 : 0,
  });
  try {
    await assert.rejects(rig.walk, /^Error: REACHED 1120 blocked-newest$/);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 119]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("the in-flight walk stops again at a parked producer that deferred write-free", async () => {
  // In-flight work binds the same newest producer: after its write-free
  // parked deferral the in-flight walk must stop there again, never offering
  // the in-flight request to the older wave.
  const rig = await walkRig({
    producers: 2,
    rows: [
      working("work-in-flight"),
      blocked("blocked-newest", FIRST_RUN + 1, 7002),
    ],
    plans: new Map([
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false }],
    ]),
    completed: (runId) => runId !== FIRST_RUN + 1,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN + 1, FIRST_RUN + 1]);
    assert.deepEqual(rig.calls.recovered, []);
    assert.deepEqual(rig.calls.listed, [FIRST_RUN + 1]);
    assert.deepEqual(walkLines(outcome.lines), [
      "deferred_producer",
      "deferred_producer",
    ]);
  } finally {
    await rig.cleanup();
  }
});

for (
  const [what, writer] of [
    ["native read writes through the ports' writer", "native"],
    ["consumer defers on an unavailable repair read", "consumer"],
  ] as const
) {
  Deno.test(`a parked producer whose ${what} ends the walk`, async () => {
    // Whichever writer the pass handed out may have written before this
    // deferral: no other parked producer and no in-flight walk may follow.
    const rig = await walkRig({
      producers: 3,
      rows: [
        working("work-in-flight"),
        blocked("blocked-newer", FIRST_RUN + 1, 7002),
        blocked("blocked-oldest", FIRST_RUN, 7001),
      ],
      plans: new Map([
        [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
        [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
        [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: false }],
      ]),
      writesOnNative: (runId) => writer === "native" && runId === FIRST_RUN,
      applies: writer === "consumer"
        ? (runId) => runId === FIRST_RUN
        : undefined,
      ingestStateUnavailable: writer === "consumer",
    });
    try {
      const outcome = await captured(rig.walk);
      assert.equal(outcome.error, null, String(outcome.error));
      assert.equal(outcome.value, null);
      assert.deepEqual(rig.calls.native, [FIRST_RUN]);
      assert.deepEqual(
        rig.calls.recovered,
        writer === "consumer" ? [FIRST_RUN] : [],
      );
      assert.deepEqual(walkLines(outcome.lines), ["deferred_producer"]);
    } finally {
      await rig.cleanup();
    }
  });
}

Deno.test("an expired parked plan whose native read may have written ends the walk", async () => {
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-newer", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
    writesOnNative: (runId) => runId === FIRST_RUN,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    assert.deepEqual(rig.unrecoverable, ["expired"]);
    assert.deepEqual(rig.calls.native, [FIRST_RUN]);
    assert.deepEqual(rig.calls.recovered, []);
    assert.deepEqual(walkLines(outcome.lines), []);
  } finally {
    await rig.cleanup();
  }
});

for (
  const [fault, read, message] of [
    [
      "changed",
      (runId: number) => portOk({ ...proof(runId), jobId: 1 }),
      "current matrix native proof changed",
    ],
    [
      "not-started",
      (runId: number) => portOk({ ...proof(runId), outcome: "not_started" }),
      "current matrix native proof unavailable",
    ],
    [
      "malformed",
      (runId: number) => portOk({ ...proof(runId), settled: "yes" }),
      "current matrix native proof changed",
    ],
    [
      // The native read's own provenance refusal (attempt or job workflow,
      // path, event, branch, launcher or repository) is never unreadable.
      "conflicting",
      () => portError("invalid", "GitHub API response is malformed"),
      "current matrix native proof unavailable",
    ],
  ] as const
) {
  Deno.test(`an expired parked plan still refuses a ${fault} native proof before any later pass`, async () => {
    // The newest in-flight producer would apply: the refusal comes first.
    const rig = await walkRig({
      producers: 3,
      rows: [
        working("work-in-flight"),
        blocked("blocked-oldest", FIRST_RUN, 7001),
      ],
      plans: new Map([
        [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
      ]),
      nativeRead: (runId) => runId === FIRST_RUN ? read(runId) : undefined,
      applies: (runId) => runId === FIRST_RUN + 2,
    });
    try {
      await assert.rejects(
        rig.walk,
        (error: unknown) =>
          error instanceof CurrentMatrixRecoveryIntegrityFailure &&
          error.message === message,
      );
      assert.deepEqual(rig.calls.listed, [FIRST_RUN]);
      assert.deepEqual(rig.calls.confirmed, [FIRST_RUN]);
      assert.deepEqual(rig.calls.native, [FIRST_RUN]);
      assert.deepEqual(rig.calls.recovered, []);
      assert.deepEqual(rig.unrecoverable, []);
    } finally {
      await rig.cleanup();
    }
  });
}

for (const lost of ["expired", "unlisted"] as const) {
  Deno.test(`an ${lost} parked plan still runs the completion read, whose refusal throws before any later pass`, async () => {
    // The completion read refuses a conflicting attempt or job provenance and
    // a moved completion custody: the lost plan never turns that into a skip,
    // and the newest in-flight producer, which would apply, never runs.
    const rig = await walkRig({
      producers: 3,
      rows: [
        working("work-in-flight"),
        blocked("blocked-oldest", FIRST_RUN, 7001),
      ],
      plans: lost === "expired"
        ? new Map([[FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }]])
        : new Map(),
      confirmThrows: (runId) => runId === FIRST_RUN,
      nativeRead: (runId) =>
        runId === FIRST_RUN
          ? portError("invalid", "GitHub API response is malformed")
          : undefined,
      applies: (runId) => runId === FIRST_RUN + 2,
    });
    try {
      await assert.rejects(rig.walk, new RegExp(`^Error: ${REFUSAL}$`));
      assert.deepEqual(rig.calls.listed, [FIRST_RUN]);
      assert.deepEqual(rig.calls.confirmed, [FIRST_RUN]);
      assert.deepEqual(rig.calls.native, []);
      assert.deepEqual(rig.calls.recovered, []);
      assert.deepEqual(rig.unrecoverable, []);
    } finally {
      await rig.cleanup();
    }
  });
}

Deno.test("an expired parked plan whose run is not confirmed complete is the unproved typed skip", async () => {
  // Never a deferral: the next parked producer still runs, and no native
  // read follows an unconfirmed completion.
  const rig = await walkRig({
    producers: 3,
    rows: [
      blocked("blocked-newer", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
    completed: (runId) => runId !== FIRST_RUN,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1002 blocked-newer");
    assert.deepEqual(rig.unrecoverable, ["expired"]);
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN, FIRST_RUN + 1]);
    assert.deepEqual(rig.calls.native, [FIRST_RUN + 1]);
    assert.deepEqual(walkLines(outcome.lines), []);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an expired parked plan whose completion read may have written ends the walk", async () => {
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-newer", FIRST_RUN + 1, 7002),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
    writesOnConfirm: (runId) => runId === FIRST_RUN,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    assert.deepEqual(rig.unrecoverable, ["expired"]);
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN]);
    assert.deepEqual(rig.calls.native, []);
    assert.deepEqual(rig.calls.recovered, []);
    assert.deepEqual(walkLines(outcome.lines), []);
  } finally {
    await rig.cleanup();
  }
});

for (
  const [label, read] of [
    ["pending", portOk(null)],
    ["unreadable", portError("unavailable", "job log aged out")],
  ] as const
) {
  Deno.test(`an expired parked plan with a ${label} native proof stays a typed skip`, async () => {
    const rig = await walkRig({
      producers: 3,
      rows: [
        blocked("blocked-newer", FIRST_RUN + 1, 7002),
        blocked("blocked-oldest", FIRST_RUN, 7001),
      ],
      plans: new Map([
        [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
        [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
      ]),
      nativeRead: (runId) => runId === FIRST_RUN ? read : undefined,
    });
    try {
      const outcome = await captured(rig.walk);
      assert(outcome.error instanceof Error, String(outcome.error));
      assert.equal(outcome.error.message, "REACHED 1002 blocked-newer");
      assert.deepEqual(rig.unrecoverable, ["expired"]);
      assert.deepEqual(rig.calls.native, [FIRST_RUN, FIRST_RUN + 1]);
      assert.deepEqual(rig.calls.confirmed, [FIRST_RUN, FIRST_RUN + 1]);
      assert.deepEqual(walkLines(outcome.lines), []);
    } finally {
      await rig.cleanup();
    }
  });
}

Deno.test("a refused early plan listing keeps a deferring parked producer a deferral", async () => {
  // The listing used to follow the native reads: a producer that defers there
  // must not turn a listing refusal into a failed maintenance run.
  const rig = await walkRig({
    producers: 2,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    plans: new Map([[FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }]]),
    listingFails: (runId) => runId === FIRST_RUN,
    completed: () => false,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    assert.deepEqual(rig.calls.listed, [FIRST_RUN]);
    assert.deepEqual(rig.calls.confirmed, [FIRST_RUN]);
    assert.deepEqual(rig.unrecoverable, []);
    assert.deepEqual(walkLines(outcome.lines), ["deferred_producer"]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a refused early plan listing is read again after the native proof and still refuses", async () => {
  const rig = await walkRig({
    producers: 2,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    listingFails: (runId) => runId === FIRST_RUN,
  });
  try {
    await assert.rejects(rig.walk, new RegExp(`^Error: ${REFUSAL}$`));
    assert.deepEqual(rig.calls.listed, [FIRST_RUN, FIRST_RUN]);
    assert.deepEqual(rig.calls.native, [FIRST_RUN]);
    assert.deepEqual(rig.calls.recovered, []);
  } finally {
    await rig.cleanup();
  }
});
