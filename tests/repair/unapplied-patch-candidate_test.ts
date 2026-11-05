/**
 * A candidate whose change set is only an unapplied patch/diff file (plus
 * tests) is not a repair: ai.ubq.fi 1281/1282/1210/1211 committed
 * `patches/issue-….patch` instead of editing the protected file, and each
 * such head consumed a charged native review round only to fail task
 * acceptance. The trusted implementation result refuses it BEFORE
 * publication and review, with a closed detail the next prompt carries.
 */
import assert from "node:assert/strict";
import { makeRig } from "./loop-rig.ts";
import { positiveLifecycle } from "./loop-candidate-fixtures.ts";
import {
  ATTEMPT_DETAIL_UNAPPLIED_PATCH,
  classifyAttemptDetailV1,
  JUDGED_ATTEMPT_DETAILS,
} from "../../src/repair/attempt-policy.ts";
import { unappliedPatchOnly } from "../../src/repair/candidate-shape.ts";
import { HOSTED_AUTONOMY_RETRYABLE } from "../../ops/hosted-autonomy-policy.ts";
import { buildPrompt } from "../../src/repair/model-port-prompt.ts";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { REPO, SHA1 } from "../state/helpers.ts";

Deno.test("an unapplied patch-file candidate is refused before review", async () => {
  const rig = await makeRig("unappliedpatch", {
    model: {
      changedPaths: [
        "patches/issue-1282-passport.patch",
        "tests/auth/passport_test.ts",
      ],
    },
    github: { candidateLifecycle: positiveLifecycle() },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "blocked");
    assert.equal(
      state.work[0]!.blocker?.message,
      ATTEMPT_DETAIL_UNAPPLIED_PATCH,
    );
    assert.equal(rig.github.pushes.length, 0, "never published");
    assert.equal(
      rig.github.calls.includes("requestReview"),
      false,
      "never reviewed",
    );
    // The implementation start stays charged; no review is reserved.
    assert.deepEqual(
      state.reservations.map((reservation) => reservation.purpose),
      ["implementation"],
    );
    assert.equal(state.reservations[0]!.outcome, "ambiguous");
    // The closed detail is durable attempt memory the next prompt carries.
    const entries = state.attemptMemory.flatMap((memory) => memory.entries);
    assert.ok(
      entries.some((entry) => entry.detail === ATTEMPT_DETAIL_UNAPPLIED_PATCH),
      JSON.stringify(entries),
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("an ordinary source-and-test candidate still proceeds to review", async () => {
  const rig = await makeRig("ordinarycandidate", {
    model: { changedPaths: ["src/app.ts", "tests/app_test.ts"] },
    github: { candidateLifecycle: positiveLifecycle() },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "review");
    assert.equal(rig.github.pushes.length, 1);
    assert.ok(rig.github.calls.includes("requestReview"));
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("a real in-place protected change still parks for the owner, unreviewed", async () => {
  // `src/handler.ts` is the rig's configured protected path.
  const rig = await makeRig("protectedinplace", {
    model: { changedPaths: ["src/handler.ts", "tests/handler_test.ts"] },
    github: { candidateLifecycle: positiveLifecycle() },
  });
  try {
    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(state.work[0]!.nextStep, "blocked");
    assert.equal(
      state.work[0]!.blocker?.message,
      "candidate touches a protected path",
    );
    assert.equal(rig.github.pushes.length, 0);
    assert.equal(rig.github.calls.includes("requestReview"), false);
    assert.equal(state.reservations[0]!.outcome, "submitted");
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("the next prompt carries the unapplied-patch correction as a verified fact", () => {
  const prompt = buildPrompt(
    {
      taskId: asWorkItemId("issue-1282"),
      repository: { ...REPO },
      base: SHA1,
      issue: { number: 1282, title: "Fix passport", body: "Body." },
      evidence: [],
      model: "gpt-reserve",
      reasoning: "max",
      maxDurationMs: 5_000,
      maxOutputChars: 12_345,
      priorAttempts: [{
        detail: ATTEMPT_DETAIL_UNAPPLIED_PATCH,
        stage: "candidate",
        failureClass: "semantic_no_progress",
        count: 1,
        lastAtMs: 0,
      }],
    },
    false,
    undefined,
    ["src/auth/"],
  );
  assert.ok(prompt.includes(`- ${ATTEMPT_DETAIL_UNAPPLIED_PATCH} (stage`));
  assert.ok(prompt.includes("apply the change to the real file in place"));
});

Deno.test("the unapplied-patch detail is a judged, retryable no-progress class", () => {
  assert.deepEqual(classifyAttemptDetailV1(ATTEMPT_DETAIL_UNAPPLIED_PATCH), {
    stage: "candidate",
    failureClass: "semantic_no_progress",
  });
  assert.ok(JUDGED_ATTEMPT_DETAILS.has(ATTEMPT_DETAIL_UNAPPLIED_PATCH));
  // The work grant re-runs it; the repeat-failure bound still parks it.
  assert.ok(
    HOSTED_AUTONOMY_RETRYABLE.some((rule) =>
      rule.nextStep === "work" &&
      ATTEMPT_DETAIL_UNAPPLIED_PATCH.startsWith(rule.prefix) &&
      rule.prefix === ATTEMPT_DETAIL_UNAPPLIED_PATCH
    ),
  );
});

Deno.test("unappliedPatchOnly: patch files with nothing but tests", () => {
  assert.equal(unappliedPatchOnly(["patches/issue-1211.patch"]), true);
  assert.equal(unappliedPatchOnly(["fix.diff", "src/x.test.ts"]), true);
  assert.equal(
    unappliedPatchOnly(["patches/notes.md", "tests/a_test.ts"]),
    true,
  );
  assert.equal(unappliedPatchOnly(["ISSUE.PATCH"]), true);
  // A real change alongside a patch (patch-package, cleanup) is not refused.
  assert.equal(
    unappliedPatchOnly(["patches/dep+1.0.0.patch", "package.json"]),
    false,
  );
  assert.equal(
    unappliedPatchOnly(["patches/x.patch", "src/auth/passport.ts"]),
    false,
  );
  assert.equal(unappliedPatchOnly(["tests/a_test.ts"]), false);
  assert.equal(unappliedPatchOnly(["src/patcher.ts"]), false);
  assert.equal(unappliedPatchOnly([]), false);
});
