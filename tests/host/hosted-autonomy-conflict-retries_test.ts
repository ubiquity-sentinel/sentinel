/**
 * Launcher side of the base-refresh conflict resolution, through the REAL
 * hosted maintenance pass over fake GitHub surfaces:
 *
 * - the conflict re-admission is inert under the production allowlist (empty
 *   while every installable runtime keeps the hosted route closed) and under
 *   any runtime that is not an allowlisted, healthy generation-78+ pointer;
 * - with an allowlisted runtime, a conflict block written before its pinned
 *   activation returns to `work` with only target.pr restored from the
 *   verified open pull request, charging nothing;
 * - a charged resolution's conflict marker refuses every class of the
 *   ordinary retry table, so no launcher path spends a second charge on the
 *   same base tip.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  conflictMarker,
  HOSTED_CONFLICT_RESOLUTIONS,
} from "../../src/repair/conflict-resolution.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  type HostedAutonomyGitHubV1,
  type HostedAutonomyResultV1,
  planHostedRetries,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import {
  CONFLICT_READMISSION_DETAIL,
  conflictResolutionRuntimeProven,
  HOSTED_AUTONOMY_CONFLICT_RESOLUTION_MIN_GENERATION,
  HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES,
  planConflictReadmissions,
} from "../../ops/hosted-autonomy-conflict-retries.ts";
import {
  HOSTED_AUTONOMY_MAX_RETRIES,
  hostedIssueKey,
} from "../../ops/hosted-autonomy-policy.ts";
import type { HostedRefreshRearmRuntimeV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { assertGen77Parses, gen77Available } from "../state/gen77-contracts.ts";
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
const ID = "issue-ubiquity-ai.ubq.fi-640";
const BRANCH = candidateBranch(ID as never);
const B0 = SHA1;
const HEAD = SHA2;
const TIP = SHA3;
const HOUR = 60 * 60 * 1000;
const NOW = T0 + 6 * HOUR;
/** A stand-in generation-79 runtime that opens the hosted route. */
const OPENER = "9".repeat(40);
const PINNED = T0 + HOUR;
const PIN: HostedRefreshRearmRuntimeV1[] = [
  { revision: OPENER, activatedNotBefore: PINNED },
];
const CONFLICT = `base refresh has conflicts at ${TIP}`;

const installedOpener = () =>
  releaseAt({
    revision: OPENER,
    generation: 79,
    healthy: {
      revision: OPENER,
      generation: 79,
      createdAt: T0 + 2 * HOUR,
      observedAt: T0 + 3 * HOUR,
    },
  });

/** A sanitized live conflict block: H published, preserved, PR detached. */
async function conflictBlocked(
  overrides: Partial<WorkRecordV1> = {},
): Promise<WorkRecordV1> {
  const operationKey = implementationIntentKey("ef".repeat(32));
  return workRecord(ID, {
    repository: REPO,
    source: { kind: "issue", id: "640", revision: SHA1 },
    related: { incidentId: null, issueNumber: 640 },
    nextStep: "blocked",
    blocker: { kind: "other", message: CONFLICT, since: T0 },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    target: {
      base: B0,
      branch: BRANCH,
      checkpoint: null,
      head: HEAD,
      pr: null,
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
    ...overrides,
  });
}

interface Facts {
  branchTip?: string | null;
  pullHead?: string;
  author?: string | null;
}

function surface(facts: Facts = {}): HostedAutonomyGitHubV1 {
  return {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch: string) =>
      Promise.resolve(
        branch === "development"
          ? TIP
          : branch === BRANCH
          ? (facts.branchTip === undefined ? HEAD : facts.branchTip)
          : null,
      ),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: () => Promise.resolve(true),
    merge: () => Promise.resolve(null),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    listPullsByHeadRef: () =>
      Promise.resolve([{
        number: 1012,
        state: "open",
        merged: false,
        headSha: facts.pullHead ?? HEAD,
        headRef: BRANCH,
        baseRef: "development",
        author: facts.author === undefined
          ? "ubiquity-sentinel[bot]"
          : facts.author,
      }]),
  } as HostedAutonomyGitHubV1;
}

