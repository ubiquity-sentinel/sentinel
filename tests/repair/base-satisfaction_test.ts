/** Real coordinator/budget restart lifecycle with fake native and GitHub boundaries. */
import assert from "node:assert/strict";
import { canonicalStringifySha256 } from "../../src/contracts/canonical.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  baseReviewEvidenceRef,
  type BaseTaskReviewPortV1,
} from "../../src/github/base-review-evidence.ts";
import type { ReviewResultV1 } from "../../src/github/review-result-contracts.ts";
import {
  ATTEMPT_DETAIL_NO_CHANGE,
  attemptMemorySettlementMutationV1,
} from "../../src/repair/attempt-policy.ts";
import {
  BASE_REVIEW_HOLD_MS,
  baseReviewOrigin,
  holdNoChange,
  MAX_NO_CHANGE_BASE_REVIEWS,
} from "../../src/repair/base-satisfaction-marker.ts";
import {
  BASE_REVIEW_HOLD_EXPIRED,
  BASE_REVIEW_NOT_ESTABLISHED,
  BASE_REVIEW_WORK_NEEDED_PARK,
  type BaseTaskReviewGitHubV1,
} from "../../src/repair/loop-base-satisfaction.ts";
import { implementationIntent } from "../../src/repair/loop-implementation.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { isWaiting, rankEligibleWork } from "../../src/repair/selection.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { baseReviewCommentBody } from "../../src/github/base-review-comments.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy-retries.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  hostedIssueKey,
} from "../../ops/hosted-autonomy-policy.ts";
import { readBaseReviewWorkNeeded } from "../../ops/hosted-autonomy-base-review-verdicts.ts";
import { r80Available, withR80Parsers } from "../host/r80-contracts.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";

const ORIGIN = "a".repeat(64);
const HOLD_UNTIL = T0 + BASE_REVIEW_HOLD_MS;
const ignoreR80 = !await r80Available();

