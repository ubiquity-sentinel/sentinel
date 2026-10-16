/**
 * Launcher side of the base-refresh conflict resolution, through the REAL
 * hosted maintenance pass over fake GitHub surfaces:
 *
 * - the hosted route opens with generation 79, so the rule needs generation
 *   79 and an exact allowlisted revision: R77 and R78 (which keep the hosted
 *   route closed) are excluded by revision at every generation, and every
 *   listed revision present locally opens the route in its own tree;
 * - the conflict re-admission is inert under the production allowlist and
 *   under any runtime that is not an allowlisted, healthy generation-79+
 *   pointer;
 * - with an allowlisted runtime, a conflict block written before its pinned
 *   activation returns to `work` with only target.pr restored from the
 *   verified open pull request, charging nothing;
 * - one pass returns at most `HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS`
 *   conflict resolutions (re-admissions and moved-tip re-pends together),
 *   counting only verified open pull requests.
 *
 * The retry table's conflict-marker guard is pinned in
 * `hosted-autonomy-conflict-guard_test.ts`.
 */
import assert from "node:assert/strict";
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
  OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION,
} from "../../src/host/owner-install-runtime-pins.ts";
import {
  type HostedAutonomyGitHubV1,
  type HostedAutonomyResultV1,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import {
  CONFLICT_READMISSION_DETAIL,
  conflictResolutionRuntimeProven,
  HOSTED_AUTONOMY_CONFLICT_RESOLUTION_MIN_GENERATION,
  HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES,
  HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS,
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

Deno.test("conflict re-admission: the hosted route opens at generation 79 and no runtime that keeps it closed is allowlisted", () => {
  // Generation 78 (R78) consumes or isolates every conflict cell and state
  // the open route writes (`matrix-conflict-gen78_test.ts`,
  // `conflict-resolution-gen78_test.ts`), so the runtime of this tree opens
  // the hosted route and the launcher re-admits only under a runtime cut
  // from it.
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS, true);
  assert.equal(HOSTED_AUTONOMY_CONFLICT_RESOLUTION_MIN_GENERATION, 79);
  const listed = HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES.map((row) =>
    row.revision
  );
  for (
    const revision of [
      OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
      OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION,
    ]
  ) assert.ok(!listed.includes(revision), revision);
  for (const row of HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES) {
    assert.match(row.revision, /^[0-9a-f]{40}$/);
    assert.ok(Number.isSafeInteger(row.activatedNotBefore));
  }
});

Deno.test("conflict re-admission: R77 and R78 are excluded by revision at every generation", () => {
  const opener = installedOpener().hostedRuntimes[0];
  for (
    const revision of [
      OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
      OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION,
    ]
  ) {
    for (const generation of [78, 79, 80]) {
      const restored = {
        ...opener,
        activeRevision: revision,
        generation,
        lastHealthyProof: {
          ...opener.lastHealthyProof!,
          execution: {
            ...opener.lastHealthyProof!.execution,
            revision,
            generation,
          },
        },
      };
      for (
        const pinned of [HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES, PIN]
      ) {
        assert.ok(
          !conflictResolutionRuntimeProven(restored, pinned),
          `${revision} at generation ${generation}`,
        );
      }
    }
  }
});

Deno.test("conflict re-admission: every allowlisted runtime present locally opens the hosted route; R78 keeps it closed", async () => {
  const root = decodeURIComponent(new URL("../../", import.meta.url).pathname);
  const source = async (revision: string) => {
    const present = await new Deno.Command("git", {
      args: ["-C", root, "cat-file", "-e", `${revision}^{commit}`],
      stdout: "null",
      stderr: "null",
    }).output();
    if (!present.success) return null;
    const shown = await new Deno.Command("git", {
      args: [
        "-C",
        root,
        "show",
        `${revision}:src/repair/conflict-resolution.ts`,
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    assert.ok(shown.success, revision);
    return new TextDecoder().decode(shown.stdout);
  };
  const OPEN = /^export const HOSTED_CONFLICT_RESOLUTIONS = true;$/m;
  for (const row of HOSTED_AUTONOMY_CONFLICT_RESOLUTION_RUNTIMES) {
    const text = await source(row.revision);
    if (text === null) continue;
    assert.match(text, OPEN, `${row.revision} keeps the hosted route closed`);
  }
  // The control: the rollback target's own tree keeps the route closed, which
  // is exactly why it is never listed.
  const r78 = await source(OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION);
  if (r78 !== null) {
    assert.doesNotMatch(r78, OPEN);
    assert.match(r78, /^export const HOSTED_CONFLICT_RESOLUTIONS = false;$/m);
  }
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

Deno.test("conflict re-admission: the runtime must be an allowlisted healthy generation-79+ pointer", async () => {
  const record = await conflictBlocked();
  const opener = installedOpener().hostedRuntimes[0];
  assert.ok(conflictResolutionRuntimeProven(opener, PIN));
  assert.ok(!conflictResolutionRuntimeProven(opener, []), "not allowlisted");
  assert.ok(
    !conflictResolutionRuntimeProven({ ...opener, generation: 78 }, PIN),
    "below generation 79",
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

/** The i-th conflict block of one repository (H published, PR detached). */
async function blockedTask(i: number): Promise<WorkRecordV1> {
  const id = `issue-ubiquity-ai.ubq.fi-${800 + i}`;
  return workRecord(id, {
    ...await ownTarget(id),
    source: { kind: "issue", id: String(800 + i), revision: SHA1 },
    related: { incidentId: null, issueNumber: 800 + i },
  });
}

/** The conflict block's fields with the target bound to task `id`. */
async function ownTarget(id: string): Promise<Partial<WorkRecordV1>> {
  const { id: _, ...base } = await conflictBlocked();
  const operationKey = implementationIntentKey("ef".repeat(32));
  return {
    ...base,
    target: {
      ...base.target,
      branch: candidateBranch(id as never),
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
  };
}

/** The i-th spent, marked resolution whose base moved (PR kept, open). */
async function spentTask(i: number) {
  const id = `issue-ubiquity-ai.ubq.fi-${900 + i}`;
  const branch = candidateBranch(id as never);
  const requestId = (0x20 + i).toString(16).repeat(32);
  const base = await ownTarget(id);
  const record = workRecord(id, {
    ...base,
    source: { kind: "issue", id: String(900 + i), revision: SHA1 },
    related: { incidentId: null, issueNumber: 900 + i },
    blocker: {
      kind: "other",
      message: "model run did not complete with a trusted candidate",
      since: T0 + 1000,
    },
    target: { ...base.target!, pr: 4000 + i },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(requestId),
      startedAt: T0,
      branch,
      expectedHead: null,
      observedBase: B0,
      pr: null,
      requestId,
      resultId: null,
      failure: conflictMarker("5".repeat(40) as never, T0),
    },
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
  return { record, spent };
}

/** One repository surface for many records: every branch at H, PRs open. */
function manySurface(
  reads: string[],
  movedBranch: string | null = null,
): HostedAutonomyGitHubV1 {
  return {
    ...surface(),
    readBaseTip: (branch: string) => {
      if (branch !== "development") reads.push(branch);
      return Promise.resolve(
        branch === "development" ? TIP : branch === movedBranch ? TIP : HEAD,
      );
    },
    readPull: (number: number) =>
      Promise.resolve({
        number,
        state: "open",
        merged: false,
        mergeCommitSha: null,
        headSha: HEAD,
        baseRef: "development",
        baseSha: B0,
        author: "ubiquity-sentinel[bot]",
        parents: [],
        revisionOnBaseBranch: false,
        baseAncestorOfRevision: false,
      }),
    listPullsByHeadRef: (branch: string) =>
      Promise.resolve([{
        number: 3000 + Number(branch.slice(-3)),
        state: "open",
        merged: false,
        headSha: HEAD,
        headRef: branch,
        baseRef: "development",
        author: "ubiquity-sentinel[bot]",
      }]),
  } as HostedAutonomyGitHubV1;
}

Deno.test("conflict re-admission: one pass re-admits at most the per-pass cap, counting only verified open pull requests", async () => {
  assert.equal(HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS, 4);
  const records = await Promise.all([1, 2, 3, 4, 5, 6].map(blockedTask));
  const moved = records[0];
  const reads: string[] = [];
  const state = new TransitionState(
    snapshotOf(records, []),
    installedOpener(),
  );
  const result = await runHostedAutonomy({
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: () => manySurface(reads, moved.target.branch),
    clock: { now: () => NOW },
    conflictResolutionRuntimes: PIN,
  });
  assert.equal(result.status, "applied", JSON.stringify(result));
  const readmitted = result.actions.filter((action) =>
    action.endsWith(`:readmit:${CONFLICT_READMISSION_DETAIL}`)
  );
  assert.equal(readmitted.length, 4, JSON.stringify(result.actions));
  assert.ok(
    result.actions.includes(`retry:${moved.id}:skipped:branch_moved`),
    "a dropped candidate holds no slot",
  );
  const capped = result.actions.filter((action) =>
    action.endsWith(":skipped:conflict_resolution_cap")
  );
  assert.equal(capped.length, 1, JSON.stringify(result.actions));
  const cappedId = capped[0].split(":")[1];
  assert.ok(
    !reads.includes(candidateBranch(cappedId as never)),
    "a candidate past the cap is not read",
  );
  assert.equal(
    state.snapshot.work.filter((work) => work.nextStep === "work").length,
    4,
  );
  assert.deepEqual(state.snapshot.reservations, [], "nothing charged");
});

Deno.test("conflict re-admission: moved-tip re-pends and re-admissions share one per-pass cap", async () => {
  const spent = await Promise.all([1, 2, 3].map(spentTask));
  const blocked = await Promise.all([1, 2, 3].map(blockedTask));
  const state = new TransitionState(
    snapshotOf(
      [...spent.map((task) => task.record), ...blocked],
      spent.map((task) => task.spent),
    ),
    installedOpener(),
  );
  const result = await runHostedAutonomy({
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: () => manySurface([]),
    clock: { now: () => NOW },
    conflictResolutionRuntimes: PIN,
  });
  assert.equal(result.status, "applied", JSON.stringify(result));
  const repended = result.actions.filter((action) =>
    action.endsWith(":conflict_resolution:base-advance")
  );
  const readmitted = result.actions.filter((action) =>
    action.endsWith(`:readmit:${CONFLICT_READMISSION_DETAIL}`)
  );
  assert.equal(repended.length, 3, JSON.stringify(result.actions));
  assert.equal(readmitted.length, 1, JSON.stringify(result.actions));
  assert.equal(
    result.actions.filter((action) =>
      action.endsWith(":skipped:conflict_resolution_cap")
    ).length,
    2,
    JSON.stringify(result.actions),
  );
  assert.deepEqual(
    state.snapshot.reservations,
    spent.map((task) => task.spent),
    "the spent charges stay charged; nothing new is charged",
  );
});
