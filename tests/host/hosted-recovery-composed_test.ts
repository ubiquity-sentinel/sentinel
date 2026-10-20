/** Historical ingestion and original-publication recovery share actual state transitions. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { reservation } from "../state/helpers.ts";
import { blockedRetryRig } from "./hosted-autonomy-blocked-implementation-fixtures.ts";
import { readProtectedOriginalCandidates } from "../../ops/hosted-autonomy-original-candidate.ts";
import { runHostedOriginalCandidateRecoveryPass } from "../../ops/hosted-autonomy-original-candidate-pass.ts";
import { createHostedAutonomyScopes } from "../../ops/hosted-autonomy-scopes.ts";
import type { HostedAutonomyGitHubV1 } from "../../ops/hosted-autonomy-types.ts";

async function composedRig() {
  const rig = await blockedRetryRig();
  const initial = rig.state.snapshot.work[0];
  // The generic matrix seed uses its task id; issue custody uses the issue number.
  initial.source.id = String(initial.related.issueNumber);
  rig.history[0].work[0].source.id = initial.source.id;
  const originalCharge = reservation(
    rig.original.operationKey.slice("impl:".length),
    {
      repository: initial.repository,
      taskId: initial.id,
      head: initial.target.base,
      attempt: 1,
      purpose: "implementation",
      outcome: "submitted",
      settledAt: rig.state.snapshot.updatedAt,
    },
  );
  // This charge already exists in real records; the producer fixture only needs its retry.
  rig.state.snapshot.reservations.push(originalCharge);
  rig.history[0].reservations.push(structuredClone(originalCharge));
  const history = new Map<GitSha, RepairStateSnapshotV1>([
    [rig.state.head, structuredClone(rig.state.snapshot)],
  ]);
  const write = rig.shared.writeRepair;
  rig.shared.writeRepair = async (...args) => {
    const result = await write(...args);
    if (result.ok && result.value.status === "applied") {
      history.set(result.value.head, structuredClone(rig.state.snapshot));
    }
    return result;
  };
  const state = {
    ...rig.shared,
    readRepairAt: (
      { commit, expectedHead }: { commit: GitSha; expectedHead: GitSha },
    ) => {
      const snapshot = history.get(commit);
      return Promise.resolve(
        expectedHead === rig.state.head && snapshot
          ? portOk({
            status: "found" as const,
            head: commit,
            snapshot: structuredClone(snapshot),
            ref: null,
          })
          : portError("conflict", "captured authoritative history changed"),
      );
    },
  };
  const github: HostedAutonomyGitHubV1 = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch) =>
      Promise.resolve(
        branch === "development" ? rig.original.base : rig.published,
      ),
    hasSuccessfulCheck: () => Promise.resolve(true),
    hasAllChecksGreen: () => Promise.resolve(true),
    readPull: () =>
      Promise.resolve({
        number: initial.target.pr!,
        state: "open",
        merged: false,
        headSha: rig.published,
        baseRef: "development",
        baseSha: rig.original.base,
        author: "ubiquity-sentinel[bot]",
        mergeCommitSha: null,
        parents: [],
        revisionOnBaseBranch: false,
        baseAncestorOfRevision: false,
      }),
    listPullsByHeadRef: () =>
      Promise.resolve([{
        number: initial.target.pr!,
        state: "open",
        merged: false,
        headSha: rig.published,
        headRef: initial.target.branch!,
        baseRef: "development",
        author: "ubiquity-sentinel[bot]",
      }]),
    readIssueOpen: () => Promise.resolve(true),
    mergeBaseTreeChanges: () =>
      Promise.resolve({
        mergeBase: rig.original.base,
        changes: [{
          path: "fix.ts",
          oldMode: null,
          oldSha: null,
          newMode: "100644",
          newSha: rig.published,
        }],
      }),
    merge: () => Promise.reject(new Error("unexpected merge")),
    closeIssue: () => Promise.reject(new Error("unexpected issue close")),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
  };
  const clock = { now: () => rig.state.snapshot.updatedAt + 1 };
  const deps = { state, githubFor: () => github, clock };
  const context = () => ({
    deps,
    snapshot: structuredClone(rig.state.snapshot),
    observedHead: rig.state.head,
    initialHead: rig.state.head,
    releaseSnapshot: rig.current,
    actions: [],
    revisions: [],
    closedIssues: new Set<string>(),
    foreignMerged: new Map(),
    dedicatedReservations: new Set<string>(),
    ...createHostedAutonomyScopes(deps),
  });
  return { rig, state, history, context };
}

Deno.test("composed recovery: exact historical producer refusal restores its original published PR without another charge", async () => {
  const f = await composedRig();
  try {
    const ingested = await f.rig.run();
    assert.equal(ingested?.status, "applied");
    const rejected = structuredClone(f.rig.state.snapshot);
    assert.equal(
      rejected.work[0].blocker?.message,
      "candidate touches a protected path",
    );
    assert.equal(rejected.work[0].target.head, f.rig.candidate);
    assert(rejected.reservations.every((r) => r.outcome === "submitted"));
    const parent = f.history.get(rejected.stateHead!)!;
    assert.equal(
      parent.work[0].nextStep,
      "blocked",
      "actual settlement retains the historical blocker",
    );
    assert.match(
      parent.work[0].blocker!.message,
      /^authenticated historical matrix runtime mismatch;/,
    );
    assert.equal(parent.work[0].intent?.kind, "implementation");
    const restored = await runHostedOriginalCandidateRecoveryPass(f.context());
    assert.equal(restored?.status, "applied", JSON.stringify(restored));
    assert.equal(f.rig.state.snapshot.work[0].target.head, f.rig.published);
    assert.deepEqual(
      f.rig.state.snapshot.work[0].target.candidateState?.preserved,
      f.rig.original,
    );
    assert.deepEqual(f.rig.state.snapshot.reservations, rejected.reservations);
    assert.deepEqual(
      f.rig.state.snapshot.work[0].counters,
      rejected.work[0].counters,
    );
    assert.deepEqual(f.rig.state.snapshot.reviews, rejected.reviews);
    assert.equal(
      await f.rig.run(),
      null,
      "late rejected result cannot be imported again",
    );
    assert.equal(
      await runHostedOriginalCandidateRecoveryPass(f.context()),
      null,
    );
    assert.deepEqual(f.rig.github.calls, []);
  } finally {
    await f.rig.cleanup();
  }
});

Deno.test("composed recovery: malformed or identity-mismatched historical predecessors remain refused", async () => {
  const f = await composedRig();
  try {
    await f.rig.run();
    const current = structuredClone(f.rig.state.snapshot);
    const parentHead = current.stateHead!;
    const parent = f.history.get(parentHead)!;
    const originalParent = structuredClone(parent);
    const controls = [
      () => {
        parent.work[0].blocker!.message += " altered";
      },
      () => {
        parent.work[0].intent!.branch = "sentinel/repair/another-task";
      },
      () => {
        parent.work[0].target.candidateState!.publishedHead = f.rig.candidate;
      },
    ];
    for (const mutate of controls) {
      Object.assign(parent, structuredClone(originalParent));
      mutate();
      const proofs = await readProtectedOriginalCandidates({
        state: f.state,
        snapshot: current,
        expectedHead: f.rig.state.head,
        records: current.work,
        clock: f.context().deps.clock,
        deadlineAt: current.updatedAt + 120_000,
      });
      assert.deepEqual(proofs, []);
      assert.deepEqual(f.rig.state.snapshot, current);
    }
  } finally {
    await f.rig.cleanup();
  }
});
