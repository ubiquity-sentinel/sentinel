/**
 * Issue #197: a self-merge refusal that arrives after the remote writes began
 * (proof stage `preserved` or later: the operation ref is pushed and
 * `development` may already carry the merge) parks the record but keeps the
 * durable proof, the only record binding that write to its task and review.
 * Before any remote write (no proof, or stage `prepared`) the intent is
 * cleared as before.
 */
import assert from "node:assert/strict";
import type { SelfMergeProofV1 } from "../../src/contracts/self-merge.ts";
import { parseSelfMergeProof } from "../../src/contracts/self-merge.ts";
import { planHostedRetirements } from "../../ops/hosted-autonomy-closures.ts";
import { hostedIssueKey } from "../../ops/hosted-autonomy-policy.ts";
import { repairSnapshot } from "../host/hosted-autonomy-rig.ts";
import { parkSelfMergeRefusal } from "../../src/repair/loop-merge.ts";
import { selfMergeFixture } from "../github/self-merge-fixture.ts";
import { T0, workRecord } from "../state/helpers.ts";
import { LOCAL_SENTINEL_REPO } from "./loop-rig.ts";

const REFUSAL =
  "self merge refused by trusted validation; owner action required: self merge trusted CI pipeline changed";

function recordWith(proof: SelfMergeProofV1) {
  return workRecord(proof.taskId, {
    repository: LOCAL_SENTINEL_REPO,
    source: {
      kind: "issue",
      id: String(proof.issueNumber),
      revision: proof.base,
    },
    related: { incidentId: null, issueNumber: proof.issueNumber },
    target: {
      base: proof.base,
      branch: proof.headRef,
      checkpoint: null,
      head: proof.head,
      pr: proof.pr,
    },
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "merge",
      key: proof.operationKey,
      startedAt: T0,
      branch: proof.headRef,
      expectedHead: proof.head,
      observedBase: proof.base,
      pr: proof.pr,
      requestId: proof.requestId,
      resultId: proof.resultId,
      selfMerge: proof,
    },
  });
}

Deno.test("self merge park: a refusal after the remote writes began keeps the proof", async () => {
  const rig = await selfMergeFixture();
  try {
    // Stop the real port after `development` was pushed: the PR closure
    // identity is wrong, so the proof stays at stage source_applied.
    rig.state.wrongCloseIdentity = true;
    const result = await rig.port.mergePullRequest(rig.request, rig.execution);
    assert.equal(result.ok, false);
    const applied = rig.execution.proof;
    assert.equal(applied?.stage, "source_applied");
    const prepared = rig.state.saved.find((p) => p.stage === "prepared");
    assert.ok(applied !== null && prepared !== undefined);

    const at = T0 + 10_000;
    const kept = parkSelfMergeRefusal(recordWith(applied), REFUSAL, at);
    assert.equal(kept.nextStep, "blocked");
    assert.equal(kept.wait, null);
    assert.equal(kept.intent?.kind, "merge");
    assert.deepEqual(kept.intent?.selfMerge, applied);
    assert.equal(
      kept.blocker?.message,
      `${REFUSAL}; self merge proof kept at stage source_applied`,
    );

    const cleared = parkSelfMergeRefusal(recordWith(prepared), REFUSAL, at);
    assert.equal(cleared.nextStep, "blocked");
    assert.equal(cleared.intent, null);
    assert.equal(cleared.blocker?.message, REFUSAL);
  } finally {
    await rig.cleanup();
  }
});

Deno.test("self merge park: the hosted retirement pass never clears a kept proof", async () => {
  // Held-fix review finding: a self merge whose PR the protocol closed itself
  // (prState closed) and whose issue is closed is closed-unmerged to the
  // launcher's retirement pass, which cleared the kept proof with the intent.
  const rig = await selfMergeFixture();
  try {
    rig.state.wrongCloseIdentity = true;
    await rig.port.mergePullRequest(rig.request, rig.execution);
    const applied = rig.execution.proof;
    assert.ok(applied !== null);
    const closed = parseSelfMergeProof({
      ...applied,
      stage: "pr_closed",
      prState: "closed",
    });
    const kept = parkSelfMergeRefusal(recordWith(closed), REFUSAL, T0 + 10_000);
    assert.equal(kept.intent?.selfMerge?.stage, "pr_closed");
    const snapshot = repairSnapshot([kept], [], [], []);
    const closedIssues = new Set([
      hostedIssueKey(kept.repository, closed.issueNumber),
    ]);
    assert.deepEqual(
      planHostedRetirements(snapshot, closedIssues, new Set([kept.id])),
      [],
    );
  } finally {
    await rig.cleanup();
  }
});
