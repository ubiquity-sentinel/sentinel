/**
 * JAM B10 (non-progress cycle): implementation retries that fail the same way
 * every time. Replays the verbatim live rows of origin/sentinel-state/repair at
 * b59c04a49: ai.ubq.fi 300 (52 identical "model run failed (unavailable)"
 * outcomes over 23 bases since 2026-10-10, every one a charged reservation)
 * and sentinel 152/155/156 (output-bound overruns).
 */
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  ATTEMPT_DETAIL_NO_CHANGE,
  attemptMemorySettlementMutationV1,
} from "../../src/repair/attempt-policy.ts";
import {
  applyHostedRetries,
  HOSTED_AUTONOMY_MAX_RETRIES,
  HOSTED_AUTONOMY_RETRYABLE,
  hostedRepositoryKey,
  planHostedRetries,
  type RetryPlanV1,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import {
  applyRepeatFailureParks,
  failureSignature,
  normalizeFailureMessage,
  parseRepeatFailurePark,
  REPEAT_FAILURE_DEFAULT_ROUTE,
  REPEAT_FAILURE_PARK_PREFIX,
  type RepeatFailureParkPlanV1,
  repeatFailureRouteIdentity,
  repeatFailureStreak,
} from "../../ops/hosted-autonomy-repeat-failure.ts";
import { parseWithR80, r80Available } from "./r80-contracts.ts";
import { makeRig, releaseSnapshot } from "./hosted-autonomy-rig.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/repeat-failure-live-v1.json", import.meta.url),
  ),
) as {
  work: WorkRecordV1[];
  attemptMemory: unknown[];
  reservations: unknown[];
};

/** The installed generation-80 runtime every live outcome ran under. */
const R80 = "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481" as GitSha;
const AI_300 = "issue-ubiquity-ai.ubq.fi-300";
const S152 = "issue-ubiquity-sentinel-152";
const S155 = "issue-ubiquity-sentinel-155";
const S156 = "issue-ubiquity-sentinel-156";
const UNAVAILABLE = "model run failed (unavailable)";
const OUTPUT_BOUND =
  "model run did not complete with a trusted candidate: interrupted output bound exceeded";
/** The maintenance pass after the live capture. */
const NOW = Date.parse("2026-10-17T23:05:00Z");
const HOUR = 60 * 60 * 1000;
/** The production route selector of the live workflow variables. */
const ROUTE = repeatFailureRouteIdentity({
  baseUrl: "",
  model: "gpt-reserve",
  fallback: "gateway",
});
/** Issue 300's live canonical task digest (any 64-hex value binds). */
const DIGEST_300 = "3".repeat(64);
const ignoreR80 = !await r80Available();
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);

function liveSnapshot(): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: NOW - 60_000,
    incidents: [],
    evidence: [],
    work: LIVE.work,
    reservations: LIVE.reservations,
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: LIVE.attemptMemory,
    lessons: [],
  });
}

/** Every record's own base is its repository's tip: no base advance. */
function ownTips(snapshot: RepairStateSnapshotV1): Map<string, string | null> {
  return new Map(
    snapshot.work.map((record) => [
      hostedRepositoryKey(record.repository),
      record.target.base,
    ]),
  );
}

function workOf(snapshot: RepairStateSnapshotV1, id: string): WorkRecordV1 {
  const record = snapshot.work.find((item) => item.id === id);
  assert.ok(record !== undefined, id);
  return record;
}

interface PassV1 {
  plans: RetryPlanV1[];
  parks: RepeatFailureParkPlanV1[];
  denials: Map<string, string>;
}

