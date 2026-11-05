/**
 * A record left at `work` (or `blocked`) although its own pull request was
 * merged by a person (live ai.ubq.fi #576/#630/#634/#1148: merged Oct 18,
 * issues closed, `work deferred` every cycle) is re-admitted to `review` once
 * the merge into the record's base by a readable non-Sentinel actor is
 * verified; the runtime's review observation then completes it as `done` with
 * human-merge provenance (`completeHumanMerge`). A cleared intent's
 * still-reserved charge is settled `ambiguous`, never refunded. An open pull
 * request leaves the record untouched.
 */
import assert from "node:assert/strict";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  retiredPullKeepsHot,
  SOURCE_ISSUE_CLOSED_RETIREMENT,
} from "../../src/contracts/work-record-retired-pull.ts";
import {
  applyHumanMergeReadmissions,
  planHumanMergeHeadReadmissions,
  verifyHumanMergeHeadReadmissions,
} from "../../ops/hosted-autonomy-human-merge-readmission.ts";
import { hostedIssueKey } from "../../ops/hosted-autonomy-policy.ts";
import type { HostedAutonomyScopeV1 } from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import { reservation, T0 } from "../state/helpers.ts";
import {
  BASE,
  deliveryRecord,
  HEAD,
  SELF_REPO,
  TARGET,
} from "./hosted-autonomy-fixtures.ts";
import { repairSnapshot } from "./hosted-autonomy-rig.ts";

const BRANCH = `sentinel/repair/${TARGET}`;
const NOW = T0 + 60_000;
const CLOSED = new Set([hostedIssueKey(SELF_REPO, 48)]);

/** A `work` record whose implementation intent's charge is still reserved. */
function staleWork(overrides: Record<string, unknown> = {}): WorkRecordV1 {
  return deliveryRecord({
    nextStep: "work",
    blocker: null,
    wait: null,
    evidence: [],
    intent: {
      kind: "implementation",
      key: "implementation:stale-1",
      startedAt: T0 + 1000,
      branch: BRANCH,
      expectedHead: null,
      observedBase: BASE,
      pr: null,
      requestId: "stale-1",
      resultId: null,
    },
    ...overrides,
  });
}

const reserved = () =>
  reservation("stale-1", {
    repository: SELF_REPO,
    taskId: TARGET,
    head: BASE,
    attempt: 2,
    purpose: "implementation",
    outcome: "reserved",
    settledAt: null,
  });

function pull(
  overrides: Partial<HostedAutonomyHeadPullV1> = {},
): HostedAutonomyHeadPullV1 {
  return {
    number: 51,
    state: "closed",
    merged: true,
    headSha: HEAD,
    headRef: BRANCH,
    baseRef: "development",
    author: "ubiquity-sentinel[bot]",
    ...overrides,
  };
}

function scope(listed: HostedAutonomyHeadPullV1, calls: string[]) {
  const surface = {
    listPullsByHeadRef: (branch: string) => {
      calls.push(`list:${branch}`);
      return Promise.resolve([listed]);
    },
    readPull: (number: number) => {
      calls.push(`readPull:${number}`);
      return Promise.resolve({
        number,
        state: listed.state,
        merged: listed.merged,
        mergedBy: "0x4007",
      });
    },
  } as unknown as HostedAutonomyGitHubV1;
  return (): Promise<HostedAutonomyScopeV1> =>
    Promise.resolve({
      repository: SELF_REPO,
      key: "self",
      surface,
      baseBranch: "development",
    });
}

Deno.test("stale human merge: a work record with an intent and a merged pull returns to review, its charge settled ambiguous", async () => {
  const snapshot = repairSnapshot([staleWork()], [], [], [reserved()]);
  const planned = planHumanMergeHeadReadmissions(snapshot, CLOSED);
  assert.deepEqual(
    planned.map((row) => [row.parkedBy, row.settleReservation]),
    [
      ["stale_step", "stale-1"],
    ],
  );
  const calls: string[] = [];
  const actions: string[] = [];
  const verified = await verifyHumanMergeHeadReadmissions(
    planned,
    scope(pull(), calls),
    actions,
  );
  assert.deepEqual(calls, [`list:${BRANCH}`, "readPull:51"]);
  assert.deepEqual(actions, []);
  assert.equal(verified.length, 1);
  assert.equal(verified[0]!.detail, "human_merge_stale_step");
  const applied = applyHumanMergeReadmissions(snapshot, verified, NOW);
  const work = applied.work[0]!;
  // The runtime's review step reads the merged pull first and completes the
  // record as `done` with human-merge provenance (completeHumanMerge).
  assert.equal(work.nextStep, "review");
  assert.equal(work.intent, null);
  assert.equal(work.wait, null);
  assert.equal(work.blocker, null);
  assert.equal(work.target.pr, 51);
  assert.equal(work.target.head, HEAD);
  assert.deepEqual(work.counters, snapshot.work[0]!.counters);
  assert.deepEqual(
    applied.reservations.map((row) => [row.id, row.outcome, row.settledAt]),
    [["stale-1", "ambiguous", NOW]],
    "the reserved charge stays charged: ambiguous, never refunded",
  );
});

