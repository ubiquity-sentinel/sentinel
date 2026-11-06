/**
 * Widened repository cells (#328, owner decision 2026-11-05).
 *
 * A step that only re-arms a read wait of an intent-free record now settles
 * like a deferral, so the record is stamped and the next fan-out plan
 * delegates it: waiting records and review/CI result reads move from the
 * serial pass to the repository cells. Each case runs the ACTUAL serial step
 * loop and repository pass over in-memory state with fake GitHub ports and an
 * injected clock, then applies the sealed deltas through the trusted writer.
 */
import assert from "node:assert/strict";
import type { LiveInputsRequestV1 } from "../../src/contracts/live-inputs.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { RepairDeltaEnvelopeV1 } from "../../src/contracts/repair-delta.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  FANOUT_SUMMARY_LINE_KIND,
  parseFanoutSummaryLine,
} from "../../src/repair/fanout-summary-line.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { applyRepairDeltas } from "../../src/repair/repair-delta-apply.ts";
import { delegatedRecordsV1 } from "../../src/repair/repair-fanout-plan.ts";
import { runRepositoryRepairPass } from "../../src/repair/repository-pass.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import {
  BatchGithub,
  captured,
  makeRig,
  MINUTE,
  plan,
  REPOS,
  reviewing,
  type Rig,
} from "./repository-pass-rig.ts";

const [ALPHA, BETA] = REPOS;

function bare(record: WorkRecordV1): WorkRecordV1 {
  const { stepInputs: _stamp, ...rest } = record;
  return rest as WorkRecordV1;
}

/** An unstamped review whose next step reads the review result. */
function awaitingReview(index: number): WorkRecordV1 {
  return bare(reviewing(ALPHA, index));
}

/** An unstamped published head whose candidate ref read is unavailable. */
function unreadableRef(index: number): WorkRecordV1 {
  return bare(reviewing(ALPHA, index, {
    nextStep: "work",
    target: {
      base: SHA1,
      branch: `sentinel/repair/issue-alpha-${index}`,
      checkpoint: null,
      head: SHA2,
      pr: 7,
    },
  }));
}

function row(rig: Rig, id: string): WorkRecordV1 {
  const found = rig.state.repair!.work.find((record) => record.id === id);
  assert.ok(found !== undefined, id);
  return found;
}

function serialPass(rig: Rig, excludeRecords?: ReadonlySet<string>) {
  return captured(() =>
    runRepairCycle(rig.deps, {
      deadline: rig.clock.now() + 90 * MINUTE,
      stepLimit: 1_000,
      modelStartsEnabled: true,
      ...(excludeRecords === undefined ? {} : { excludeRecords }),
    })
  );
}

/** Plan, run every cell, and apply the deltas in one trusted write. */
async function fanOutAndApply(rig: Rig) {
  const { plan: fanout, binding } = await plan(rig);
  const { value: results } = await captured(() =>
    Promise.all(fanout.cells.map((cell) =>
      runRepositoryRepairPass(rig.deps, {
        repository: cell.repository,
        binding,
        records: cell.records,
        deadline: rig.clock.now() + 90 * MINUTE,
        stepLimit: 1_000,
        modelStartsEnabled: true,
      })
    ))
  );
  const envelopes = results.map((result) => {
    assert.equal(result.status, "sealed", JSON.stringify(result));
    return (result as { envelope: RepairDeltaEnvelopeV1 }).envelope;
  });
  const writes = rig.state.repairWrites;
  const { value: applied, lines } = await captured(() =>
    applyRepairDeltas(rig.deps, {
      plan: fanout,
      artifacts: envelopes.map((envelope) => ({
        cellId: fanout.cells.find((cell) =>
          cell.repository.name === envelope.delta.repository.name
        )!.cellId,
        envelope: structuredClone(envelope),
      })),
      deadline: rig.clock.now() + 10 * MINUTE,
    })
  );
  const summary = lines.find((line) => line.kind === FANOUT_SUMMARY_LINE_KIND);
  return {
    fanout,
    envelopes,
    applied,
    writes: rig.state.repairWrites - writes,
    summary: parseFanoutSummaryLine(summary),
  };
}

