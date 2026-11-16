/**
 * The owner's one-park preservation allowance of 2026-11-16
 * (`OWNER_PRESERVATION_ALLOWANCES_2026_11_16`, "#249 one more attempt (cap
 * 6→7)") over the verbatim live rows of sentinel-state/repair at
 * 048efadb4e7d (sequence 96671), through the real protected maintenance
 * pass: sentinel 249, six submitted charges, parked on the trusted
 * validator's refusal since 2026-11-12 and retained at the six-charge
 * preservation cap, is disposed once and returned to work by the ordinary
 * retry grant; its next refusal (the seventh charge) is retained at the cap
 * for good, and no other record or park gains the allowance.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { producerRequests } from "../../ops/hosted-autonomy-producer-requests.ts";
import { TransitionState } from "./hosted-autonomy-preservation-fixtures.ts";
import { DAY, runAt, TIP } from "./hosted-autonomy-preservation-cases.ts";
import {
  execution,
  FIRST_RUN,
} from "./hosted-autonomy-history-reach-fixtures.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL(
      "../fixtures/host/owner-release-preservation-live-v1.json",
      import.meta.url,
    ),
  ),
) as {
  work: WorkRecordV1[];
  attemptMemory: unknown[];
  reservations: RepairStateSnapshotV1["reservations"];
};

const S249 = "issue-ubiquity-sentinel-249";
const REFUSED = "candidate preservation validation refused";
const UNRECOVERABLE =
  "candidate preservation unrecoverable: trusted validation refused the exact candidate; submitted admission retained";
/** A maintenance pass after the owner's decision, days after the park. */
const NOW = Date.UTC(2026, 10, 16, 23);
const HOUR = 60 * 60_000;
/** The seventh start's own candidate head. */
const HEAD7 = "7".repeat(40) as GitSha;
/** A later tip: the base advanced again after the seventh refusal. */
const TIP2 = "8".repeat(40) as GitSha;

const fault = (message: string) =>
  new CurrentMatrixRecoveryIntegrityFailure(
    message,
    "e".repeat(40) as GitSha,
    null,
    null,
  );

const requestsOf = (snapshot: RepairStateSnapshotV1) =>
  producerRequests(snapshot, execution(FIRST_RUN + 1), new Set(), fault);

function snapshotWith(
  work: WorkRecordV1[],
  reservations: unknown[] = LIVE.reservations,
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 5,
    updatedAt: NOW - HOUR,
    incidents: [],
    evidence: [],
    work,
    reservations,
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: LIVE.attemptMemory,
    lessons: [],
  });
}

function live249(): WorkRecordV1 {
  const record = LIVE.work.find((row) => row.id === S249);
  assert.ok(record !== undefined);
  return structuredClone(record);
}

const charges = (snapshot: RepairStateSnapshotV1, id: string) =>
  snapshot.reservations.filter((row) => row.taskId === id).length;

/**
 * The runtime's seventh start of 249 at `tip`, its candidate refused by the
 * trusted validator again (`loop-preservation.ts`: intent cleared, head and
 * descriptor kept, the check-named refusal) with its charge settled
 * submitted, in one validated CAS write.
 */
async function refuseSeventh(state: TransitionState, at: number, tip: GitSha) {
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const prior = read.value.snapshot;
  const record = prior.work.find((row) => row.id === S249)!;
  assert.equal(record.nextStep, "work");
  const requestId = "c".repeat(64);
  const refused: WorkRecordV1 = {
    ...record,
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: `${REFUSED}: secret_shaped_text`,
      since: at,
    },
    intent: null,
    wait: null,
    counters: { ...record.counters, attempts: 7 },
    target: {
      base: tip,
      branch: candidateBranch(S249 as WorkRecordV1["id"]),
      candidateState: { preserved: null, publishedHead: null },
      checkpoint: null,
      head: HEAD7,
      pr: null,
    },
    updatedAt: at,
  };
  const written = await state.writeRepair(
    parseRepairStateSnapshotV1({
      ...prior,
      stateHead: read.value.head,
      sequence: prior.sequence + 1,
      updatedAt: at,
      work: prior.work.map((row) => row.id === S249 ? refused : row),
      reservations: [...prior.reservations, {
        version: "v1",
        kind: "budget_reservation",
        repository: record.repository,
        id: requestId,
        taskId: S249,
        attempt: 7,
        head: tip,
        purpose: "retry",
        createdAt: at - HOUR,
        outcome: "submitted",
        settledAt: at - 1,
        proofRef: null,
      }],
    }),
    read.value.head,
  );
  assert.ok(written.ok && written.value.status === "applied");
}

