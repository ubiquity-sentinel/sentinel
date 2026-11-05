/**
 * The repeat-failure park re-arms once per installed runtime revision. Live
 * parks (ai.ubq.fi 1210/1211/1281/1282 and others, `other|ff0e06bb0b1bfebd`,
 * "model run completed without any change to its checkout") were written
 * before a park recorded its revision, so a newly installed runtime (with a
 * changed implementer prompt) never re-admitted them. Replays the live
 * ai.ubq.fi 300 rows of the repeat-failure fixture.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { attemptMemorySettlementMutationV1 } from "../../src/repair/attempt-policy.ts";
import {
  applyHostedRetries,
  hostedRepositoryKey,
  planHostedRetries,
  type RetryPlanV1,
} from "../../ops/hosted-autonomy.ts";
import {
  applyRepeatFailureParks,
  parseRepeatFailurePark,
  type RepeatFailureParkPlanV1,
  repeatFailureRouteIdentity,
} from "../../ops/hosted-autonomy-repeat-failure.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/repeat-failure-live-v1.json", import.meta.url),
  ),
) as {
  work: WorkRecordV1[];
  attemptMemory: unknown[];
  reservations: unknown[];
};

/** The revision every live outcome ran under. */
const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
/** Two later installed runtime revisions. */
const R81 = "81818181818181818181818181818181abcdef01" as GitSha;
const R82 = "82828282828282828282828282828282abcdef02" as GitSha;
const AI_300 = "issue-ubiquity-ai.ubq.fi-300";
const UNAVAILABLE = "model run failed (unavailable)";
const NOW = Date.parse("2026-10-17T23:05:00Z");
const HOUR = 60 * 60 * 1000;
const ROUTE = repeatFailureRouteIdentity({
  baseUrl: "",
  model: "gpt-reserve",
  fallback: "gateway",
});
const DIGEST_300 = "3".repeat(64);
const NEW_BASE = "abcdefabcdefabcdefabcdefabcdefabcdefabcd" as GitSha;

/** Only ai.ubq.fi 300 and its own rows: the other live rows are unrelated. */
function liveSnapshot(): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: NOW - 60_000,
    incidents: [],
    evidence: [],
    work: LIVE.work.filter((record) => record.id === AI_300),
    reservations: LIVE.reservations,
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: LIVE.attemptMemory,
    lessons: [],
  });
}

function workOf(snapshot: RepairStateSnapshotV1): WorkRecordV1 {
  const record = snapshot.work.find((item) => item.id === AI_300);
  assert.ok(record !== undefined);
  return record;
}

function ownTips(snapshot: RepairStateSnapshotV1): Map<string, string | null> {
  const record = workOf(snapshot);
  return new Map([[
    hostedRepositoryKey(record.repository),
    record.target.base,
  ]]);
}

interface PassV1 {
  plans: RetryPlanV1[];
  parks: RepeatFailureParkPlanV1[];
  denials: Map<string, string>;
}

/** One launcher planning pass under the installed `runtime` (or none). */
function pass(
  snapshot: RepairStateSnapshotV1,
  runtime: GitSha | undefined,
  now = NOW,
): PassV1 {
  const parks: RepeatFailureParkPlanV1[] = [];
  const denials = new Map<string, string>();
  const plans = planHostedRetries(
    snapshot,
    now,
    runtime ?? R80,
    ownTips(snapshot),
    new Set(),
    (denial) => denials.set(denial.id, denial.reason),
    {
      repeatFailure: {
        route: ROUTE,
        issueDigests: new Map([[AI_300, DIGEST_300]]),
        ...(runtime === undefined ? {} : { runtime }),
      },
      onRepeatFailurePark: (park) => parks.push(park),
    },
  );
  return { plans, parks, denials };
}

/** One more identical failed implementation, settled under `runtime`. */
async function settleFailure(
  snapshot: RepairStateSnapshotV1,
  runtime: GitSha,
  at: number,
): Promise<RepairStateSnapshotV1> {
  const record = workOf(snapshot);
  const moved: WorkRecordV1 = {
    ...record,
    nextStep: "blocked",
    target: { ...record.target, base: NEW_BASE },
    blocker: { kind: "other", message: UNAVAILABLE, since: at },
    updatedAt: at,
  };
  const memory = await attemptMemorySettlementMutationV1({
    record: moved,
    detail: UNAVAILABLE,
    now: at,
    runtimeSha: runtime,
  });
  const draft = structuredClone(snapshot) as RepairStateSnapshotV1;
  draft.work = draft.work.map((item) => item.id === AI_300 ? moved : item);
  draft.updatedAt = at;
  memory(draft);
  draft.attemptMemory.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  return parseRepairStateSnapshotV1(draft);
}

