/**
 * The current-matrix history walk must reach an old producer inside its 300 s
 * budget: one complete release fetch per walk, serving the traversal and every
 * producer pass's own snapshot reads, local parent reads under the same
 * ancestry/head/sequence/cycle refusals, and no producer custody reads for
 * snapshots no pending record can bind to. An expired or unlisted plan
 * artifact of one producer is a typed per-producer skip, never an escaping
 * error, while a conflicting artifact identity stays fatal.
 */
import assert from "node:assert/strict";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { isDeferredCurrentMatrixHistoryBudget } from "../../ops/hosted-autonomy-policy.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import {
  ARCHIVE,
  blocked,
  captured,
  FIRST_RUN,
  network,
  REFUSAL,
  walkLines,
  walkRig,
  walkRows,
  working,
} from "./hosted-autonomy-history-reach-fixtures.ts";

Deno.test("current matrix walk reaches a producer 120 release snapshots back within its budget", async () => {
  const rig = await walkRig({
    producers: 120,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    gitCost: network,
    repairCost: 1000,
    portsCost: 2000,
  });
  try {
    await assert.rejects(rig.walk, /^Error: REACHED 1001 blocked-oldest$/);
    // One complete history fetch for the whole walk: the producer pass's
    // completion, custody and recovery reads of its snapshot all use it.
    assert.equal(rig.runner.complete, 1);
    assert.equal(rig.calls.ports, 1);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN]);
    const left = [];
    for await (const entry of Deno.readDir(`${rig.root}/release`)) {
      if (/^state-(?:history|op)-/.test(entry.name)) left.push(entry.name);
    }
    assert.deepEqual(left, [], "the history view must be closed");
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a parked traversal stopped at its reserve logs a bounded step diagnostic", async () => {
  // Each local ancestry proof costs three seconds and the parked producer is
  // never found: with no in-flight work the traversal still stops at the
  // reserve, never at the deadline, and nothing fails.
  const rig = await walkRig({
    producers: 120,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    gitCost: (args) => args[0] === "merge-base" ? 3000 : 0,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    const diagnostics = walkRows(outcome.lines);
    assert.equal(diagnostics.length, 1, outcome.lines.join("\n"));
    const [row] = diagnostics;
    assert.deepEqual(Object.keys(row).sort(), [
      "kind",
      "outcome",
      "producers",
      "sequence",
      "steps",
    ]);
    assert.equal(row.outcome, "deferred_budget");
    // 270 s of the 300 s budget at one step per three seconds.
    assert(Number.isSafeInteger(row.steps) && row.steps >= 85, row.steps);
    assert(row.steps <= 91, row.steps);
    assert.equal(row.producers, 0);
    assert(Number.isSafeInteger(row.sequence));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a producer pass past the walk deadline logs one bounded step diagnostic", async () => {
  const rig = await walkRig({
    producers: 3,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    recoverCost: () => 301_000,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(isDeferredCurrentMatrixHistoryBudget(outcome.error));
    assert.deepEqual(
      walkRows(outcome.lines).map((row) => [row.outcome, row.producers]),
      [["deferred_budget", 1]],
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a lost oldest parked group never holds the traversal back from a newer live group", async () => {
  // No in-flight work. The oldest group's plan expired and its producer lies
  // past the reserve (three seconds per local ancestry proof): the traversal
  // stops there and the newer live group's producer, already found, still
  // runs.
  const rig = await walkRig({
    producers: 120,
    rows: [
      blocked("blocked-expired", FIRST_RUN, 7001),
      blocked("blocked-live", FIRST_RUN + 115, 7116),
    ],
    plans: new Map([
      [FIRST_RUN + 115, { id: 7116, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
    gitCost: (args) => args[0] === "merge-base" ? 3000 : 0,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1116 blocked-live");
    assert.deepEqual(rig.calls.listed, [FIRST_RUN + 115]);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 115]);
    assert.deepEqual(walkLines(outcome.lines), ["deferred_budget"]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an expired bound plan artifact is a typed per-producer skip and the walk recovers the newer producer", async () => {
  const newer = blocked("blocked-newer", FIRST_RUN + 2, 7003);
  const older = blocked("blocked-older", FIRST_RUN, 7001);
  const rig = await walkRig({
    producers: 3,
    rows: [newer, older],
    plans: new Map([
      [FIRST_RUN + 2, { id: 7003, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1003 blocked-newer");
    assert.deepEqual(rig.unrecoverable, ["expired"]);
    // The expired archive is never downloaded.
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 2]);
    const skipped = outcome.lines.map((line) => JSON.parse(line)).filter((
      row,
    ) => row.kind === "sentinel_current_matrix_producer_unrecoverable");
    assert.deepEqual(skipped, [{
      kind: "sentinel_current_matrix_producer_unrecoverable",
      runId: FIRST_RUN,
      runAttempt: 1,
      artifact: "expired",
      requests: 1,
    }]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an unlisted plan artifact skips its producer and its requests never reach an older producer", async () => {
  const inFlight = working("work-in-flight");
  const newest = blocked("blocked-newest", FIRST_RUN + 2, 7003);
  const older = blocked("blocked-older", FIRST_RUN, 7001);
  const rig = await walkRig({
    producers: 3,
    rows: [inFlight, newest, older],
    plans: new Map([
      [FIRST_RUN + 1, { id: 7002, digest: ARCHIVE, expired: false }],
      [FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }],
    ]),
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    // The newest bound producer is unlisted: its in-flight request is
    // withheld from every older producer (the listed one included) instead
    // of being settled by an older wave.
    assert.deepEqual(rig.unrecoverable, ["expired", "unlisted"]);
    assert.deepEqual(rig.calls.recovered, []);
    assert.deepEqual(
      outcome.lines.map((line) => JSON.parse(line)).filter((row) =>
        row.kind === "sentinel_current_matrix_producer_unrecoverable"
      ).map((row) => [row.runId, row.artifact, row.requests]),
      [
        [FIRST_RUN, "expired", 1],
        [FIRST_RUN + 2, "unlisted", 1],
        // The ordinary walk's revisit newly withholds the in-flight request.
        [FIRST_RUN + 2, "unlisted", 1],
      ],
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an unlisted plan requested only by in-flight work keeps the transport refusal", async () => {
  const rig = await walkRig({
    producers: 2,
    rows: [working("work-in-flight")],
  });
  try {
    await assert.rejects(rig.walk, /^Error: current matrix wave unavailable$/);
    assert.deepEqual(rig.unrecoverable, []);
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 1]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a blocker-bound producer is reached before a newer in-flight producer exhausts the budget", async () => {
  // In-flight work binds every ordinary producer, and the newest producer's
  // pass outlives the whole 300 s budget on every run.
  const rig = await walkRig({
    producers: 5,
    rows: [
      working("work-in-flight"),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    recoverCost: (runId) => runId === FIRST_RUN + 4 ? 301_000 : 0,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    // Only the parked candidate is requested from its exact producer: the
    // in-flight request is never offered to that older wave.
    assert.equal(outcome.error.message, "REACHED 1001 blocked-oldest");
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN]);
    assert.equal(rig.calls.ports, 1);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an unresolved newer in-flight producer does not stop a blocker-bound older producer", async () => {
  // A blocked record bound to an older producer is not a reservation the
  // newer producer could ever settle, so its deferral does not withhold it.
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    completed: (runId) => runId !== FIRST_RUN + 2,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1001 blocked-oldest");
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("in-flight work still waits for an unresolved newer producer after the blocker-bound pass", async () => {
  // The older producer's plan expired: a typed skip of its parked candidate
  // only. The newest producer is still in flight, so the in-flight request
  // is offered to no older wave and nothing is downloaded or written.
  const rig = await walkRig({
    producers: 3,
    rows: [
      working("work-in-flight"),
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([[FIRST_RUN, { id: 7001, digest: ARCHIVE, expired: true }]]),
    completed: (runId) => runId !== FIRST_RUN + 2,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    assert.deepEqual(rig.unrecoverable, ["expired"]);
    assert.deepEqual(rig.calls.recovered, []);
    const rows = outcome.lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      rows.filter((row) =>
        row.kind === "sentinel_current_matrix_producer_unrecoverable"
      ).map((row) => [row.runId, row.requests]),
      [[FIRST_RUN, 1]],
    );
    assert.deepEqual(
      rows.filter((row) => row.kind === "sentinel_current_matrix_walk").map((
        row,
      ) => row.outcome),
      ["deferred_producer"],
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an unrecoverable blocker-bound producer is one action, and the ordinary walk logs only the requests it newly withholds", async () => {
  const rig = await walkRig({
    producers: 2,
    rows: [
      working("work-in-flight", "9".repeat(64)),
      working("work-in-flight-2", "8".repeat(64)),
      blocked("blocked-newest", FIRST_RUN + 1, 7002),
    ],
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    assert.equal(outcome.value, null);
    // The ordinary walk classifies the same unlisted plan again and still
    // withholds the in-flight requests from every older producer.
    assert.deepEqual(rig.unrecoverable, ["unlisted"]);
    assert.deepEqual(rig.calls.recovered, []);
    assert.deepEqual(
      outcome.lines.map((line) => JSON.parse(line)).filter((row) =>
        row.kind === "sentinel_current_matrix_producer_unrecoverable"
      ).map((row) => [row.runId, row.requests]),
      [[FIRST_RUN + 1, 1], [FIRST_RUN + 1, 2]],
    );
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a blocker-bound pass still refuses a malformed in-flight binding", async () => {
  // The blocked scope narrows what is requested, never what is checked: every
  // record's exact charge binding is refused before any port is built.
  const inFlight = working("work-in-flight");
  const rig = await walkRig({
    producers: 3,
    rows: [
      { ...inFlight, charge: { ...inFlight.charge, head: SHA2 } },
      blocked("blocked-oldest", FIRST_RUN, 7001),
    ],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
  });
  try {
    await assert.rejects(
      rig.walk,
      (error: unknown) =>
        error instanceof CurrentMatrixRecoveryIntegrityFailure &&
        error.message === "current matrix request binding unavailable",
    );
    assert.equal(rig.calls.ports, 0);
    assert.deepEqual(rig.calls.recovered, []);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("an unfound blocker-bound producer leaves the ordinary walk its budget reserve", async () => {
  // The blocker names a producer this history never holds: the first walk
  // stops stepping at its slice and the newest in-flight producer still runs.
  const rig = await walkRig({
    producers: 120,
    rows: [
      working("work-in-flight"),
      blocked("blocked-unfound", FIRST_RUN - 50, 7001),
    ],
    plans: new Map([[FIRST_RUN + 119, {
      id: 7120,
      digest: ARCHIVE,
      expired: false,
    }]]),
    gitCost: (args) => args[0] === "merge-base" ? 3000 : 0,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1120 work-in-flight");
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 119]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("with in-flight work the parked traversal leaves the ordinary walk half the budget", async () => {
  // Live 2026-10-24 (run 40097996543): two parked rows named a producer whose
  // plan had expired 1031 history steps back; that traversal read until its
  // 30 s reserve and the in-flight producer's recovery ran out of budget on
  // every pass. With in-flight work pending it now stops at half the budget.
  const rig = await walkRig({
    producers: 120,
    rows: [
      working("work-in-flight"),
      blocked("blocked-unfound", FIRST_RUN - 50, 7001),
    ],
    gitCost: (args) => args[0] === "merge-base" ? 3000 : 0,
    recoverCost: () => 60_000,
    applies: (runId) => runId === FIRST_RUN + 119,
  });
  try {
    const outcome = await captured(rig.walk);
    assert.equal(outcome.error, null, String(outcome.error));
    const result = outcome.value as { status: string } | null;
    assert.equal(result?.status, "applied", outcome.lines.join("\n"));
    assert.deepEqual(rig.calls.recovered, [FIRST_RUN + 119]);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("a listed bound plan artifact with a conflicting identity stays fatal", async () => {
  const rig = await walkRig({
    producers: 2,
    rows: [blocked("blocked-conflict", FIRST_RUN + 1, 7002)],
    plans: new Map([
      [FIRST_RUN + 1, { id: 9999, digest: ARCHIVE, expired: true }],
    ]),
  });
  try {
    await assert.rejects(rig.walk, new RegExp(`^Error: ${REFUSAL}$`));
    assert.deepEqual(rig.unrecoverable, []);
  } finally {
    await rig.cleanup();
  }
});

for (
  const fault of [
    "wrong-head",
    "wrong-sequence",
    "cycle",
    "unavailable",
  ] as const
) {
  Deno.test(`current matrix walk refuses a ${fault} local history read`, async () => {
    const rig = await walkRig({
      producers: 4,
      rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
      plans: new Map([[FIRST_RUN, {
        id: 7001,
        digest: ARCHIVE,
        expired: false,
      }]]),
      wrapState: (state) => {
        const open = state.openReleaseHistory as (
          input: { expectedHead: GitSha },
        ) => Promise<
          {
            ok: boolean;
            value: {
              readAt(commit: GitSha): Promise<
                {
                  ok: boolean;
                  value: {
                    head: GitSha;
                    snapshot: { sequence: number; stateHead: GitSha | null };
                  };
                }
              >;
              close(): Promise<void>;
            };
          }
        >;
        let first: GitSha | null = null;
        state.openReleaseHistory = async (input: { expectedHead: GitSha }) => {
          first = input.expectedHead;
          const opened = await open(input);
          if (!opened.ok) return opened;
          const view = opened.value;
          return portOk({
            close: () => view.close(),
            readAt: async (commit: GitSha) => {
              if (fault === "unavailable") {
                return portError("unavailable", "offline view unavailable");
              }
              const read = await view.readAt(commit);
              assert(read.ok);
              if (fault === "wrong-head") {
                return portOk({ ...read.value, head: first });
              }
              if (fault === "wrong-sequence") {
                return portOk({
                  ...read.value,
                  snapshot: {
                    ...read.value.snapshot,
                    sequence: read.value.snapshot.sequence + 2,
                  },
                });
              }
              return portOk({
                ...read.value,
                snapshot: { ...read.value.snapshot, stateHead: first },
              });
            },
          });
        };
      },
    });
    try {
      await assert.rejects(
        rig.walk,
        (error: unknown) =>
          error instanceof CurrentMatrixRecoveryIntegrityFailure,
      );
      assert.deepEqual(rig.calls.recovered, []);
    } finally {
      await rig.cleanup();
    }
  });
}

Deno.test("an unavailable history view falls back to exact per-step history reads", async () => {
  const rig = await walkRig({
    producers: 4,
    rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
    plans: new Map([[FIRST_RUN, {
      id: 7001,
      digest: ARCHIVE,
      expired: false,
    }]]),
    wrapState: (state) => {
      state.openReleaseHistory = () =>
        Promise.resolve(portError("unavailable", "offline view unavailable"));
    },
  });
  try {
    await assert.rejects(rig.walk, /^Error: REACHED 1001 blocked-oldest$/);
    assert(rig.runner.complete >= 4, String(rig.runner.complete));
  } finally {
    await rig.cleanup();
  }
});

Deno.test("release history view proves ancestry locally and refuses a moved head", async () => {
  const rig = await walkRig({ producers: 3, rows: [] });
  try {
    const open = Reflect.get(rig.store, "openReleaseHistory") as (
      input: { expectedHead: GitSha },
    ) => Promise<
      {
        ok: boolean;
        value: {
          readAt(commit: string): Promise<
            {
              ok: boolean;
              value?: {
                head: string;
                snapshot: { sequence: number; stateHead: string | null };
              };
              error?: { kind: string };
            }
          >;
          close(): Promise<void>;
        };
        error?: { kind: string };
      }
    >;
    assert.equal(typeof open, "function");
    const latest = await rig.store.readRelease();
    assert(latest.ok && latest.value.status === "found");
    const moved = await open.call(rig.store, { expectedHead: SHA1 });
    assert.equal(moved.ok, false);
    assert.equal(moved.error?.kind, "conflict");
    const before = rig.runner.complete;
    const opened = await open.call(rig.store, {
      expectedHead: latest.value.head,
    });
    assert(opened.ok);
    let head: string | null = latest.value.snapshot.stateHead;
    let sequence = latest.value.snapshot.sequence;
    while (head !== null) {
      const read = await opened.value.readAt(head);
      assert(read.ok && read.value, JSON.stringify(read));
      assert.equal(read.value.head, head);
      assert.equal(read.value.snapshot.sequence, --sequence);
      head = read.value.snapshot.stateHead;
    }
    assert.equal(sequence, 1);
    assert.equal(rig.runner.complete, before + 1);
    const foreign = await opened.value.readAt(SHA2);
    assert.equal(foreign.ok, false);
    assert.equal(foreign.error?.kind, "invalid");
    const malformed = await opened.value.readAt("not-a-commit");
    assert.equal(malformed.ok, false);
    assert.equal(malformed.error?.kind, "invalid");
    await opened.value.close();
    const closed = await opened.value.readAt(latest.value.head);
    assert.equal(closed.ok, false);
    for await (const entry of Deno.readDir(`${rig.root}/release`)) {
      assert(!entry.name.startsWith("state-history-"), entry.name);
    }
  } finally {
    await rig.cleanup();
  }
});

Deno.test("four parked passes that settle nothing and the newer in-flight passes all fit one walk", async () => {
  // The live shape: four parked groups, oldest first, whose passes each reach
  // their recovery and settle nothing (40 s each), then the in-flight walk's
  // nine newer producers that hold no requested cell (5 s each) before the
  // in-flight work's own producer. A 60 s walk ended inside the second
  // parked pass on every run and never reached the in-flight producer.
  const rig = await walkRig({
    producers: 14,
    rows: [
      working("work-in-flight"),
      ...[0, 1, 2, 3].map((offset) =>
        blocked(`blocked-${offset}`, FIRST_RUN + offset, 7001 + offset)
      ),
    ],
    plans: new Map(
      Array.from({ length: 14 }, (_, offset) => [FIRST_RUN + offset, {
        id: 7001 + offset,
        digest: ARCHIVE,
        expired: false,
      }]),
    ),
    settlesNothing: (runId) => runId !== FIRST_RUN + 4,
    recoverCost: (runId) => runId < FIRST_RUN + 4 ? 40_000 : 5_000,
  });
  try {
    const outcome = await captured(rig.walk);
    assert(outcome.error instanceof Error, String(outcome.error));
    assert.equal(outcome.error.message, "REACHED 1005 work-in-flight");
    assert.deepEqual(rig.calls.recovered, [
      FIRST_RUN,
      FIRST_RUN + 1,
      FIRST_RUN + 2,
      FIRST_RUN + 3,
      ...Array.from({ length: 9 }, (_, index) => FIRST_RUN + 13 - index),
      FIRST_RUN + 4,
    ]);
    assert.deepEqual(walkLines(outcome.lines), []);
    // Every pass read its producer snapshot through the walk's one view.
    assert.equal(rig.runner.complete, 1);
  } finally {
    await rig.cleanup();
  }
});

type ReleaseRead = {
  ok: boolean;
  value: {
    status: string;
    head: GitSha;
    snapshot: { updatedAt: number };
  };
};

for (
  const [fault, refusal] of [
    ["moved release head", "current matrix release custody changed"],
    ["changed producer read", "current matrix producer ancestry changed"],
    ["unreadable producer read", REFUSAL],
  ] as const
) {
  Deno.test(`a producer pass reading through the history view still refuses a ${fault} before recovery`, async () => {
    const rig = await walkRig({
      producers: 3,
      rows: [blocked("blocked-oldest", FIRST_RUN, 7001)],
      plans: new Map([[FIRST_RUN, {
        id: 7001,
        digest: ARCHIVE,
        expired: false,
      }]]),
      wrapState: (state) => {
        if (fault === "moved release head") {
          // The walk's own first read is genuine; every later live read
          // finds the release head moved.
          const read = state.readRelease as () => Promise<ReleaseRead>;
          let reads = 0;
          state.readRelease = async () => {
            const result = await read();
            if (++reads === 1 || !result.ok) return result;
            return portOk({ ...result.value, head: SHA1 });
          };
          return;
        }
        const open = state.openReleaseHistory as (
          input: { expectedHead: GitSha },
        ) => Promise<
          {
            ok: boolean;
            value: {
              readAt(commit: GitSha): Promise<ReleaseRead>;
              close(): Promise<void>;
            };
          }
        >;
        state.openReleaseHistory = async (input: { expectedHead: GitSha }) => {
          const opened = await open(input);
          if (!opened.ok) return opened;
          const view = opened.value;
          const seen = new Set<GitSha>();
          return portOk({
            close: () => view.close(),
            // The traversal's own read of each commit is genuine; every
            // later read of it by the producer pass is not.
            readAt: async (commit: GitSha) => {
              const read = await view.readAt(commit);
              if (!seen.has(commit) || !read.ok) {
                seen.add(commit);
                return read;
              }
              if (fault === "unreadable producer read") {
                return portError("unavailable", "offline view unavailable");
              }
              return portOk({
                ...read.value,
                snapshot: {
                  ...read.value.snapshot,
                  updatedAt: read.value.snapshot.updatedAt + 1,
                },
              });
            },
          });
        };
      },
    });
    try {
      const outcome = await captured(rig.walk);
      assert(outcome.error instanceof Error, String(outcome.error));
      assert.equal(outcome.error.message, refusal);
      assert.equal(
        outcome.error instanceof CurrentMatrixRecoveryIntegrityFailure,
        refusal !== REFUSAL,
      );
      assert.deepEqual(rig.calls.confirmed, [FIRST_RUN]);
      assert.deepEqual(rig.calls.recovered, []);
    } finally {
      await rig.cleanup();
    }
  });
}
