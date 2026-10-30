/**
 * A pull request merged by a human (or any non-Sentinel actor) is a completed
 * delivery: the review-phase record becomes `done` with durable provenance
 * naming the observed merge SHA and actor, while reservations and the existing
 * issue-closure path are left exactly as a Sentinel merge would leave them.
 */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { GitHubPullRequestV1 } from "../../src/contracts/ports.ts";
import { parseEvidenceRef } from "../../src/contracts/shared.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { humanMergeProvenanceRef } from "../../src/repair/loop-review-observation.ts";
import { reservation, SHA2, SHA3, T0 } from "../state/helpers.ts";
import { exactOpenPr, preservedIssueWork } from "./loop-candidate-fixtures.ts";
import { makeRig, seededSnapshot } from "./loop-rig.ts";

const HUMAN_MERGE_ACTOR = "0x4007";

Deno.test("human merge: a merged review-phase PR completes delivery with observed provenance", async () => {
  const id = asWorkItemId("issue-1");
  const branch = candidateBranch(id);
  // The observed PR carries the merge actor; the frozen pull contract does
  // not type `mergedBy` yet, so the fixture preserves the runtime field.
  const merged = {
    ...exactOpenPr(7, SHA3, branch),
    state: "merged" as const,
    mergeSha: SHA2,
    mergedBy: HUMAN_MERGE_ACTOR,
  } as GitHubPullRequestV1 & { mergedBy: string };
  const rig = await makeRig("human-merge-completion", {
    summaries: false,
    github: {
      candidateLifecycle: {
        refs: { [`refs/heads/${branch}`]: SHA3 },
        pullRequests: [merged],
      },
    },
  });
  try {
    const record = preservedIssueWork("issue-1", SHA3, {
      nextStep: "review",
      pr: 7,
    });
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
    assert.deepEqual(state.releaseRequests, []);
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

Deno.test("human merge: a merged head that differs from the reviewed head never completes delivery", async () => {
  const id = asWorkItemId("issue-1");
  const branch = candidateBranch(id);
  const merged = {
    ...exactOpenPr(7, SHA2, branch),
    state: "merged" as const,
    mergeSha: SHA2,
    mergedBy: HUMAN_MERGE_ACTOR,
  } as GitHubPullRequestV1 & { mergedBy: string };
  const rig = await makeRig("human-merge-head-mismatch", {
    summaries: false,
    github: {
      candidateLifecycle: {
        refs: { [`refs/heads/${branch}`]: SHA3 },
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
    const work = (await rig.snapshot()).work[0]!;
    assert.equal(work.nextStep, "blocked");
    assert.equal(
      work.blocker?.message,
      "observed merged head identity mismatch",
      "an unobserved revision is never recorded as this task's delivery",
    );
    assert.deepEqual(work.evidence, []);
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