async function fixture() {
  const github = new RelationsFakeGithub({ baseSha: SHA2 });
  const rig = makeMemoryRig(github);
  const issue = issueRecord(1141, {
    title: "Task already implemented",
    body: "Verify exact base behavior",
    relations: { openBlockers: [], subIssueCount: 0 },
  });
  github.latest.set(issue.number, issue);
  const task = {
    issueNumber: issue.number,
    title: issue.title,
    body: issue.body,
    digest: await reviewTaskStatementDigest({
      issueNumber: issue.number,
      title: issue.title,
      body: issue.body,
    }),
  };
  let record = workRecord("issue-1141", {
    source: { kind: "issue", id: "1141", revision: SHA2 },
    related: { issueNumber: 1141, incidentId: null },
    target: {
      base: SHA2,
      head: null,
      pr: null,
      branch: null,
      checkpoint: null,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    nextStep: "work",
    intent: null,
  });
  record = holdNoChange({
    ...record,
    intent: implementationIntent(ORIGIN, record, T0),
  }, T0);
  const original: BudgetReservationV1 = {
    version: "v1",
    kind: "budget_reservation",
    id: ORIGIN,
    taskId: record.id,
    repository: record.repository,
    head: SHA2,
    attempt: 1,
    purpose: "implementation",
    outcome: "ambiguous",
    createdAt: T0,
    settledAt: T0,
    proofRef: null,
  };
  await rig.state.writeRepair(
    seededSnapshot([record], { reservations: [original] }),
    null,
  );
  let runs = 0;
  let closes = 0;
  let inspectBlocked = false;
  let ambiguous = false;
  let changed = false;
  const admissions: string[] = [];
  const result: ReviewResultV1 = {
    verdict: "clean",
    summary: "Task already holds at base",
    findings: [],
    taskAcceptance: {
      issueNumber: 1141,
      taskDigest: task.digest,
      verdict: "already_satisfied_at_base",
      evidence: ["The exact base implements the task."],
    },
  };
  const port: BaseTaskReviewPortV1 = {
    inspect: () =>
      Promise.resolve(
        inspectBlocked ? portError("unavailable", "CI pending") : portOk(task),
      ),
    run: async (input) => {
      runs++;
      admissions.push(input.admission);
      const state = await rig.snapshot();
      const current = state.work[0];
      assert.deepEqual(
        current,
        input.record,
        "native call follows durable exact intent",
      );
      assert.equal(current.intent?.kind, "issue_closure");
      // A further round keeps the hold's original bound.
      assert.equal(current.wait?.until, HOLD_UNTIL);
      assert.equal(
        state.reservations.find((row) => row.id === input.admission)?.outcome,
        "reserved",
      );
      assert.equal(
        state.reservations.find((row) => row.id === ORIGIN)?.outcome,
        "ambiguous",
      );
      assert.equal(current.intent?.pr, null);
      if (ambiguous) return portError("unavailable", "native owner lost");
      return portOk({
        result,
        ref: baseReviewEvidenceRef({
          issueNumber: 1141,
          base: input.record.target.base,
          taskDigest: task.digest,
          admission: input.admission,
          resultComment: runs * 2,
          resultDigest: await canonicalStringifySha256(result),
          executionComment: runs * 2 + 1,
          executionDigest: "b".repeat(64),
        }),
      });
    },
    close: () => {
      closes++;
      return Promise.resolve(
        changed ? portError("conflict", "base moved") : portOk("closed"),
      );
    },
  };
  (github as BaseTaskReviewGitHubV1).baseTaskReview = port;
  return {
    rig,
    port,
    record,
    original,
    task,
    result,
    counts: () => ({ runs, closes, admissions }),
    setBlocked: (value: boolean) => inspectBlocked = value,
    setAmbiguous: (value: boolean) => ambiguous = value,
    setChanged: (value: boolean) => changed = value,
  };
}

Deno.test("base satisfaction: charged no-change reviews exact base then closes only its issue on a later pass", async () => {
  const f = await fixture();
  assert.notEqual((await f.rig.run()).status, "state_error");
  const ready = await f.rig.snapshot();
  assert.equal(f.counts().runs, 1);
  assert.equal(f.counts().closes, 0);
  assert.equal(ready.work[0].nextStep, "work");
  assert.equal(ready.work[0].wait?.until, HOLD_UNTIL);
  assert.ok(ready.work[0].intent?.resultId);
  assert.deepEqual(ready.reservations.map((row) => row.outcome).sort(), [
    "ambiguous",
    "submitted",
  ]);
  f.rig.clock.advance(24 * 60 * 60_000);
  await f.rig.run();
  const done = await f.rig.snapshot();
  assert.equal(done.work[0].nextStep, "done");
  assert.equal(done.work[0].target.head, null);
  assert.equal(done.work[0].target.pr, null);
  assert.equal(done.reviews.length, 0, "no fabricated PR receipt");
  assert.equal(done.releaseRequests.length, 0, "no invented repair release");
  assert.deepEqual(f.counts(), {
    runs: 1,
    closes: 1,
    admissions: f.counts().admissions,
  });
  assert.equal(f.rig.model.requests.length, 0);
  assert.equal(f.rig.github.pushes.length, 0);
  if (!ignoreR80) {
    await withR80Parsers((r80) => {
      r80.parseRepairStateSnapshotV1(ready);
      r80.parseRepairStateSnapshotV1(done);
    });
  }
});

Deno.test("base satisfaction: unavailable native outcomes remain charged across restarts and never park a spent round count", async () => {
  const f = await fixture();
  f.setAmbiguous(true);
  for (let attempt = 0; attempt < 4; attempt++) {
    await f.rig.run();
    f.rig.clock.advance(60 * 60_000);
  }
  const state = await f.rig.snapshot();
  // Rounds are accounting (owner directive 2026-10-30): the fourth pass buys
  // a fourth review instead of parking at a three-round ceiling.
  assert.equal(f.counts().runs, 4);
  assert.equal(new Set(f.counts().admissions).size, 4);
  assert.equal(state.work[0].counters.reviewRounds, 4);
  assert.equal(state.work[0].nextStep, "work");
  assert.equal(state.work[0].blocker, null);
  assert.equal(state.reservations.length, 5);
  assert.ok(state.reservations.every((row) => row.outcome === "ambiguous"));
  assert.equal(f.counts().closes, 0);
});

Deno.test("base satisfaction: CI precedes admission and stale closure proof spends a fresh distinct round", async () => {
  const f = await fixture();
  f.setBlocked(true);
  const before = await f.rig.snapshot();
  await f.rig.run();
  assert.deepEqual((await f.rig.snapshot()).reservations, before.reservations);
  assert.equal(f.counts().runs, 0);
  f.setBlocked(false);
  await f.rig.run();
  f.setChanged(true);
  await f.rig.run();
  const retried = await f.rig.snapshot();
  assert.equal(f.counts().runs, 2);
  assert.equal(f.counts().closes, 1);
  assert.equal(retried.work[0].nextStep, "work");
  assert.equal(retried.reservations.length, 3);
  assert.equal(new Set(f.counts().admissions).size, 2);
});

Deno.test("base satisfaction: a crash with reserved review intent charges it without re-invoking the old native session", async () => {
  const f = await fixture();
  await f.rig.run();
  const current = await f.rig.snapshot();
  const admission = current.work[0].intent!.requestId;
  const record: WorkRecordV1 = {
    ...current.work[0],
    intent: { ...current.work[0].intent!, resultId: null },
    evidence: [],
  };
  const replay = {
    ...current,
    stateHead: f.rig.state.repairHead,
    sequence: current.sequence + 1,
    work: [record],
    reservations: current.reservations.map((row) =>
      row.id === admission
        ? { ...row, outcome: "reserved" as const, settledAt: null }
        : row
    ),
  };
  await f.rig.state.writeRepair(replay, f.rig.state.repairHead);
  await f.rig.run();
  assert.equal(f.counts().runs, 1);
  assert.equal(
    (await f.rig.snapshot()).reservations.find((row) => row.id === admission)
      ?.outcome,
    "ambiguous",
  );
  await f.rig.run();
  assert.equal(f.counts().runs, 2);
  assert.equal(new Set(f.counts().admissions).size, 2);
});

Deno.test("base satisfaction: historical exact repeat-failure park enters the held path, generic unavailable does not", async () => {
  const f = await fixture();
  const state = await f.rig.snapshot();
  const blocked: WorkRecordV1 = {
    ...f.record,
    nextStep: "blocked",
    wait: null,
    intent: { ...f.record.intent!, failure: undefined },
    blocker: {
      kind: "other",
      since: T0,
      message:
        `repeated identical failure; owner action required (close or edit the issue, or change the model route): 52x other|0123456789abcdef issue=123456789abc route=abcdef012345: ${ATTEMPT_DETAIL_NO_CHANGE}`,
    },
  };
  delete blocked.intent!.failure;
  assert.equal(baseReviewOrigin(blocked, state), ORIGIN);
  // A park that also records its prompt digest is the same exact wrapper.
  assert.equal(
    baseReviewOrigin({
      ...blocked,
      blocker: {
        ...blocked.blocker!,
        message: blocked.blocker!.message.replace(
          "route=abcdef012345: ",
          "route=abcdef012345 prompt=0123456789ab: ",
        ),
      },
    }, state),
    ORIGIN,
  );
  assert.equal(
    baseReviewOrigin({
      ...blocked,
      blocker: {
        ...blocked.blocker!,
        message: "model run failed (unavailable)",
      },
    }, state),
    null,
  );
  assert.equal(
    baseReviewOrigin(
      { ...blocked, target: { ...blocked.target, head: SHA1 } },
      state,
    ),
    null,
  );
  await f.rig.state.writeRepair({
    ...state,
    stateHead: f.rig.state.repairHead,
    sequence: state.sequence + 1,
    work: [blocked],
  }, f.rig.state.repairHead);
  await f.rig.run();
  assert.equal((await f.rig.snapshot()).work[0].wait?.until, HOLD_UNTIL);
  assert.equal(
    f.counts().runs,
    0,
    "first transition records the R80-inert hold",
  );
  await f.rig.run();
  assert.equal(f.counts().runs, 1);
});

/** The live held shape: candidate branch on target and intent, open-ended. */
async function legacyHold(f: Awaited<ReturnType<typeof fixture>>) {
  const state = await f.rig.snapshot();
  const branch = candidateBranch(f.record.id);
  const legacy: WorkRecordV1 = {
    ...f.record,
    target: { ...f.record.target, branch },
    wait: { ...f.record.wait!, until: null },
    intent: { ...f.record.intent!, branch },
  };
  await f.rig.state.writeRepair({
    ...state,
    stateHead: f.rig.state.repairHead,
    sequence: state.sequence + 1,
    work: [legacy],
  }, f.rig.state.repairHead);
  return legacy;
}

Deno.test("base satisfaction: a legacy open-ended hold gets a bounded window, then its review; ranking never steps it", async () => {
  const f = await fixture();
  const legacy = await legacyHold(f);
  assert.equal(baseReviewOrigin(legacy, await f.rig.snapshot()), ORIGIN);
  f.setBlocked(true);
  f.rig.clock.advance(60_000);
  await f.rig.run();
  const bounded = await f.rig.snapshot();
  assert.deepEqual(bounded.work[0].wait, {
    ...legacy.wait!,
    until: T0 + 60_000 + BASE_REVIEW_HOLD_MS,
  });
  assert.equal(bounded.work[0].intent?.requestId, ORIGIN);
  assert.deepEqual(bounded.reservations, [f.original]);
  // Expired or not, ranking leaves the hold to the base review.
  const late = T0 + 10 * BASE_REVIEW_HOLD_MS;
  assert.equal(isWaiting(bounded.work[0], late), true);
  assert.equal(
    rankEligibleWork(bounded, f.rig.configs, late).skipped[legacy.id],
    "waiting",
  );
  await f.rig.run();
  assert.equal(f.counts().runs, 0, "CI still pending: deferred, uncharged");
  f.setBlocked(false);
  await f.rig.run();
  assert.equal(f.counts().runs, 1);
  assert.equal(f.rig.model.requests.length, 0);
});

Deno.test("base satisfaction: a hold whose review keeps deferring parks at its bound with every charge kept", async () => {
  const f = await fixture();
  f.setBlocked(true);
  f.rig.clock.advance(BASE_REVIEW_HOLD_MS - 1);
  await f.rig.run();
  const held = await f.rig.snapshot();
  assert.equal(held.work[0].nextStep, "work");
  assert.deepEqual(held.work[0].wait, f.record.wait);
  f.rig.clock.advance(1);
  await f.rig.run();
  const parked = await f.rig.snapshot();
  assert.equal(parked.work[0].nextStep, "blocked");
  assert.deepEqual(parked.work[0].blocker, {
    kind: "missing_evidence",
    message: BASE_REVIEW_HOLD_EXPIRED,
    since: HOLD_UNTIL,
  });
  // The ambiguous implementation charge is kept, never refunded or reused.
  assert.deepEqual(parked.reservations, [f.original]);
  assert.equal(parked.work[0].intent?.requestId, ORIGIN);
  assert.equal(baseReviewOrigin(parked.work[0], parked), null);
  assert.equal(f.counts().runs, 0);
  assert.equal(f.rig.model.requests.length, 0);
});

/** `count` durable no-change outcomes of the held task (attempt memory). */
async function noChangeHistory(
  f: Awaited<ReturnType<typeof fixture>>,
  count: number,
) {
  const state = await f.rig.snapshot();
  const draft = structuredClone(state);
  for (let index = 0; index < count; index++) {
    (await attemptMemorySettlementMutationV1({
      record: draft.work[0],
      detail: ATTEMPT_DETAIL_NO_CHANGE,
      now: T0 + index,
      runtimeSha: SHA1,
    }))(draft);
  }
  await f.rig.state.writeRepair({
    ...draft,
    stateHead: f.rig.state.repairHead,
    sequence: state.sequence + 1,
  }, f.rig.state.repairHead);
}

Deno.test("base satisfaction: a review finding work still needed returns the task to implementation with its receipt", async () => {
  for (const verdict of ["not_fulfilled", "uncertain"] as const) {
    const f = await fixture();
    f.result.taskAcceptance = { ...f.result.taskAcceptance!, verdict };
    await noChangeHistory(f, 1);
    // One step: the review itself; the implementation start is not run here.
    await f.rig.run(1);
    const state = await f.rig.snapshot();
    const record = state.work[0];
    assert.equal(f.counts().runs, 1, verdict);
    assert.equal(record.nextStep, "work");
    assert.equal(record.wait, null);
    assert.equal(record.blocker, null);
    assert.equal(record.intent, null);
    assert.equal(record.target.base, SHA2);
    assert.equal(record.counters.reviewRounds, 1);
    assert.ok(
      record.evidence.some((row) =>
        row.kind === "review_receipt" &&
        row.ref.startsWith("artifact:base-review/")
      ),
    );
    // Both charges stay as settled: nothing is refunded or reused.
    assert.deepEqual(state.reservations.map((row) => row.outcome).sort(), [
      "ambiguous",
      "submitted",
    ]);
    assert.equal(baseReviewOrigin(record, state), null);
    assert.ok(
      rankEligibleWork(state, f.rig.configs, f.rig.clock.now()).ordered
        .includes(record.id),
    );
    assert.equal(f.rig.model.requests.length, 0);
  }
  // A review that says nothing about the work keeps the existing park.
  const f = await fixture();
  f.result.verdict = "unavailable";
  f.result.taskAcceptance = null;
  await f.rig.run();
  const parked = (await f.rig.snapshot()).work[0];
  assert.equal(parked.nextStep, "blocked");
  assert.equal(parked.blocker?.message, BASE_REVIEW_NOT_ESTABLISHED);
});

Deno.test("base satisfaction: work-needed round trips park after the bounded no-change outcomes", async () => {
  const f = await fixture();
  f.result.taskAcceptance = {
    ...f.result.taskAcceptance!,
    verdict: "not_fulfilled",
  };
  await noChangeHistory(f, MAX_NO_CHANGE_BASE_REVIEWS);
  await f.rig.run();
  const state = await f.rig.snapshot();
  const record = state.work[0];
  assert.equal(f.counts().runs, 1);
  assert.equal(record.nextStep, "blocked");
  assert.equal(
    record.blocker?.message,
    `${BASE_REVIEW_WORK_NEEDED_PARK} ${MAX_NO_CHANGE_BASE_REVIEWS}`,
  );
  assert.ok(
    record.evidence.some((row) => row.ref.startsWith("artifact:base-review/")),
  );
  assert.deepEqual(state.reservations.map((row) => row.outcome).sort(), [
    "ambiguous",
    "submitted",
  ]);
  assert.equal(f.rig.model.requests.length, 0);
});

/**
 * The park the runtime wrote for this exact completed review before work-needed
 * reviews returned to implementation: its bounded park keeps the same intent,
 * evidence and charges; only the message was the not-established one.
 */
async function historicalPark(result: Partial<ReviewResultV1>) {
  const g = await fixture();
  Object.assign(g.result, result);
  await noChangeHistory(g, MAX_NO_CHANGE_BASE_REVIEWS);
  await g.rig.run(1);
  const parked = (await g.rig.snapshot()).work[0];
  assert.equal(parked.nextStep, "blocked");
  assert.ok(parked.intent?.resultId, "the park retains its result binding");
  return {
    ...parked,
    blocker: { ...parked.blocker!, message: BASE_REVIEW_NOT_ESTABLISHED },
  };
}

/** The repository surface serving the review's result comment. */
function commentSurface(
  payload: ReviewResultV1,
  author = HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
) {
  const reads: number[] = [];
  return {
    reads,
    scopeFor: () =>
      Promise.resolve({
        surface: {
          readIssueComment: (_issue: number, id: number) => {
            reads.push(id);
            return Promise.resolve({
              id,
              author,
              body: baseReviewCommentBody(payload),
            });
          },
        },
      }),
  };
}

function notFulfilled(result: ReviewResultV1): Partial<ReviewResultV1> {
  return {
    taskAcceptance: { ...result.taskAcceptance!, verdict: "not_fulfilled" },
  };
}

Deno.test("base satisfaction: a historical park of a work-needed review re-arms once into the runtime's own return", async () => {
  const f = await fixture();
  Object.assign(f.result, notFulfilled(f.result));
  await noChangeHistory(f, 1);
  await f.rig.run(1);
  const state = await f.rig.snapshot();
  const returned = state.work[0];
  assert.equal(returned.nextStep, "work");
  const parked = await historicalPark(notFulfilled(f.result));
  const historical = { ...state, work: [parked] };
  const surface = commentSurface(f.result);
  const verified = await readBaseReviewWorkNeeded(
    historical,
    new Set(),
    surface.scopeFor,
  );
  assert.equal(verified.size, 1);
  // Only the result comment the evidence names is read.
  assert.deepEqual(surface.reads, [2]);
  const now = f.rig.clock.now();
  const plans = planHostedRetries(
    historical,
    now,
    SHA1,
    new Map(),
    new Set(),
    undefined,
    { baseReviewWorkNeeded: verified },
  );
  assert.equal(plans.length, 1);
  const rearmed = applyHostedRetries(historical, SHA1, plans, now);
  // Exactly the record the runtime now writes for that review.
  assert.deepEqual(
    { ...rearmed.work[0], updatedAt: 0 },
    { ...returned, updatedAt: 0 },
  );
  // Every charge stays as settled: nothing is refunded, reused or added.
  assert.deepEqual(rearmed.reservations, state.reservations);
  assert.equal(baseReviewOrigin(rearmed.work[0], rearmed), null);
  assert.ok(
    rankEligibleWork(rearmed, f.rig.configs, now).ordered.includes(parked.id),
  );
  assert.equal(f.rig.model.requests.length, 0);
});

Deno.test("base satisfaction: a historical not-established park stays parked unless its comment proves work is needed", async () => {
  const f = await fixture();
  Object.assign(f.result, notFulfilled(f.result));
  await noChangeHistory(f, 1);
  // The review's charges, as both runtimes settled them.
  await f.rig.run(1);
  const state = await f.rig.snapshot();
  const workNeeded = await historicalPark(notFulfilled(f.result));
  const rearms = async (
    parked: WorkRecordV1,
    surface: ReturnType<typeof commentSurface>,
    closed = new Set<string>(),
  ) => {
    const historical = { ...state, work: [parked] };
    const verified = await readBaseReviewWorkNeeded(
      historical,
      closed,
      surface.scopeFor,
    );
    return planHostedRetries(
      historical,
      f.rig.clock.now(),
      SHA1,
      new Map(),
      closed,
      undefined,
      { baseReviewWorkNeeded: verified },
    ).length;
  };
  assert.equal(await rearms(workNeeded, commentSurface(f.result)), 1);
  // A comment by another author, or whose result does not hash to the stored
  // digest (here an "already satisfied" answer), proves nothing.
  assert.equal(
    await rearms(workNeeded, commentSurface(f.result, "someone[bot]")),
    0,
  );
  const satisfied: ReviewResultV1 = {
    ...f.result,
    taskAcceptance: {
      ...f.result.taskAcceptance!,
      verdict: "already_satisfied_at_base",
    },
  };
  assert.equal(await rearms(workNeeded, commentSurface(satisfied)), 0);
  // A closed issue is never read.
  const closed = commentSurface(f.result);
  assert.equal(
    await rearms(
      workNeeded,
      closed,
      new Set([hostedIssueKey(workNeeded.repository, 1141)]),
    ),
    0,
  );
  assert.deepEqual(closed.reads, []);
  // A real not-established park (the review gave no task verdict) keeps it:
  // its comment hashes to its digest but answers no work needed.
  const g = await fixture();
  g.result.verdict = "unavailable";
  g.result.taskAcceptance = null;
  await g.rig.run(1);
  const unavailable = (await g.rig.snapshot()).work[0];
  assert.equal(unavailable.blocker?.message, BASE_REVIEW_NOT_ESTABLISHED);
  assert.equal(await rearms(unavailable, commentSurface(g.result)), 0);
});
