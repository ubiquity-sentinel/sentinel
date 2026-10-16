/**
 * Parked candidate preservation that can never complete reaches the ordinary
 * retry authority through the real hosted maintenance pass: the historical
 * custody class only after native proof that the exact candidate is gone, the
 * trusted-refusal class only after the base advanced, a day after the refusal
 * and while its task holds few charges. The consumed admission stays
 * byte-identical throughout; nothing is refunded or charged here.
 */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy.ts";
import {
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";
import {
  BASE,
  DAY,
  expectNotJudged,
  expectRetained,
  type Facts,
  HEAD,
  parkedFixture,
  refusedFixture,
  REPO,
  runAt,
  TIP,
  UNRECOVERABLE,
} from "./hosted-autonomy-preservation-cases.ts";
import { reservation, T0 } from "../state/helpers.ts";

/** The runtime's proven-absence shape, blocked on the retryable class. */
function disposed(record: WorkRecordV1, at: number) {
  const { candidateState: _dropped, ...target } = record.target;
  return {
    ...record,
    intent: null,
    wait: null,
    target: { ...target, head: null },
    updatedAt: at,
  };
}

Deno.test("preservation disposition: proven-absent historical candidate reaches the retry authority without a refund", async () => {
  const { record, charge } = await parkedFixture();
  const state = new TransitionState(snapshotOf([record], [charge]));
  const before = structuredClone(state.snapshot);
  const now = T0 + 9 * DAY;

  const first = await runAt(state, {}, now);
  assert.equal(first.status, "applied", JSON.stringify(first));
  assert.equal(first.reason, "dispositioned");
  assert.equal(state.writes, 1);
  assert(
    first.actions.includes(`preservation:${record.id}:unrecoverable:absent`),
  );
  const parked = state.snapshot.work[0]!;
  assert(parked.blocker?.message.startsWith(UNRECOVERABLE));
  assert.equal(parked.nextStep, "blocked");
  assert.deepEqual(
    { ...parked, blocker: null },
    { ...disposed(record, now), blocker: null },
  );
  assert.equal(parked.target.candidateState, undefined);
  assert.deepEqual(state.snapshot.reservations, before.reservations);

  // The ordinary retry authority owns the next step: a fresh admission, the
  // consumed charge untouched and no other record moved.
  const second = await runAt(state, {}, now + 1000);
  assert.equal(second.status, "applied", JSON.stringify(second));
  assert.equal(second.reason, "retried");
  const retried = state.snapshot.work[0]!;
  assert.equal(retried.nextStep, "work");
  assert.equal(retried.blocker, null);
  assert.equal(retried.intent, null);
  assert.equal(retried.target.head, null);
  assert.equal(retried.target.candidateState, undefined);
  assert.equal(retried.counters.attempts, 2);
  assert.deepEqual(state.snapshot.reservations, before.reservations);
});

for (
  const [name, facts, reason] of [
    [
      "an existing preservation ref",
      { preservationRefAbsent: false },
      "preservation_ref",
    ],
    [
      "an unreadable preservation ref",
      { preservationRefAbsent: null },
      "preservation_ref",
    ],
    [
      "an existing candidate branch",
      { branchAbsent: false },
      "candidate_branch",
    ],
    ["a present candidate commit", { headAbsent: false }, "candidate_commit"],
    ["a blind commit surface", { baseAbsent: true }, "base_commit"],
    ["an observed pull request", {
      pulls: [{ number: 1, state: "closed", head: "x" }],
    }, "pulls"],
    ["an unreadable pull listing", { pulls: null }, "pulls"],
    [
      "a surface without commit reads",
      { commitCapability: false },
      "capability_absent",
    ],
  ] as const
) {
  Deno.test(`preservation disposition: ${name} retains the parked candidate`, async () => {
    const { record, charge } = await parkedFixture();
    const state = new TransitionState(snapshotOf([record], [charge]));
    const before = canonicalStringify(state.snapshot);
    const result = await runAt(state, facts as Facts, T0 + 9 * DAY);
    assert.equal(state.writes, 0, JSON.stringify(result));
    assert.equal(canonicalStringify(state.snapshot), before);
    assert(
      result.actions.includes(`preservation:${record.id}:retained:${reason}`),
      JSON.stringify(result),
    );
  });
}

Deno.test("preservation disposition: artifact retention not yet past retains the parked candidate", async () => {
  const { record, charge } = await parkedFixture();
  const state = new TransitionState(snapshotOf([record], [charge]));
  const before = canonicalStringify(state.snapshot);
  const result = await runAt(state, {}, T0 + 7 * DAY);
  assert.equal(state.writes, 0);
  assert.equal(canonicalStringify(state.snapshot), before);
  assert(
    result.actions.includes(
      `preservation:${record.id}:retained:artifact_retention`,
    ),
  );
});

Deno.test("preservation disposition: a closed issue's parked or refused record is left alone", async () => {
  // Both would be disposed at this instant were their issues open.
  for (
    const { record, charge } of [
      await parkedFixture({ issue: 884 }),
      await refusedFixture(),
    ]
  ) {
    await expectNotJudged(
      [record],
      [charge],
      { issueOpen: false },
      T0 + 9 * DAY,
    );
  }
});

Deno.test("preservation disposition: a validation refusal re-enters the retry authority once the base advanced", async () => {
  const { record, charge } = await refusedFixture();
  const state = new TransitionState(snapshotOf([record], [charge]));
  const before = structuredClone(state.snapshot);
  // Exactly one day after the refusal is the earliest re-entry.
  const now = record.blocker!.since + DAY;
  const first = await runAt(state, {}, now);
  assert.equal(first.status, "applied", JSON.stringify(first));
  assert(
    first.actions.includes(`preservation:${record.id}:unrecoverable:refused`),
  );
  const parked = state.snapshot.work[0]!;
  assert(parked.blocker?.message.startsWith(UNRECOVERABLE));
  assert.deepEqual(
    { ...parked, blocker: null },
    { ...disposed(record, now), blocker: null },
  );
  assert.deepEqual(state.snapshot.reservations, before.reservations);
  const second = await runAt(state, {}, now + 1000);
  assert.equal(second.reason, "retried", JSON.stringify(second));
  assert.equal(state.snapshot.work[0]!.nextStep, "work");
  assert.equal(state.snapshot.work[0]!.counters.attempts, 3);
  assert.deepEqual(state.snapshot.reservations, before.reservations);
});

for (
  const [name, tip, reason] of [
    ["at the unchanged base", BASE, "base_unchanged"],
    // A 5xx, 429 or timeout on the tip read proves no changed evidence.
    ["under an unreadable base tip", null, "base_unreadable"],
  ] as const
) {
  Deno.test(`preservation disposition: a validation refusal ${name} stays blocked`, async () => {
    const { record, charge } = await refusedFixture();
    await expectRetained(
      [record],
      [charge],
      { tip },
      T0 + 2 * DAY,
      record.id,
      reason,
    );
  });
}

Deno.test("preservation disposition: the native commit read proves absence only from an exact 404", async () => {
  const observe = createHostedAutonomyGitHub("offline-native-token", REPO)
    .mismatchDisposition;
  assert(observe?.readCommitAbsent !== undefined);
  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push(url.pathname);
    const sha = url.pathname.split("/").at(-1);
    const respond = (status: number, body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));
    if (sha === HEAD) return respond(404, { message: "Not Found" });
    if (sha === BASE) return respond(200, { sha: BASE });
    if (sha === TIP) return respond(200, { sha: BASE });
    return respond(500, {});
  };
  try {
    assert.equal(await observe.readCommitAbsent(HEAD), true);
    assert.equal(await observe.readCommitAbsent(BASE), false);
    assert.equal(await observe.readCommitAbsent(TIP), null);
    assert.equal(await observe.readCommitAbsent("f".repeat(40)), null);
    assert.equal(await observe.readCommitAbsent("not-a-sha"), null);
    assert.deepEqual(requests, [
      `/repos/ubiquity/ai.ubq.fi/git/commits/${HEAD}`,
      `/repos/ubiquity/ai.ubq.fi/git/commits/${BASE}`,
      `/repos/ubiquity/ai.ubq.fi/git/commits/${TIP}`,
      `/repos/ubiquity/ai.ubq.fi/git/commits/${"f".repeat(40)}`,
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

/** More charges for the same task at older bases (every one counts). */
function extraCharges(id: string, count: number) {
  return Array.from(
    { length: count },
    (_, index) =>
      reservation(String(index + 1).repeat(64).slice(0, 64), {
        repository: REPO,
        taskId: id,
        attempt: 10 + index,
        head: TIP,
        purpose: index % 2 === 0 ? "implementation" : "review_request",
        outcome: index % 3 === 0 ? "ambiguous" : "submitted",
        createdAt: T0 - 5000,
        settledAt: T0 - 4000,
      }),
  );
}

Deno.test("preservation disposition: a validation refusal inside a day of the refusal stays blocked", async () => {
  const { record, charge } = await refusedFixture();
  await expectRetained(
    [record],
    [charge],
    {},
    record.blocker!.since + DAY - 1,
    record.id,
    "pacing",
  );
});

Deno.test("preservation disposition: a validation refusal whose task already holds six charges stays blocked", async () => {
  const { record, charge } = await refusedFixture();
  await expectRetained(
    [record],
    [charge, ...extraCharges(record.id, 5)],
    {},
    T0 + 2 * DAY,
    record.id,
    "reservation_cap",
  );
});

Deno.test("preservation disposition: a validation refusal whose task holds five charges still re-enters once", async () => {
  const { record, charge } = await refusedFixture();
  const state = new TransitionState(
    snapshotOf([record], [charge, ...extraCharges(record.id, 4)]),
  );
  const before = structuredClone(state.snapshot.reservations);
  const result = await runAt(state, {}, T0 + 2 * DAY);
  assert(
    result.actions.includes(`preservation:${record.id}:unrecoverable:refused`),
    JSON.stringify(result),
  );
  assert.deepEqual(state.snapshot.reservations, before);
});

for (
  const [name, mutate] of [
    ["an ambiguous", { outcome: "ambiguous" }],
    ["an unsettled", { outcome: "reserved", settledAt: null }],
    ["an other-base", { head: TIP }],
    ["an other-attempt", { attempt: 1 }],
  ] as const
) {
  Deno.test(`preservation disposition: ${name} producing charge binds neither class`, async () => {
    const parked = await parkedFixture();
    await expectRetained(
      [parked.record],
      [{ ...parked.charge, ...mutate }],
      {},
      T0 + 9 * DAY,
      parked.record.id,
      "binding",
    );
    const refused = await refusedFixture();
    await expectRetained(
      [refused.record],
      [{ ...refused.charge, ...mutate }],
      {},
      T0 + 2 * DAY,
      refused.record.id,
      "charge",
    );
  });
}

Deno.test("preservation disposition: a missing producing charge binds neither class", async () => {
  const parked = await parkedFixture();
  await expectRetained(
    [parked.record],
    [],
    {},
    T0 + 9 * DAY,
    parked.record.id,
    "binding",
  );
  const refused = await refusedFixture();
  await expectRetained(
    [refused.record],
    [],
    {},
    T0 + 2 * DAY,
    refused.record.id,
    "charge",
  );
});

Deno.test("preservation disposition: a record that names a pull request is never disposed", async () => {
  const parked = await parkedFixture();
  await expectRetained(
    [{ ...parked.record, target: { ...parked.record.target, pr: 1012 } }],
    [parked.charge],
    {},
    T0 + 9 * DAY,
    parked.record.id,
    "shape",
  );
  const refused = await refusedFixture();
  await expectRetained(
    [{ ...refused.record, target: { ...refused.record.target, pr: 1012 } }],
    [refused.charge],
    {},
    T0 + 2 * DAY,
    refused.record.id,
    "shape",
  );
});

Deno.test("preservation disposition: a record whose charge a dedicated matrix recovery owns is left to it", async () => {
  const dedicated = CLOSED_C_WAVE.cells[0]!.reservationId;
  for (
    const { record, charge } of [
      await parkedFixture({ dedicated }),
      await refusedFixture({ dedicated }),
    ]
  ) {
    const state = new TransitionState(snapshotOf([record], [charge]));
    const before = canonicalStringify(state.snapshot);
    const result = await runAt(state, {}, T0 + 9 * DAY);
    assert.equal(state.writes, 0, JSON.stringify(result));
    assert.equal(canonicalStringify(state.snapshot), before);
    assert(
      !result.actions.some((action) => action.startsWith("preservation:")),
      JSON.stringify(result),
    );
  }
  // The same records under their own derived charges are disposed.
  const parked = await parkedFixture();
  const refused = await refusedFixture();
  const state = new TransitionState(
    snapshotOf([parked.record, refused.record], [
      parked.charge,
      refused.charge,
    ]),
  );
  const result = await runAt(state, {}, T0 + 9 * DAY);
  assert.equal(state.writes, 1, JSON.stringify(result));
});

Deno.test("preservation disposition: only an exact 404 proves a ref or commit absent; 403, 429 and timeouts are unreadable", async () => {
  const observe = createHostedAutonomyGitHub("offline-native-token", REPO)
    .mismatchDisposition!;
  const originalFetch = globalThis.fetch;
  let mode: "403" | "429" | "timeout" | "404" | "present" = "404";
  globalThis.fetch = () => {
    if (mode === "timeout") {
      return Promise.reject(
        new DOMException("The signal has been aborted", "AbortError"),
      );
    }
    const status = mode === "present" ? 200 : Number(mode);
    const body = mode === "present"
      ? { ref: "refs/heads/x", sha: HEAD }
      : { message: "API rate limit exceeded" };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  try {
    const reads = [
      () => observe.readRefAbsent("refs/heads/sentinel-candidates/x"),
      () => observe.readCommitAbsent!(HEAD),
    ];
    for (const read of reads) {
      mode = "404";
      assert.equal(await read(), true);
      mode = "present";
      assert.equal(await read(), false);
      for (const unreadable of ["403", "429", "timeout"] as const) {
        mode = unreadable;
        assert.equal(await read(), null, unreadable);
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
