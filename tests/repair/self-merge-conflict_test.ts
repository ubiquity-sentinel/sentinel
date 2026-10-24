/**
 * Issue #203: once a self-merge proof is saved, the recovery path re-armed a
 * five-minute `unavailable` wait for every non-refusal error, so a conflict
 * that never clears (the target moved without this merge, or a closure,
 * native merge or issue identity mismatch) waited forever. A target that
 * moved before any source write now drops the proof and reconciles the plain
 * merge intent; any other conflict parks for the owner with the proof kept.
 */
import assert from "node:assert/strict";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { PortErrorV1 } from "../../src/contracts/ports.ts";
import type { SelfMergeProofV1 } from "../../src/contracts/self-merge.ts";
import { parseSelfMergeProof } from "../../src/contracts/self-merge.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
} from "../../src/repair/loop-types.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  reconcileMergeIntent,
  selfMergeConflict,
} from "../../src/repair/loop-merge.ts";
import { selfMergeFixture } from "../github/self-merge-fixture.ts";
import { reviewReceipt, T0, workRecord } from "../state/helpers.ts";
import { FakeClock, FakeGithub, MemoryState } from "./helpers.ts";
import { LOCAL_SENTINEL_REPO, seededSnapshot } from "./loop-rig.ts";

const MOVED = "self merge target moved without exact merge";
const fault = (kind: PortErrorV1["kind"], detail: string): PortErrorV1 => ({
  kind,
  detail,
} as PortErrorV1);
const NOW = T0 + 3_600_000;

function recordWith(proof: SelfMergeProofV1): WorkRecordV1 {
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

async function proofs() {
  const rig = await selfMergeFixture();
  try {
    rig.state.wrongCloseIdentity = true;
    await rig.port.mergePullRequest(rig.request, rig.execution);
    const prepared = rig.state.saved.find((p) => p.stage === "prepared")!;
    const applied = rig.execution.proof!;
    assert.equal(applied.stage, "source_applied");
    const preserved = parseSelfMergeProof({ ...prepared, stage: "preserved" });
    return { prepared, preserved, applied };
  } finally {
    await rig.cleanup();
  }
}

async function recover(
  proof: SelfMergeProofV1,
  error: PortErrorV1,
  prState: "open" | "closed" = "closed",
) {
  const record = recordWith(proof);
  const receipt = reviewReceipt("self-merge-receipt", {
    repository: LOCAL_SENTINEL_REPO,
    requestId: proof.requestId,
    resultId: proof.resultId,
    outcome: "completed",
    observedReviewer: "chatgpt-codex-connector[bot]",
    completedAt: T0 + 1500,
    summary: "clean",
    pullRequest: { number: proof.pr, head: proof.head, base: proof.base },
  });
  const clock = new FakeClock(NOW);
  const state = new MemoryState();
  state.repair = seededSnapshot([record], { reviews: [receipt] });
  state.repairHead = proof.base;
  const github = new FakeGithub();
  let merges = 0, reads = 0;
  github.mergePullRequest = () => {
    merges++;
    return Promise.resolve(portError(error.kind, error.detail));
  };
  github.readPullRequest = () => {
    reads++;
    return Promise.resolve(portOk({
      number: proof.pr,
      state: prState,
      head: proof.head,
      base: proof.base,
      headRef: proof.headRef,
      mergeSha: null,
    } as never));
  };
  const deps = {
    clock,
    state,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
  } as unknown as RepairCycleDepsV1;
  const read = await state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  const context: LoopContextV1 = {
    head: read.value.head,
    snapshot: read.value.snapshot,
    bounds: { runDeadline: NOW + 3_600_000, modelCutoff: NOW + 3_600_000 },
    executionBaseline: null,
  };
  const step = await reconcileMergeIntent(deps, context, record);
  const after = await state.readRepair();
  assert.ok(after.ok && after.value.status === "found");
  return { step, row: after.value.snapshot.work[0], merges, reads };
}

Deno.test("self merge conflict: the disposition drops a pre-write proof only for a moved target", async () => {
  const { prepared, preserved, applied } = await proofs();
  const moved = fault("conflict", MOVED);
  for (const proof of [prepared, preserved]) {
    const decided = selfMergeConflict(recordWith(proof), moved);
    assert.equal(decided?.kind, "reconcile", proof.stage);
    if (decided?.kind === "reconcile") {
      assert.equal(decided.record.intent?.kind, "merge");
      assert.equal(decided.record.intent?.selfMerge, undefined);
    }
  }
  assert.equal(selfMergeConflict(recordWith(applied), moved)?.kind, "park");
  assert.equal(
    selfMergeConflict(
      recordWith(preserved),
      fault("conflict", "self merge PR closure identity mismatch"),
    )?.kind,
    "park",
  );
  assert.equal(
    selfMergeConflict(
      recordWith(preserved),
      fault("unavailable", "merge transport unavailable"),
    ),
    null,
  );
});

Deno.test("self merge conflict: a moved target at preserved reconciles the plain merge intent", async () => {
  const { preserved } = await proofs();
  const { row, merges, reads } = await recover(
    preserved,
    fault("conflict", MOVED),
  );
  assert.equal(merges, 1);
  assert.equal(reads, 1, "the plain reconcile read the pull request");
  assert.equal(row.nextStep, "blocked");
  assert.equal(row.blocker?.message, "pull request closed before merge");
  assert.notEqual(row.wait?.reason, "unavailable");
});

Deno.test("self merge conflict: a closure identity conflict after the source write parks with the proof", async () => {
  const { applied } = await proofs();
  const detail = "self merge PR closure identity mismatch";
  const { row, reads } = await recover(applied, fault("conflict", detail));
  assert.equal(reads, 0);
  assert.equal(row.nextStep, "blocked");
  assert.equal(row.wait, null);
  assert.deepEqual(row.intent?.selfMerge, applied);
  assert.equal(
    row.blocker?.message,
    `self merge conflict; owner action required: ${detail}; self merge proof kept at stage source_applied`,
  );
});