/** One launcher planning pass with the bound's live facts. */
function pass(
  snapshot: RepairStateSnapshotV1,
  input: {
    now?: number;
    route?: string;
    digests?: Map<string, string | null>;
    tips?: Map<string, string | null>;
  } = {},
): PassV1 {
  const parks: RepeatFailureParkPlanV1[] = [];
  const denials = new Map<string, string>();
  const digests = input.digests ?? new Map([[AI_300, DIGEST_300]]);
  for (const id of [S152, S155, S156]) {
    if (!digests.has(id)) digests.set(id, `${id.length}`.padStart(64, "5"));
  }
  const plans = planHostedRetries(
    snapshot,
    input.now ?? NOW,
    R80,
    input.tips ?? ownTips(snapshot),
    new Set(),
    (denial) => denials.set(denial.id, denial.reason),
    {
      repeatFailure: { route: input.route ?? ROUTE, issueDigests: digests },
      onRepeatFailurePark: (park) => parks.push(park),
    },
  );
  return { plans, parks, denials };
}

/**
 * The runtime's own settlement of one more failed implementation at `base`:
 * the record blocked with `detail` and the SAME attempt-memory writer the
 * matrix ingester uses, in one snapshot.
 */
async function settleFailure(
  snapshot: RepairStateSnapshotV1,
  id: string,
  base: GitSha,
  detail: string,
  at: number,
): Promise<RepairStateSnapshotV1> {
  const record = workOf(snapshot, id);
  const moved: WorkRecordV1 = {
    ...record,
    nextStep: "blocked",
    target: { ...record.target, base },
    blocker: { kind: "other", message: detail, since: at },
    updatedAt: at,
  };
  const memory = await attemptMemorySettlementMutationV1({
    record: moved,
    detail,
    now: at,
    runtimeSha: R80,
  });
  const draft = structuredClone(snapshot) as RepairStateSnapshotV1;
  draft.work = draft.work.map((item) => item.id === id ? moved : item);
  draft.updatedAt = at;
  memory(draft);
  draft.attemptMemory.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  return parseRepairStateSnapshotV1(draft);
}

/** The pass's park, applied as the retry pass writes it. */
function parked(snapshot: RepairStateSnapshotV1, at = NOW) {
  const first = pass(snapshot, { now: at });
  assert.equal(first.parks.length, 1, JSON.stringify([...first.denials]));
  return {
    first,
    after: applyRepeatFailureParks(snapshot, first.parks, at),
  };
}

const NEW_BASE = "abcdefabcdefabcdefabcdefabcdefabcdefabcd" as GitSha;

Deno.test(
  "repeat failure: live ai.ubq.fi 300 is no longer re-granted after 52 identical failures",
  () => {
    const snapshot = liveSnapshot();
    const denials: { id: string; reason: string }[] = [];
    const plans = planHostedRetries(
      snapshot,
      NOW,
      R80,
      ownTips(snapshot),
      new Set(),
      (denial) => denials.push({ id: denial.id, reason: denial.reason }),
    );
    assert.deepEqual(
      plans.map((plan) => plan.id).sort(),
      [S152, S155, S156].sort(),
      "only 300 is withheld; the sentinel rows are not yet past the bound",
    );
    const denied = denials.filter((denial) => denial.id === AI_300);
    assert.equal(denied.length, 1, JSON.stringify(denials));
    // Without the launcher's live issue digest the bound withholds the grant
    // but writes nothing: no park can be re-armed by an edit it never saw.
    assert.equal(denied[0].reason, "repeat_failure_unverified_issue");
  },
);

