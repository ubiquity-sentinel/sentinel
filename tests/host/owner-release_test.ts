/**
 * The owner's one-time release of 2026-11-15 (`ops/hosted-autonomy-owner-
 * releases.ts`) over the verbatim live rows of sentinel-state/repair at
 * 554559876818: sentinel 177's repeat-failure park (released) and
 * ubiquity-dollar 997's park of the same signature, route, prompt and second
 * (not released), through the launcher planner and the real protected
 * maintenance pass (`runHostedAutonomy`, expected-head CAS and readback).
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { attemptMemorySettlementMutationV1 } from "../../src/repair/attempt-policy.ts";
import { implementerPromptTemplateDigest } from "../../src/repair/model-port-prompt-digest.ts";
import {
  applyHostedRetries,
  hostedRepositoryKey,
  planHostedRetries,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import {
  OWNER_RELEASES_2026_11_15,
  type OwnerReleaseV1,
} from "../../ops/hosted-autonomy-owner-releases.ts";
import {
  parseRepeatFailurePark,
  REPEAT_FAILURE_PARK_PREFIX,
} from "../../ops/hosted-autonomy-repeat-failure.ts";
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import { makeRig, releaseSnapshot } from "./hosted-autonomy-rig.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/owner-release-live-v1.json", import.meta.url),
  ),
) as {
  work: WorkRecordV1[];
  attemptMemory: unknown[];
  reservations: unknown[];
};

const S177 = "issue-ubiquity-sentinel-177";
const D997 = "issue-ubiquity-ubiquity-dollar-997";
/** The live route identity both parks recorded. */
const ROUTE = "e4b22974d0b1";
/** The live prompt identity both parks recorded, as a full digest. */
const PROMPT = "29921b7659c5".padEnd(64, "0");
/** Live task digests whose prefixes the parks recorded (unchanged issues). */
const DIGESTS = new Map<string, string>([
  [S177, "c37a034f80c5".padEnd(64, "0")],
  [D997, "4e16d2463c50".padEnd(64, "0")],
]);
const ISSUE_DIGESTS = new Map<number, string>([
  [177, DIGESTS.get(S177)!],
  [997, DIGESTS.get(D997)!],
]);
const RUNTIME = "7".repeat(40) as GitSha;
const TIP = "f".repeat(40) as GitSha;
const UNAVAILABLE = "model run failed (unavailable)";
/** A maintenance pass after the owner's decision. */
const NOW = Date.UTC(2026, 10, 16, 12);
const HOUR = 60 * 60_000;
const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname);

function liveSnapshot(extra: WorkRecordV1[] = []): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: NOW - HOUR,
    incidents: [],
    evidence: [],
    work: [...LIVE.work, ...extra],
    reservations: LIVE.reservations,
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: LIVE.attemptMemory,
    lessons: [],
  });
}

/** Rows in a stable order: the store keeps its own row order. */
function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
}

function workOf(snapshot: RepairStateSnapshotV1, id: string): WorkRecordV1 {
  const record = snapshot.work.find((item) => item.id === id);
  assert.ok(record !== undefined, id);
  return record;
}

/** One launcher planning pass with the live bound facts. */
function plan(
  snapshot: RepairStateSnapshotV1,
  ownerReleases?: readonly OwnerReleaseV1[],
) {
  const denials = new Map<string, string>();
  const plans = planHostedRetries(
    snapshot,
    NOW,
    RUNTIME,
    new Map(
      snapshot.work.map((
        record,
      ) => [hostedRepositoryKey(record.repository), TIP]),
    ),
    new Set(),
    (denial) => denials.set(denial.id, denial.reason),
    {
      repeatFailure: {
        route: ROUTE,
        issueDigests: DIGESTS,
        prompt: PROMPT,
        ...(ownerReleases === undefined ? {} : { ownerReleases }),
      },
    },
  );
  return { plans, denials };
}

/** A copy of 177's exact park on another record (id and issue only). */
function foreignCopy(): WorkRecordV1 {
  const record = workOf(liveSnapshot(), S177);
  return {
    ...record,
    id: "issue-ubiquity-sentinel-9177" as WorkRecordV1["id"],
    source: { ...record.source, id: "9177" },
    related: { ...record.related, issueNumber: 9177 },
    target: {
      ...record.target,
      branch: "sentinel/repair/issue-ubiquity-sentinel-9177",
    },
    intent: null,
  };
}

