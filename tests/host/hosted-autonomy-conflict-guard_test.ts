/**
 * The ordinary retry table's conflict-marker guard (`planHostedRetries`).
 *
 * A charged conflict resolution that did not publish keeps the conflict
 * marker (the base tip B its one charge was spent on) on its retained intent.
 * The guard refuses the record only while that charge is settled charged
 * (`submitted` or `ambiguous`, never refunded) AND the configured base tip is
 * still B or unreadable: that tip's one charge is spent. Once the target moved
 * past B, a record whose blocker class the table retries returns to a plain
 * refresh at the new tip (no marker, PR kept, charges byte-identical), so the
 * installed runtime refreshes there and a renewed conflict costs at most one
 * charge at the NEW tip; a protected-path resolution, or any class the table
 * never retries, stays owner-terminal at every tip. All eligible records may
 * proceed in one maintenance pass. A charge that is
 * not a settled charge of this task (still `reserved`, missing, or refunded by
 * the runtime's own `confirmed_not_submitted` path) leaves the record's own
 * blocker class in charge, whose settled-intent rule refuses any unsettled
 * implementation charge; a settled charge bound to another task, repository
 * or purpose is refused outright.
 */
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import assert from "node:assert/strict";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  withHostedProductionPolicy,
} from "./hosted-supervisor-policy-fixture.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import {
  CONFLICT_PROTECTED_DETAIL,
  conflictMarker,
  conflictMarkerBase,
} from "../../src/repair/conflict-resolution.ts";
import {
  ATTEMPT_DETAIL_ARTIFACT_ONLY,
  ATTEMPT_DETAIL_LOOP_STOP,
} from "../../src/repair/attempt-policy.ts";
import { HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS } from "../../ops/hosted-autonomy-conflict-retries.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  applyHostedRetries,
  type HostedAutonomyGitHubV1,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { assertGen78Parses, gen78Available } from "../state/gen77-contracts.ts";
import {
  releaseAt,
  snapshotOf,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";

const REPO = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
};
const ID = "issue-ubiquity-ai.ubq.fi-641";
const BRANCH = candidateBranch(ID as never);
const PR = 1007;
const B0 = SHA1;
const HEAD = SHA2;
/** The base tip the resolution's one charge was spent on. */
const MARKED = "5".repeat(40) as GitSha;
/** A newer base tip the target moved to after the spent resolution. */
const TIP = SHA3;
const HOUR = 60 * 60 * 1000;
const NOW = T0 + 6 * HOUR;
const CHARGE = "ab".repeat(32);
const INCOMPLETE = "model run did not complete with a trusted candidate";
const NOT_STARTED =
  "implementation start is past the model cutoff or no longer fits the run bounds";
const THROTTLED = "model run failed (unavailable)";

/** The charged resolution's retained implementation intent, with marker. */
function retained(requestId = CHARGE): IncompleteOperationV1 {
  return {
    kind: "implementation",
    key: implementationIntentKey(requestId),
    startedAt: T0,
    branch: BRANCH,
    expectedHead: null,
    observedBase: B0,
    pr: null,
    requestId,
    resultId: null,
    failure: conflictMarker(MARKED, T0),
  };
}

function charge(
  outcome: "reserved" | "submitted" | "ambiguous" | "confirmed_not_submitted",
  overrides: Record<string, unknown> = {},
) {
  return reservation(CHARGE, {
    repository: REPO,
    taskId: ID,
    head: B0,
    attempt: 2,
    purpose: "retry",
    outcome,
    settledAt: outcome === "reserved" ? null : T0 + 1000,
    proofRef: outcome === "confirmed_not_submitted"
      ? "artifact://proof/not-submitted"
      : null,
    ...overrides,
  });
}