Deno.test(
  "repeat failure: live 300 parks once in an explicit owner-gated blocker that charges nothing and R80 parses",
  async () => {
    const snapshot = liveSnapshot();
    const streak = repeatFailureStreak(snapshot, workOf(snapshot, AI_300));
    assert.ok(streak !== null);
    // Every identical outcome attempt memory recorded since 2026-10-10.
    assert.equal(streak.count, 53);
    assert.equal(streak.failureClass, "transient_infrastructure");
    assert.ok(streak.lastAtMs - streak.firstAtMs > 6 * HOUR);
    const { first, after } = parked(snapshot);
    assert.deepEqual(
      first.plans.map((plan) => plan.id).sort(),
      [S152, S155, S156].sort(),
    );
    const park = first.parks[0];
    assert.equal(park.id, AI_300);
    const signature = failureSignature("other", UNAVAILABLE);
    assert.equal(park.park.signature, signature);
    assert.equal(park.park.count, 53);
    assert.equal(park.park.issue, DIGEST_300.slice(0, 12));
    assert.equal(park.park.route, ROUTE);
    assert.equal(
      first.denials.get(AI_300),
      `repeat_failure_parked:${signature}:x53`,
    );
    const record = workOf(after, AI_300);
    const before = workOf(snapshot, AI_300);
    assert.equal(record.nextStep, "blocked");
    assert.ok(record.blocker!.message.startsWith(REPEAT_FAILURE_PARK_PREFIX));
    assert.ok(record.blocker!.message.endsWith(`: ${UNAVAILABLE}`));
    assert.equal(record.blocker!.kind, "other");
    assert.equal(record.blocker!.since, NOW);
    // Only the blocker (and its time) changed: intent, counters, target and
    // every charge, review and memory record are exactly as before.
    assert.equal(
      canonicalStringify({ ...record, blocker: null, updatedAt: 0 }),
      canonicalStringify({ ...before, blocker: null, updatedAt: 0 }),
    );
    assert.deepEqual(after.reservations, snapshot.reservations);
    assert.deepEqual(after.attemptMemory, snapshot.attemptMemory);
    for (const id of [S152, S155, S156]) {
      assert.deepEqual(workOf(after, id), workOf(snapshot, id));
    }
    // No launcher retry rule (this one's or an earlier one's) matches it.
    assert.equal(
      HOSTED_AUTONOMY_RETRYABLE.some((rule) =>
        record.blocker!.message.startsWith(rule.prefix)
      ),
      false,
    );
    assert.deepEqual(parseRepeatFailurePark(record.blocker), park.park);
    if (!ignoreR80) {
      assert.deepEqual(
        await parseWithR80(after),
        JSON.parse(JSON.stringify(after)),
      );
    }
  },
);

Deno.test({
  name:
    "repeat failure: the park write parses with the installed R80 runtime's own parser",
  ignore: ignoreR80,
  fn: async () => {
    const { after } = parked(liveSnapshot());
    const reparsed = await parseWithR80(after) as RepairStateSnapshotV1;
    assert.equal(
      workOf(reparsed, AI_300).blocker!.message,
      workOf(after, AI_300).blocker!.message,
    );
  },
});

Deno.test(
  "repeat failure: a parked record is named every pass and never rewritten or re-granted",
  () => {
    const { after } = parked(liveSnapshot());
    for (
      const at of [NOW + 5 * 60_000, NOW + 48 * HOUR, NOW + 30 * 24 * HOUR]
    ) {
      const next = pass(after, { now: at });
      assert.equal(next.parks.length, 0, "no second write");
      assert.equal(
        next.plans.some((plan) => plan.id === AI_300),
        false,
        "age alone never re-arms",
      );
      assert.match(next.denials.get(AI_300) ?? "", /^repeat_failure_parked:/);
    }
    // A moved base alone never re-arms either.
    const tips = ownTips(after);
    tips.set(hostedRepositoryKey(workOf(after, AI_300).repository), NEW_BASE);
    assert.equal(
      pass(after, { tips }).plans.some((plan) => plan.id === AI_300),
      false,
    );
    // Without the launcher facts nothing re-arms.
    const bare = planHostedRetries(after, NOW, R80, ownTips(after));
    assert.equal(bare.some((plan) => plan.id === AI_300), false);
  },
);

