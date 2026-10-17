/**
 * The REAL retry pass under a proven CI-first runtime with a legacy cutoff
 * (generation 80 round-2 recheck P1, `ops/hosted-autonomy-ci-rerun.ts:148`):
 * a 645-shaped legacy record (live: ai.ubq.fi 645, 646, 657, 663 and 1140,
 * spent 6/6/6/5/3 rounds under R79's review-before-CI order, parked `CI checks
 * failed: verify-artifact(skipped), validate(failure)`) must reach its CI
 * correction. Every correction plan requires the head's once-per-head flake
 * re-run to be settled (`readCiRerunSettled`), so that read must count the
 * record's rounds under the same cutoff as the planner; read without it, the
 * record's open final round is invisible, nothing is settled and the record
 * stays blocked for good with no CI fix, no final review and no report.
 * The planner tests hand `ciRerunSettled` to `planHostedRetries` directly and
 * so never see this; this test runs `runHostedRetryPass` end to end.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseWorkRecordV1,
  type WorkRecordV1,
} from "../../src/contracts/work-record.ts";
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
import {
  legacyFinalRoundOpen,
  legacyReviewRoundPin,
} from "../../src/repair/review-round-cap.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import {
  authorizingReceipt,
  blockedRecord,
} from "./hosted-autonomy-fixtures.ts";
import { makeRig, repairSnapshot } from "./hosted-autonomy-rig.ts";
import { releaseAt } from "./hosted-autonomy-preservation-fixtures.ts";

const AI = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
} as const;
/** The generation-80 runtime, pinned in both launcher allowlists here. */
const R80 = "8080808080808080808080808080808080808080" as GitSha;
/** The legacy cutoff: every seeded review admission (at T0) precedes it. */
const CUT = T0 + 1;
const PASS_NOW = T0 + 5_000_000;
const HEAD = SHA3;
const BASE = SHA2;
const CI_RED = "CI checks failed: verify-artifact(skipped), validate(failure)";

/** The live 645 shape: six rounds spent under R79, red, blocked by the gate. */
function legacy645(): WorkRecordV1 {
  const id = "issue-ubiquity-ai.ubq.fi-645";
  return parseWorkRecordV1({
    ...blockedRecord(),
    repository: AI,
    id,
    source: { kind: "issue", id: "645", revision: SHA1 },
    related: { incidentId: null, issueNumber: 645 },
    blocker: { kind: "other", message: CI_RED, since: T0 + 5000 },
    target: {
      base: BASE,
      branch: `sentinel/repair/${id}`,
      checkpoint: null,
      head: HEAD,
      pr: 1009,
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
    counters: { attempts: 7, retries: 0, reviewRounds: 6 },
  });
}

function charges(record: WorkRecordV1) {
  return Array.from(
    { length: 6 },
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

/** The R79 review of the red head: completed, clean, task accepted. */
function review(record: WorkRecordV1) {
  return authorizingReceipt({
    repository: AI,
    pullRequest: { number: record.target.pr, head: HEAD, base: BASE },
  });
}

/** R80 at generation 80 with its own healthy proof. */
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

/** Pins R80 in the two production allowlists the retry pass reads. */
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

Deno.test("legacy CI correction (retry pass): a 645-shaped legacy record whose re-run settled is planned for its CI fix under the cutoff", async () => {
  const record = legacy645();
  const snapshot = repairSnapshot(
    [record],
    [review(record)],
    [],
    charges(record),
  );
  // The rule's own view: pin 6, final round open.
  assert.equal(legacyReviewRoundPin(snapshot, record, CUT), 6);
  assert.equal(legacyFinalRoundOpen(snapshot, record, CUT), true);
  const { rig, github } = await makeRig("legacy-settled-645", {
    repair: snapshot,
    baseTip: BASE,
    issueOpen: true,
  });
  const listed: string[] = [];
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
    hasAllChecksGreen: () => Promise.resolve(false),
    // The red run is already past attempt 1: nothing is left to re-run.
    listHeadRuns: (head: string) => {
      listed.push(head);
      return Promise.resolve([{
        id: 645,
        headSha: head,
        status: "completed",
        conclusion: "failure",
        runAttempt: 2,
        createdAt: PASS_NOW - 60_000,
      } as HostedAutonomyHeadRunV1]);
    },
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
    const result = await withR80Pinned(() => runHostedRetryPass(context, SHA1));
    assert.equal(result?.status, "applied", JSON.stringify(context.actions));
    assert.ok(
      context.actions.includes(
        `retry:${record.id}:grant=0:other:CI checks failed:`,
      ),
      JSON.stringify(context.actions),
    );
    assert.deepEqual(listed, [HEAD], "the re-run listing was read");
    const after = await rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    const admitted = after.value.snapshot.work[0];
    assert.equal(admitted.nextStep, "delivery");
    assert.equal(admitted.blocker, null);
    // Nothing is charged: the runtime's own CI gate charges the fix.
    assert.deepEqual(admitted.counters, record.counters);
    assert.deepEqual(
      after.value.snapshot.reservations,
      snapshot.reservations,
    );
  } finally {
    await Deno.remove(rig.tmp, { recursive: true });
  }
});