/** A published candidate H (PR kept) blocked after its charged resolution. */
async function marked(
  message = INCOMPLETE,
  overrides: Partial<WorkRecordV1> = {},
): Promise<WorkRecordV1> {
  const operationKey = implementationIntentKey("ef".repeat(32));
  return workRecord(ID, {
    repository: REPO,
    source: { kind: "issue", id: "641", revision: SHA1 },
    related: { incidentId: null, issueNumber: 641 },
    nextStep: "blocked",
    blocker: { kind: "other", message, since: T0 + 1000 },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    target: {
      base: B0,
      branch: BRANCH,
      checkpoint: null,
      head: HEAD,
      pr: PR,
      candidateState: {
        preserved: {
          operationKey,
          base: B0,
          head: HEAD,
          ref: await candidatePreservationRef(REPO, ID as never, operationKey),
        },
        publishedHead: HEAD,
      },
    },
    intent: retained(),
    ...overrides,
  });
}

function plan(
  snapshot: RepairStateSnapshotV1,
  tip: string | null | undefined,
) {
  const denials: string[] = [];
  const tips = new Map<string, string | null>();
  if (tip !== undefined) tips.set(hostedRepositoryKey(REPO), tip);
  const plans = planHostedRetries(
    snapshot,
    NOW,
    SHA3 as GitSha,
    tips,
    new Set(),
    (denial) => denials.push(denial.reason),
  );
  return { plans, denials };
}

Deno.test("conflict guard: a spent charge on the still-current or an unreadable tip is refused", async () => {
  for (const outcome of ["ambiguous", "submitted"] as const) {
    const snapshot = snapshotOf([await marked()], [charge(outcome)]);
    for (const tip of [MARKED, null, undefined]) {
      assert.deepEqual(plan(snapshot, tip), {
        plans: [],
        denials: ["conflict_resolution_spent"],
      }, `${outcome} at ${tip}`);
    }
  }
  // The same record without a marker is an ordinary retry of its class.
  const unmarked = snapshotOf(
    [
      await marked(INCOMPLETE, {
        intent: { ...retained(), failure: undefined },
      }),
    ],
    [charge("ambiguous")],
  );
  assert.equal(plan(unmarked, MARKED).plans.length, 1);
});

Deno.test("conflict guard: a moved base returns the record to a plain refresh at the new tip, charges untouched", async () => {
  for (
    const [message, outcome] of [
      [INCOMPLETE, "ambiguous"],
      [NOT_STARTED, "ambiguous"],
      [THROTTLED, "ambiguous"],
    ] as const
  ) {
    const record = await marked(message);
    const snapshot = snapshotOf([record], [charge(outcome)]);
    const planned = plan(snapshot, TIP);
    assert.deepEqual(planned.denials, [], message);
    assert.equal(planned.plans.length, 1, message);
    assert.equal(planned.plans[0].nextStep, "work");
    assert.equal(planned.plans[0].advanceBase, true);
    assert.equal(planned.plans[0].observedBase, TIP);
    assert.equal(planned.plans[0].grant, 0);
    const applied = applyHostedRetries(
      snapshot,
      "1".repeat(40) as GitSha,
      planned.plans,
      NOW,
    );
    const work = applied.work[0];
    assert.equal(work.nextStep, "work");
    assert.equal(work.blocker, null);
    assert.deepEqual(work.intent, {
      kind: "base_refresh",
      key: baseRefreshIntentKey(PR, HEAD, TIP),
      startedAt: NOW,
      branch: BRANCH,
      expectedHead: HEAD,
      observedBase: TIP,
      pr: PR,
      requestId: null,
      resultId: null,
    });
    assert.equal(conflictMarkerBase(work.intent), null, "no marker");
    assert.deepEqual(work.target, record.target, "H and the PR are kept");
    assert.equal(work.counters.attempts, 2, "the attempt floor is kept");
    assert.equal(work.counters.reviewRounds, 1);
    assert.deepEqual(
      applied.reservations,
      snapshot.reservations,
      "the spent charge stays charged",
    );
    if (await gen78Available()) await assertGen78Parses(applied);
  }
});

Deno.test("conflict guard: a moved base with no review round left plans nothing", async () => {
  const snapshot = snapshotOf(
    [
      await marked(INCOMPLETE, {
        counters: { attempts: 2, retries: 0, reviewRounds: 3 },
      }),
    ],
    [charge("ambiguous")],
  );
  assert.deepEqual(plan(snapshot, TIP), {
    plans: [],
    denials: ["conflict_resolution_rounds_spent"],
  });
});