Deno.test(
  "repeat failure: an edited issue re-arms once; an identical failure after it re-parks at once",
  async () => {
    const { after } = parked(liveSnapshot());
    const edited = "e".repeat(64);
    const rearm = pass(after, { digests: new Map([[AI_300, edited]]) });
    const plan = rearm.plans.find((item) => item.id === AI_300);
    assert.ok(plan !== undefined, JSON.stringify([...rearm.denials]));
    assert.equal(plan.nextStep, "work");
    assert.equal(plan.grant, 0);
    assert.equal(plan.detail, "other:repeat_failure_rearmed:issue_edited");
    const granted = applyHostedRetries(after, NEW_BASE, [plan], NOW);
    const record = workOf(granted, AI_300);
    assert.equal(record.nextStep, "work");
    assert.equal(record.blocker, null);
    // Charged history is never lowered: the next start is attempt 53.
    assert.equal(record.counters.attempts, 52);
    assert.deepEqual(granted.reservations, after.reservations);
    // The probe fails the same way on a new base: the edit did not change the
    // outcome, so the record re-parks immediately with the edited baseline.
    const failed = await settleFailure(
      granted,
      AI_300,
      NEW_BASE,
      UNAVAILABLE,
      NOW + HOUR,
    );
    const again = pass(failed, {
      now: NOW + HOUR + 60_000,
      digests: new Map([[AI_300, edited]]),
    });
    assert.equal(again.plans.some((item) => item.id === AI_300), false);
    assert.equal(again.parks.length, 1);
    assert.equal(again.parks[0].park.count, 54);
    assert.equal(again.parks[0].park.issue, edited.slice(0, 12));
  },
);

Deno.test("repeat failure: a changed model route re-arms a park once", () => {
  const { after } = parked(liveSnapshot());
  const route = repeatFailureRouteIdentity({
    baseUrl: "",
    model: "owner-changed-model",
    fallback: "gateway",
  });
  assert.notEqual(route, ROUTE);
  const rearm = pass(after, { route });
  const plan = rearm.plans.find((item) => item.id === AI_300);
  assert.ok(plan !== undefined);
  assert.equal(plan.detail, "other:repeat_failure_rearmed:route_changed");
  // A moved tip still advances through the ordinary base path.
  const tips = ownTips(after);
  tips.set(hostedRepositoryKey(workOf(after, AI_300).repository), NEW_BASE);
  const advancing = pass(after, { route, tips }).plans.find((item) =>
    item.id === AI_300
  );
  assert.equal(advancing?.advanceBase, true);
  assert.equal(
    advancing?.detail,
    "other:repeat_failure_rearmed:route_changed:base-advance",
  );
});

Deno.test(
  "repeat failure: unchanged-base outcomes keep their admission for native base review",
  async () => {
    const snapshot = liveSnapshot();
    const changed = await settleFailure(
      snapshot,
      AI_300,
      NEW_BASE,
      ATTEMPT_DETAIL_NO_CHANGE,
      NOW,
    );
    const streak = repeatFailureStreak(changed, workOf(changed, AI_300));
    assert.equal(streak?.count, 1);
    const next = pass(changed, { now: NOW + 60_000 });
    assert.equal(next.parks.length, 0);
    assert.equal(next.plans.some((plan) => plan.id === AI_300), false);
    assert.deepEqual(
      workOf(changed, AI_300).intent,
      workOf(snapshot, AI_300).intent,
      "the original charged implementation remains available to native review",
    );
    // Three historical no-change outcomes also take the base-review route;
    // the launcher must not replace them with an owner-gated repeat park.
    let state = changed;
    for (const offset of [1, 2]) {
      state = await settleFailure(
        state,
        AI_300,
        `${offset}`.repeat(40) as GitSha,
        ATTEMPT_DETAIL_NO_CHANGE,
        NOW + offset * 10 * 60_000,
      );
    }
    const due = pass(state, { now: NOW + HOUR });
    assert.equal(repeatFailureStreak(state, workOf(state, AI_300))?.count, 3);
    assert.equal(due.parks.length, 0);
    assert.equal(due.plans.some((plan) => plan.id === AI_300), false);
    assert.equal(due.denials.has(AI_300), false);
    assert.deepEqual(
      workOf(state, AI_300).intent,
      workOf(snapshot, AI_300).intent,
    );
    assert.deepEqual(state.reservations, snapshot.reservations);
  },
);

