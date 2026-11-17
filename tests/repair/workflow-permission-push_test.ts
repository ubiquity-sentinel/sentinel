/**
 * GitHub refuses a push that creates or updates a workflow when the App
 * installation lacks the `workflows` permission (2026-11-17). The refusal is
 * a closed detail, never a non-fast-forward conflict, and the record parks
 * for the owner: no retry loop and no further charged run.
 */
import assert from "node:assert/strict";
import { PUSH_WORKFLOWS_PERMISSION_DETAIL } from "../../src/contracts/ports-github.ts";
import { isWorkflowsPermissionRefusal } from "../../src/github/git-executor.ts";
import { makeRig } from "./loop-rig.ts";
import { positiveLifecycle } from "./loop-candidate-fixtures.ts";

const GITHUB_REFUSAL = " ! [remote rejected] 3f2a -> sentinel/repair/issue-1 " +
  "(refusing to allow a GitHub App to create or update workflow " +
  "`.github/workflows/ci.yml` without `workflows` permission)\n" +
  "error: failed to push some refs";

Deno.test("workflows permission: GitHub's refusal is recognised, other rejections are not", () => {
  assert.equal(isWorkflowsPermissionRefusal(GITHUB_REFUSAL), true);
  assert.equal(
    isWorkflowsPermissionRefusal(
      "refusing to allow an OAuth App to create or update workflow `x`",
    ),
    true,
  );
  for (
    const text of [
      " ! [rejected] main -> main (non-fast-forward)",
      " ! [remote rejected] x -> y (protected branch hook declined)",
      "",
    ]
  ) assert.equal(isWorkflowsPermissionRefusal(text), false, text);
});

Deno.test("workflows permission: a refused workflow push parks for the owner once, with no retry and no new run", async () => {
  const rig = await makeRig("workflowpermission", {
    configOverrides: { protectedPaths: [".github/workflows/"] },
    model: { changedPaths: ["src/app.ts", ".github/workflows/ci.yml"] },
    github: {
      candidateLifecycle: positiveLifecycle(),
      pushRefusal: PUSH_WORKFLOWS_PERMISSION_DETAIL,
    },
  });
  try {
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    let work = (await rig.snapshot()).work[0]!;
    assert.equal(work.nextStep, "blocked", JSON.stringify(work));
    assert.equal(work.blocker?.message, PUSH_WORKFLOWS_PERMISSION_DETAIL);
    assert.equal(work.intent, null, "no push intent is left to retry");
    assert.equal(work.wait, null);
    assert.equal(rig.github.pushes.length, 0, "nothing was written");
    assert.ok(!rig.github.calls.includes("createPr"));
    const runs = rig.model.requests.length;
    assert.equal(runs, 1);
    // Later cycles neither push again nor start another charged run.
    rig.clock.advance(24 * 60 * 60_000);
    await rig.run();
    work = (await rig.snapshot()).work[0]!;
    assert.equal(work.blocker?.message, PUSH_WORKFLOWS_PERMISSION_DETAIL);
    assert.equal(rig.model.requests.length, runs);
    assert.equal(
      rig.github.calls.filter((call) => call.startsWith("push:")).length,
      1,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});