function runWith(
  state: TransitionState,
  facts: Facts = {},
  /** null runs the production allowlist. */
  runtimes: readonly HostedRefreshRearmRuntimeV1[] | null = PIN,
): Promise<HostedAutonomyResultV1> {
  return runHostedAutonomy({
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: () => surface(facts),
    clock: { now: () => NOW },
    ...(runtimes === null ? {} : { conflictResolutionRuntimes: runtimes }),
  });
}

Deno.test("conflict re-admission: the production allowlist is empty while every installable runtime keeps the route closed", () => {
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS, false);
  assert.deepEqual(HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES, []);
  assert.equal(HOSTED_AUTONOMY_CONFLICT_RESOLUTION_MIN_GENERATION, 78);
});

Deno.test("conflict re-admission: inert under the production allowlist", async () => {
  const record = await conflictBlocked();
  const state = new TransitionState(
    snapshotOf([record], []),
    installedOpener(),
  );
  const result = await runWith(state, {}, null);
  assert.deepEqual(state.snapshot.work[0], record, "untouched");
  assert.equal(state.writes, 0);
  assert.ok(
    !result.actions.some((action) => action.includes(ID)),
    JSON.stringify(result.actions),
  );
});

Deno.test("conflict re-admission: an allowlisted healthy runtime restores the verified PR and charges nothing", async () => {
  const record = await conflictBlocked();
  const state = new TransitionState(
    snapshotOf([record], []),
    installedOpener(),
  );
  const result = await runWith(state);
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.ok(
    result.actions.includes(
      `retry:${ID}:readmit:${CONFLICT_READMISSION_DETAIL}`,
    ),
    JSON.stringify(result.actions),
  );
  assert.equal(state.writes, 1, "one CAS write");
  const work = state.snapshot.work[0];
  assert.deepEqual(work, {
    ...record,
    nextStep: "work",
    blocker: null,
    wait: null,
    intent: null,
    target: { ...record.target, pr: 1012 },
    updatedAt: work.updatedAt,
  });
  assert.deepEqual(state.snapshot.reservations, [], "nothing charged");
  if (await gen77Available()) await assertGen77Parses(state.snapshot);
});

Deno.test("conflict re-admission: the runtime must be an allowlisted healthy generation-78+ pointer", async () => {
  const record = await conflictBlocked();
  const opener = installedOpener().hostedRuntimes[0];
  assert.ok(conflictResolutionRuntimeProven(opener, PIN));
  assert.ok(!conflictResolutionRuntimeProven(opener, []), "not allowlisted");
  assert.ok(
    !conflictResolutionRuntimeProven({ ...opener, generation: 77 }, PIN),
    "below generation 78",
  );
  assert.ok(
    !conflictResolutionRuntimeProven(
      { ...opener, lastHealthyProof: null },
      PIN,
    ),
    "no healthy proof",
  );
  for (
    const release of [
      releaseAt({ revision: OPENER, generation: 79, healthy: null }),
      releaseAt({
        revision: OPENER,
        generation: 79,
        healthy: {
          revision: SHA1,
          generation: 78,
          createdAt: T0 + 2 * HOUR,
          observedAt: T0 + 3 * HOUR,
        },
      }),
    ]
  ) {
    const state = new TransitionState(snapshotOf([record], []), release);
    await runWith(state);
    assert.deepEqual(state.snapshot.work[0], record, "inert");
  }
});

