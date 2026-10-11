/** Issue-task semantic acceptance and source integrity. */
import assert from "node:assert/strict";
import type { ReviewTaskAcceptanceV1 } from "../../src/contracts/review-receipt.ts";
import {
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_DIGEST_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
} from "../../src/repair/review-gate.ts";
import {
  reviewEvidenceRef,
  reviewOperationKey,
  reviewReceiptId,
} from "../../src/repair/keys.ts";
import { SHA1, SHA2 } from "../state/helpers.ts";
import {
  issueRecord,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import {
  acceptedObservation,
  FAKE_ISSUE_TASK_DIGEST,
  noVerdictObservation,
  reviewWaitIssueRecord,
  semanticRig,
} from "./loop-review-fixtures.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

Deno.test(
  "semantic acceptance: an issue-backed delivery requires the bound positive verdict",
  async () => {
    const cases: [
      string,
      ReviewTaskAcceptanceV1 | null,
      string,
      "missing_evidence" | "other",
    ][] = [
      [
        "change-only review (no acceptance)",
        null,
        TASK_ACCEPTANCE_MISSING_DETAIL,
        "missing_evidence",
      ],
      [
        // Same issue, same head, but the verdict was judged against DIFFERENT
        // issue text: only the trusted live digest authorizes.
        "same-issue receipt against changed task text",
        {
          issueNumber: 1,
          taskDigest: "a".repeat(64),
          verdict: "fulfilled",
          evidence: ["the candidate satisfies the text the reviewer was shown"],
        },
        TASK_ACCEPTANCE_DIGEST_DETAIL,
        "missing_evidence",
      ],
      [
        "relevant file changed in an unrelated way",
        {
          issueNumber: 1,
          taskDigest: FAKE_ISSUE_TASK_DIGEST,
          verdict: "not_fulfilled",
          evidence: ["the changed file does not implement the task"],
        },
        TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
        "other",
      ],
      [
        "already satisfied at base",
        {
          issueNumber: 1,
          taskDigest: FAKE_ISSUE_TASK_DIGEST,
          verdict: "already_satisfied_at_base",
          evidence: ["the base commit already implements the required fix"],
        },
        TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
        "other",
      ],
    ];
    for (const [label, acceptance, detail, kind] of cases) {
      const head = SHA2;
      const rig = await semanticRig(
        `semantic-${label.replace(/[^a-z]+/gi, "")}`,
        head,
        acceptance === null ? 3 : 1,
      );
      try {
        const completedAt = rig.clock.now() + 1000;
        const currentKey = reviewOperationKey(
          7,
          head,
          acceptance === null ? 3 : 1,
        );
        const nextKey = reviewOperationKey(7, head, 4);
        if (acceptance === null) {
          // The retired round ceiling no longer suppresses this unused retry.
          rig.github.releasedHead = head;
          rig.github.unboundReviewKeys.add(nextKey);
        }
        rig.github.reviewObservationsByKey.set(
          currentKey,
          acceptedObservation(head, acceptance, completedAt),
        );
        const outcome = await rig.run();
        const alreadySatisfied =
          acceptance?.verdict === "already_satisfied_at_base";
        assert.equal(
          outcome.status,
          alreadySatisfied ? "margin" : "idle",
          JSON.stringify(outcome),
        );
        const state = await rig.snapshot();
        const work = state.work[0]!;
        if (acceptance === null) {
          assert.equal(work.nextStep, "review", label);
          assert.equal(work.blocker, null, label);
          assert.equal(work.counters.reviewRounds, 4, label);
          assert.equal(rig.github.reviewRequestIdentities.length, 1, label);
          assert.equal(
            rig.github.reviewRequestIdentities[0]!.operationKey,
            nextKey,
          );
          assert.equal(state.reservations.length, 1, label);
          assert.equal(state.reservations[0]!.purpose, "review_request");
          assert.equal(state.reservations[0]!.attempt, 4);
          assert.equal(state.reservations[0]!.outcome, "submitted");
          assert.equal(state.reservations[0]!.head, head);
          const receiptId = await reviewReceiptId(currentKey, head);
          const retained = state.reviews.find((receipt) =>
            receipt.id === receiptId
          );
          assert.ok(
            retained,
            "the original change-only receipt remains durable",
          );
          assert.equal(retained.taskAcceptance, null);
          assert.equal(retained.outcome, "completed");
          assert.equal(
            rig.github.calls.some((call) => call.startsWith("closeIssue:")),
            false,
            label,
          );
        } else if (alreadySatisfied) {
          assert.equal(
            outcome.detail,
            "all eligible work is deferred (cooldown or run bounds)",
            label,
          );
          assert.equal(work.nextStep, "delivery", label);
          assert.equal(work.blocker, null, label);
          assert.deepEqual(work.intent, {
            kind: "already_satisfied_closure",
            key: `satisfied:7:${head}:${SHA1}`,
            startedAt: rig.clock.now(),
            branch: "sentinel/repair/issue-1",
            expectedHead: head,
            observedBase: SHA1,
            pr: 7,
            requestId: "review-req-1",
            resultId: "result-1",
          });
          assert.deepEqual(work.target, reviewWaitIssueRecord(head).target);
          assert.deepEqual(work.counters, {
            attempts: 1,
            retries: 0,
            reviewRounds: 1,
          });
          const receiptId = await reviewReceiptId(currentKey, head);
          const retained = state.reviews.find((receipt) =>
            receipt.id === receiptId
          );
          assert.ok(retained);
          assert.deepEqual(retained.taskAcceptance, acceptance);
          assert.equal(retained.outcome, "completed");
          assert.ok(
            work.evidence.some((evidence) =>
              evidence.kind === "review_receipt" &&
              evidence.ref === reviewEvidenceRef(receiptId)
            ),
          );
          assert.equal(rig.github.reviewRequestIdentities.length, 0, label);
          assert.equal(state.reservations.length, 0, label);
          assert.equal(rig.github.calls.includes("createPr"), false, label);
          assert.equal(rig.github.pushes.length, 0, label);
        } else {
          assert.equal(work.nextStep, "blocked", label);
          assert.equal(work.blocker?.message, detail, label);
          assert.equal(work.blocker?.kind, kind, label);
        }
        assert.equal(rig.model.requests.length, 0);
        assert.equal(
          rig.github.calls.some((call) => call.startsWith("closeIssue:")),
          false,
          `${label} must never close an issue`,
        );
        assert.equal(work.target.head, head);
        assert.equal(
          rig.github.calls.includes("merge"),
          false,
          `${label} must never merge`,
        );
        assert.equal(
          state.releaseRequests.length,
          0,
          `${label} must never request a release`,
        );
        assert.equal(
          state.work[0]!.target.pr,
          7,
          "the publication identity is retained for audit",
        );
      } finally {
        await rig.ctx.cleanup();
      }
    }
  },
);

Deno.test(
  "semantic acceptance: the exact bound fulfilled verdict delivers",
  async () => {
    const head = SHA2;
    const rig = await semanticRig("semantic-fulfilled", head);
    try {
      const completedAt = rig.clock.now() + 1000;
      rig.github.reviewObservationsByKey.set(
        `review:7:${head}`,
        acceptedObservation(head, {
          issueNumber: 1,
          taskDigest: FAKE_ISSUE_TASK_DIGEST,
          verdict: "fulfilled",
          evidence: ["the exact candidate change implements the source issue"],
        }, completedAt),
      );
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.blocker, null);
      assert.equal(work.nextStep, "delivery");
      assert.equal(
        rig.github.calls.filter((call) => call === "merge").length,
        1,
        "the exact bound verdict is the only path to the merge",
      );
      assert.equal(state.reviews.length, 1);
      assert.equal(state.reviews[0]!.taskAcceptance?.verdict, "fulfilled");
      assert.equal(state.releaseRequests.length, 1);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "semantic acceptance: unverifiable task context never delivers and never merges",
  async () => {
    const head = SHA2;
    // Exact published identity, but the live issue read answers "missing": the
    // trusted context cannot be built, so no delivery may be authorized.
    const github = new RelationsFakeGithub({
      baseSha: SHA1,
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": head },
        pullRequests: [exactOpenPr(7, head, "sentinel/repair/issue-1")],
      },
    });
    github.latest.set(1, null);
    const rig = await makeRig("semantic-nocontext", {
      summaries: false,
      githubPort: github,
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([reviewWaitIssueRecord(head)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      rig.clock.advance(3600_000 + 1);
      const at = rig.clock.now() + 1000;
      github.reviewObservationsByKey.set(
        `review:7:${head}`,
        acceptedObservation(head, {
          issueNumber: 1,
          taskDigest: FAKE_ISSUE_TASK_DIGEST,
          verdict: "fulfilled",
          evidence: ["the exact candidate change implements the source issue"],
        }, at),
      );
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(
        work.nextStep === "delivery",
        false,
        "missing context is never a delivery",
      );
      assert.equal(
        work.blocker?.message === TASK_ACCEPTANCE_MISSING_DETAIL,
        false,
      );
      assert.equal(
        github.calls.includes("merge"),
        false,
        "no merge is attempted against an unverifiable task context",
      );
      assert.equal(state.releaseRequests.length, 0);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "semantic acceptance: a closed post-merge source issue still authorizes the exact reviewed delivery",
  async () => {
    const head = SHA2;
    // GitHub auto-closes the issue through the published "Resolves #N" link at
    // merge time; the SAME canonical title/body digest must keep the delivery
    // releasable and closable.
    const github = new RelationsFakeGithub({
      baseSha: SHA1,
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": head },
        pullRequests: [exactOpenPr(7, head, "sentinel/repair/issue-1")],
      },
    });
    github.latest.set(1, issueRecord(1, { state: "closed" }));
    const rig = await makeRig("semantic-closed", {
      summaries: false,
      githubPort: github,
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([reviewWaitIssueRecord(head)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      rig.clock.advance(3600_000 + 1);
      const at = rig.clock.now() + 1000;
      github.reviewObservationsByKey.set(
        `review:7:${head}`,
        acceptedObservation(head, {
          issueNumber: 1,
          taskDigest: FAKE_ISSUE_TASK_DIGEST,
          verdict: "fulfilled",
          evidence: ["the exact candidate change implements the source issue"],
        }, at),
      );
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const work = state.work[0]!;
      assert.equal(work.blocker, null);
      assert.equal(work.nextStep, "delivery");
      assert.equal(
        github.calls.filter((call) => call === "merge").length,
        1,
        "the closed-at-merge issue keeps the same trusted task digest",
      );
      assert.equal(state.releaseRequests.length, 1);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "semantic acceptance: an unreadable source issue is never reviewed into a false task",
  async () => {
    const head = SHA2;
    // Exact published identity (so the freshness gate admits a new request)
    // with the source issue deliberately absent: no live task can be read.
    const github = new RelationsFakeGithub({
      baseSha: SHA1,
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": head },
        pullRequests: [exactOpenPr(7, head, "sentinel/repair/issue-1")],
      },
    });
    github.latest.set(1, null);
    const rig = await makeRig("semantic-stale", {
      summaries: false,
      githubPort: github,
    });
    try {
      const written = await rig.store.writeRepair(
        seededSnapshot([reviewWaitIssueRecord(head)]),
        null,
      );
      assert.ok(written.ok && written.value.status === "applied");
      // Leave the seeded review wait behind so the record is eligible again.
      rig.clock.advance(3600_000 + 1);
      // A bound no-verdict review forces the bounded re-attempt path, which
      // must NOT submit a review that could never carry the task acceptance.
      const at = rig.clock.now() + 1000;
      github.reviewObservationsByKey.set(
        `review:7:${head}`,
        noVerdictObservation(
          head,
          "structured review unavailable: no accepted result",
          at,
        ),
      );
      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.equal(state.work[0]!.nextStep, "blocked");
      assert.equal(state.work[0]!.blocker?.kind, "stale_source");
      assert.equal(
        state.work[0]!.blocker?.message,
        "source issue is not open: no task-bound review can be requested",
      );
      assert.equal(
        github.calls.includes("requestReview"),
        false,
        "no review is requested without a live task statement",
      );
      assert.equal(
        state.reservations.filter((reservation) =>
          reservation.purpose === "review_request"
        ).length,
        0,
        "no review start is ever charged for an unreadable task",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