/** The live park as a launcher that recorded no revision wrote it. */
function legacyParked(): RepairStateSnapshotV1 {
  const snapshot = liveSnapshot();
  const first = pass(snapshot, undefined);
  assert.equal(first.parks.length, 1, JSON.stringify([...first.denials]));
  assert.equal(first.parks[0].park.revision, undefined);
  assert.doesNotMatch(first.parks[0].message, / rev=/);
  return applyRepeatFailureParks(snapshot, first.parks, NOW);
}

function rearmPlan(next: PassV1): RetryPlanV1 {
  const plan = next.plans.find((item) => item.id === AI_300);
  assert.ok(plan !== undefined, JSON.stringify([...next.denials]));
  return plan;
}

Deno.test("repeat failure runtime: a legacy park re-arms once under the installed revision", () => {
  const parked = legacyParked();
  // Without a runtime fact nothing changes: the park is only named.
  const bare = pass(parked, undefined, NOW + 5 * 60_000);
  assert.equal(bare.plans.length, 0);
  assert.match(bare.denials.get(AI_300) ?? "", /^repeat_failure_parked:/);
  const next = pass(parked, R81, NOW + 10 * 60_000);
  const plan = rearmPlan(next);
  assert.equal(plan.nextStep, "work");
  assert.equal(plan.grant, 0);
  assert.equal(plan.detail, "other:repeat_failure_rearmed:runtime_changed");
  assert.equal(next.parks.length, 0);
  const granted = applyHostedRetries(parked, NEW_BASE, [plan], NOW);
  const record = workOf(granted);
  assert.equal(record.nextStep, "work");
  assert.equal(record.blocker, null);
  // Counted, never refunded: charged history and counters are unchanged.
  assert.equal(record.counters.attempts, workOf(parked).counters.attempts);
  assert.deepEqual(granted.reservations, parked.reservations);
  assert.deepEqual(granted.attemptMemory, parked.attemptMemory);
});

Deno.test("repeat failure runtime: the re-armed revision re-parks with its revision and never re-arms twice; a newer one does", async () => {
  const parked = legacyParked();
  const granted = applyHostedRetries(
    parked,
    NEW_BASE,
    [rearmPlan(pass(parked, R81, NOW + 10 * 60_000))],
    NOW + 10 * 60_000,
  );
  // The re-armed run fails identically under R81: the change did not alter
  // the outcome, so the record re-parks at once, recording R81.
  const failed = await settleFailure(granted, R81, NOW + HOUR);
  const repark = pass(failed, R81, NOW + HOUR + 60_000);
  assert.equal(repark.plans.length, 0);
  assert.equal(repark.parks.length, 1);
  assert.equal(repark.parks[0].park.revision, R81.slice(0, 12));
  assert.equal(repark.parks[0].park.count, 54);
  assert.match(
    repark.parks[0].message,
    new RegExp(` rev=${R81.slice(0, 12)}: `),
  );
  const again = applyRepeatFailureParks(
    failed,
    repark.parks,
    NOW + HOUR + 60_000,
  );
  assert.deepEqual(
    parseRepeatFailurePark(workOf(again).blocker),
    repark.parks[0].park,
  );
  // The same revision, on every later pass: parked, no grant, no write.
  for (const at of [NOW + 2 * HOUR, NOW + 48 * HOUR]) {
    const same = pass(again, R81, at);
    assert.equal(same.plans.length, 0);
    assert.equal(same.parks.length, 0);
    assert.match(same.denials.get(AI_300) ?? "", /^repeat_failure_parked:/);
  }
  // A newer installed revision re-arms it once more.
  const newer = pass(again, R82, NOW + 49 * HOUR);
  assert.equal(
    rearmPlan(newer).detail,
    "other:repeat_failure_rearmed:runtime_changed",
  );
  // ... and three more identical outcomes under it leave it parked under R82.
  let state = applyHostedRetries(
    again,
    NEW_BASE,
    [rearmPlan(newer)],
    NOW + 49 * HOUR,
  );
  let last: PassV1 | null = null;
  for (const offset of [1, 2, 3]) {
    const at = NOW + (49 + offset) * HOUR;
    if (workOf(state).nextStep !== "blocked") {
      state = await settleFailure(state, R82, at);
    }
    last = pass(state, R82, at + 60_000);
    state = applyRepeatFailureParks(state, last.parks, at + 60_000);
    assert.equal(last.plans.length, 0, `offset ${offset}`);
  }
  const final = parseRepeatFailurePark(workOf(state).blocker);
  assert.equal(final?.revision, R82.slice(0, 12));
  assert.equal(final?.count, 55);
  assert.equal(last!.parks.length, 0, "parked once, then only named");
});
