/**
 * JAM B11 through the real hosted maintenance pass, replayed from the REAL
 * record and release custody (sentinel issue 157 / PR 160, live state
 * 2026-10-17T23:3xZ, R80 installed at generation 80).
 *
 * R80 refused the refreshed candidate on a protected-path verdict, blocked the
 * record with "base refresh failed 3 consecutive times: invalid candidate
 * could not be preserved" and detached PR 160 (markTerminalBlocked). The
 * refresh re-arm pass then kept it as `refresh:...:retained:activation` on
 * every pass: a refusal at or after the corrected validator's activation is
 * that validator's own and can never be re-armed, so nothing could ever move
 * it and nothing told the owner. Now that pass parks it ONCE as an explicit
 * owner-gated block that restores the verified PR binding, and names it on
 * every later pass without a read or a write. Nothing is charged, refunded,
 * pushed, merged, reviewed, closed or deleted.
 */
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  type ReleaseStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  type HostedAutonomyGitHubV1,
  type HostedAutonomyPullV1,
  type HostedAutonomyResultV1,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import { planHostedRetries } from "../../ops/hosted-autonomy-retries.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import {
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";
import {
  R80_RUNTIME,
  r80Available,
  withR80,
} from "../repair/refresh-refusal-r80.ts";

const LIVE = JSON.parse(
  await Deno.readTextFile(
    new URL("../fixtures/host/refresh-refusal-157-live.json", import.meta.url),
  ),
) as {
  work: WorkRecordV1[];
  reservations: unknown[];
  release: unknown;
  pullRequest: { number: number; head: string; headRef: string };
  observedBase: string;
};

const ID = "issue-ubiquity-sentinel-157";
const R80_MESSAGE =
  "base refresh failed 3 consecutive times: invalid candidate could not be preserved";
const PARK =
  "base refresh refused by trusted validation; owner action required (land the change by hand or close the issue): ";
const HEAD = LIVE.pullRequest.head;
const BRANCH = LIVE.pullRequest.headRef;
/** The live development tip of the 23:38Z pass (the base moved on). */
const TIP = "3f041b46d95269b29054ca5c27bce6aa179f9683";
/** The live pass instant (2026-10-17T23:40:00Z). */
const NOW = Date.parse("2026-10-17T23:40:00Z");

interface Facts {
  issueOpen?: boolean;
  pulls?: { number: number; state: string; head: string | null }[] | null;
  pull?: Partial<HostedAutonomyPullV1> | null;
}

interface Calls {
  listings: number;
  pullReads: number;
  merges: number;
  closes: number;
}

function surface(facts: Facts, calls: Calls): HostedAutonomyGitHubV1 {
  const pull: HostedAutonomyPullV1 = {
    number: LIVE.pullRequest.number,
    state: "open",
    merged: false,
    mergeCommitSha: null,
    headSha: HEAD,
    baseRef: "development",
    baseSha: LIVE.work[0]!.target.base,
    author: "ubiquity-sentinel[bot]",
    parents: [],
    revisionOnBaseBranch: false,
    baseAncestorOfRevision: false,
    ...(facts.pull ?? {}),
  };
  return {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch: string) =>
      Promise.resolve(
        branch === "development"
          ? TIP
          : branch === BRANCH || branch.startsWith("sentinel-candidates/")
          ? HEAD
          : null,
      ),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => {
      calls.pullReads++;
      return Promise.resolve(facts.pull === null ? null : pull);
    },
    readIssueOpen: () => Promise.resolve(facts.issueOpen ?? true),
    merge: () => {
      calls.merges++;
      return Promise.resolve(null);
    },
    closeIssue: () => {
      calls.closes++;
      return Promise.resolve(false);
    },
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    mismatchDisposition: {
      readRefAbsent: () => Promise.resolve(null),
      listPullsByHead: () => {
        calls.listings++;
        return Promise.resolve(
          facts.pulls === undefined
            ? [{ number: LIVE.pullRequest.number, state: "open", head: BRANCH }]
            : facts.pulls,
        );
      },
      readRunTerminal: () => Promise.resolve(null),
    },
  };
}