Deno.test("widening: a review-result read that only re-arms its wait is stamped, delegated, kept by the cell and applied", async () => {
  const rig = makeRig([awaitingReview(1)]);
  await serialPass(rig);
  const observed = row(rig, "issue-alpha-1");
  assert.equal(observed.wait?.reason, "review_pending");
  // Before the widening this progress step left the record unstamped, so no
  // plan ever delegated it.
  assert.ok(observed.stepInputs !== undefined, "observation is stamped");
  assert.equal(observed.stepInputs.deadline, observed.wait?.until);

  rig.clock.advance(16 * MINUTE);
  const result = await fanOutAndApply(rig);
  assert.deepEqual([...delegatedRecordsV1(result.fanout)], ["issue-alpha-1"]);
  const delta = result.envelopes[0].delta;
  assert.deepEqual(delta.deferredToTrusted, []);
  assert.deepEqual(rig.github.effects(), [], "no GitHub write");
  assert.equal(delta.transitions.length, 1);
  const after = delta.transitions[0].after;
  assert.equal(after.nextStep, "review");
  assert.equal(after.blocker, null);
  assert.equal(after.intent, null);
  assert.equal(after.wait?.reason, "review_pending");
  assert.ok((after.wait?.until ?? 0) > rig.clock.now());
  // Only the no-progress counter may move; nothing is charged.
  const { stalled: _after, ...charged } = after.counters;
  const { stalled: _before, ...prior } = observed.counters;
  assert.deepEqual(charged, prior, "nothing charged");
  assert.deepEqual(
    delta.steps?.map((step) => [step.record, step.kind, step.disposition]),
    [["issue-alpha-1", "review:review_pending", "kept"]],
  );
  assert.equal(result.applied.status, "applied");
  assert.equal(result.writes, 1);
  assert.deepEqual(row(rig, "issue-alpha-1"), after);
  assert.ok(result.summary !== null);
  assert.equal(result.summary.recordsDelegated, 1);
  assert.equal(result.summary.recordsSerialOwned, 0);
  assert.equal(result.summary.stepKinds["review:review_pending"].kept, 1);
});

Deno.test("widening: a read that re-arms an unavailable wait is delegated and kept", async () => {
  const rig = makeRig([unreadableRef(2)]);
  await serialPass(rig);
  const observed = row(rig, "issue-alpha-2");
  assert.equal(observed.wait?.reason, "unavailable");
  assert.ok(observed.stepInputs !== undefined, "observation is stamped");

  rig.clock.advance(3 * MINUTE);
  const result = await fanOutAndApply(rig);
  const delta = result.envelopes[0].delta;
  assert.deepEqual(delta.deferredToTrusted, []);
  assert.deepEqual(rig.github.effects(), []);
  const after = delta.transitions[0].after;
  assert.equal(after.wait?.reason, "unavailable");
  assert.equal(after.nextStep, "work");
  assert.equal(after.blocker, null);
  assert.deepEqual(after.counters.attempts, observed.counters.attempts);
  assert.deepEqual(
    delta.steps?.map((step) => [step.kind, step.disposition]),
    [["work:unavailable", "kept"]],
  );
  assert.equal(result.applied.status, "applied");
  assert.deepEqual(row(rig, "issue-alpha-2"), after);
});

Deno.test("widening: a cell evaluates a running wait's deadline without stepping or writing it", async () => {
  const now = makeRig([]).clock.now();
  const waiting = reviewing(ALPHA, 3, {
    wait: { reason: "backoff", since: now - MINUTE, until: now + 10 * MINUTE },
  });
  const rig = makeRig([waiting]);
  const result = await fanOutAndApply(rig);
  assert.deepEqual([...delegatedRecordsV1(result.fanout)], ["issue-alpha-3"]);
  const delta = result.envelopes[0].delta;
  assert.deepEqual(delta.transitions, []);
  assert.deepEqual(delta.deferredToTrusted, []);
  assert.deepEqual(delta.steps, []);
  assert.equal(result.applied.status, "none");
  assert.equal(result.writes, 0);
  assert.deepEqual(row(rig, "issue-alpha-3"), waiting);
});

