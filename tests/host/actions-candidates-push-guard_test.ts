/**
 * The 2026-11-17 push backstop in the REAL hosted candidate preserver: a
 * `sentinel-candidates/*` preservation push of model-written content
 * re-derives its paths from the source mirror's own `base..head` tree diff
 * (raw, NUL-separated) before anything else, so on Sentinel's own repository
 * a CI-executable change is never sent, whatever the configured protected
 * list says and whatever the candidate's receipt claims.
 */
import assert from "node:assert/strict";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import { PROTECTED_PATH_PARK } from "../../src/repair/workflow-trust.ts";
import { MemoryState } from "../repair/helpers.ts";
import { T0 } from "../state/helpers.ts";
import {
  BRANCH,
  candidateRecord,
  makeCandidateCtx,
  SELF_REPO,
  snapshot,
} from "./actions-candidates-fixture.ts";
import {
  CANDIDATE_OPERATION_KEY,
  CANDIDATE_TASK_ID,
  candidateFor,
  mirror,
  PRESERVATION_ID,
  preserveAttempt,
  remoteSha,
  submittedReservation,
} from "./actions-candidates-preservation-fixture.ts";

async function attempt(files: Record<string, string> | undefined) {
  const ctx = await makeCandidateCtx({ files });
  const taskId = CANDIDATE_TASK_ID;
  const ref = await candidatePreservationRef(
    { ...SELF_REPO },
    taskId,
    CANDIDATE_OPERATION_KEY,
  );
  const record = candidateRecord(ctx, {
    target: {
      base: ctx.base,
      branch: BRANCH,
      checkpoint: null,
      head: ctx.head,
      pr: null,
      candidateState: { preserved: null, publishedHead: null },
    },
    intent: {
      kind: "candidate_preservation",
      key: CANDIDATE_OPERATION_KEY,
      startedAt: T0,
      branch: ref,
      expectedHead: ctx.head,
      observedBase: ctx.base,
      pr: null,
      requestId: PRESERVATION_ID,
      resultId: null,
    },
  });
  const state = new MemoryState();
  state.repair = snapshot([record], [submittedReservation(record)]);
  const result = await preserveAttempt({
    ctx,
    state,
    taskId,
    sourcePath: await mirror(ctx),
    publishedHead: null,
    // Nothing configured: the backstop alone must refuse.
    protectedPaths: [],
    candidate: await candidateFor(
      taskId,
      ctx.base,
      ctx.head,
      CANDIDATE_OPERATION_KEY,
    ),
    ensure: () => Promise.resolve({ ok: true, value: undefined }),
  });
  return { ctx, ref, result };
}

Deno.test("preserver push guard: Sentinel's own CI-executable change is never preserved", async () => {
  for (
    const files of [
      {
        "src/app.ts": "export const a = 1;\n",
        ".github/workflows/x.yml": "on: push\n",
      },
      { ".github/actions/setup/action.yml": "runs: {}\n" },
      { "src/we\\ird.ts": "export const b = 2;\n" },
    ] as Record<string, string>[]
  ) {
    const { ctx, ref, result } = await attempt(files);
    try {
      assert.deepEqual(result.result, {
        ok: false,
        error: { kind: "invalid", detail: PROTECTED_PATH_PARK },
      }, JSON.stringify(Object.keys(files)));
      assert.equal(result.pushes.length, 0, "nothing is sent");
      assert.equal(await remoteSha(ctx, ref), null);
    } finally {
      await ctx.cleanup();
    }
  }
});

Deno.test("preserver push guard: an ordinary change is preserved as before", async () => {
  const { ctx, ref, result } = await attempt(undefined);
  try {
    assert.ok(result.result.ok, JSON.stringify(result.result));
    assert.equal(await remoteSha(ctx, ref), ctx.head);
  } finally {
    await ctx.cleanup();
  }
});
