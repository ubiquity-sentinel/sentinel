/** Candidate preservation, republication and recovered replay transports. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portError } from "../../src/contracts/ports.ts";
import type { GitHubPullRequestV1 } from "../../src/contracts/ports.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { REPO, SHA1, SHA2, SHA3, T0, workRecord } from "../state/helpers.ts";
import { LOCAL_SENTINEL_REPO, makeRig, seededSnapshot } from "./loop-rig.ts";
import {
  CHECK_POLL_MS,
  exactOpenPr,
  H0,
  H1,
  positiveLifecycle,
  preservedIssueWork,
  PRODUCING_RESERVATION,
} from "./loop-candidate-fixtures.ts";

for (const boundary of ["fixture", "original replay"] as const) {
  Deno.test(
    `lifecycle94: recovered ${boundary} transport is observed again after the existing poll interval`,
    async () => {
      const rig = await makeRig(`retry94-${boundary.replaceAll(" ", "-")}`, {
        github: { candidateLifecycle: positiveLifecycle() },
      });
      try {
        let unavailable = true;
        let observations = 0;
        const resolve = rig.replay.resolveTestIds.bind(rig.replay);
        const replay = rig.replay.runReplay.bind(rig.replay);
        rig.replay.resolveTestIds = (ref, digest) => {
          if (boundary !== "fixture") return resolve(ref, digest);
          observations++;
          if (!unavailable) return resolve(ref, digest);
          rig.clock.advance(CHECK_POLL_MS + 17);
          return Promise.resolve(
            portError("unavailable", "fixture transport unavailable"),
          );
        };
        rig.replay.runReplay = (request) => {
          if (boundary !== "original replay" || request.revision !== SHA2) {
            return replay(request);
          }
          observations++;
          if (!unavailable) return replay(request);
          rig.clock.advance(CHECK_POLL_MS + 17);
          return Promise.resolve(
            portError("unavailable", "original replay transport unavailable"),
          );
        };
        await rig.run();
        const parked = await rig.snapshot();
        const record = parked.work[0]!;
        assert.equal(observations, 1);
        assert.equal(record.wait?.reason, "unavailable");
        assert.equal(rig.model.requests.length, 0);
        assert.equal(parked.reservations.length, 0);
        const evidence = structuredClone(parked.evidence);
        const target = structuredClone(record.target);
        unavailable = false;
        rig.clock.advance(CHECK_POLL_MS + 1);
        const outcome = await rig.run();
        assert.ok(
          observations > 1,
          `recovered ${boundary} must be retried: ${JSON.stringify(outcome)}`,
        );
        assert.equal(record.wait?.until, record.wait!.since + CHECK_POLL_MS);
        assert.equal(
          record.wait?.since,
          T0 + CHECK_POLL_MS + 17,
          "retry starts from the completed failed observation",
        );
        const recovered = await rig.snapshot();
        assert.deepEqual(recovered.evidence, evidence);
        assert.equal(recovered.work[0]!.target.base, target.base);
        assert.equal(
          rig.model.requests.length,
          1,
          "one normal admission after evidence recovers",
        );
        assert.equal(recovered.work[0]!.nextStep, "review");
      } finally {
        await rig.ctx.cleanup();
      }
    },
  );
}

const deadLocalCandidate = (id: ReturnType<typeof asWorkItemId>) =>
  workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: candidateBranch(id),
      checkpoint: null,
      head: null,
      pr: null,
      candidateState: { preserved: null, publishedHead: null },
    },
    nextStep: "work",
  });

Deno.test(
  "candidate lifecycle: a dead worker-local candidate starts one fresh implementation from the base",
  async () => {
    const rig = await makeRig("candidate-descriptor", { summaries: false });
    try {
      const id = asWorkItemId("issue-1");
      const written = await rig.store.writeRepair(
        seededSnapshot([deadLocalCandidate(id)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // The placeholder descriptor owns no publishable artifact and its
      // deterministic branch is absent, so the row is released to exactly one
      // fresh implementation start over the base (no checkoutBase).
      await rig.run();
      assert.equal(rig.model.requests.length, 1, "one fresh implementation");
      assert.equal(rig.model.requests[0]!.base, SHA1);
      assert.equal(
        rig.model.requests[0]!.checkoutBase,
        undefined,
        "a released dead candidate starts from the base",
      );
      assert.equal(rig.github.pushes.length, 0, "nothing published");
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.ok(work.target.head !== null, "the fresh candidate head");
      assert.equal(
        work.intent?.kind,
        "candidate_preservation",
        "the fresh candidate then awaits its deterministic preservation",
      );
      assert.deepEqual(work.target.candidateState, {
        preserved: null,
        publishedHead: null,
      });
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
        "no review without a preserved descriptor",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a released dead candidate refuses uncharged when its branch is live",
  async () => {
    const rig = await makeRig("candidate-descriptor-live", {
      summaries: false,
      // A worker pushed the candidate but died before recording it: the
      // deterministic branch exists while publishedHead is still null.
      github: { branchRefSha: SHA3 },
    });
    try {
      const id = asWorkItemId("issue-1");
      const record = deadLocalCandidate(id);
      const before = canonicalStringify(record);
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "margin", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.equal(state.sequence, 1, "an uncharged refusal writes nothing");
      assert.equal(canonicalStringify(state.work[0]), before);
      assert.equal(state.reservations.length, 0);
      assert.equal(rig.model.requests.length, 0, "no model start");
      assert.equal(rig.github.pushes.length, 0, "no push");
      assert.equal(rig.github.preservationRequests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
        "no review request without a preserved descriptor",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: an unavailable preserver keeps the exact intent/head with a bounded wait",
  async () => {
    const rig = await makeRig("candidate-preserve-unavailable", {
      summaries: false,
    });
    try {
      const id = asWorkItemId("issue-1");
      const operationKey = implementationIntentKey(PRODUCING_RESERVATION);
      const ref = await candidatePreservationRef(REPO, id, operationKey);
      const record = workRecord("issue-1", {
        source: { kind: "issue", id: "1", revision: SHA1 },
        related: { incidentId: null, issueNumber: 1 },
        target: {
          base: SHA1,
          branch: candidateBranch(id),
          checkpoint: null,
          head: H0,
          pr: null,
          candidateState: { preserved: null, publishedHead: null },
        },
        nextStep: "work",
        intent: {
          kind: "candidate_preservation",
          key: operationKey,
          startedAt: T0,
          branch: ref,
          expectedHead: H0,
          observedBase: SHA1,
          pr: null,
          requestId: PRODUCING_RESERVATION,
          resultId: null,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0];
      assert.equal(work.intent?.kind, "candidate_preservation");
      assert.equal(work.intent?.key, operationKey);
      assert.equal(work.intent?.requestId, PRODUCING_RESERVATION);
      assert.equal(work.intent?.resultId, null);
      assert.equal(work.intent?.expectedHead, H0);
      assert.equal(
        work.target.head,
        H0,
        "the exact candidate head is retained",
      );
      assert.equal(work.target.candidateState?.preserved, null);
      assert.equal(work.target.candidateState?.publishedHead, null);
      assert.equal(work.wait?.reason, "unavailable");
      assert.equal(work.wait?.until, T0 + CHECK_POLL_MS);
      assert.deepEqual(rig.github.preservationRequests, [{
        taskId: id,
        candidate: {
          operationKey,
          base: SHA1,
          head: H0,
          ref,
        },
        publishedHead: null,
      }]);
      assert.equal(state.reservations.length, 0, "no charge for a wait");
      assert.equal(rig.model.requests.length, 0);
      assert.equal(rig.github.pushes.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        0,
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a positively missing candidate returns to a fresh attempt instead of retrying forever",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const operationKey = implementationIntentKey(PRODUCING_RESERVATION);
    const ref = await candidatePreservationRef(REPO, id, operationKey);
    const lifecycle = positiveLifecycle();
    const positivePreserve = lifecycle.preserveCandidate!;
    let preservations = 0;
    const rig = await makeRig("candidate-preserve-missing", {
      github: {
        issues: [{ number: 1, title: "reproducible failure", body: "body" }],
        candidateLifecycle: {
          ...lifecycle,
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
          preserveCandidate: (request) => {
            preservations++;
            if (preservations === 1) {
              // The host loader's exact positive-absence classification: no
              // trusted store or remote ref holds the produced candidate.
              return Promise.resolve(
                portError(
                  "not_found",
                  "candidate is not available in the trusted local store",
                ),
              );
            }
            return positivePreserve(request);
          },
        },
      },
    });
    try {
      const record = workRecord("issue-1", {
        source: { kind: "issue", id: "1", revision: SHA1 },
        related: { incidentId: null, issueNumber: 1 },
        target: {
          base: SHA1,
          branch,
          checkpoint: null,
          head: H0,
          pr: 7,
          candidateState: { preserved: null, publishedHead: H1 },
        },
        nextStep: "work",
        intent: {
          kind: "candidate_preservation",
          key: operationKey,
          startedAt: T0,
          branch: ref,
          expectedHead: H0,
          observedBase: SHA1,
          pr: null,
          requestId: PRODUCING_RESERVATION,
          resultId: null,
        },
        counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      });
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      // Run 1: the missing candidate is never reconciled and the record never
      // parks on it. It returns to the legacy work shape bound to the published
      // branch head with its charged attempt history preserved, and the same
      // cycle buys exactly one fresh implementation attempt whose candidate is
      // preserved under a new operation identity.
      const first = await rig.run();
      assert.equal(first.status, "idle", JSON.stringify(first));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.ok(
        rig.model.requests.length >= 1,
        "the recovery buys a fresh run",
      );
      assert.equal(work.target.head, SHA3, "the fresh candidate head");
      assert.equal(work.counters.attempts, 2, "one charged fresh attempt");
      assert.notEqual(
        work.target.candidateState?.preserved?.operationKey ?? null,
        operationKey,
        "the lost operation identity is retired",
      );
      assert.equal(
        work.target.candidateState?.preserved?.head ?? null,
        SHA3,
        "the fresh candidate is preserved",
      );
      assert.equal(work.target.candidateState?.publishedHead, SHA3);
      assert.equal(
        work.nextStep,
        "review",
        "the record advances past the loss",
      );
      assert.equal(work.wait?.reason, "review_pending");
      assert.ok(
        state.reservations.some((entry) =>
          entry.attempt === 2 && entry.purpose === "retry" &&
          entry.outcome === "submitted"
        ),
        "the fresh attempt is charged as a retry",
      );
      assert.ok(preservations >= 2, "one refused and one durable preservation");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a closed-unmerged own PR republishes the preserved candidate once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    // GitHub freezes a closed pull request's head forever, so both shapes are
    // recoverable: the exact published head and a head that predates the
    // refreshed candidate now on the task branch (the live issue-138 shape).
    for (const closedHead of [H1, H0]) {
      const rig = await makeRig(
        `candidate-closed-pr-${closedHead.slice(0, 6)}`,
        {
          summaries: false,
          github: {
            candidateLifecycle: {
              ...positiveLifecycle(),
              refs: { [`refs/heads/${branch}`]: H1 },
              pullRequests: [{
                ...exactOpenPr(7, closedHead, branch),
                state: "closed" as const,
              }],
            },
          },
        },
      );
      try {
        const written = await rig.store.writeRepair(
          seededSnapshot([preservedIssueWork("issue-1", H1)]),
          null,
        );
        assert.ok(written.ok && written.value.status === "applied");

        const outcome = await rig.run();
        assert.equal(outcome.status, "idle", JSON.stringify(outcome));
        const state = await rig.snapshot();
        const work = state.work[0]!;
        assert.equal(work.target.head, H1, "the exact candidate is retained");
        assert.equal(work.target.pr, 8, "one replacement pull request");
        assert.equal(work.nextStep, "review");
        assert.equal(work.wait?.reason, "review_pending");
        const replaced = rig.github.candidatePullRequests.get(8);
        assert.equal(
          replaced?.head,
          H1,
          "the replacement carries the candidate",
        );
        assert.equal(
          replaced?.body,
          "Resolves #1",
          "the closing keyword body",
        );
        assert.equal(
          rig.model.requests.length,
          0,
          "recovering a closed publication starts no model run",
        );
        assert.equal(rig.github.pushes.length, 0, "no additional push");
        const assignIndex = rig.github.calls.indexOf("assignIssue:1");
        const createIndex = rig.github.calls.indexOf("createPr");
        assert.ok(
          assignIndex !== -1 && createIndex !== -1 && assignIndex < createIndex,
          "the source issue is assigned before the pull request exists",
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "candidate lifecycle: a refused issue assignment still publishes from the preserved candidate",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-assign-failed", {
      summaries: false,
      github: {
        assignFailNext: true,
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [],
        },
      },
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([preservedIssueWork("issue-1", H1, { pr: null })]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.target.pr, 7, "the replacement was published anyway");
      assert.equal(work.target.head, H1, "the candidate is retained");
      assert.equal(work.nextStep, "review");
      assert.ok(
        rig.github.calls.includes("assignIssue:1"),
        "the assignment was attempted first",
      );
      const assignIndex = rig.github.calls.indexOf("assignIssue:1");
      const createIndex = rig.github.calls.indexOf("createPr");
      assert.ok(
        assignIndex !== -1 && createIndex !== -1 && assignIndex < createIndex,
        "the assignment attempt precedes the pull request",
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a review-phase record whose own PR was closed unmerged republishes once",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-review-closed-pr", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [{
            ...exactOpenPr(7, H1, branch),
            state: "closed" as const,
          }],
        },
      },
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([
          preservedIssueWork("issue-1", H1, { nextStep: "review", pr: 7 }),
        ]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.target.head, H1, "the exact candidate is retained");
      assert.equal(work.target.pr, 8, "one replacement pull request");
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(
        rig.github.candidatePullRequests.get(8)?.body,
        "Resolves #1",
      );
      assert.equal(rig.model.requests.length, 0, "no model runs to recover");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: a human-merged review-phase PR completes through delivery bookkeeping",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-review-merged-pr", {
      summaries: false,
      localScope: true,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [
            {
              ...exactOpenPr(7, H1, branch),
              state: "merged" as const,
              mergeSha: SHA2,
              mergedBy: "0x4007",
            } as GitHubPullRequestV1 & { mergedBy: string },
          ],
        },
      },
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([
          {
            ...preservedIssueWork("issue-1", H1, {
              nextStep: "review",
              pr: 7,
            }),
            repository: LOCAL_SENTINEL_REPO,
          },
        ]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.nextStep, "done");
      assert.equal(work.blocker, null);
      assert.deepEqual(
        work.evidence,
        [{
          kind: "review_receipt",
          ref: `artifact:review-receipt/human-merge-v1/7/${H1}/${SHA2}/0x4007`,
        }],
      );
      assert.equal(
        work.target.pr,
        7,
        "the delivered merged PR identity is retained",
      );
      assert.equal(work.target.head, H1, "the delivered head is retained");
      assert.equal(work.intent, null);
      assert.equal(work.wait, null);
      assert.equal(
        state.releaseRequests.length,
        1,
        "the ordinary post-merge bookkeeping persists one release request",
      );
      assert.equal(state.releaseRequests[0]!.revision, SHA2);
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        0,
        "a merged repair is never republished",
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        0,
        "a completed human merge is never merged again",
      );
      assert.equal(
        rig.github.calls.filter((call) => call.startsWith("closeIssue")).length,
        0,
        "no new GitHub write is invented for the human merge",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "candidate lifecycle: an exact preserved/published candidate progresses to one review",
  async () => {
    const id = asWorkItemId("issue-1");
    const branch = candidateBranch(id);
    const rig = await makeRig("candidate-preserved-progress", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: H1 },
          pullRequests: [exactOpenPr(7, H1, branch)],
        },
      },
    });
    try {
      const record = preservedIssueWork("issue-1", H1);
      const written = await rig.store.writeRepair(
        seededSnapshot([record]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0];
      assert.equal(work.nextStep, "review");
      assert.equal(work.wait?.reason, "review_pending");
      assert.equal(work.intent, null);
      assert.equal(work.target.head, H1);
      assert.equal(work.target.candidateState?.publishedHead, H1);
      assert.equal(
        rig.github.pushes.length,
        0,
        "an already published exact head is adopted, never re-pushed",
      );
      assert.equal(rig.model.requests.length, 0);
      assert.equal(
        rig.github.calls.filter((call) => call === "requestReview").length,
        1,
      );
      assert.deepEqual(
        state.reservations.map((reservation) => reservation.purpose),
        ["review_request"],
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