Deno.test("owner release: 177's exact park re-arms once through the ordinary work grant, nothing else", () => {
  const snapshot = liveSnapshot();
  const before = workOf(snapshot, S177);
  // The bound without the owner's release (the code before it): parked.
  const base = plan(snapshot, []);
  assert.equal(base.plans.length, 0);
  assert.equal(
    base.denials.get(S177),
    "repeat_failure_parked:other|ba872ff9154d4db3:x4",
  );
  const { plans, denials } = plan(snapshot);
  assert.deepEqual(plans, [{
    id: S177,
    repository: before.repository,
    grant: 0,
    nextStep: "work",
    reviewRounds: null,
    advanceBase: true,
    observedBase: TIP,
    detail: "other:repeat_failure_rearmed:owner_release:base-advance",
  }]);
  assert.equal(denials.get(S177), undefined);
  // The same signature, route, prompt and second on another record stays.
  assert.equal(
    denials.get(D997),
    "repeat_failure_parked:other|ba872ff9154d4db3:x5",
  );
  const after = applyHostedRetries(snapshot, TIP, plans, NOW);
  const released = workOf(after, S177);
  // Only the step, blocker, wait, intent and stamp move: target, counters,
  // evidence and every other field stay; no charge or memory row changes.
  assert.deepEqual(released, {
    ...before,
    nextStep: "work",
    blocker: null,
    wait: null,
    intent: null,
    updatedAt: NOW,
  });
  assert.deepEqual(after.reservations, snapshot.reservations);
  assert.deepEqual(after.attemptMemory, snapshot.attemptMemory);
  assert.deepEqual(workOf(after, D997), workOf(snapshot, D997));
  // Released, it is no longer blocked: no later plan names it.
  assert.equal(plan(after).plans.length, 0);
});

Deno.test("owner release: only the exact record and park the owner named", () => {
  const record = workOf(liveSnapshot(), S177);
  const blocker = record.blocker!;
  const cases: { name: string; row: WorkRecordV1 }[] = [
    { name: "another record, same park", row: foreignCopy() },
    {
      name: "a later park of 177",
      row: { ...record, blocker: { ...blocker, since: blocker.since + 1 } },
    },
    {
      name: "another count",
      row: {
        ...record,
        blocker: { ...blocker, message: blocker.message.replace("4x", "5x") },
      },
    },
    {
      name: "another repository identity",
      row: {
        ...record,
        repository: { ...record.repository, installationId: 1 },
      },
    },
  ];
  for (const { name, row } of cases) {
    const snapshot = liveSnapshot().work.some((item) => item.id === row.id)
      ? parseRepairStateSnapshotV1({
        ...liveSnapshot(),
        work: liveSnapshot().work.map((item) =>
          item.id === row.id ? row : item
        ),
      })
      : liveSnapshot([row]);
    const { plans, denials } = plan(snapshot);
    assert.equal(plans.some((entry) => entry.id === row.id), false, name);
    assert.match(denials.get(row.id) ?? "", /^repeat_failure_parked:/, name);
  }
  // The recorded decision names exactly one park.
  assert.deepEqual(OWNER_RELEASES_2026_11_15.map((entry) => entry.id), [S177]);
});

/** The protected maintenance pass over the rig (real CAS + readback). */
async function maintenance(
  rig: Awaited<ReturnType<typeof makeRig>>["rig"],
  at: number,
) {
  return await runHostedAutonomy(
    await withDarkQueueAuthority({
      ciMinutes: INACTIVE_CI_MINUTES,
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => at },
      modelRoute: ROUTE,
    }),
  );
}

async function readState(rig: Awaited<ReturnType<typeof makeRig>>["rig"]) {
  const read = await rig.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  return read.value;
}

/**
 * The runtime's settlement of one more identical failed start of 177 at the
 * tip (its sixth charge, settled ambiguous, and the same memory writer the
 * matrix ingester uses), in one CAS write.
 */
async function failAgain(
  rig: Awaited<ReturnType<typeof makeRig>>["rig"],
  at: number,
) {
  const read = await readState(rig);
  const record = workOf(read.snapshot, S177);
  const requestId = "6".repeat(64);
  const failed: WorkRecordV1 = {
    ...record,
    nextStep: "blocked",
    target: { ...record.target, base: TIP },
    counters: { ...record.counters, attempts: 6 },
    intent: {
      kind: "implementation",
      key: `impl:${requestId}`,
      startedAt: at - HOUR,
      branch: record.target.branch,
      expectedHead: null,
      observedBase: TIP,
      pr: null,
      requestId,
      resultId: null,
    },
    blocker: { kind: "other", message: UNAVAILABLE, since: at },
    updatedAt: at,
  };
  const draft = structuredClone(read.snapshot) as RepairStateSnapshotV1;
  draft.work = draft.work.map((item) => item.id === S177 ? failed : item);
  draft.reservations.push(
    {
      version: "v1",
      kind: "budget_reservation",
      repository: record.repository,
      id: requestId,
      taskId: S177,
      attempt: 6,
      head: TIP,
      purpose: "retry",
      createdAt: at - HOUR,
      outcome: "ambiguous",
      settledAt: at,
      proofRef: null,
    } as RepairStateSnapshotV1["reservations"][number],
  );
  (await attemptMemorySettlementMutationV1({
    record: failed,
    detail: UNAVAILABLE,
    now: at,
    runtimeSha: RUNTIME,
  }))(draft);
  draft.attemptMemory.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  );
  const written = await rig.state.writeRepair(
    parseRepairStateSnapshotV1({
      ...draft,
      stateHead: read.head,
      sequence: read.snapshot.sequence + 1,
      updatedAt: at,
    }),
    read.head,
  );
  assert.ok(written.ok && written.value.status === "applied");
}