function liveRelease(): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1(structuredClone(LIVE.release));
}

function liveState(record: WorkRecordV1 = LIVE.work[0]!): TransitionState {
  const state = new TransitionState(
    snapshotOf([structuredClone(record)], structuredClone(LIVE.reservations)),
    liveRelease(),
  );
  state.snapshot = { ...state.snapshot, updatedAt: NOW - 60_000 };
  return state;
}

async function pass(
  state: TransitionState,
  facts: Facts = {},
  now = NOW,
): Promise<{ result: HostedAutonomyResultV1; calls: Calls }> {
  const calls: Calls = { listings: 0, pullReads: 0, merges: 0, closes: 0 };
  // The production allowlist and the live release custody: R80 installed.
  const result = await runHostedAutonomy({
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: () => surface(facts, calls),
    clock: { now: () => now },
  });
  return { result, calls };
}

function refreshActions(result: HostedAutonomyResultV1): string[] {
  return result.actions.filter((action) => action.startsWith("refresh:"));
}

Deno.test("refresh park (live 157): R80's own refusal parks once for the owner with PR 160 restored, then is named on every pass", async () => {
  const live = LIVE.work[0]!;
  assert.equal(live.blocker?.message, R80_MESSAGE);
  assert.equal(live.target.pr, null, "R80 detached PR 160");
  const state = liveState();
  const reservations = canonicalStringify(state.snapshot.reservations);

  // Pass 1: one CAS write parks it and restores the verified PR binding.
  const first = await pass(state);
  assert.equal(first.result.status, "applied", JSON.stringify(first.result));
  assert.deepEqual(refreshActions(first.result), [
    `refresh:${ID}:owner_parked:pr=160`,
  ]);
  assert.equal(state.writes, 1);
  assert.deepEqual(state.snapshot.work[0], {
    ...live,
    blocker: { kind: "other", message: `${PARK}${R80_MESSAGE}`, since: NOW },
    target: { ...live.target, pr: 160 },
    updatedAt: NOW,
  });
  assert.equal(
    canonicalStringify(state.snapshot.reservations),
    reservations,
    "every charge is byte-identical: nothing charged or refunded",
  );
  assert.equal(first.calls.merges, 0, "never merged");
  assert.equal(first.calls.closes, 0, "never closed");

  // Every later pass names it without any read or write.
  for (const later of [NOW + 60 * 60_000, NOW + 30 * 24 * 60 * 60_000]) {
    const parked = canonicalStringify(state.snapshot);
    const next = await pass(state, {}, later);
    assert.equal(state.writes, 1, JSON.stringify(next.result));
    assert.equal(canonicalStringify(state.snapshot), parked);
    assert.deepEqual(refreshActions(next.result), [
      `refresh:${ID}:owner_required:pr=160`,
    ]);
    assert.ok(
      !next.result.actions.some((action) =>
        action.startsWith(`retry:${ID}:grant`) ||
        action.startsWith(`merge:${ID}`) ||
        action.startsWith(`delivery:${ID}:carried_merge`)
      ),
      JSON.stringify(next.result.actions),
    );
    assert.equal(next.calls.listings, 0, "no listing for a bound park");
    assert.equal(next.calls.merges, 0);
  }

  // No retry rule plans the park, at the moved base tip or at its own base.
  for (const tip of [TIP, live.target.base]) {
    const denied: string[] = [];
    const plans = planHostedRetries(
      state.snapshot,
      NOW + 60 * 60_000,
      R80_RUNTIME as never,
      new Map([[hostedRepositoryKey(live.repository), tip]]),
      new Set(),
      (denial) => denied.push(denial.reason),
    );
    assert.deepEqual(plans.filter((plan) => plan.id === ID), []);
  }
});