Deno.test(
  "repeat failure: live sentinel 152/156 park once their output-bound streak spans six hours; 155 alternates and never parks",
  async () => {
    const snapshot = liveSnapshot();
    for (const id of [S152, S156]) {
      const streak = repeatFailureStreak(snapshot, workOf(snapshot, id));
      assert.equal(streak?.count, 5, id);
      assert.ok(streak!.lastAtMs - streak!.firstAtMs < 6 * HOUR, id);
    }
    assert.equal(
      repeatFailureStreak(snapshot, workOf(snapshot, S155))?.count,
      1,
      "155's newest output-bound follows an unavailable outcome",
    );
    // The next identical outcome, past six hours from each one's first,
    // parks both.
    let state = snapshot;
    let latest = 0;
    for (const id of [S152, S156]) {
      const first = repeatFailureStreak(snapshot, workOf(snapshot, id))!
        .firstAtMs;
      latest = Math.max(latest, first + 6 * HOUR + 60_000);
      state = await settleFailure(
        state,
        id,
        NEW_BASE,
        OUTPUT_BOUND,
        first + 6 * HOUR + 60_000,
      );
    }
    const next = pass(state, { now: latest + 60_000 });
    const sentinel = next.parks.filter((park) => park.id !== AI_300);
    assert.deepEqual(sentinel.map((park) => park.id).sort(), [S152, S156]);
    assert.ok(next.plans.some((plan) => plan.id === S155));
    for (const park of sentinel) {
      assert.equal(park.park.count, 6);
      assert.equal(
        park.park.signature,
        failureSignature("other", OUTPUT_BOUND),
      );
    }
  },
);

Deno.test(
  "repeat failure: a short transient outage never parks; an unreadable issue withholds without parking",
  async () => {
    const snapshot = liveSnapshot();
    // 155's three newest outcomes are made identical within one hour.
    let state = snapshot;
    for (const offset of [1, 2, 3]) {
      state = await settleFailure(
        state,
        S155,
        `${offset}`.repeat(40) as GitSha,
        UNAVAILABLE,
        NOW + offset * 15 * 60_000,
      );
    }
    assert.equal(
      repeatFailureStreak(state, workOf(state, S155))?.count,
      3,
    );
    const next = pass(state, { now: NOW + HOUR });
    assert.equal(next.parks.some((park) => park.id === S155), false);
    assert.ok(next.plans.some((plan) => plan.id === S155));
    // Unreadable source digest: no grant, no write, named.
    const unread = pass(liveSnapshot(), {
      digests: new Map([[AI_300, null]]),
    });
    assert.equal(unread.parks.length, 0);
    assert.equal(unread.plans.some((plan) => plan.id === AI_300), false);
    assert.equal(
      unread.denials.get(AI_300),
      "repeat_failure_unverified_issue",
    );
  },
);