Deno.test("owner release: the maintenance pass releases 177 once; an identical failure re-parks it for good", async () => {
  const { rig } = await makeRig("owner-release", {
    repair: liveSnapshot(),
    release: releaseSnapshot([], RUNTIME),
    fixtureDir: ROOT,
    baseTip: TIP,
    issueTask: (number) =>
      Promise.resolve({
        issueNumber: number,
        title: `live issue ${number}`,
        body: "unchanged statement",
        digest: ISSUE_DIGESTS.get(number) ?? "5".repeat(64),
      }),
  });
  try {
    const first = await maintenance(rig, NOW);
    assert.equal(first.status, "applied", JSON.stringify(first));
    assert.equal(first.reason, "retried");
    assert.ok(
      first.actions.includes(
        `retry:${S177}:grant=0:other:repeat_failure_rearmed:owner_release:base-advance`,
      ),
      JSON.stringify(first.actions),
    );
    const promptUnchanged = implementerPromptTemplateDigest().startsWith(
      PROMPT.slice(0, 12),
    );
    // 997 shares the park's route, prompt and second but was not named; it
    // is only re-armed by its own prompt rule once the prompt changes.
    assert.equal(
      first.actions.some((action) =>
        action.startsWith(`retry:${D997}:grant=`) &&
        !action.includes("rearmed:prompt_changed")
      ),
      false,
      JSON.stringify(first.actions),
    );
    if (promptUnchanged) {
      assert.ok(
        first.actions.includes(
          `retry:${D997}:denied:repeat_failure_parked:other|ba872ff9154d4db3:x5`,
        ),
        JSON.stringify(first.actions),
      );
    }
    const released = await readState(rig);
    const record = workOf(released.snapshot, S177);
    assert.equal(record.nextStep, "work");
    assert.equal(record.blocker, null);
    assert.equal(record.intent, null);
    assert.deepEqual(record.counters, workOf(liveSnapshot(), S177).counters);
    // Every charge and memory row is byte for byte the live one.
    assert.deepEqual(
      byId(released.snapshot.reservations),
      byId(liveSnapshot().reservations),
    );
    assert.deepEqual(
      byId(released.snapshot.attemptMemory),
      byId(liveSnapshot().attemptMemory),
    );
    // Revert safety: the planner without the release (the code before it)
    // leaves the released record, now at `work`, exactly as it is.
    const reverted = plan(released.snapshot, []);
    assert.equal(reverted.plans.length, 0);
    assert.equal(reverted.denials.get(S177), undefined);
    // The runtime's next start fails the same way: the bound parks it at
    // once, with its own later second, and no later pass releases it again.
    await failAgain(rig, NOW + HOUR);
    const second = await maintenance(rig, NOW + 2 * HOUR);
    assert.ok(
      second.actions.includes(
        `retry:${S177}:parked:repeat_failure:other|ba872ff9154d4db3:x5`,
      ),
      JSON.stringify(second.actions),
    );
    const reparked = workOf((await readState(rig)).snapshot, S177);
    assert.ok(reparked.blocker!.message.startsWith(REPEAT_FAILURE_PARK_PREFIX));
    assert.equal(parseRepeatFailurePark(reparked.blocker)?.count, 5);
    assert.equal(reparked.blocker!.since, NOW + 2 * HOUR);
    const writes = rig.writes;
    const third = await maintenance(rig, NOW + 3 * HOUR);
    assert.ok(
      third.actions.includes(
        `retry:${S177}:denied:repeat_failure_parked:other|ba872ff9154d4db3:x5`,
      ),
      JSON.stringify(third.actions),
    );
    assert.equal(
      third.actions.some((action) => action.includes("owner_release")),
      false,
    );
    assert.equal(rig.writes, writes, "a re-parked record is never rewritten");
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
