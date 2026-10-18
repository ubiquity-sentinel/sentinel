/**
 * The launcher's foreign green read (`hasAllChecksGreen`) is tri-state and
 * requires every expected check (sentinel issue #154):
 *
 * - green (true) only for a complete, non-empty listing of the exact head
 *   whose every run completed with `success` and, when the caller names the
 *   base the head is tested against, which reports every check name of each
 *   base check suite it shares a name with;
 * - not green (false) for a readable listing that fails that;
 * - unreadable (null) for a listing (the head's or the base's) that cannot be
 *   read and proven complete, or that holds no check run at all.
 *
 * The REAL surface runs over a stubbed `fetch`, on the live verify-artifact
 * gap of ai.ubq.fi PR 1064. The REAL retry pass then records a head as read
 * (`ciReadHeads`) only after a successful non-empty listing, and an
 * unreadable listing plans nothing: it no longer takes a CI correction slot
 * (the issue's case: a rate-limited listing for green legacy 618 read as red
 * and, its re-run settled, was planned as one).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import { createHostedAutonomyGitHub } from "../../ops/hosted-autonomy-github.ts";
import { HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES } from "../../ops/hosted-autonomy-ci-retries.ts";
import { HOSTED_AUTONOMY_CI_FIRST_RUNTIMES } from "../../ops/hosted-autonomy-ci-first.ts";
import {
  readHostedClosedIssues,
  runHostedRetryPass,
} from "../../ops/hosted-autonomy-retry-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyHeadRunV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  blockedRecord,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { releaseAt } from "./hosted-autonomy-preservation-fixtures.ts";
import { LIVE_GAP, liveGapWire } from "../repair/ci-coverage-fixtures.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;

/** A route answer: a JSON page, or a bare HTTP status (a 503 or a 403). */
type Answer = Record<string, unknown> | number;

/**
 * Runs `body` with `fetch` answering each check-run listing of the commit
 * named in its URL from `routes` (any other request is a 404).
 */
