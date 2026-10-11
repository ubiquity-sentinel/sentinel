/** Retired pull requests and exact orphan adoption. */
import assert from "node:assert/strict";
import { asWorkItemId } from "../../src/contracts/brands.ts";
import type { WorkItemId } from "../../src/contracts/brands.ts";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { candidateBranch, workItemIdForIssue } from "../../src/repair/keys.ts";
import {
  applyHostedRetirements,
  HOSTED_AUTONOMY_RETIRED,
  hostedIssueKey,
  planHostedRetirements,
} from "../../ops/hosted-autonomy.ts";
import {
  REPO,
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { issueRecord, makeRig, seededSnapshot } from "./loop-rig.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

const RETIRED_AI_120 = workItemIdForIssue(REPO, 120);
const RETIRED_SENTINEL_61 = workItemIdForIssue(REPO, 61);
const HUMAN_MERGED_264 = workItemIdForIssue(REPO, 264);
const FRESH_AFTER_RETIREMENT = workItemIdForIssue(REPO, 999);

/** One closed-unmerged-PR record in the shape retirement consumes. */
function retiredPrRecord(
  id: WorkItemId,
  issueNumber: number,
  pr: number,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord(id, {
    source: { kind: "issue", id: String(issueNumber), revision: SHA1 },
    related: { incidentId: null, issueNumber },
    target: {
      base: SHA1,
      branch: `sentinel/repair/issue-${issueNumber}`,
      checkpoint: null,
      head: SHA2,
      pr,
    },
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: T0 + 3_600_000 },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

/** One open issue row served to the real intake in these cases. */
function freshIssueRow(number: number): GitHubIssueV1 {
  return issueRecord(number, {
    title: "fresh eligible repair after retirements",
    labels: ["P2", "priority:9"],
    createdAt: T0 - 100,
  });
}

Deno.test(
  "retired PR WIP: actual retirements free two slots and the fresh issue starts exactly one model session",
  async () => {
    const rig = await makeRig("retired-wip", {
      summaries: false,
      github: {
        openIssues: [freshIssueRow(999)],
        // The pre-admission freshness re-read must resolve the same row.
        issues: [freshIssueRow(999)],
      },
    });
    try {
      const retiredAi120 = retiredPrRecord(RETIRED_AI_120, 120, 375, {
        evidence: [{
          kind: "review_receipt",
          ref: "artifact:review-receipt/ai-120",
        }],
      });
      const retiredSentinel61 = retiredPrRecord(RETIRED_SENTINEL_61, 61, 63, {
        counters: { attempts: 2, retries: 0, reviewRounds: 1 },
        intent: {
          kind: "implementation",
          key: "implementation:sentinel-61",
          startedAt: T0 + 500,
          branch: "sentinel/repair/issue-61",
          expectedHead: null,
          observedBase: SHA1,
          pr: null,
          requestId: "charge-61",
          resultId: null,
        },
      });
      // ai#264 / PR393: human-merged but unaccepted, so it stays counted.
      const humanMerged264 = retiredPrRecord(HUMAN_MERGED_264, 264, 393, {
        nextStep: "delivery",
      });
      const historicalCharge = reservation("charge-61", {
        taskId: RETIRED_SENTINEL_61,
        head: SHA1,
        attempt: 2,
        purpose: "implementation",
        outcome: "submitted",
        settledAt: T0 + 2000,
      });
      const historicalReceipt = reviewReceipt("review-receipt-ai-120", {
        pullRequest: { number: 375, head: SHA2, base: SHA1 },
        submittedAt: T0 + 1000,
        observedAt: T0 + 2000,
      });
      const seeded = seededSnapshot(
        [retiredAi120, retiredSentinel61, humanMerged264],
        { reservations: [historicalCharge], reviews: [historicalReceipt] },
      );
      const seededWrite = await rig.store.writeRepair(seeded, null);
      assert.ok(seededWrite.ok && seededWrite.value.status === "applied");
      const read = await rig.store.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("seeded repair state unavailable");
      }

      const plans = planHostedRetirements(
        read.value.snapshot,
        new Set([hostedIssueKey(REPO, 120), hostedIssueKey(REPO, 61)]),
        new Set([retiredAi120.id, retiredSentinel61.id]),
      );
      assert.deepEqual(
        plans.map((plan) => plan.id).sort(),
        [retiredAi120.id, retiredSentinel61.id].sort(),
        "the actual retirement helper parks both closed-unmerged PRs",
      );
      const retired = applyHostedRetirements(
        read.value.snapshot,
        read.value.head,
        plans,
        T0 + 1000,
      );
      const retiredWrite = await rig.store.writeRepair(
        retired,
        read.value.head,
      );
      assert.ok(retiredWrite.ok && retiredWrite.value.status === "applied");
      // The retirement write advanced the durable state past the frozen rig
      // clock; move the fake clock forward so the run's own writes are legal.
      rig.clock.advance(2_000);

      const outcome = await rig.run();
      // Semantic red before the fix: the two retired records still count, the
      // fresh issue is WIP-skipped and this is 0 with no model start.
      assert.equal(rig.model.requests.length, 1, JSON.stringify(outcome));
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));

      const state = await rig.snapshot();
      const fresh = state.work.find((record) =>
        record.id === FRESH_AFTER_RETIREMENT
      );
      assert.ok(fresh, "the fresh issue reached durable state");
      assert.equal(fresh.counters.attempts, 1);
      assert.equal(
        state.reservations.filter((record) =>
          record.taskId === FRESH_AFTER_RETIREMENT &&
          record.purpose === "implementation"
        ).length,
        1,
        "exactly one durable implementation charge",
      );

      const ai120 = state.work.find((record) => record.id === RETIRED_AI_120);
      assert.ok(ai120);
      assert.equal(ai120.nextStep, "blocked");
      assert.equal(ai120.target.pr, 375);
      assert.equal(ai120.target.head, SHA2);
      assert.equal(ai120.blocker?.kind, "other");
      assert.equal(ai120.blocker?.message, HOSTED_AUTONOMY_RETIRED);
      assert.equal(ai120.wait, null);
      assert.equal(ai120.intent, null);
      assert.equal(ai120.counters.attempts, 1);
      assert.equal(ai120.counters.reviewRounds, 1);

      const sentinel61 = state.work.find((record) =>
        record.id === RETIRED_SENTINEL_61
      );
      assert.ok(sentinel61);
      assert.equal(sentinel61.nextStep, "blocked");
      assert.equal(sentinel61.target.pr, 63);
      assert.equal(sentinel61.target.head, SHA2);
      assert.equal(sentinel61.blocker?.kind, "other");
      assert.equal(sentinel61.blocker?.message, HOSTED_AUTONOMY_RETIRED);
      assert.equal(sentinel61.wait, null);
      assert.equal(sentinel61.intent, null);
      assert.equal(sentinel61.counters.attempts, 2);
      assert.equal(sentinel61.counters.reviewRounds, 1);

      assert.ok(
        state.reservations.some((record) =>
          record.id === historicalCharge.id &&
          record.outcome === "submitted"
        ),
        "the historical charge is retained",
      );
      assert.ok(
        state.reviews.some((record) => record.id === historicalReceipt.id),
        "the historical review receipt is retained",
      );

      const humanMerged = state.work.find((record) =>
        record.id === HUMAN_MERGED_264
      );
      assert.ok(humanMerged);
      assert.equal(humanMerged.nextStep, "delivery");
      assert.equal(humanMerged.target.pr, 393);
      assert.equal(humanMerged.target.head, SHA2);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "retired PR WIP: two terminal blocks free the cap so a fresh issue starts (control)",
  async () => {
    const rig = await makeRig("retired-wip-control", {
      summaries: false,
      github: {
        openIssues: [freshIssueRow(999)],
        // The control must fail only on the cap: a missing issue row would
        // produce zero starts for the wrong reason.
        issues: [freshIssueRow(999)],
      },
    });
    try {
      const genericBlocked = retiredPrRecord(
        workItemIdForIssue(REPO, 301),
        301,
        401,
        {
          nextStep: "blocked",
          wait: null,
          blocker: {
            kind: "other",
            message: "model run ended without a trusted receipt",
            since: T0,
          },
        },
      );
      const unavailableBlocked = retiredPrRecord(
        workItemIdForIssue(REPO, 302),
        302,
        402,
        {
          nextStep: "blocked",
          wait: null,
          blocker: {
            kind: "unavailable",
            message: "review transport unavailable",
            since: T0,
          },
        },
      );
      const waitingReview = retiredPrRecord(
        workItemIdForIssue(REPO, 303),
        303,
        403,
      );
      const write = await rig.store.writeRepair(
        seededSnapshot([genericBlocked, unavailableBlocked, waitingReview]),
        null,
      );
      assert.ok(write.ok && write.value.status === "applied");

      const outcome = await rig.run();
      // The two terminal blocks free their slots; only the one live waiting PR
      // still counts, so the fresh issue is admitted and starts one model run.
      assert.equal(rig.model.requests.length, 1, JSON.stringify(outcome));

      const state = await rig.snapshot();
      const fresh = state.work.find((record) =>
        record.id === FRESH_AFTER_RETIREMENT
      );
      assert.ok(fresh, "the fresh issue was admitted into state");
      assert.equal(fresh.counters.attempts, 1, "the fresh issue ran");
      assert.equal(
        state.work.filter((record) => record.nextStep === "blocked").length,
        2,
        "the two terminal blocks stay terminal",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "issue-141: a live PR is discovered and attached before the unfinished-PR cap is enforced",
  async () => {
    const taskId = asWorkItemId("issue-141");
    const branch = candidateBranch(taskId);
    const rig = await makeRig("orphan-attach", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: SHA3 },
          pullRequests: [exactOpenPr(9, SHA3, branch)],
        },
      },
    });
    try {
      // Three live (waiting) publications saturate the cap. They are skipped
      // as waiting, so only the orphan can make progress.
      const saturated = [1, 2, 3].map((n) =>
        workRecord(`issue-${n}`, {
          source: { kind: "issue", id: String(n), revision: SHA1 },
          related: { incidentId: null, issueNumber: n },
          target: {
            base: SHA1,
            branch: `sentinel/repair/issue-${n}`,
            checkpoint: null,
            head: SHA3,
            pr: n,
          },
          nextStep: "review",
          wait: {
            reason: "review_pending",
            since: T0,
            until: T0 + 3_600_000,
          },
        })
      );
      const orphan = workRecord("issue-141", {
        source: { kind: "issue", id: "141", revision: SHA1 },
        related: { incidentId: null, issueNumber: 141 },
        target: {
          base: SHA1,
          branch,
          checkpoint: null,
          head: SHA3,
          pr: null,
        },
        nextStep: "work",
        intent: {
          kind: "pull_request",
          key: `pr:${SHA3}`,
          startedAt: T0,
          branch,
          expectedHead: SHA3,
          observedBase: SHA1,
          pr: null,
          requestId: null,
          resultId: null,
        },
      });
      const seeded = await rig.store.writeRepair(
        seededSnapshot([...saturated, orphan]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");

      const outcome = await rig.run();
      assert.equal(outcome.status, "idle", JSON.stringify(outcome));
      const state = await rig.snapshot();
      const attached = state.work.find((record) => record.id === "issue-141");
      assert.ok(attached, "the orphan record still exists");
      assert.equal(
        attached?.target.pr,
        9,
        "the existing live PR is attached instead of being WIP-skipped",
      );
      assert.equal(
        rig.github.calls.filter((call) => call === "createPr").length,
        0,
        "no replacement PR is created for an already-published branch",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "orphan PR with a foreign base is not adopted even at the exact head",
  async () => {
    const taskId = asWorkItemId("issue-142");
    const branch = candidateBranch(taskId);
    const foreignPr = {
      ...exactOpenPr(9, SHA3, branch),
      baseRef: "main",
    };
    const rig = await makeRig("orphan-foreign-base", {
      summaries: false,
      github: {
        candidateLifecycle: {
          ...positiveLifecycle(),
          refs: { [`refs/heads/${branch}`]: SHA3 },
          pullRequests: [foreignPr],
        },
      },
    });
    try {
      const orphan = workRecord("issue-142", {
        source: { kind: "issue", id: "142", revision: SHA1 },
        related: { incidentId: null, issueNumber: 142 },
        target: {
          base: SHA1,
          branch,
          checkpoint: null,
          head: SHA3,
          pr: null,
        },
        nextStep: "work",
        intent: {
          kind: "pull_request",
          key: `pr:${SHA3}`,
          startedAt: T0,
          branch,
          expectedHead: SHA3,
          observedBase: SHA1,
          pr: null,
          requestId: null,
          resultId: null,
        },
      });
      const seeded = await rig.store.writeRepair(
        seededSnapshot([orphan]),
        null,
      );
      assert.ok(seeded.ok && seeded.value.status === "applied");

      await rig.run();
      const state = await rig.snapshot();
      const record = state.work.find((work) => work.id === "issue-142");
      assert.ok(record, "the orphan record still exists");
      assert.equal(
        record?.target.pr,
        null,
        "the foreign-base PR is never adopted at the exact head",
      );
      assert.equal(
        record?.nextStep,
        "blocked",
        "the foreign publication terminally blocks instead of cycling",
      );
      assert.equal(
        record?.blocker?.message,
        "PR base identity mismatch",
        "the blocker names the base identity mismatch",
      );
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
