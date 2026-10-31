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
import { ATTEMPT_DETAIL_NO_CHANGE } from "../../src/repair/attempt-policy.ts";
import {
  baseReviewOrigin,
  holdNoChange,
} from "../../src/repair/base-satisfaction-marker.ts";
import type { BaseTaskReviewGitHubV1 } from "../../src/repair/loop-base-satisfaction.ts";
import { implementationIntent } from "../../src/repair/loop-implementation.ts";
import { SHA1, SHA2, T0, workRecord } from "../state/helpers.ts";
import { r80Available, withR80Parsers } from "../host/r80-contracts.ts";
import {
  issueRecord,
  makeMemoryRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";

const ORIGIN = "a".repeat(64);
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
      assert.equal(current.wait?.until, null);
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
  assert.equal(ready.work[0].wait?.until, null);
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
  assert.equal((await f.rig.snapshot()).work[0].wait?.until, null);
  assert.equal(
    f.counts().runs,
    0,
    "first transition records the R80-inert hold",
  );
  await f.rig.run();
  assert.equal(f.counts().runs, 1);
});