Deno.test("repeat failure: a recorded success or a straddling entry never overstates the streak", () => {
  const snapshot = liveSnapshot();
  const record = workOf(snapshot, AI_300);
  const families = snapshot.attemptMemory.filter((memory) =>
    memory.taskId === AI_300
  );
  const newest = Math.max(
    ...families.flatMap((memory) => memory.entries.map((e) => e.lastAtMs)),
  );
  // A success recorded after every failure: nothing to park.
  const succeeded = parseRepairStateSnapshotV1({
    ...snapshot,
    attemptMemory: snapshot.attemptMemory.map((memory) =>
      memory.id === families[0].id
        ? {
          ...memory,
          successes: 1,
          lastSuccessAtMs: newest + 1,
          lastSuccessRevision: R80,
        }
        : memory
    ),
  });
  assert.equal(repeatFailureStreak(succeeded, record), null);
  // A different outcome inside a multi-occurrence entry's window: only that
  // entry's last occurrence is proven later than it.
  const entries = families.flatMap((memory) =>
    memory.entries.map((entry) => ({ memory, entry }))
  ).sort((left, right) => right.entry.lastAtMs - left.entry.lastAtMs);
  const { memory: straddle, entry } = entries.find((item) =>
    item.entry.count > 1
  )!;
  const inserted = entry.firstAtMs + 1;
  const later = entries.filter((item) => item.entry.firstAtMs > inserted)
    .reduce((sum, item) => sum + item.entry.count, 0);
  const inside = parseRepairStateSnapshotV1({
    ...snapshot,
    attemptMemory: snapshot.attemptMemory.map((memory) =>
      memory.id === straddle.id
        ? {
          ...memory,
          entries: [
            ...memory.entries.filter((item) => item.lastAtMs < inserted),
            {
              ...entry,
              fingerprint: "f".repeat(64),
              detail: OUTPUT_BOUND,
              count: 1,
              firstAtMs: inserted,
              lastAtMs: inserted,
            },
            ...memory.entries.filter((item) => item.lastAtMs >= inserted),
          ],
        }
        : memory
    ),
  });
  assert.ok(entry.count > 1);
  assert.equal(repeatFailureStreak(inside, record)?.count, later + 1);
});

Deno.test("repeat failure: the signature folds identities but keeps the failure class", () => {
  assert.equal(
    normalizeFailureMessage("Base refresh has conflicts at 3f041b46d95269b2"),
    normalizeFailureMessage("base refresh has  conflicts at 01f482529d"),
  );
  assert.notEqual(
    failureSignature("other", "model run failed (unavailable)"),
    failureSignature("other", "model run failed (bundle)"),
  );
  assert.notEqual(
    failureSignature("other", UNAVAILABLE),
    failureSignature("unavailable", UNAVAILABLE),
  );
  assert.match(failureSignature("other", UNAVAILABLE), /^other\|[0-9a-f]{16}$/);
  assert.match(REPEAT_FAILURE_DEFAULT_ROUTE, /^[0-9a-f]{12}$/);
  assert.equal(
    repeatFailureRouteIdentity({ baseUrl: null, model: null, fallback: null }),
    repeatFailureRouteIdentity({ baseUrl: "", model: " ", fallback: "" }),
  );
});

Deno.test("repeat failure: historical reservations do not impose a lifetime retry cap", () => {
  const snapshot = liveSnapshot();
  const charge = (snapshot.reservations as unknown as { id: string }[])[0];
  const template = snapshot.reservations.find((row) => row.taskId === S155)!;
  const capped = parseRepairStateSnapshotV1({
    ...snapshot,
    reservations: [
      ...snapshot.reservations,
      ...Array.from(
        { length: HOSTED_AUTONOMY_MAX_RETRIES },
        (_, index) => ({
          ...template,
          id: (index + 1).toString(16).padStart(64, "0"),
          attempt: 100 + index,
          outcome: "ambiguous",
          settledAt: template.createdAt + 1,
        }),
      ),
    ].sort((left, right) => left.id < right.id ? -1 : 1),
  });
  assert.ok(charge !== undefined);
  const next = pass(capped);
  assert.equal(next.plans.some((plan) => plan.id === S155), true);
  assert.equal(next.denials.get(S155), undefined);
  assert.equal(capped.reservations.length, snapshot.reservations.length + 200);
});

/** The protected maintenance pass over the live rows (real CAS + readback). */
async function maintenance(
  rig: Awaited<ReturnType<typeof makeRig>>["rig"],
  at: number,
  modelRoute = ROUTE,
) {
  return await runHostedAutonomy(
    await withDarkQueueAuthority({
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => at },
      modelRoute,
    }),
  );
}