Deno.test("owner allowance 249: the exact park re-enters once at cap seven; the seventh charge's refusal stays at the cap", async () => {
  const before = snapshotWith([live249()]);
  const state = new TransitionState(before);
  const live = live249();
  assert.equal(charges(before, S249), 6);
  assert.deepEqual(live.blocker, {
    kind: "other",
    message: REFUSED,
    since: 1794524920682,
  });
  assert.deepEqual(await requestsOf(before), []);

  // The disposition re-enters the exact park once (the code before the
  // allowance retained it at the six-charge cap).
  const first = await runAt(state, {}, NOW);
  assert.equal(first.status, "applied", JSON.stringify(first));
  assert.equal(first.reason, "dispositioned");
  assert.ok(
    first.actions.includes(`preservation:${S249}:unrecoverable:refused`),
    JSON.stringify(first.actions),
  );
  const disposed = state.snapshot.work[0];
  const { candidateState: _dropped, ...target } = live.target;
  assert.deepEqual(disposed, {
    ...live,
    intent: null,
    wait: null,
    target: { ...target, head: null },
    blocker: { kind: "other", message: UNRECOVERABLE, since: NOW },
    updatedAt: NOW,
  });
  assert.deepEqual(state.snapshot.reservations, before.reservations);
  assert.deepEqual(await requestsOf(state.snapshot), []);

  // The ordinary retry grant returns it to work: uncharged, the base kept.
  const second = await runAt(state, {}, NOW + 1000);
  assert.equal(second.reason, "retried", JSON.stringify(second));
  assert.ok(
    second.actions.includes(
      `retry:${S249}:grant=0:other:candidate preservation unrecoverable:base-advance`,
    ),
    JSON.stringify(second.actions),
  );
  const released = state.snapshot.work[0];
  assert.equal(released.nextStep, "work");
  assert.equal(released.blocker, null);
  assert.equal(released.intent, null);
  assert.equal(released.counters.attempts, 6);
  assert.deepEqual(released.target, disposed.target);
  assert.deepEqual(state.snapshot.reservations, before.reservations);
  assert.deepEqual(await requestsOf(state.snapshot), []);

  // A third pass leaves the record at work (nothing re-enters it again).
  const writes = state.writes;
  const idle = await runAt(state, {}, NOW + 2000);
  assert.equal(state.writes, writes, JSON.stringify(idle));

  // The runtime's seventh start is refused again: its new park is not the
  // allowance's, so the ordinary cap retains it, a day later and on a moved
  // base alike. Seven charges in all; an eighth is never re-entered here.
  const at = NOW + HOUR;
  await refuseSeventh(state, at, TIP);
  assert.equal(charges(state.snapshot, S249), 7);
  assert.deepEqual(await requestsOf(state.snapshot), []);
  const parked = canonicalStringify(state.snapshot);
  const third = await runAt(state, { tip: TIP2 }, at + 2 * DAY);
  assert.ok(
    third.actions.includes(`preservation:${S249}:retained:reservation_cap`),
    JSON.stringify(third.actions),
  );
  assert.equal(canonicalStringify(state.snapshot), parked);
});

Deno.test("owner allowance 249: no other record or park gains the seventh charge", async () => {
  const live = live249();
  const blocker = live.blocker!;
  // The same park, the same six charges, on another record.
  const otherId = "issue-ubiquity-sentinel-9249";
  const other: WorkRecordV1 = {
    ...live,
    id: otherId as WorkRecordV1["id"],
    source: { ...live.source, id: "9249" },
    related: { ...live.related, issueNumber: 9249 },
    target: {
      ...live.target,
      branch: candidateBranch(otherId as WorkRecordV1["id"]),
    },
  };
  const otherCharges = LIVE.reservations.map((row, index) => ({
    ...row,
    id: `${index}`.padEnd(64, "d"),
    taskId: otherId,
  }));
  // Both in one pass: only 249 is re-entered, the copy keeps the cap.
  const state = new TransitionState(
    snapshotWith([live, other], [...LIVE.reservations, ...otherCharges]),
  );
  const result = await runAt(state, {}, NOW);
  assert.ok(
    result.actions.includes(`preservation:${S249}:unrecoverable:refused`),
    JSON.stringify(result.actions),
  );
  assert.ok(
    result.actions.includes(`preservation:${otherId}:retained:reservation_cap`),
    JSON.stringify(result.actions),
  );
  assert.equal(
    state.snapshot.work.find((row) => row.id === otherId)?.blocker?.message,
    REFUSED,
  );
  // 249 under any other park of the same class keeps the six-charge cap.
  for (
    const [name, park] of [
      ["a later refusal", { ...blocker, since: blocker.since + 1 }],
      [
        "a check-named refusal",
        { ...blocker, message: `${REFUSED}: secret_shaped_text` },
      ],
    ] as const
  ) {
    const parkedState = new TransitionState(
      snapshotWith([{ ...live, blocker: park }]),
    );
    const before = canonicalStringify(parkedState.snapshot);
    const retained = await runAt(parkedState, {}, NOW);
    assert.ok(
      retained.actions.includes(
        `preservation:${S249}:retained:reservation_cap`,
      ),
      `${name}: ${JSON.stringify(retained.actions)}`,
    );
    assert.equal(canonicalStringify(parkedState.snapshot), before, name);
  }
});