Deno.test("conflict re-admission: local refusals (activation, shape, closed issue, retry budget)", async () => {
  const release = installedOpener();
  const plan = (
    record: WorkRecordV1,
    reservations: unknown[] = [],
    closed: ReadonlySet<string> = new Set(),
  ) => {
    const denials: string[] = [];
    const candidates = planConflictReadmissions(
      snapshotOf([record], reservations),
      release,
      closed,
      (denial) => denials.push(denial.reason),
      PIN,
    );
    return { candidates: candidates.map((row) => row.head), denials };
  };
  assert.deepEqual(plan(await conflictBlocked()).candidates, [HEAD]);
  assert.deepEqual(
    plan(
      await conflictBlocked({
        blocker: {
          kind: "other",
          message: "base refresh has conflicts",
          since: T0,
        },
      }),
    ).candidates,
    [HEAD],
    "the legacy bare message",
  );
  assert.deepEqual(
    plan(
      await conflictBlocked({
        blocker: { kind: "other", message: CONFLICT, since: PINNED },
      }),
    ),
    { candidates: [], denials: ["conflict_block_after_activation"] },
    "the resolving runtime's own block is final",
  );
  assert.deepEqual(
    plan(
      await conflictBlocked({
        counters: { attempts: 2, retries: 0, reviewRounds: 3 },
      }),
    ),
    { candidates: [], denials: ["conflict_unresolvable_shape"] },
    "no review round left",
  );
  assert.deepEqual(
    plan(await conflictBlocked(), [], new Set([hostedIssueKey(REPO, 640)])),
    { candidates: [], denials: [] },
    "closed source issue",
  );
  const budget = Array.from(
    { length: HOSTED_AUTONOMY_MAX_RETRIES },
    (_, index) =>
      reservation(`charge-${index}`, {
        repository: REPO,
        taskId: ID,
        head: B0,
        attempt: index + 1,
        purpose: "retry",
        outcome: "submitted",
        settledAt: T0,
      }),
  );
  assert.deepEqual(plan(await conflictBlocked(), budget).candidates, []);
  for (
    const message of [
      "base refresh has conflicts at abc",
      "base refresh failed 3 consecutive times: conflict candidate ref carries an unrelated head",
      "model run did not complete with a trusted candidate",
    ]
  ) {
    assert.deepEqual(
      plan(
        await conflictBlocked({
          blocker: { kind: "other", message, since: T0 },
        }),
      ),
      { candidates: [], denials: [] },
      message,
    );
  }
});

Deno.test("conflict re-admission: a moved branch or a foreign PR is never re-admitted", async () => {
  for (
    const [facts, reason] of [
      [{ branchTip: TIP }, "branch_moved"],
      [{ author: "someone-else" }, "pr_foreign"],
      [{ pullHead: TIP, branchTip: HEAD }, "pr_foreign"],
    ] as const
  ) {
    const record = await conflictBlocked();
    const state = new TransitionState(
      snapshotOf([record], []),
      installedOpener(),
    );
    const result = await runWith(state, facts);
    assert.deepEqual(state.snapshot.work[0], record, reason);
    assert.ok(
      result.actions.includes(`retry:${ID}:skipped:${reason}`),
      JSON.stringify(result.actions),
    );
  }
});

Deno.test("retry guard: a charged conflict resolution is never re-admitted by the ordinary retry table", async () => {
  const reservationId = "ab".repeat(32);
  const retained = {
    kind: "implementation" as const,
    key: implementationIntentKey(reservationId),
    startedAt: T0,
    branch: BRANCH,
    expectedHead: null,
    observedBase: B0,
    pr: null,
    requestId: reservationId,
    resultId: null,
  };
  const charge = reservation(reservationId, {
    repository: REPO,
    taskId: ID,
    head: B0,
    attempt: 2,
    purpose: "retry",
    outcome: "ambiguous",
    settledAt: T0,
  });
  const blocked = (marked: boolean) =>
    conflictBlocked({
      blocker: {
        kind: "other",
        message: "model run did not complete with a trusted candidate",
        since: T0,
      },
      target: {
        base: B0,
        branch: BRANCH,
        checkpoint: null,
        head: HEAD,
        pr: 1012,
      },
      intent: marked
        ? { ...retained, failure: conflictMarker(TIP as GitSha, T0) }
        : retained,
    });
  const plan = async (marked: boolean) => {
    const denials: string[] = [];
    const plans = planHostedRetries(
      snapshotOf([await blocked(marked)], [charge]),
      NOW,
      SHA3 as GitSha,
      new Map(),
      new Set(),
      (denial) => denials.push(denial.reason),
    );
    return { plans: plans.length, denials };
  };
  assert.deepEqual(await plan(false), { plans: 1, denials: [] });
  assert.deepEqual(await plan(true), {
    plans: 0,
    denials: ["conflict_resolution_spent"],
  });
});
