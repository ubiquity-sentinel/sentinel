/** Exact-head merge reconciliation and delivery authorization. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  candidateBranch,
  reviewOperationKey,
  reviewReceiptId,
} from "../../src/repair/keys.ts";
import {
  monitoredReleaseRecord,
  releaseRequest,
  reservation,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { makeRig, seededSnapshot, SHA4 } from "./loop-rig.ts";
import { completedReceipt, deliveryRecord } from "./loop-review-fixtures.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";
import { REPO_2 } from "../budget/helpers.ts";
import { CHECK_POLL_MS } from "../../src/repair/loop-bounds.ts";

Deno.test("pending CI observation rearms from the fresh clock and preserves wait history", async () => {
  const taskId = asWorkItemId("issue-ci-rearm");
  const branch = candidateBranch(taskId);
  const rig = await makeRig("ci-rearm", {
    summaries: false,
    github: {
      openIssues: [],
      checks: [{
        name: "ci",
        status: "in_progress",
        conclusion: null,
        head: SHA3,
        startedAt: T0,
        completedAt: null,
      }],
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { [`refs/heads/${branch}`]: SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, branch)],
      },
    },
  });
  try {
    const record = workRecord(taskId, {
      source: { kind: "issue", id: "1", revision: SHA1 },
      related: { incidentId: null, issueNumber: 1 },
      target: { base: SHA1, branch, checkpoint: null, head: SHA3, pr: 7 },
      nextStep: "delivery",
      wait: { reason: "ci_pending", since: T0, until: T0 + CHECK_POLL_MS },
      counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    });
    const proof = completedReceipt(7, SHA3, SHA1, {
      id: await reviewReceiptId(reviewOperationKey(7, SHA3, 1), SHA3),
      findings: [],
      unresolvedSeverities: [],
    });
    const originalCharge = reservation("ci-prior-implementation", {
      taskId,
      head: SHA1,
      purpose: "implementation",
      outcome: "submitted",
      settledAt: T0 + 1000,
    });
    const written = await rig.store.writeRepair(
      seededSnapshot([record], {
        reviews: [proof],
        reservations: [originalCharge],
      }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");
    rig.clock.advance(2 * CHECK_POLL_MS);
    const readChecks = rig.github.readChecks.bind(rig.github);
    let observations = 0;
    rig.github.readChecks = (head) => {
      observations++;
      // A captured executeMerge timestamp is stale by the time CI responds.
      if (observations === 1) rig.clock.advance(CHECK_POLL_MS + 1);
      return readChecks(head);
    };
    const outcome = await rig.entry();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    assert.equal(observations, 1, "pending CI is observed once per due pass");
    const after = await rig.snapshot();
    const pending = after.work[0];
    assert.equal(pending.wait?.reason, "ci_pending");
    assert.equal(pending.wait?.since, T0);
    assert.equal(pending.wait?.until, rig.clock.now() + CHECK_POLL_MS);
    assert.ok(pending.wait!.until! > rig.clock.now());
    assert.deepEqual(pending.target, record.target);
    assert.equal(pending.intent, record.intent);
    assert.deepEqual(after.reservations, [originalCharge]);
    assert.deepEqual(after.reviews, [proof]);
    assert.equal(after.releaseRequests.length, 0);
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 0);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(
      rig.github.drains.length,
      1,
      "production exit still drains reviews",
    );
    assert.equal(rig.github.drains[0].interrupt, true);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("merge reconciliation rejects an observed merged head different from the reviewed head", async () => {
  const rig = await makeRig("mergehead", {
    summaries: false,
    github: {
      // The PR was merged, but at a head this task never reviewed (SHA2).
      pullRequest: { state: "merged", head: SHA2, mergeSha: SHA2 },
    },
  });
  try {
    const seed = seededSnapshot([deliveryRecord(SHA3, {
      intent: {
        kind: "merge",
        key: `merge:7:${SHA3}`,
        startedAt: T0,
        branch: "sentinel/repair/issue-1",
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: 7,
        requestId: "review-req-1",
        resultId: "result-1",
      },
    })]);
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(
      state.work[0].nextStep,
      "blocked",
      "a mismatched merged head fails closed",
    );
    assert.equal(
      state.work[0].blocker?.message,
      "observed merged head identity mismatch",
    );
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "no merge is retried after the contradiction",
    );
    assert.equal(
      state.releaseRequests.length,
      0,
      "no release request is fabricated for the wrong merged head",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("delivery matches an existing release request by source PR/head and retains the merged revision", async () => {
  const rig = await makeRig("rrlookup", { summaries: false });
  try {
    const seed = seededSnapshot(
      [deliveryRecord(SHA3)],
      {
        reviews: [completedReceipt(7, SHA3, SHA1)],
        releaseRequests: [releaseRequest("release-7", {
          // Merged revision differs from the reviewed head: the lookup must
          // NOT match on `revision` — it matches source PR/head instead.
          revision: SHA2,
          source: {
            pullRequest: 7,
            reviewRequestId: "review-req-1",
            reviewReceiptId: completedReceipt(7, SHA3, SHA1).id,
            head: SHA3,
            base: SHA1,
          },
        })],
      },
    );
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    const outcome = await rig.run();
    assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    const state = await rig.snapshot();
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      0,
      "the existing release request suspends a new merge",
    );
    assert.equal(
      state.releaseRequests.length,
      1,
      "no duplicate release request is created",
    );
    assert.equal(
      state.releaseRequests[0].revision,
      SHA2,
      "the merged revision is retained inside the matched request",
    );
    assert.equal(
      state.releaseRequests[0].source.head,
      SHA3,
      "the source PR/head identity matched the saved reviewed head",
    );
    assert.equal(state.work[0].nextStep, "delivery");
    assert.equal(
      state.work[0].wait?.reason,
      "unavailable",
      "waits for release acceptance of the exact matched request",
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("base refresh preserves merged own PR identity for guarded maintenance", async () => {
  const record = deliveryRecord(SHA3);
  const rig = await makeRig("merged-refresh-identity", {
    summaries: false,
    github: {
      baseSha: SHA2,
      candidateLifecycle: {
        refs: { "refs/heads/sentinel/repair/issue-1": SHA3 },
        pullRequests: [{
          ...exactOpenPr(7, SHA3, record.target.branch!),
          state: "merged",
          mergeSha: SHA4,
        }],
        prepareBaseRefresh: () => {
          throw new Error("an observed merge must never be refreshed");
        },
      },
    },
  });
  try {
    const receipt = completedReceipt(7, SHA3, SHA1);
    const charge = reservation("retained-merge-charge", {
      taskId: record.id,
      purpose: "review_request",
    });
    const seed = seededSnapshot([record], {
      reviews: [receipt],
      reservations: [charge],
    });
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");
    const result = await rig.entry();
    assert.equal(result.status, "idle", JSON.stringify(result));
    const state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "blocked");
    assert.equal(
      state.work[0].blocker?.message,
      "pull request was merged outside the trusted review path",
    );
    assert.deepEqual(
      state.work[0].target,
      record.target,
      "observing a merge preserves its PR identity without accepting it",
    );
    assert.equal(state.work[0].intent, null);
    assert.deepEqual(state.work[0].counters, record.counters);
    assert.deepEqual(state.work[0].source, record.source);
    assert.deepEqual(state.work[0].evidence, record.evidence);
    assert.deepEqual(state.reviews, [receipt]);
    assert.deepEqual(state.reservations, [charge]);
    assert.deepEqual(state.releaseRequests, []);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 0);
    assert.equal(
      rig.github.calls.filter((call) => call === "closeIssue:1").length,
      0,
    );
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("trusted merge survives a transient post-merge task read", async () => {
  const rig = await makeRig("merge-task-read", {
    summaries: false,
    configOverrides: { repository: REPO_2 },
    github: {
      mergeOutcome: { outcome: "merged", head: SHA3, mergeSha: SHA2 },
      candidateLifecycle: {
        refs: { "refs/heads/sentinel/repair/issue-1": SHA3 },
        pullRequests: [exactOpenPr(7, SHA3, "sentinel/repair/issue-1")],
      },
    },
  });
  try {
    const record = deliveryRecord(SHA3, { repository: REPO_2 });
    const receipt = completedReceipt(7, SHA3, SHA1, {
      repository: REPO_2,
      id: await reviewReceiptId(reviewOperationKey(7, SHA3, 1), SHA3),
    });
    const written = await rig.store.writeRepair(
      seededSnapshot([record], { reviews: [receipt] }),
      null,
    );
    assert.ok(written.ok && written.value.status === "applied");

    let savedIntent: WorkRecordV1["intent"] = null;
    let merged = false;
    let failPostMergeRead = false;
    let refreshes = 0;
    const merge = rig.github.mergePullRequest.bind(rig.github);
    rig.github.mergePullRequest = async (request) => {
      savedIntent = (await rig.snapshot()).work[0].intent;
      assert.equal(savedIntent?.kind, "merge", "intent precedes mutation");
      const result = await merge(request);
      merged = true;
      failPostMergeRead = true;
      return result;
    };
    const readIssue = rig.github.readIssue.bind(rig.github);
    rig.github.readIssue = async (number) => {
      if (failPostMergeRead) {
        failPostMergeRead = false;
        return portError("unavailable", "transient post-merge task read");
      }
      return await readIssue(number);
    };
    const readRef = rig.github.readRef.bind(rig.github);
    rig.github.readRef = (ref) =>
      merged && ref === "refs/heads/development"
        ? Promise.resolve(portOk({ ref, sha: SHA2 }))
        : readRef(ref);
    rig.github.prepareBaseRefresh = () => {
      refreshes++;
      return Promise.resolve(portError("unavailable", "unexpected refresh"));
    };

    rig.clock.advance(2000);
    const first = await rig.entry();
    assert.equal(first.status, "idle", JSON.stringify(first));
    let state = await rig.snapshot();
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 1);
    assert.equal(state.releaseRequests.length, 0);
    assert.deepEqual(
      state.work[0].intent,
      savedIntent,
      "the exact trusted merge intent survives the transient read",
    );
    assert.deepEqual(state.work[0].target, record.target);
    assert.equal(state.work[0].wait?.reason, "unavailable");
    assert.equal(refreshes, 0);

    rig.clock.advance(state.work[0].wait!.until! - rig.clock.now());
    const resumed = await rig.entry();
    assert.equal(resumed.status, "idle", JSON.stringify(resumed));
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "delivery");
    assert.equal(state.work[0].blocker, null);
    assert.equal(state.work[0].intent, null);
    assert.equal(state.releaseRequests.length, 1);
    const request = state.releaseRequests[0];
    assert.deepEqual(request.target.repository, REPO_2);
    assert.deepEqual(receipt.repository, record.repository);
    assert.equal(request.revision, SHA2);
    assert.deepEqual(request.source, {
      pullRequest: 7,
      reviewRequestId: receipt.requestId,
      reviewReceiptId: receipt.id,
      head: SHA3,
      base: SHA1,
    });

    const accepted = monitoredReleaseRecord(
      "merge-task-read-accepted",
      "accepted",
    );
    const identity = { gitSha: SHA2, revisionId: "dep-merged" };
    const releaseState: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: rig.clock.now(),
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
      releases: [monitoredReleaseRecord(accepted.id, "accepted", {
        repository: REPO_2,
        requestId: request.id,
        requestRevision: request.revision,
        candidate: { identity, buildTransactionId: "txn-merged" },
        observed: { ...accepted.observed, identity },
        acceptance: {
          ...accepted.acceptance!,
          identity,
          samples: accepted.acceptance!.samples.map((sample) => ({
            ...sample,
            identity,
          })),
        },
      })],
    };
    const acceptedWrite = await rig.releaseStore.writeRelease(
      releaseState,
      null,
    );
    assert.ok(acceptedWrite.ok && acceptedWrite.value.status === "applied");
    rig.clock.advance(state.work[0].wait!.until! - rig.clock.now());
    const delivered = await rig.entry();
    assert.equal(delivered.status, "idle", JSON.stringify(delivered));
    state = await rig.snapshot();
    assert.equal(state.work[0].nextStep, "done");
    assert.deepEqual(state.releaseRequests, [request]);
    assert.equal(rig.github.calls.filter((call) => call === "merge").length, 1);
    assert.equal(
      rig.github.calls.filter((call) => call === "closeIssue:1").length,
      1,
    );
    assert.equal(refreshes, 0);
    assert.equal(rig.model.requests.length, 0);
    assert.equal(rig.github.reviewRequestIdentities.length, 0);
    assert.deepEqual(state.reviews, [receipt]);
    assert.deepEqual(state.reservations, []);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test("merged-but-ambiguous merge reconciliation builds one release request with the merged revision", async () => {
  const rig = await makeRig("rrmissing", {
    summaries: false,
    github: {
      // Direct merge response lost; the remote then shows the exact merged
      // head this task reviewed, with a distinct merge SHA.
      mergeOutcome: { outcome: "ambiguous", head: null, mergeSha: null },
      pullRequest: { state: "merged", head: SHA3, mergeSha: SHA2 },
    },
  });
  try {
    const seed = seededSnapshot(
      [deliveryRecord(SHA3)],
      {
        reviews: [completedReceipt(7, SHA3, SHA1, {
          id: await reviewReceiptId(reviewOperationKey(7, SHA3, 1), SHA3),
        })],
      },
    );
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");

    // The same bounded run first attempts the merge (ambiguous), then
    // reconciles by observing the merged PR and builds the release request.
    const first = await rig.run();
    assert.equal(first.status, "idle", JSON.stringify(first));
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "exactly one merge attempt, reconciled by observation",
    );
    let state = await rig.snapshot();
    assert.equal(state.releaseRequests.length, 1);
    assert.equal(state.work[0].intent, null, "merge intent reconciled");
    assert.equal(
      state.releaseRequests[0].revision,
      SHA2,
      "request revision is the exact merged revision",
    );
    assert.equal(
      state.releaseRequests[0].source.head,
      SHA3,
      "request source head is the reviewed candidate head",
    );
    assert.equal(state.releaseRequests[0].source.pullRequest, 7);

    // A later run observes the exact matched request: no blind re-merge, no
    // duplicate request.
    const second = await rig.run();
    assert.equal(second.status, "idle", JSON.stringify(second));
    state = await rig.snapshot();
    assert.equal(
      rig.github.calls.filter((call) => call === "merge").length,
      1,
      "no re-merge while the request is open",
    );
    assert.equal(state.releaseRequests.length, 1);
  } finally {
    await rig.ctx.cleanup();
  }
});

Deno.test(
  "delivery never merges without an authorizing current-head review receipt",
  async () => {
    const taskId = asWorkItemId("issue-noreview");
    const branch = candidateBranch(taskId);
    const rig = await makeRig("merge-gate-none", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: SHA3 },
          pullRequests: [exactOpenPr(7, SHA3, branch)],
        },
      },
    });
    try {
      const seeded = await rig.store.writeRepair(
        seededSnapshot([
          workRecord("issue-noreview", {
            source: { kind: "issue", id: "901", revision: SHA1 },
            related: { incidentId: null, issueNumber: 901 },
            target: {
              base: SHA1,
              branch,
              checkpoint: null,
              head: SHA3,
              pr: 7,
            },
            nextStep: "delivery",
            wait: null,
          }),
        ]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(
        outcome.status,
        "state_error",
        "a delivery without a review is a state contradiction",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "mergePr").length,
        0,
        "the merge is refused before any merge mutation",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "delivery refuses to merge on a completed receipt with unresolved P0 findings",
  async () => {
    const taskId = asWorkItemId("issue-rejected");
    const branch = candidateBranch(taskId);
    // Owner directive 2026-10-24: only an unresolved P0 blocks the merge. The
    // clean receipt and the unresolved-P1 receipt both authorize; the
    // unresolved-P0 receipt is refused before any merge mutation.
    const cases: Array<{
      name: string;
      severity: "P0" | "P1" | null;
      merges: boolean;
    }> = [
      { name: "clean", severity: null, merges: true },
      { name: "p1", severity: "P1", merges: true },
      { name: "rejected", severity: "P0", merges: false },
    ];
    for (const { name, severity, merges } of cases) {
      const rig = await makeRig(`merge-gate-${name}`, {
        summaries: false,
        github: {
          candidateLifecycle: {
            ...positiveLifecycle(),
            refs: { [`refs/heads/${branch}`]: SHA3 },
            pullRequests: [exactOpenPr(7, SHA3, branch)],
          },
        },
      });
      try {
        const proof = completedReceipt(7, SHA3, SHA1, {
          id: await reviewReceiptId(reviewOperationKey(7, SHA3, 1), SHA3),
          findings: severity === null ? [] : [{
            id: "finding-1",
            severity,
            path: "src/app.ts",
            message: "required fix",
            fingerprint: "a".repeat(64),
            resolved: false,
            resolutionEvidence: null,
          }],
          unresolvedSeverities: severity === null ? [] : [severity],
        });
        const seeded = await rig.store.writeRepair(
          seededSnapshot([
            workRecord("issue-rejected", {
              source: { kind: "issue", id: "1", revision: SHA1 },
              related: { incidentId: null, issueNumber: 1 },
              target: {
                base: SHA1,
                branch,
                checkpoint: null,
                head: SHA3,
                pr: 7,
              },
              nextStep: "delivery",
              wait: null,
              counters: { attempts: 1, retries: 0, reviewRounds: 1 },
            }),
          ], { reviews: [proof] }),
          null,
        );
        assert.ok(seeded.ok && seeded.value.status === "applied");

        const outcome = await rig.run();
        assert.equal(
          outcome.status,
          merges ? "idle" : "state_error",
          `${name}: ${JSON.stringify(outcome)}`,
        );
        assert.equal(
          rig.github.calls.filter((call) => call === "merge").length,
          merges ? 1 : 0,
          `${name}: only a receipt without an unresolved P0 authorizes a merge`,
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test("a failed merge reconcile read emits one closed delivery event and keeps the wait", async () => {
  const rig = await makeRig("mergereaderr", { summaries: false });
  try {
    const seed = seededSnapshot([deliveryRecord(SHA3, {
      intent: {
        kind: "merge",
        key: `merge:7:${SHA3}`,
        startedAt: T0,
        branch: "sentinel/repair/issue-1",
        expectedHead: SHA3,
        observedBase: SHA1,
        pr: 7,
        requestId: "review-req-1",
        resultId: "result-1",
      },
    })]);
    const written = await rig.store.writeRepair(seed, null);
    assert.ok(written.ok && written.value.status === "applied");
    rig.github.readPullRequest = () =>
      Promise.resolve(portError("rate_limited", "transient delivery read"));
    const emitted: string[] = [];
    const originalLog = console.log;
    try {
      console.log = ((...args: unknown[]) => {
        emitted.push(args.map((arg) => String(arg)).join(" "));
      }) as typeof console.log;
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    } finally {
      console.log = originalLog;
    }
    const state = await rig.snapshot();
    assert.equal(state.work[0].wait?.reason, "unavailable");
    const events = emitted
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.kind === "sentinel_merge_event");
    assert.equal(events.length, 1, emitted.join("\n"));
    assert.deepEqual(events[0], {
      version: "v1",
      kind: "sentinel_merge_event",
      event: "merge_reconcile_read_error",
      prNumber: 7,
      errorKind: "rate_limited",
      detailCode: null,
    });
  } finally {
    await rig.ctx.cleanup();
  }
});