Deno.test("widening: a delegated read whose result needs a write is dropped and handed back to the serial path", async () => {
  const rig = makeRig([awaitingReview(4)]);
  await serialPass(rig);
  assert.ok(row(rig, "issue-alpha-4").stepInputs !== undefined);
  // The task-bound review result arrives: recording its verdict writes a
  // review receipt, which no delta may carry.
  rig.github.releasedHead = SHA2;
  rig.github.lastReviewTask = {
    issueNumber: 104,
    title: "issue 104",
    body: "",
    digest: await reviewTaskStatementDigest({
      issueNumber: 104,
      title: "issue 104",
      body: "",
    }),
  };
  rig.github.completeReview();
  rig.clock.advance(16 * MINUTE);
  const before = row(rig, "issue-alpha-4");
  const result = await fanOutAndApply(rig);
  const delta = result.envelopes[0].delta;
  assert.deepEqual(delta.deferredToTrusted, ["issue-alpha-4"]);
  assert.deepEqual(rig.github.effects(), []);
  assert.deepEqual(
    delta.steps?.map((step) => [step.kind, step.disposition]),
    [["review:review_pending", "deferred"]],
  );
  assert.equal(rig.state.repair!.reviews.length, 0, "no receipt by a cell");
  assert.deepEqual(row(rig, "issue-alpha-4"), bare(before), "stamp dropped");
  assert.equal(result.summary?.stepKinds["review:review_pending"].deferred, 1);
  // The next plan leaves it with the trusted serial pass, which records it.
  const next = await plan(rig);
  assert.equal(delegatedRecordsV1(next.plan).has("issue-alpha-4"), false);
  await serialPass(rig, delegatedRecordsV1(next.plan));
  assert.ok(rig.state.repair!.reviews.length > 0, "serial recorded receipt");
  assert.notDeepEqual(row(rig, "issue-alpha-4").wait, before.wait);
});

class CountingGithub extends BatchGithub {
  readonly requests: LiveInputsRequestV1[] = [];

  override readLiveInputs(request: LiveInputsRequestV1) {
    this.requests.push(structuredClone(request));
    return super.readLiveInputs(request);
  }
}

Deno.test("widening: the serial pass reads no batch for a fully delegated repository and only owned records otherwise", async () => {
  // Alpha: two delegated reviews and one serial-owned review (no stamp).
  // Beta: only delegated reviews.
  const rig = makeRig([
    reviewing(ALPHA, 10),
    reviewing(ALPHA, 11),
    awaitingReview(12),
    reviewing(BETA, 20),
    reviewing(BETA, 21),
  ]);
  const github = new CountingGithub({ baseSha: SHA1, openIssues: [] });
  rig.deps.github = github;
  const { plan: fanout } = await plan(rig);
  const delegated = delegatedRecordsV1(fanout);
  assert.deepEqual(
    [...delegated].sort(),
    ["issue-alpha-10", "issue-alpha-11", "issue-beta-20", "issue-beta-21"],
  );
  await serialPass(rig, delegated);
  assert.deepEqual(
    github.requests.map((request) => request.repository.name),
    ["alpha"],
    "no batch for the fully delegated repository",
  );
  assert.deepEqual(github.requests[0].issues, [112]);
  for (const id of delegated) {
    assert.deepEqual(
      row(rig, id),
      [
        reviewing(ALPHA, 10),
        reviewing(ALPHA, 11),
        reviewing(BETA, 20),
        reviewing(BETA, 21),
      ]
        .find((record) => record.id === id),
      "delegated rows untouched",
    );
  }
});