Deno.test("conflict guard: a not-started resolution whose charge is still reserved falls through and plans nothing", async () => {
  // An unsettled charge (in flight, or isolated with its admission retained)
  // is the record class's own business: its settled-intent rule refuses it,
  // so nothing is planned, refunded or denied as spent, at any tip.
  for (const message of [NOT_STARTED, INCOMPLETE]) {
    const snapshot = snapshotOf([await marked(message)], [charge("reserved")]);
    for (const tip of [MARKED, TIP, undefined]) {
      assert.deepEqual(plan(snapshot, tip), { plans: [], denials: [] });
    }
  }
  // A missing charge is no settled charge either.
  const missing = snapshotOf([await marked(NOT_STARTED)], []);
  assert.deepEqual(plan(missing, TIP), { plans: [], denials: [] });
});

Deno.test("conflict guard: a not-started resolution settled by ingest is spent at its tip and re-pends once the base moved", async () => {
  const snapshot = snapshotOf([await marked(NOT_STARTED)], [
    charge("ambiguous"),
  ]);
  assert.deepEqual(plan(snapshot, MARKED), {
    plans: [],
    denials: ["conflict_resolution_spent"],
  });
  const moved = plan(snapshot, TIP);
  assert.equal(moved.plans.length, 1);
  assert.equal(moved.plans[0].observedBase, TIP);
});

Deno.test("conflict guard: a settled charge bound to another task, repository or purpose is refused", async () => {
  for (
    const overrides of [
      { taskId: "issue-ubiquity-ai.ubq.fi-999" },
      { repository: { ...REPO, name: "other" } },
      { purpose: "review_request" },
    ]
  ) {
    const snapshot = snapshotOf([await marked()], [
      charge("ambiguous", overrides),
    ]);
    for (const tip of [MARKED, TIP]) {
      assert.deepEqual(plan(snapshot, tip), {
        plans: [],
        denials: ["conflict_resolution_unbound"],
      }, JSON.stringify(overrides));
    }
  }
});

Deno.test("conflict guard: a refunded charge or a refresh intent leaves the record's own class in charge", async () => {
  // Refunded by the runtime's own path (provably never submitted): the
  // tip's one charge was never spent, so the class plans its refresh.
  const refunded = snapshotOf([await marked()], [
    charge("confirmed_not_submitted"),
  ]);
  const planned = plan(refunded, MARKED);
  assert.deepEqual(planned.denials, []);
  assert.equal(planned.plans.length, 1);
  assert.equal(planned.plans[0].observedBase, MARKED);
  // A resolved merge whose publication failed keeps its marked refresh
  // intent (no charge named): no class of the table re-admits it.
  const resolved = snapshotOf([
    await marked(
      "base refresh failed 3 consecutive times: unavailable candidate preservation unavailable",
      {
        intent: {
          kind: "base_refresh",
          key: baseRefreshIntentKey(PR, HEAD, MARKED),
          startedAt: T0,
          branch: BRANCH,
          expectedHead: HEAD,
          observedBase: MARKED,
          pr: PR,
          requestId: null,
          resultId: "6".repeat(40),
          failure: { ...conflictMarker(MARKED, T0), attempts: 4 },
        },
      },
    ),
  ], [charge("submitted")]);
  for (const tip of [MARKED, TIP]) {
    assert.deepEqual(plan(resolved, tip), { plans: [], denials: [] });
  }
});

/** The record's own repository surface in the full maintenance pass. */
function surface(pullState: "open" | "closed"): HostedAutonomyGitHubV1 {
  return {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch: string) =>
      Promise.resolve(
        branch === "development" ? TIP : branch === BRANCH ? HEAD : null,
      ),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: (number: number) =>
      Promise.resolve(
        number === PR
          ? {
            number,
            state: pullState,
            merged: false,
            mergeCommitSha: null,
            headSha: HEAD,
            baseRef: "development",
            baseSha: B0,
            author: "ubiquity-sentinel[bot]",
            parents: [],
            revisionOnBaseBranch: false,
            baseAncestorOfRevision: false,
          }
          : null,
      ),
    readIssueOpen: () => Promise.resolve(true),
    merge: () => Promise.resolve(null),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    listPullsByHeadRef: () => Promise.resolve([]),
  } as HostedAutonomyGitHubV1;
}