async function withListings<T>(
  routes: Record<string, Answer>,
  body: () => Promise<T>,
  requested: string[] = [],
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requested.push(url);
    const match = /\/commits\/([0-9a-f]{40})\/check-runs\?/.exec(url);
    const answer = match === null ? 404 : routes[match[1]] ?? 404;
    return Promise.resolve(
      typeof answer === "number"
        ? new Response("{}", { status: answer })
        : new Response(JSON.stringify(answer), { status: 200 }),
    );
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

function page(runs: Record<string, unknown>[]): Record<string, unknown> {
  return { total_count: runs.length, check_runs: runs };
}

const surface = () => createHostedAutonomyGitHub("fixture-token", AI);

Deno.test("launcher green read: the live verify-artifact gap is not green against T; the complete head is", async () => {
  const requested: string[] = [];
  const gap = await withListings(
    {
      [LIVE_GAP.head]: page(liveGapWire("gap")),
      [LIVE_GAP.tip]: page(liveGapWire("tip")),
    },
    () => surface().hasAllChecksGreen(LIVE_GAP.head, LIVE_GAP.tip),
    requested,
  );
  assert.equal(gap, false, "three of four expected checks is not green");
  assert.ok(
    requested.some((url) => url.includes(`/commits/${LIVE_GAP.tip}/`)),
    "the base listing was read",
  );
  const complete = await withListings({
    [LIVE_GAP.head]: page(liveGapWire("complete")),
    [LIVE_GAP.tip]: page(liveGapWire("tip")),
  }, () => surface().hasAllChecksGreen(LIVE_GAP.head, LIVE_GAP.tip));
  assert.equal(complete, true);
  // A read that names no base (a tip's own CI) judges the existing runs.
  const tipOnly = await withListings({
    [LIVE_GAP.head]: page(liveGapWire("gap")),
  }, () => surface().hasAllChecksGreen(LIVE_GAP.head));
  assert.equal(tipOnly, true);
});

Deno.test("launcher green read: a listing that cannot be read, or holds no run, is unreadable (null), never red", async () => {
  const head = LIVE_GAP.head;
  const tip = LIVE_GAP.tip;
  // Rate limited or failing head listing.
  for (const status of [403, 500, 503]) {
    assert.equal(
      await withListings(
        { [head]: status, [tip]: page(liveGapWire("tip")) },
        () => surface().hasAllChecksGreen(head, tip),
      ),
      null,
      `head listing ${status}`,
    );
  }
  // No check run at all: no evidence either way.
  assert.equal(
    await withListings(
      { [head]: page([]), [tip]: page(liveGapWire("tip")) },
      () => surface().hasAllChecksGreen(head, tip),
    ),
    null,
  );
  // A green head whose base cannot be read cannot prove coverage.
  assert.equal(
    await withListings(
      { [head]: page(liveGapWire("complete")), [tip]: 503 },
      () => surface().hasAllChecksGreen(head, tip),
    ),
    null,
  );
  // A base run without a usable check suite id is a malformed listing.
  const malformed = liveGapWire("tip").map((run, index) =>
    index === 0 ? { ...run, check_suite: { id: "x" } } : run
  );
  assert.equal(
    await withListings(
      { [head]: page(liveGapWire("complete")), [tip]: page(malformed) },
      () => surface().hasAllChecksGreen(head, tip),
    ),
    null,
  );
  // A readable red head is not green (false), with no base read needed.
  const red = liveGapWire("complete").map((run, index) =>
    index === 0 ? { ...run, conclusion: "failure" } : run
  );
  const requested: string[] = [];
  assert.equal(
    await withListings(
      { [head]: page(red), [tip]: 503 },
      () => surface().hasAllChecksGreen(head, tip),
      requested,
    ),
    false,
  );
  assert.equal(
    requested.some((url) => url.includes(`/commits/${tip}/`)),
    false,
  );
});

Deno.test("launcher green read: a base workflow the head never runs is not required", async () => {
  const head = SHA3;
  const base = SHA2;
  const run = (
    id: number,
    name: string,
    sha: string,
    suite: number,
  ): Record<string, unknown> => ({
    id,
    name,
    head_sha: sha,
    status: "completed",
    conclusion: "success",
    check_suite: { id: suite },
  });
  assert.equal(
    await withListings({
      [head]: page([run(1, "validate", head, 90)]),
      [base]: page([
        run(2, "validate", base, 10),
        run(3, "dispatch", base, 20),
        run(4, "dispatch", base, 21),
      ]),
    }, () => surface().hasAllChecksGreen(head, base)),
    true,
  );
});

/** The generation-80 runtime, pinned in both launcher allowlists here. */
const R80 = "8080808080808080808080808080808080808080" as GitSha;
const CUT = T0 + 1;
const PASS_NOW = T0 + 5_000_000;
const HEAD = SHA3;
const BASE = SHA2;
const CI_RED = "CI checks failed: verify-artifact(skipped), validate(failure)";

/**
 * A CI-parked ai.ubq.fi record on its exact base: the green legacy 618 shape
 * (`rounds` 6: every ordinary round spent under R79's review-before-CI
 * order), or an ordinary one (`rounds` 1).
 */
function parked(issue: number, rounds: number): WorkRecordV1 {
  const id = `issue-ubiquity-ai.ubq.fi-${issue}`;
  return parseWorkRecordV1({
    ...blockedRecord(),
    repository: AI,
    id,
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    blocker: { kind: "other", message: CI_RED, since: T0 + 5000 },
    target: {
      base: BASE,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: HEAD,
      pr: 1000 + issue,
      candidateState: {
        preserved: {
          operationKey: `impl:${"d".repeat(64)}`,
          base: BASE,
          head: HEAD,
          ref: `refs/heads/sentinel-candidates/${"c".repeat(64)}`,
        },
        publishedHead: HEAD,
      },
    },
    counters: { attempts: rounds + 1, retries: 0, reviewRounds: rounds },
  });
}

function charges(record: WorkRecordV1) {
  return Array.from(
    { length: record.counters.reviewRounds },
    (_, index) =>
      reservation(`${record.id}-review-${index + 1}`, {
        repository: AI,
        taskId: record.id,
        attempt: index + 1,
        head: HEAD,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 10 + index,
      }),
  );
}

const RELEASE = releaseAt({
  revision: R80,
  generation: 80,
  healthy: {
    revision: R80,
    generation: 80,
    createdAt: T0 + 100,
    observedAt: T0 + 110,
  },
});

async function withR80Pinned<T>(body: () => Promise<T>): Promise<T> {
  const correction = HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES as Set<string>;
  const ciFirst = HOSTED_AUTONOMY_CI_FIRST_RUNTIMES as Set<string>;
  assert.equal(correction.has(R80) || ciFirst.has(R80), false);
  correction.add(R80);
  ciFirst.add(R80);
  try {
    return await body();
  } finally {
    correction.delete(R80);
    ciFirst.delete(R80);
  }
}

/** One REAL retry pass over `record` with `listing` as its head's runs. */
async function retryPass(
  prefix: string,
  record: WorkRecordV1,
  listing: Answer,
): Promise<{ actions: string[]; after: WorkRecordV1 }> {
  const snapshot = repairSnapshot(
    [record],
    [authorizingReceipt({
      repository: AI,
      pullRequest: { number: record.target.pr, head: HEAD, base: BASE },
    })],
    [],
    charges(record),
  );
  const { rig, github } = await makeRig(prefix, {
    repair: snapshot,
    baseTip: BASE,
    issueOpen: true,
  });
  const real = surface();
  rig.githubFor = () => ({
    ...github,
    readPull: (number: number) =>
      Promise.resolve({
        number,
        state: "open",
        merged: false,
        mergeCommitSha: null,
        headSha: HEAD,
        baseRef: "development",
        author: "ubiquity-sentinel[bot]",
      } as unknown as HostedAutonomyPullV1),
    // The REAL read, over the stubbed listing.
    hasAllChecksGreen: (head: string, base?: string) =>
      real.hasAllChecksGreen(head, base),
    // The re-run is settled: attempt 2 already failed.
    listHeadRuns: (head: string) =>
      Promise.resolve([{
        id: 618,
        headSha: head,
        status: "completed",
        conclusion: "failure",
        runAttempt: 2,
        createdAt: PASS_NOW - 60_000,
      } as HostedAutonomyHeadRunV1]),
    rerunFailedJobs: () => Promise.reject(new Error("never re-run here")),
  });
  try {
    const deps = {
      state: rig.state,
      githubFor: rig.githubFor,
      clock: { now: () => PASS_NOW },
      legacyReviewCutoff: CUT,
    } as unknown as HostedAutonomyDepsV1;
    const read = await rig.state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    const context = {
      deps,
      actions: [] as string[],
      revisions: [],
      snapshot: read.value.snapshot,
      observedHead: read.value.head,
      initialHead: read.value.head,
      releaseSnapshot: RELEASE,
      closedIssues: new Set<string>(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set<string>(),
      ...createHostedAutonomyScopes(deps),
    } as unknown as HostedAutonomyPassContextV1;
    await readHostedClosedIssues(context);
    await withListings(
      { [HEAD]: listing, [BASE]: page([]) },
      () => withR80Pinned(() => runHostedRetryPass(context, SHA1)),
    );
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    return { actions: context.actions, after: after.value.snapshot.work[0] };
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
}

const RED_LISTING = page([{
  id: 6181,
  name: "validate",
  head_sha: HEAD,
  status: "completed",
  conclusion: "failure",
  check_suite: { id: 7 },
}]);

for (
  const [label, issue, rounds] of [
    ["green legacy 618 (every ordinary round spent)", 618, 6],
    ["an ordinary CI-parked head", 1201, 1],
  ] as const
) {
  Deno.test(`retry pass: an unreadable check-run listing plans nothing for ${label}`, async () => {
    const record = parked(issue, rounds);
    const planned = `retry:${record.id}:grant=0:other:CI checks failed:`;
    // Control: a readable red listing plans the CI correction.
    const red = await retryPass(`cover-red-${issue}`, record, RED_LISTING);
    assert.ok(red.actions.includes(planned), JSON.stringify(red.actions));
    assert.equal(red.after.nextStep, "delivery");
    // Rate limited, failing or empty: nothing is planned, nothing written.
    const listings: Answer[] = [403, 503, page([])];
    for (const [index, listing] of listings.entries()) {
      const unread = await retryPass(
        `cover-unread-${issue}-${index}`,
        record,
        listing,
      );
      assert.equal(
        unread.actions.some((action) =>
          action.startsWith(`retry:${record.id}:grant`)
        ),
        false,
        `${JSON.stringify(listing)}: ${JSON.stringify(unread.actions)}`,
      );
      assert.equal(unread.after.nextStep, "blocked", "left parked");
      assert.deepEqual(unread.after.blocker, record.blocker);
      assert.deepEqual(unread.after.counters, record.counters);
    }
  });
}
