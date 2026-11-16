/**
 * The runtime's own write of a self merge, read back by finalize and the
 * progress commenter. A merged outcome carrying the executor's receipt is
 * persisted by the real repair loop (temporary Git state, fake GitHub): the
 * receipt lands on `target.selfMerge` in the same write as the release
 * request for its merge revision, created at the merge. Finalize counts that
 * merge in its own cycle only, and the progress commenter says it was merged
 * exactly once.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { progressChanges } from "../../src/host/progress-comments.ts";
import { collectFinalizeMetricsV1 } from "../../src/host/throughput-metrics-finalize.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import { selfMergeReceipt } from "../host/self-merge-receipt-fixture.ts";
import { SHA1, SHA2, SHA3 } from "../state/helpers.ts";
import { exactOpenPr } from "./loop-candidate-fixtures.ts";
import { LOCAL_SENTINEL_REPO, makeRig, seededSnapshot } from "./loop-rig.ts";
import { completedReceipt, deliveryRecord } from "./loop-review-fixtures.ts";

const BRANCH = "sentinel/repair/issue-1";

/** The merge count finalize records for a cycle spanning `[from, to]`. */
function mergesIn(
  repair: RepairStateSnapshotV1,
  from: number,
  to: number,
): number | null {
  return collectFinalizeMetricsV1({
    cycle: { runId: 1, attempt: 1 },
    finalizeStartedAtMs: to,
    nowMs: to,
    jobs: [{
      name: "maintenance",
      conclusion: "success",
      summary: null,
      startedAtMs: from,
      completedAtMs: from,
    }],
    runSummary: null,
    repair,
  }).counts.mergesCompleted;
}

async function selfMerged() {
  const receipt = selfMergeReceipt(7, "merged", {
    taskId: "issue-1",
    issueNumber: 1,
    headRef: BRANCH,
    head: SHA3,
    base: SHA1,
    merge: SHA2,
  });
  const rig = await makeRig("self-merge-readers", {
    summaries: false,
    localScope: true,
    github: {
      mergeOutcome: {
        outcome: "merged",
        head: SHA3,
        mergeSha: SHA2,
        selfMerge: receipt,
      },
      candidateLifecycle: {
        refs: { [`refs/heads/${BRANCH}`]: SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, BRANCH)],
      },
    },
  });
  try {
    const record = deliveryRecord(SHA3, { repository: LOCAL_SENTINEL_REPO });
    const review = completedReceipt(7, SHA3, SHA1, {
      repository: LOCAL_SENTINEL_REPO,
      id: await reviewReceiptId(reviewOperationKey(7, SHA3, 1), SHA3),
    });
    const written = await rig.store.writeRepair(
      seededSnapshot([record], { reviews: [review] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");
    let merged = false;
    const merge = rig.github.mergePullRequest.bind(rig.github);
    rig.github.mergePullRequest = async (request) => {
      const result = await merge(request);
      merged = true;
      return result;
    };
    const readRef = rig.github.readRef.bind(rig.github);
    rig.github.readRef = (ref) =>
      merged && ref === "refs/heads/development"
        ? Promise.resolve(portOk({ ref, sha: SHA2 }))
        : readRef(ref);
    const cycleStart = rig.clock.now();
    rig.clock.advance(2000);
    const mergedAt = rig.clock.now();
    const result = await rig.entry();
    assert.equal(result.status, "idle", JSON.stringify(result));
    return { rig, record, receipt, cycleStart, mergedAt };
  } catch (error) {
    await rig.ctx.cleanup();
    throw error;
  }
}

Deno.test("self merge delivery: the runtime's merge write is counted once by finalize", async () => {
  const { rig, receipt, cycleStart, mergedAt } = await selfMerged();
  try {
    const state = await rig.snapshot();
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 1);
    assert.equal(state.work[0].nextStep, "delivery");
    assert.deepEqual(state.work[0].target.selfMerge, receipt);
    assert.equal(state.releaseRequests.length, 1);
    const request = state.releaseRequests[0];
    assert.equal(request.revision, receipt.merge);
    assert.equal(request.source.pullRequest, receipt.pr);
    assert.equal(request.createdAt, mergedAt);
    // This cycle counts the merge; every later cycle, still reading the
    // record at delivery, does not.
    assert.equal(mergesIn(state, cycleStart, mergedAt + 60_000), 1);
    assert.equal(mergesIn(state, mergedAt + 120_000, mergedAt + 900_000), 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("self merge delivery: the runtime's merge write is reported merged once", async () => {
  const { rig, record } = await selfMerged();
  try {
    const after = (await rig.snapshot()).work;
    // The cycle that merged: one stage change, on the pull request.
    const changes = progressChanges([record], after, LOCAL_SENTINEL_REPO);
    assert.deepEqual(
      changes.map((change) => [change.commentOn, change.stage]),
      [[7, { key: "done:7", words: "Merged in #7; this repair is done." }]],
    );
    // The next cycle reads the same record still waiting at delivery.
    assert.deepEqual(progressChanges(after, after, LOCAL_SENTINEL_REPO), []);
  } finally {
    await rig.ctx.cleanup();
  }
});