type HistoricalRunner =
  typeof import("../../ops/hosted-autonomy-runner.ts").runHostedAutonomy;

function historicalMaintenanceTest(
  name: string,
  scenario: (run: HistoricalRunner) => Promise<void>,
) {
  Deno.test(
    name,
    () =>
      withHostedProductionPolicy(
        DORMANT_HOSTED_SUPERVISOR_POLICY,
        async (graph) => {
          const { runHostedAutonomy } = await graph.runner();
          await scenario(runHostedAutonomy);
        },
      ),
  );
}

async function maintain(
  state: TransitionState,
  pullState: "open" | "closed",
  runHostedAutonomy: HistoricalRunner,
) {
  return runHostedAutonomy(
    await withDarkQueueAuthority({
      state: state as unknown as StateReadView & RepairStateWriter,
      githubFor: () => surface(pullState),
      clock: { now: () => NOW },
    }),
  );
}

const installed = () =>
  releaseAt({
    revision: SHA3,
    generation: 79,
    healthy: {
      revision: SHA3,
      generation: 79,
      createdAt: T0 + 2 * HOUR,
      observedAt: T0 + 3 * HOUR,
    },
  });

historicalMaintenanceTest(
  "conflict guard: the full maintenance pass re-pends a moved-base record on its open PR only",
  async (runHostedAutonomy) => {
    const record = await marked();
    const charges = [charge("ambiguous")];
    const before = snapshotOf([record], charges);
    const open = new TransitionState(before, installed());
    const result = await maintain(open, "open", runHostedAutonomy);
    assert.equal(result.status, "applied", JSON.stringify(result));
    assert.ok(
      result.actions.some((action) =>
        action.startsWith(`retry:${ID}:grant=0:`)
      ),
      JSON.stringify(result.actions),
    );
    const work = open.snapshot.work[0];
    assert.equal(work.nextStep, "work");
    assert.equal(work.intent?.kind, "base_refresh");
    assert.equal(work.intent?.observedBase, TIP);
    assert.equal(conflictMarkerBase(work.intent), null);
    assert.equal(work.target.pr, PR);
    assert.deepEqual(open.snapshot.reservations, before.reservations);

    const closed = new TransitionState(
      snapshotOf([record], charges),
      installed(),
    );
    const skipped = await maintain(closed, "closed", runHostedAutonomy);
    assert.deepEqual(closed.snapshot.work[0], record, "a closed PR is left");
    assert.ok(
      skipped.actions.includes(`retry:${ID}:skipped:pr_not_open`),
      JSON.stringify(skipped.actions),
    );
  },
);

Deno.test("conflict guard: at a moved tip only a class the table retries re-pends; a protected or other terminal resolution stays with the owner", async () => {
  // A resolution blocked for touching a protected path (or any class the
  // table never retries) keeps no attempt-memory brake: re-pending it at
  // every base move would charge one more resolution per move. It stays
  // owner-terminal like the same block without a marker.
  for (
    const [message, outcome, reason] of [
      [CONFLICT_PROTECTED_DETAIL, "submitted", "conflict_resolution_protected"],
      [
        ATTEMPT_DETAIL_ARTIFACT_ONLY,
        "ambiguous",
        "conflict_resolution_terminal",
      ],
      [ATTEMPT_DETAIL_LOOP_STOP, "ambiguous", "conflict_resolution_terminal"],
    ] as const
  ) {
    const snapshot = snapshotOf([await marked(message)], [charge(outcome)]);
    assert.deepEqual(plan(snapshot, MARKED), {
      plans: [],
      denials: ["conflict_resolution_spent"],
    }, message);
    for (const tip of [TIP, "6".repeat(40), "7".repeat(40)]) {
      assert.deepEqual(
        plan(snapshot, tip),
        { plans: [], denials: [reason] },
        `${message} at ${tip}`,
      );
    }
    // The same block without a marker is owner-terminal too: no class.
    const unmarked = snapshotOf(
      [
        await marked(message, {
          intent: { ...retained(), failure: undefined },
        }),
      ],
      [charge(outcome)],
    );
    assert.equal(plan(unmarked, TIP).plans.length, 0, message);
  }
});

