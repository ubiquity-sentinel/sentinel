/**
 * A conflict resolution is model-written content too (2026-11-17): a
 * resolution that changes a CI-executable path is preserved and pushed only
 * when the record's source is trusted for CI (`workflow-trust.ts`), exactly
 * like an implementation. Through the REAL loop and the real conflict
 * resolution: an App issue of a kind with no CI trust is charged once, parks
 * with the untrusted park and is never preserved or pushed; the owner's
 * issue publishes the same resolution.
 */
import assert from "node:assert/strict";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { UNTRUSTED_WORKFLOW_PARK } from "../../src/repair/workflow-trust.ts";
import {
  conflictGithub,
  ConflictModel,
  conflictRig,
  makeConflictGit,
  publishedCandidate,
} from "./conflict-resolution-rig.ts";

const POLL = 5 * 60_000;
const WORKFLOW = ".github/workflows/resolved.yml";

function charges(state: RepairStateSnapshotV1) {
  return state.reservations.filter((row) =>
    row.purpose === "implementation" || row.purpose === "retry"
  );
}

async function resolve(author: Partial<GitHubIssueV1> | null) {
  const ctx = await makeConflictGit({});
  const github = conflictGithub(ctx);
  if (author !== null) {
    const read = github.readIssue.bind(github);
    github.readIssue = async (number: number) => {
      const issue = await read(number);
      if (!issue.ok || issue.value === null) return issue;
      const { authorId: _id, ...rest } = issue.value as GitHubIssueV1 & {
        authorId?: number;
      };
      return portOk({ ...rest, ...author } as GitHubIssueV1);
    };
  }
  const model = new ConflictModel(ctx, {
    extra: { [WORKFLOW]: "on: push\njobs: {}\n" },
  });
  const rig = conflictRig(github, model);
  await rig.seed([await publishedCandidate(ctx)]);
  for (let run = 0; run < 2; run++) {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    rig.clock.advance(POLL + 1000);
  }
  const state = await rig.snapshot();
  return { ctx, github, model, state, work: state.work[0] };
}

Deno.test("conflict resolution trust: an App issue of another kind never preserves or pushes a CI change", async () => {
  const run = await resolve({
    author: "ubiquity-sentinel[bot]",
    body: "Sentinel notice of a kind that carries no CI trust.",
  });
  try {
    assert.equal(run.work.nextStep, "blocked", JSON.stringify(run.work));
    assert.equal(run.work.blocker?.message, UNTRUSTED_WORKFLOW_PARK);
    const charged = charges(run.state);
    assert.equal(charged.length, 1, "the resolution run stays charged once");
    assert.equal(charged[0].outcome, "submitted");
    assert.equal(run.work.target.head, run.ctx.head, "the PR head is kept");
    assert.deepEqual(run.github.pushes, [], "nothing is pushed");
    assert.deepEqual(run.github.preservationRequests, [], "nor preserved");
  } finally {
    await run.ctx.cleanup();
  }
});

Deno.test("conflict resolution trust: the owner's issue publishes the same CI resolution", async () => {
  const run = await resolve(null);
  try {
    assert.equal(run.work.blocker, null, JSON.stringify(run.work.blocker));
    assert.equal(run.work.nextStep, "review");
    assert.equal(run.github.pushes.length, 1);
  } finally {
    await run.ctx.cleanup();
  }
});