Deno.test("stale human merge: a work record whose pull is open is untouched", async () => {
  const snapshot = repairSnapshot([staleWork()], [], [], [reserved()]);
  const calls: string[] = [];
  const actions: string[] = [];
  const verified = await verifyHumanMergeHeadReadmissions(
    planHumanMergeHeadReadmissions(snapshot, CLOSED),
    scope(pull({ state: "open", merged: false }), calls),
    actions,
  );
  assert.deepEqual(verified, []);
  // No merger detail is read for an open pull.
  assert.deepEqual(calls, [`list:${BRANCH}`]);
  assert.deepEqual(actions, [`retry:${TARGET}:skipped:pr_not_merged`]);
  assert.equal(applyHumanMergeReadmissions(snapshot, verified, NOW), snapshot);
});

Deno.test("stale human merge: Sentinel's own merge, an open issue or an owned intent is never re-admitted", async () => {
  const calls: string[] = [];
  const actions: string[] = [];
  const planned = planHumanMergeHeadReadmissions(
    repairSnapshot([staleWork()], [], [], [reserved()]),
    CLOSED,
  );
  const sentinelMerged = {
    listPullsByHeadRef: () => Promise.resolve([pull()]),
    readPull: (number: number) =>
      Promise.resolve({
        number,
        state: "closed",
        merged: true,
        mergedBy: "ubiquity-sentinel[bot]",
      }),
  } as unknown as HostedAutonomyGitHubV1;
  assert.deepEqual(
    await verifyHumanMergeHeadReadmissions(
      planned,
      () =>
        Promise.resolve({
          repository: SELF_REPO,
          key: "self",
          surface: sentinelMerged,
          baseBranch: "development",
        }),
      actions,
    ),
    [],
  );
  assert.deepEqual(actions, [`retry:${TARGET}:skipped:merge_by_sentinel`]);
  assert.deepEqual(calls, []);
  // An open source issue: not a candidate (no read at all).
  assert.deepEqual(
    planHumanMergeHeadReadmissions(repairSnapshot([staleWork()]), new Set()),
    [],
  );
  // Without the pass's issue facts the stale shape is not planned.
  assert.deepEqual(
    planHumanMergeHeadReadmissions(repairSnapshot([staleWork()])),
    [],
  );
  // A merge, closure or self-merge operation stays with its owner.
  assert.deepEqual(
    planHumanMergeHeadReadmissions(
      repairSnapshot([
        staleWork({
          intent: {
            kind: "merge",
            key: "merge:51",
            startedAt: T0 + 1000,
            branch: BRANCH,
            expectedHead: HEAD,
            observedBase: BASE,
            pr: 51,
            requestId: null,
            resultId: null,
          },
        }),
      ]),
      CLOSED,
    ),
    [],
  );
});

Deno.test("stale human merge: a retired record is completed only once its pull is recorded merged", () => {
  const retired = (closure?: Record<string, unknown>) =>
    parseWorkRecordV1({
      ...staleWork({
        nextStep: "blocked",
        intent: null,
        blocker: {
          kind: "other",
          message: SOURCE_ISSUE_CLOSED_RETIREMENT,
          since: T0 + 3000,
        },
      }),
      ...(closure === undefined ? {} : { retiredPullClosure: closure }),
    });
  const merged = retired({ pr: 51, outcome: "merged", at: NOW });
  // Recorded merged: planned without any issue read, and kept hot.
  assert.deepEqual(
    planHumanMergeHeadReadmissions(repairSnapshot([merged]), new Set()).map(
      (row) => row.parkedBy,
    ),
    ["stale_step"],
  );
  assert.equal(retiredPullKeepsHot(merged), true);
  // Unsettled (the retired-pull pass owns it) or closed: never planned.
  for (
    const record of [retired(), retired({ pr: 51, outcome: "closed", at: NOW })]
  ) {
    assert.deepEqual(
      planHumanMergeHeadReadmissions(repairSnapshot([record]), CLOSED),
      [],
    );
  }
  assert.equal(
    retiredPullKeepsHot(retired({ pr: 51, outcome: "closed", at: NOW })),
    false,
  );
});
