/**
 * A pull request merged by a human (or any non-Sentinel actor) is a completed
 * delivery: its exact outstanding review admission is settled, the observed
 * merge identity becomes durable provenance, and the ordinary post-merge
 * bookkeeping persists the release request and verifies the source issue
 * through the same read a trusted delivery uses. No closure or comment write
 * is invented when that path would not make one.
 */
import assert from "node:assert/strict";
import {
  asFindingFingerprint,
  asWorkItemId,
  type GitSha,
} from "../../src/contracts/brands.ts";
import { type GitHubPullRequestV1, portOk } from "../../src/contracts/ports.ts";
import { parseEvidenceRef } from "../../src/contracts/shared.ts";
import {
  humanMergeProvenanceRef,
  humanMergeRequestId,
} from "../../src/repair/human-merge.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { MERGED_OFF_TIP_PREFIX } from "../../src/repair/merge-off-tip.ts";
import { reservation, SHA1, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { exactOpenPr, preservedIssueWork } from "./loop-candidate-fixtures.ts";
import { completedReceipt, deliveryRecord } from "./loop-review-fixtures.ts";
import {
  issueRecord,
  LOCAL_SENTINEL_REPO,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";

const HUMAN_MERGE_ACTOR = "0x4007";

/** The human-merge cases run on a non-queue target; queue custody has its own case. */
function humanMergeRecord() {
  return deliveryRecord(SHA3, {
    repository: LOCAL_SENTINEL_REPO,
    nextStep: "review",
  });
}

function localReceipt(overrides: Record<string, unknown> = {}) {
  return completedReceipt(7, SHA3, SHA1, {
    repository: LOCAL_SENTINEL_REPO,
    ...overrides,
  });
}

function mergedPr(head = SHA3) {
  const id = asWorkItemId("issue-1");
  return {
    ...exactOpenPr(7, head, candidateBranch(id)),
    state: "merged" as const,
    mergeSha: SHA2,
    mergedBy: HUMAN_MERGE_ACTOR,
  } as GitHubPullRequestV1 & { mergedBy: string };
}

/** A rig whose source issue #1 was already closed by the merge keyword. */
function closedIssueRig(name: string, merged: GitHubPullRequestV1) {
  const id = asWorkItemId("issue-1");
  const github = new RelationsFakeGithub({
    baseSha: SHA1,
    candidateLifecycle: {
      refs: { [`refs/heads/${candidateBranch(id)}`]: SHA3 },
      pullRequests: [merged],
    },
  });
  github.latest.set(1, issueRecord(1, { state: "closed" }));
  return makeRig(name, {
    summaries: false,
    githubPort: github,
    localScope: true,
  });
}

Deno.test("human merge: a closed source issue completes delivery with provenance and a release request", async () => {
  const merged = mergedPr();
  const rig = await closedIssueRig("human-merge-completion", merged);
  try {
    const record = humanMergeRecord();
    const charge = reservation("human-merge-review-charge", {
      taskId: record.id,
      head: SHA3,
      purpose: "review_request",
      outcome: "submitted",
      settledAt: T0 + 1000,
    });
    const written = await rig.store.writeRepair(
      seededSnapshot([record], { reservations: [charge] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0]!;
    assert.equal(work.nextStep, "done");
    assert.equal(work.blocker, null);
    assert.equal(work.wait, null);
    assert.equal(work.intent, null);
    assert.equal(work.target.pr, 7, "the delivered PR identity is retained");
    assert.equal(work.target.head, SHA3, "the reviewed head is retained");
    assert.deepEqual(work.evidence, [{
      kind: "review_receipt",
      ref:
        `artifact:review-receipt/human-merge-v1/7/${SHA3}/${SHA2}/${HUMAN_MERGE_ACTOR}`,
    }]);
    assert.deepEqual(
      state.reservations,
      [charge],
      "the completed review charge is neither refunded nor re-charged",
    );
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(state.releaseRequests[0]!.revision, SHA2);
    assert.equal(state.releaseRequests[0]!.source.pullRequest, 7);
    assert.equal(state.releaseRequests[0]!.source.head, SHA3);
    assert.equal(state.releaseRequests[0]!.source.base, SHA1);
    assert.equal(
      state.releaseRequests[0]!.source.reviewRequestId,
      humanMergeRequestId(7, SHA3, SHA2),
      "the human-merge request identity is durable when no review authorizes it",
    );
    assert.equal(state.releaseRequests[0]!.source.reviewReceiptId, null);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "the completed human merge is never merged again",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "createPr").length,
      0,
      "the completed delivery is never republished",
    );
    assert.equal(
      rig.github.calls.filter((call) => call.startsWith("closeIssue")).length,
      0,
      "no new GitHub write is invented for the human merge",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("human merge: an open source issue still completes without inventing a closure write", async () => {
  const merged = mergedPr();
  const rig = await makeRig("human-merge-open-issue", {
    summaries: false,
    localScope: true,
    github: {
      candidateLifecycle: {
        refs: {
          [`refs/heads/${candidateBranch(asWorkItemId("issue-1"))}`]: SHA3,
        },
        pullRequests: [merged],
      },
    },
  });
  try {
    const record = humanMergeRecord();
    const written = await rig.store.writeRepair(
      seededSnapshot([record]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0]!;
    assert.equal(
      work.nextStep,
      "done",
      "the human merge is a completed delivery",
    );
    assert.equal(work.blocker, null);
    assert.equal(work.intent, null);
    assert.equal(work.target.pr, 7);
    assert.deepEqual(work.evidence, [{
      kind: "review_receipt",
      ref:
        `artifact:review-receipt/human-merge-v1/7/${SHA3}/${SHA2}/${HUMAN_MERGE_ACTOR}`,
    }]);
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(state.releaseRequests[0]!.revision, SHA2);
    assert.ok(
      rig.github.calls.includes("readIssue:1"),
      "the source issue was verified before the merge was booked",
    );
    assert.equal(
      rig.github.calls.filter((call) => call.startsWith("closeIssue")).length,
      0,
      "the observation never invents an issue closure write",
    );
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 0);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("human merge: a reserved review admission is settled once before the record completes", async () => {
  const merged = mergedPr();
  const rig = await closedIssueRig("human-merge-reserved-admission", merged);
  try {
    const id = asWorkItemId("issue-1");
    const record = humanMergeRecord();
    const admission = reservation("human-merge-reserved-review", {
      taskId: record.id,
      head: SHA3,
      attempt: record.counters.reviewRounds + 1,
      purpose: "review_request",
      outcome: "reserved",
      settledAt: null,
    });
    const withIntent = {
      ...record,
      intent: {
        kind: "review_request" as const,
        key: `review:7:${SHA3}:${record.counters.reviewRounds + 1}`,
        startedAt: T0,
        branch: candidateBranch(id),
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: 7,
        requestId: admission.id,
        resultId: null,
      },
    };
    const written = await rig.store.writeRepair(
      seededSnapshot([withIntent], { reservations: [admission] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0]!;
    assert.equal(work.nextStep, "done");
    assert.equal(work.intent, null);
    assert.deepEqual(
      state.reservations,
      [{
        ...admission,
        outcome: "ambiguous",
        settledAt: T0,
      }],
      "the exact outstanding admission is charged ambiguous once",
    );
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(
      state.releaseRequests[0]!.source.reviewRequestId,
      admission.id,
      "the release request names the settled review admission",
    );
    assert.equal(state.releaseRequests[0]!.source.reviewReceiptId, null);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("human merge: an exact authorizing review is retained on the release request", async () => {
  const merged = mergedPr();
  const rig = await closedIssueRig("human-merge-reviewed", merged);
  try {
    const record = humanMergeRecord();
    const receipt = localReceipt();
    const written = await rig.store.writeRepair(
      seededSnapshot([record], { reviews: [receipt] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "done");
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(
      state.releaseRequests[0]!.source.reviewRequestId,
      receipt.requestId,
    );
    assert.equal(
      state.releaseRequests[0]!.source.reviewReceiptId,
      receipt.id,
      "the exact authorizing receipt survives into the delivery bookkeeping",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("human merge: a gateway merge without verified queue proof is held, not booked", async () => {
  const merged = mergedPr();
  const id = asWorkItemId("issue-1");
  const rig = await makeRig("human-merge-queue-custody", {
    summaries: false,
    github: {
      candidateLifecycle: {
        refs: { [`refs/heads/${candidateBranch(id)}`]: SHA3 },
        pullRequests: [merged],
      },
    },
  });
  try {
    const record = preservedIssueWork("issue-1", SHA3, {
      nextStep: "review",
      pr: 7,
    });
    const written = await rig.store.writeRepair(
      seededSnapshot([record]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0]!;
    assert.equal(
      work.nextStep,
      "review",
      "queue custody is checked before outside-merge bookkeeping",
    );
    assert.equal(work.wait?.reason, "backoff");
    assert.equal(work.wait?.until, null);
    assert.deepEqual(work.evidence, []);
    assert.deepEqual(state.releaseRequests, []);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("human merge: a merge that landed off its reviewed base is never booked", async () => {
  const merged = mergedPr();
  const rig = await closedIssueRig("human-merge-off-base", merged);
  const reads: string[] = [];
  Object.defineProperty(rig.github, "readCommitParents", {
    value: (sha: GitSha) => {
      reads.push(sha);
      return Promise.resolve(portOk([SHA2, SHA3]));
    },
  });
  try {
    const record = humanMergeRecord();
    const written = await rig.store.writeRepair(
      seededSnapshot([record]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    const work = state.work[0]!;
    assert.deepEqual(reads, [SHA2], "the observed merge commit was checked");
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      `${MERGED_OFF_TIP_PREFIX}merge ${SHA2} has parents ${SHA2},${SHA3}, not ${SHA1},${SHA3}`,
    );
    assert.deepEqual(work.evidence, []);
    assert.deepEqual(state.releaseRequests, []);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("human merge: only the latest completed review can authorize delivery", async () => {
  const merged = mergedPr();
  const rig = await closedIssueRig("human-merge-latest-review", merged);
  try {
    const record = humanMergeRecord();
    const earlier = localReceipt();
    const latest = localReceipt({
      id: "review-receipt:latest-p0",
      requestId: "review-req-latest-p0",
      resultId: "result-latest-p0",
      completedAt: T0 + 2000,
      observedAt: T0 + 2001,
      findings: [{
        id: "latest-p0",
        severity: "P0",
        path: "src/app.ts",
        message: "latest review has a blocking finding",
        fingerprint: asFindingFingerprint("a".repeat(64)),
        resolved: false,
        resolutionEvidence: null,
      }],
      unresolvedSeverities: ["P0"],
    });
    const written = await rig.store.writeRepair(
      seededSnapshot([record], { reviews: [earlier, latest] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "done");
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(
      state.releaseRequests[0]!.source.reviewRequestId,
      humanMergeRequestId(7, SHA3, SHA2),
      "the earlier clean receipt is not reused after a later P0 review",
    );
    assert.notEqual(
      state.releaseRequests[0]!.source.reviewReceiptId,
      earlier.id,
    );
    assert.equal(state.releaseRequests[0]!.source.reviewReceiptId, null);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("human merge: a merged head that differs from the reviewed head never completes delivery", async () => {
  const merged = mergedPr(SHA2);
  const id = asWorkItemId("issue-1");
  const rig = await makeRig("human-merge-head-mismatch", {
    summaries: false,
    localScope: true,
    github: {
      candidateLifecycle: {
        refs: { [`refs/heads/${candidateBranch(id)}`]: SHA3 },
        pullRequests: [merged],
      },
    },
  });
  try {
    const record = humanMergeRecord();
    const written = await rig.store.writeRepair(
      seededSnapshot([record]),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const work = (await rig.snapshot()).work[0]!;
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      "observed merged head identity mismatch",
      "an unobserved revision is never recorded as this task's delivery",
    );
    assert.deepEqual(work.evidence, []);
    assert.deepEqual((await rig.snapshot()).releaseRequests, []);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("human merge provenance: a bot actor is encoded into a valid evidence reference", () => {
  const ref = humanMergeProvenanceRef(
    7,
    SHA3,
    SHA2,
    "ubiquity-sentinel[bot]",
  );
  assert.doesNotThrow(() => parseEvidenceRef(ref, "$human_merge"));
  assert.match(ref.ref, /\/hex-[0-9a-f]+$/);
});
