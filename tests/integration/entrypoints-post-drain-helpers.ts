import {
  DEP_2,
  makeRepairRig,
  repairConfigs,
  REPO,
  SHA1,
  SHA3,
  T0,
} from "./helpers.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  CLEAN_REVIEW_RESULT,
  preparedCleanReview,
  ReviewRestStore,
  SECOND_HEAD,
  TRANSPORT_PUBLISHER,
  trustedSnapshot,
  wireConcreteReviewTransport,
} from "./entrypoints-review-helpers.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import {
  monitoredReleaseRecord,
  reservation,
  reviewReceipt,
  sample,
  workRecord,
} from "../state/helpers.ts";
import { REPO_2 } from "../budget/helpers.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import assert from "node:assert/strict";
import { GitHubApiClient } from "../../src/github/client.ts";
import { FakeAuthProvider, FakeCooldownGate } from "../github/helpers.ts";
import { GitHubCodexReviewTransport } from "../../src/github/codex-review-transport.ts";
import type { ReviewDrainReportV1 } from "../../src/contracts/ports.ts";
import { RepairReviewDrainError, runRepairEntrypoint } from "../../src/main.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";

export async function postDrainTaskScenario(
  mode:
    | "expired"
    | "future"
    | "wrong-key"
    | "wrong-head"
    | "unavailable"
    | "missing-acceptance"
    | "missing-acceptance-capped"
    | "failed-drain"
    | "deadline"
    | "foreign-only"
    | "foreign-first"
    | "matrix-deferred"
    | "matrix-fresh"
    | "matrix-horizon"
    | "matrix-deadline"
    | "matrix-step-limit"
    | "lost-merge" = "expired",
): Promise<void> {
  const head = SHA3;
  const branch = "sentinel/repair/issue-1";
  const attempt = mode === "missing-acceptance" ? 2 : 4;
  const key = `review:7:${head}:attempt-${attempt}`;
  const rig = await makeRepairRig("post-drain-task", {
    summaries: false,
    github: { candidateLifecycle: {} },
  });
  let releaseResult!: () => void;
  const resultReady = new Promise<void>((resolve) => {
    releaseResult = resolve;
  });
  try {
    const issue = {
      number: 1,
      title: "issue 1",
      body: "",
      state: "open" as const,
      author: null,
      labels: [],
      createdAt: T0,
      updatedAt: T0,
      closedAt: null,
      relations: { subIssueCount: 0, openBlockers: [] },
    };
    rig.github.readIssue = () => Promise.resolve(portOk(issue));
    rig.github.candidatePullRequests.set(7, {
      number: 7,
      title: "repair issue 1",
      body: "Resolves #1",
      state: "open",
      head,
      base: SHA1,
      mergeSha: null,
      headRef: branch,
      baseRef: "development",
      author: TRANSPORT_PUBLISHER,
      createdAt: T0,
      updatedAt: T0,
      mergedAt: null,
      reviewDecision: "none",
    });
    const task = {
      issueNumber: 1,
      title: issue.title,
      body: issue.body,
      digest: await reviewTaskStatementDigest({
        issueNumber: 1,
        title: issue.title,
        body: issue.body,
      }),
    };
    const charge = reservation(`review-attempt-${attempt}`, {
      taskId: "issue-1",
      attempt,
      head,
      purpose: "review_request",
      outcome: "submitted",
      settledAt: T0,
      proofRef: null,
    });
    const work = workRecord("issue-1", {
      source: { kind: "issue", id: "1", revision: SHA1 },
      target: { base: SHA1, branch, checkpoint: null, head, pr: 7 },
      nextStep: "review",
      wait: { reason: "review_pending", since: T0, until: T0 + 15 * 60_000 },
      counters: { attempts: 1, retries: 0, reviewRounds: attempt },
      updatedAt: T0,
    });
    const collision = mode === "foreign-only" || mode === "foreign-first";
    const foreign = workRecord("foreign-issue-1", {
      ...work,
      id: "foreign-issue-1",
      repository: REPO_2,
    });
    const foreignCharge = reservation("foreign-review-attempt-4", {
      ...charge,
      id: "foreign-review-attempt-4",
      taskId: foreign.id,
      repository: REPO_2,
    });
    const foreignReceipt = reviewReceipt("foreign-retained-receipt", {
      repository: REPO_2,
      pullRequest: { number: 7, head, base: SHA1 },
      outcome: "pending",
      observedReviewer: null,
      resultId: null,
      completedAt: null,
    });
    const matrixOwned = mode.startsWith("matrix-");
    const matrixCharge = reservation("matrix-owned-implementation", {
      taskId: "issue-2",
    });
    const matrixWork = workRecord("issue-2", {
      source: { kind: "issue", id: "2", revision: SHA1 },
      related: { incidentId: null, issueNumber: 2 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-2",
        checkpoint: null,
        head: null,
        pr: null,
      },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      intent: {
        kind: "implementation",
        key: "matrix-owned-implementation",
        startedAt: T0,
        branch: "sentinel/repair/issue-2",
        expectedHead: SHA1,
        observedBase: SHA1,
        pr: null,
        requestId: matrixCharge.id,
        resultId: null,
      },
    });
    const freshMatrixWork = workRecord("issue-3", {
      source: { kind: "issue", id: "3", revision: SHA1 },
      related: { incidentId: null, issueNumber: 3 },
      target: {
        base: SHA1,
        branch: "sentinel/repair/issue-3",
        checkpoint: null,
        head: null,
        pr: null,
      },
    });
    const seededWork = matrixOwned
      ? mode === "matrix-fresh"
        ? [work, freshMatrixWork]
        : mode === "matrix-horizon"
        ? [work, freshMatrixWork, matrixWork]
        : [work, matrixWork]
      : mode === "foreign-only"
      ? [foreign]
      : collision
      ? [foreign, work]
      : [work];
    const charges = matrixOwned && mode !== "matrix-fresh"
      ? [matrixCharge, charge]
      : mode === "foreign-only"
      ? [foreignCharge]
      : collision
      ? [foreignCharge, charge]
      : [charge];
    const seeded = await rig.store.writeRepair(
      parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: null,
        sequence: 1,
        updatedAt: T0,
        incidents: [],
        evidence: [],
        work: seededWork,
        reservations: charges,
        reviews: collision ? [foreignReceipt] : [],
        replays: [],
        releaseRequests: [],
        githubCooldowns: [],
        attemptMemory: [],
        lessons: [],
      }),
      null,
    );
    assert.ok(seeded.ok && seeded.value.status === "applied");
    const rest = new ReviewRestStore();
    const client = new GitHubApiClient({
      repository: REPO,
      apiBaseUrl: "https://api.github.com",
      http: rest.handle,
      auth: new FakeAuthProvider(),
      cooldownGate: new FakeCooldownGate(),
      clock: rig.clock,
    });
    const transport = new GitHubCodexReviewTransport({
      client,
      repository: REPO,
      publisher: TRANSPORT_PUBLISHER,
      clock: rig.clock,
      ownerRunId: "run-post-drain-task",
      snapshot: {
        capture: async (input) =>
          portOk(await trustedSnapshot(input.base, input.head)),
      },
      reviewer: {
        prepare: (request) =>
          Promise.resolve(portOk(preparedCleanReview(request, 0, {
            ...CLEAN_REVIEW_RESULT,
            ...(mode === "unavailable"
              ? { verdict: "unavailable" as const }
              : {}),
            taskAcceptance: mode === "missing-acceptance" ||
                mode === "missing-acceptance-capped" || mode === "unavailable"
              ? null
              : {
                issueNumber: 1,
                taskDigest: task.digest,
                verdict: "fulfilled",
                evidence: ["the exact candidate fulfills the source issue"],
              },
          }, () => resultReady))),
      },
    });
    const submitted = await transport.submitReview({
      operationKey: key,
      prNumber: 7,
      expectedHead: head,
      expectedBase: SHA1,
      expectedReviewer: TRANSPORT_PUBLISHER,
      latestStartAt: T0 + 30 * 60_000,
      settleBy: T0 + 40 * 60_000,
      task,
    });
    assert.ok(
      submitted.ok && submitted.value.status === "submitted",
      JSON.stringify(submitted),
    );
    const reports: ReviewDrainReportV1[] = [];
    wireConcreteReviewTransport(
      rig.github,
      transport,
      reports,
      () => rig.clock.now(),
      client,
    );
    const drain = rig.github.drainReviews;
    rig.github.drainReviews = async (request) => {
      rig.clock.advance(mode === "future" ? 1 : 15 * 60_000 + 1);
      releaseResult();
      const result = await drain(request);
      if (!result.ok) return result;
      if (mode === "wrong-key") {
        result.value.operations[0].operationKey = `${key}:other`;
      }
      if (mode === "wrong-head") {
        [...rest.reviews.values()][0].head = SECOND_HEAD;
      }
      if (mode === "failed-drain") result.value.ok = false;
      if (mode === "deadline" || mode === "matrix-deadline") {
        rig.clock.advance(60 * 60_000);
      }
      return result;
    };
    const merge = rig.github.mergePullRequest.bind(rig.github);
    rig.github.mergePullRequest = (request) => {
      assert.equal(request.expectedHead, head);
      assert.equal(request.review.taskAcceptance?.verdict, "fulfilled");
      assert.equal(request.review.resultId, "result-9");
      return merge(request).then((result) =>
        mode === "lost-merge"
          ? portError("unavailable", "synthetic lost merge response")
          : result
      );
    };
    if (mode === "failed-drain") {
      await assert.rejects(() => rig.run(60 * 60_000), RepairReviewDrainError);
    } else {
      const configs = repairConfigs({
        sessionBound: {
          maxDurationMs: mode === "matrix-horizon" ? 55 * 60_000 : 240_000,
          maxOutputChars: 200_000,
        },
      });
      const outcome = matrixOwned
        ? await runRepairEntrypoint({
          clock: rig.clock,
          state: rig.store,
          configs,
          controllerSha: SHA1,
          github: rig.github,
          githubCooldown: rig.githubCooldown,
          incidents: rig.incidents,
          replay: rig.replay,
          model: rig.model,
          budget: new RollingStartBudget({
            clock: rig.clock,
            state: rig.store,
            configs,
          }),
          externalImplementations: true,
        }, {
          deadline: rig.clock.now() + 60 * 60_000,
          stepLimit: mode === "matrix-step-limit" ? 0 : 16,
        })
        : await rig.run(60 * 60_000);
      if (matrixOwned) {
        assert.equal(
          rig.github.calls.filter((call) => call === "merge").length,
          mode === "matrix-deferred" || mode === "matrix-fresh" ? 1 : 0,
          `completed drained review must advance only within the original bounds: ${
            JSON.stringify(outcome)
          }`,
        );
        assert.deepEqual(
          (await rig.snapshot()).work.find((record) =>
            record.id ===
              (mode === "matrix-fresh" ? freshMatrixWork.id : matrixWork.id)
          ),
          mode === "matrix-fresh" ? freshMatrixWork : matrixWork,
          "matrix-owned implementation intent stays unchanged and charged",
        );
      }
      if (collision) {
        const current = await rig.snapshot();
        assert.deepEqual(
          current.work.find((record) => record.id === foreign.id),
          foreign,
          "a same-key foreign record cannot consume this invocation's review",
        );
        assert.deepEqual(
          current.reviews.filter((receipt) =>
            receipt.repository.name === REPO_2.name
          ),
          [foreignReceipt],
          "foreign receipts are preserved without relabeling",
        );
        assert.deepEqual(current.reservations, charges);
        assert.deepEqual(
          rig.github.observedReviewKeys,
          mode === "foreign-only" ? [] : [key],
        );
      }
      assert.equal(
        outcome.status,
        mode === "deadline" || mode === "matrix-deadline" ||
          mode === "matrix-horizon"
          ? "margin"
          : mode === "matrix-step-limit"
          ? "step_limit"
          : "idle",
        JSON.stringify(outcome),
      );
    }
    assert.equal(reports[0]?.operations[0]?.durable, true);
    assert.equal(rest.submits, 1, "the actual drain published the result");
    let state = await rig.snapshot();
    const positive = mode === "expired" || mode === "future" ||
      mode === "lost-merge" || mode === "foreign-first" ||
      mode === "matrix-deferred" || mode === "matrix-fresh";
    assert.equal(
      state.reviews.length,
      (positive || mode === "missing-acceptance" ||
          mode === "missing-acceptance-capped"
        ? 1
        : 0) + (collision ? 1 : 0),
      "a completed result may be retained without authorizing delivery",
    );
    if (mode === "missing-acceptance") {
      assert.equal(state.reviews[0].taskAcceptance, null);
      assert.equal(state.work[0].nextStep, "review");
    }
    if (mode === "missing-acceptance-capped") {
      assert.equal(state.reviews[0].taskAcceptance, null);
      assert.equal(state.work[0].nextStep, "review");
      assert.equal(state.work[0].counters.reviewRounds, attempt);
    }
    assert.deepEqual(state.reservations, charges);
    assert.equal(state.work[0].target.head, head);
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      positive ? 1 : 0,
    );
    assert.equal(
      state.releaseRequests.length,
      positive && mode !== "lost-merge" ? 1 : 0,
    );
    assert.equal(rig.model.requests.length, 0);
    assert.equal(
      rig.github.calls.filter((call) => call === "requestReview").length,
      0,
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "listOpenIssues").length,
      1,
    );
    assert.equal(
      rig.github.calls.filter((call) => call.startsWith("closeIssue:")).length,
      0,
      "production acceptance must precede closure",
    );
    assert.equal(rig.github.pushes.length, 0);
    assert.equal(rest.creates, 1);
    if (mode === "lost-merge") {
      assert.equal(state.work[0].intent?.kind, "merge");
      rig.clock.advance(5 * 60_000 + 1);
      await rig.run(60 * 60_000);
      state = await rig.snapshot();
      assert.equal(
        state.releaseRequests.length,
        1,
        "restart reconciles the exact already-merged PR",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
      );
      assert.deepEqual(state.reservations, [charge]);
      // Production is an injected external acceptance boundary here. Its
      // exact-candidate evidence enters the REAL separate release Git store
      // only after merge; no review or merge authorization is seeded.
      const accepted = monitoredReleaseRecord(
        "post-drain-production",
        "accepted",
      );
      const released = await rig.releaseStore.writeRelease(
        parseReleaseStateSnapshotV1({
          version: "v1",
          kind: "release_state_snapshot",
          stateHead: null,
          sequence: 1,
          updatedAt: rig.clock.now(),
          hostedRuntimes: [],
          hostedReleases: [],
          githubCooldowns: [],
          releases: [{
            ...accepted,
            requestId: state.releaseRequests[0].id,
            requestRevision: head,
            candidate: {
              identity: DEP_2,
              buildTransactionId: "post-drain-production",
            },
            observed: { ...accepted.observed, identity: DEP_2 },
            acceptance: {
              ...accepted.acceptance!,
              identity: DEP_2,
              samples: [sample(DEP_2, T0 + 33_000)],
            },
          }],
        }),
        null,
      );
      assert.ok(released.ok && released.value.status === "applied");
      rig.clock.advance(5 * 60_000 + 1);
      await rig.run(60 * 60_000);
      state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "done");
      assert.equal(
        rig.github.calls.filter((call) => call === "closeIssue:1").length,
        1,
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(rest.creates, 1);
      assert.deepEqual(state.reservations, [charge]);
    }
  } finally {
    releaseResult();
    await rig.ctx.cleanup();
  }
}