Deno.test(
  "repeat failure: the protected maintenance pass parks live 300 in its own write, then only names it",
  async () => {
    const { rig } = await makeRig("repeat-failure", {
      repair: liveSnapshot(),
      release: releaseSnapshot([], R80),
      fixtureDir: ROOT,
      issueTask: (number) =>
        Promise.resolve({
          issueNumber: number,
          title: `live issue ${number}`,
          body: "unchanged statement",
          digest: number === 300 ? DIGEST_300 : "5".repeat(64),
        }),
    });
    try {
      const first = await maintenance(rig, NOW);
      assert.equal(first.status, "applied", JSON.stringify(first));
      const label = `${failureSignature("other", UNAVAILABLE)}:x53`;
      assert.ok(
        first.actions.includes(
          `retry:${AI_300}:parked:repeat_failure:${label}`,
        ),
        JSON.stringify(first.actions),
      );
      assert.ok(
        first.actions.includes(
          `retry:${AI_300}:denied:repeat_failure_parked:${label}`,
        ),
      );
      const read = await rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const after = read.value.snapshot;
      const record = workOf(after, AI_300);
      assert.equal(record.nextStep, "blocked");
      assert.ok(record.blocker!.message.startsWith(REPEAT_FAILURE_PARK_PREFIX));
      assert.equal(after.reservations.length, LIVE.reservations.length);
      // The sentinel rows were re-granted in the same write.
      for (const id of [S152, S155, S156]) {
        assert.equal(workOf(after, id).nextStep, "work", id);
      }
      if (!ignoreR80) await parseWithR80(after);
      const writes = rig.writes;
      const second = await maintenance(rig, NOW + 10 * 60_000);
      assert.ok(
        second.actions.includes(
          `retry:${AI_300}:denied:repeat_failure_parked:${label}`,
        ),
        JSON.stringify(second.actions),
      );
      assert.equal(rig.writes, writes, "a parked record is never rewritten");
      // The park itself was a retry write; naming it again is not one, so
      // the no-write pass reports its own class, never `retried`.
      assert.equal(first.reason, "retried");
      assert.equal(second.status, "skipped", JSON.stringify(second));
      assert.notEqual(second.reason, "retried", JSON.stringify(second));
      // The owner switches the model route: the next pass re-arms it once.
      const route = repeatFailureRouteIdentity({
        baseUrl: "",
        model: "owner-changed-model",
        fallback: "gateway",
      });
      const third = await maintenance(rig, NOW + 20 * 60_000, route);
      assert.ok(
        third.actions.some((action) =>
          action.startsWith(
            `retry:${AI_300}:grant=0:other:repeat_failure_rearmed:route_changed`,
          )
        ),
        JSON.stringify(third.actions),
      );
      const rearmed = await rig.state.readRepair();
      assert.ok(rearmed.ok && rearmed.value.status === "found");
      assert.equal(workOf(rearmed.value.snapshot, AI_300).nextStep, "work");
    } finally {
      await Deno.remove(rig.tmp, { recursive: true });
    }
  },
);

Deno.test("repeat failure: the maintenance step receives only the non-secret route selector", async () => {
  const workflow = await Deno.readTextFile(
    `${ROOT}.github/workflows/supervisor.yml`,
  );
  const start = workflow.indexOf("\n  maintenance:\n");
  const end = workflow.indexOf("\n  prepare:\n");
  assert.ok(start >= 0 && end > start);
  const maintenance = workflow.slice(start, end);
  for (const name of ["BASE_URL", "ID", "FALLBACK"]) {
    const variable = `SENTINEL_MODEL_${name}`;
    const expression = name === "ID"
      ? "vars.SENTINEL_IMPLEMENTATION_MODEL_ID || 'gpt-6.1-sol'"
      : `vars.${variable}`;
    assert.ok(
      maintenance.includes(`${variable}: \${{ ${expression} }}`),
      variable,
    );
    assert.match(
      maintenance,
      new RegExp(`--allow-env=[^\\s]*\\b${variable}\\b`),
    );
  }
  // No model credential or failover override reaches the launcher job.
  for (const secret of ["SENTINEL_DEEPSEEK_API_KEY", "UOS_AI_TOKEN"]) {
    assert.equal(maintenance.includes(secret), false, secret);
  }
});