Deno.test("refresh park: an unverified pull request parks without a binding, then binds it once it verifies", async () => {
  const state = liveState();
  const first = await pass(state, { pulls: null });
  assert.equal(first.result.status, "applied", JSON.stringify(first.result));
  assert.deepEqual(refreshActions(first.result), [
    `refresh:${ID}:owner_parked:pr=unverified`,
  ]);
  const parked = state.snapshot.work[0]!;
  assert.equal(parked.blocker?.message, `${PARK}${R80_MESSAGE}`);
  assert.equal(parked.target.pr, null, "a binding is never fabricated");

  // Still unverifiable: named, no write.
  const second = await pass(state, { pull: { headSha: TIP } }, NOW + 60_000);
  assert.equal(state.writes, 1, JSON.stringify(second.result));
  assert.deepEqual(refreshActions(second.result), [
    `refresh:${ID}:owner_required:pr=unverified`,
  ]);

  // Verified: one write binds the PR; the message is never rewritten.
  const third = await pass(state, {}, NOW + 120_000);
  assert.equal(third.result.status, "applied", JSON.stringify(third.result));
  assert.deepEqual(refreshActions(third.result), [
    `refresh:${ID}:owner_bound:pr=160`,
  ]);
  assert.equal(state.writes, 2);
  assert.deepEqual(state.snapshot.work[0], {
    ...parked,
    target: { ...parked.target, pr: 160 },
    updatedAt: NOW + 120_000,
  });

  const fourth = await pass(state, {}, NOW + 180_000);
  assert.equal(state.writes, 2);
  assert.deepEqual(refreshActions(fourth.result), [
    `refresh:${ID}:owner_required:pr=160`,
  ]);
});

Deno.test("refresh park: a runtime-written park that kept its PR is named on every pass with no read or write", async () => {
  const live = LIVE.work[0]!;
  const record: WorkRecordV1 = {
    ...live,
    blocker: {
      kind: "other",
      message: `${PARK}candidate touches a protected path`,
      since: live.blocker!.since,
    },
    target: { ...live.target, pr: 160 },
  };
  const state = liveState(record);
  const before = canonicalStringify(state.snapshot);
  const { result, calls } = await pass(state);
  assert.equal(state.writes, 0, JSON.stringify(result));
  assert.equal(canonicalStringify(state.snapshot), before);
  assert.deepEqual(refreshActions(result), [
    `refresh:${ID}:owner_required:pr=160`,
  ]);
  assert.equal(calls.listings, 0);
});

Deno.test("refresh park: a closed issue's refusal is neither parked nor named", async () => {
  for (
    const record of [
      LIVE.work[0]!,
      {
        ...LIVE.work[0]!,
        blocker: {
          kind: "other" as const,
          message: `${PARK}${R80_MESSAGE}`,
          since: NOW,
        },
      },
    ]
  ) {
    const state = liveState(record);
    const before = canonicalStringify(state.snapshot);
    const { result } = await pass(state, { issueOpen: false });
    assert.equal(state.writes, 0, JSON.stringify(result));
    assert.equal(canonicalStringify(state.snapshot), before);
    assert.deepEqual(refreshActions(result), []);
  }
});

Deno.test({
  name:
    "rollback: R80 parses the launcher's park and binding writes and its own selection skips them",
  ignore: !(await r80Available()),
  fn: async () => {
    const written: unknown[] = [];
    const state = liveState();
    const original = state.writeRepair.bind(state);
    state.writeRepair = (next, expected) => {
      written.push(structuredClone(next));
      return original(next, expected);
    };
    await pass(state, { pulls: null });
    await pass(state, {}, NOW + 60_000);
    assert.equal(written.length, 2);
    await withR80((r80) => {
      for (const snapshot of written) {
        r80.parse(snapshot);
        assert.equal(r80.skipReason(snapshot, ID, NOW), "blocked");
      }
    });
  },
});