/** The i-th marked record of one repository, with its own spent charge. */
async function markedTask(i: number) {
  const id = `issue-ubiquity-ai.ubq.fi-${700 + i}`;
  const branch = candidateBranch(id as never);
  const requestId = (0x10 + i).toString(16).repeat(32);
  const operationKey = implementationIntentKey("ef".repeat(32));
  const record = workRecord(id, {
    repository: REPO,
    source: { kind: "issue", id: String(700 + i), revision: SHA1 },
    related: { incidentId: null, issueNumber: 700 + i },
    nextStep: "blocked",
    blocker: { kind: "other", message: INCOMPLETE, since: T0 + 1000 },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    target: {
      base: B0,
      branch,
      checkpoint: null,
      head: HEAD,
      pr: 2000 + i,
      candidateState: {
        preserved: {
          operationKey,
          base: B0,
          head: HEAD,
          ref: await candidatePreservationRef(REPO, id as never, operationKey),
        },
        publishedHead: HEAD,
      },
    },
    intent: { ...retained(requestId), branch },
  });
  const spent = reservation(requestId, {
    repository: REPO,
    taskId: id,
    head: B0,
    attempt: 2,
    purpose: "retry",
    outcome: "ambiguous",
    settledAt: T0 + 1000,
    proofRef: null,
  });
  return { id, record, spent };
}

historicalMaintenanceTest(
  "conflict guard: one maintenance pass re-pends every moved-base record with an open pull request",
  async (runHostedAutonomy) => {
    assert.equal(
      HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS,
      Number.MAX_SAFE_INTEGER,
    );
    const tasks = await Promise.all([1, 2, 3, 4, 5, 6].map(markedTask));
    const closedPr = tasks[0].record.target.pr;
    const reads: number[] = [];
    const state = new TransitionState(
      snapshotOf(tasks.map((task) => task.record), tasks.map((t) => t.spent)),
      installed(),
    );
    const result = await runHostedAutonomy(
      await withDarkQueueAuthority({
        state: state as unknown as StateReadView & RepairStateWriter,
        githubFor: () => ({
          ...surface("open"),
          readBaseTip: (branch: string) =>
            Promise.resolve(branch === "development" ? TIP : HEAD),
          readPull: (number: number) => {
            reads.push(number);
            return Promise.resolve({
              number,
              state: number === closedPr ? "closed" : "open",
              merged: false,
              mergeCommitSha: null,
              headSha: HEAD,
              baseRef: "development",
              baseSha: B0,
              author: "ubiquity-sentinel[bot]",
              parents: [],
              revisionOnBaseBranch: false,
              baseAncestorOfRevision: false,
            });
          },
        } as HostedAutonomyGitHubV1),
        clock: { now: () => NOW },
      }),
    );
    assert.equal(result.status, "applied", JSON.stringify(result));
    const granted = result.actions.filter((action) =>
      action.endsWith(":conflict_resolution:base-advance")
    );
    const capped = result.actions.filter((action) =>
      action.endsWith(":skipped:conflict_resolution_cap")
    );
    assert.equal(granted.length, 5, JSON.stringify(result.actions));
    assert.equal(capped.length, 0, JSON.stringify(result.actions));
    assert.ok(
      result.actions.includes(`retry:${tasks[0].id}:skipped:pr_not_open`),
      "a closed pull request holds no slot",
    );
    assert.equal(reads.length, 6, "all records are verified");
    const repended = state.snapshot.work.filter((work) =>
      work.nextStep === "work"
    );
    assert.equal(repended.length, 5);
    for (const work of repended) {
      assert.equal(work.intent?.observedBase, TIP);
      assert.equal(conflictMarkerBase(work.intent), null);
    }
    assert.deepEqual(
      state.snapshot.reservations,
      tasks.map((task) => task.spent),
      "every spent charge stays charged",
    );
  },
);
