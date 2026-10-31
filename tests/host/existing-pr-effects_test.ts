import { createPrepareBaseRefresh } from "../../src/host/local-base-refresh.ts";
import assert from "node:assert/strict";
import { nativeLifecycleRig } from "../repair/existing-pr-lifecycle-fixtures.ts";
import {
  prepareExistingPrEffect,
  routeExistingPr,
} from "../../src/repair/loop-existing-pr.ts";
import { requestReviewFor } from "../../src/repair/loop-review-request.ts";
import { persistTransition } from "../../src/repair/loop-state.ts";
import { REPO, reviewReceipt } from "../state/helpers.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import {
  parseReviewJournalBody,
  renderReviewJournalBody,
} from "../../src/github/review-journal.ts";
import {
  checkRunWire,
  checksPageWire,
  issueWire,
  rulesetWire,
  statusesPageWire,
  structuredCompletedFixture,
} from "../github/helpers.ts";
import { defaultRules } from "../github/merge-helpers.ts";

Deno.test("existing PR effects: actual review admission then exact-head direct merge uses fresh retained custody", async () => {
  const r = await nativeLifecycleRig(REPO);
  try {
    let context = await r.reload();
    for (let n = 0; n < 3; n++) {
      const step = await routeExistingPr(
        r.deps,
        context,
        context.snapshot.work[0],
      );
      assert.ok(step.status === "step" && step.step.kind === "progress");
      context = await r.reload();
    }
    r.host.port.prepareBaseRefresh = createPrepareBaseRefresh({
      clock: r.clock,
      git: r.host.git,
      repository: REPO,
      observer: r.host.port,
      baseBranch: "development",
      trustedPrAuthor: "sentinel[bot]",
    });
    const checks = [
      "validate",
      "verify-artifact",
      "darwin-native",
      "mac-containment",
    ];
    const prefix = "/repos/ubiquity/ai.ubq.fi";
    const task = {
      issueNumber: 1,
      title: "Repair source",
      body: r.nativeControls.body,
    };
    r.nativeControls.replies.set(
      `GET ${prefix}/issues/1`,
      issueWire({ number: 1, title: task.title, body: task.body }),
    );
    for (const head of [r.ctx.head, r.ctx.base]) {
      r.nativeControls.replies.set(
        `GET ${prefix}/commits/${head}/check-runs`,
        checksPageWire(checks.map((name, i) =>
          checkRunWire({
            id: 100 + i,
            name,
            head_sha: head,
            check_suite: { id: 10 },
          })
        )),
      );
      r.nativeControls.replies.set(
        `GET ${prefix}/commits/${head}/statuses`,
        statusesPageWire([]),
      );
    }
    context.bounds = {
      runDeadline: r.clock.now() + 7_200_000,
      modelCutoff: r.clock.now() + 5_400_000,
    };
    r.reviewService.submitResult = {
      status: "submitted",
      requestId: "req-1",
      requestedAt: r.clock.now(),
    };
    const review = await requestReviewFor(
      r.deps,
      context,
      context.snapshot.work[0],
      7,
    );
    assert.notEqual(review.kind, "state_error", JSON.stringify(review));
    assert.equal(r.reviewService.submits.length, 1, JSON.stringify(review));
    context = await r.reload();
    const afterReview = context.snapshot.work[0];
    assert.equal(afterReview.target.pr, 7);
    assert.equal(afterReview.target.branch, "human/issue-1");
    assert.equal(afterReview.target.candidateState?.preserved, null);
    assert.equal(
      context.snapshot.reservations.filter((row) =>
        row.purpose === "review_request"
      ).length,
      1,
    );
    const taskAcceptance = {
      issueNumber: 1,
      taskDigest: await reviewTaskStatementDigest(task),
      verdict: "fulfilled" as const,
      evidence: ["The native candidate fulfills the exact task"],
    };
    const key = reviewOperationKey(7, r.ctx.head);
    const completed = await structuredCompletedFixture({
      head: r.ctx.head,
      base: r.ctx.base,
      operationKey: key,
      requestedAt: r.clock.now(),
      completedAt: r.clock.now(),
      result: {
        verdict: "clean",
        summary: "no issues found",
        findings: [],
        taskAcceptance,
      },
    });
    const journal = await parseReviewJournalBody(completed.body);
    assert.equal(journal.phase, "ready");
    const body = renderReviewJournalBody({
      ...journal,
      repository: { owner: REPO.owner, name: REPO.name },
      prNumber: 7,
      publisher: "sentinel[bot]",
    });
    r.reviewService.readResult = {
      ...completed.service,
      repository: REPO,
      prNumber: 7,
      expectedReviewer: "sentinel[bot]",
    };
    r.nativeControls.replies.set(`GET ${prefix}/pulls/7/reviews`, [{
      ...completed.review,
      body,
      user: { login: "sentinel[bot]" },
    }]);
    r.nativeControls.replies.set(`GET ${prefix}/pulls/7/comments`, []);
    r.nativeControls.replies.set(
      `GET ${prefix}/rules/branches/development`,
      defaultRules(),
    );
    r.nativeControls.replies.set(`GET ${prefix}/rulesets`, [rulesetWire()]);
    r.nativeControls.replies.set(`GET ${prefix}/rulesets/1`, rulesetWire());
    // Real effective protections retain strict checks; supply its exact named check.
    r.nativeControls.replies.set(
      `GET ${prefix}/commits/${r.ctx.head}/check-runs`,
      checksPageWire([checkRunWire({ name: "ci", head_sha: r.ctx.head })]),
    );
    const receipt = reviewReceipt(await reviewReceiptId(key, r.ctx.head), {
      repository: REPO,
      expectedReviewer: "sentinel[bot]",
      observedReviewer: "sentinel[bot]",
      pullRequest: { number: 7, head: r.ctx.head, base: r.ctx.base },
      outcome: "completed",
      resultId: completed.service.resultId,
      requestId: "req-1",
      summary: "no issues found",
      taskAcceptance,
      submittedAt: r.clock.now(),
      completedAt: r.clock.now(),
      observedAt: r.clock.now(),
    });
    assert.deepEqual(
      await persistTransition(r.deps, context, (draft) => {
        draft.reviews = [receipt];
        draft.work[0] = {
          ...draft.work[0],
          nextStep: "delivery",
          wait: null,
          intent: {
            kind: "merge",
            key: `merge:7:${r.ctx.head}`,
            branch: "human/issue-1",
            expectedHead: r.ctx.head,
            observedBase: r.ctx.base,
            pr: 7,
            requestId: receipt.requestId,
            resultId: receipt.resultId,
            startedAt: r.clock.now(),
          },
        };
      }),
      { kind: "progress" },
    );
    context = await r.reload();
    const merge = {
      pullRequestNumber: 7,
      expectedHead: r.ctx.head,
      expectedBase: r.ctx.base,
      review: receipt,
    };
    // A merge commit on exactly [reviewed base, head]: the only bookable one.
    const mergeSha = "e".repeat(40);
    r.nativeControls.replies.set(`PUT ${prefix}/pulls/7/merge`, {
      merged: true,
      sha: mergeSha,
      message: "Merged",
    });
    r.nativeControls.replies.set(`GET ${prefix}/git/commits/${mergeSha}`, {
      sha: mergeSha,
      parents: [{ sha: r.ctx.base }, { sha: r.ctx.head }],
    });
    const missing = await r.host.port.mergePullRequest(merge);
    assert.ok(!missing.ok || missing.value.outcome !== "merged");
    const auth = await prepareExistingPrEffect(
      r.deps,
      context,
      context.snapshot.work[0],
      { operation: "merge" },
    );
    assert.ok(auth.ok && auth.value !== undefined, JSON.stringify(auth));
    const copied = await r.host.port.mergePullRequest(
      merge,
      undefined,
      structuredClone(auth.value),
    );
    assert.ok(!copied.ok || copied.value.outcome !== "merged");
    const merged = await r.host.port.mergePullRequest(
      merge,
      undefined,
      auth.value,
    );
    assert.ok(
      merged.ok && merged.value.outcome === "merged",
      JSON.stringify(merged),
    );
    const replay = await r.host.port.mergePullRequest(
      merge,
      undefined,
      auth.value,
    );
    assert.ok(!replay.ok || replay.value.outcome !== "merged");
    assert.equal(r.requests.filter((row) => row.method === "PUT").length, 1);
    assert.deepEqual(
      (await r.reload()).snapshot.reservations,
      context.snapshot.reservations,
    );
  } finally {
    await r.ctx.cleanup();
  }
});
