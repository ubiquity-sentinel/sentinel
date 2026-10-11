/** Task-bound review observations and seeded delivery records. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { ReviewObservationV1 } from "../../src/contracts/ports.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewTaskAcceptanceV1 } from "../../src/contracts/review-receipt.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { TASK_ACCEPTANCE_MISSING_DETAIL } from "../../src/repair/review-gate.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { reviewOperationKey, reviewReceiptId } from "../../src/repair/keys.ts";
import { scopeLocalRepairIssues } from "../../src/host/local.ts";
import {
  reservation,
  reviewReceipt,
  SHA1,
  SHA2,
  T0,
  workRecord,
} from "../state/helpers.ts";
import type { FakeGithub } from "./helpers.ts";
import {
  issueRecord,
  makeMemoryRig,
  makeRig,
  RelationsFakeGithub,
  seededSnapshot,
} from "./loop-rig.ts";
import { exactOpenPr, positiveLifecycle } from "./loop-candidate-fixtures.ts";

/**
 * Digest of the blanket fake's synthesized issue #1 text ("issue 1", empty
 * body). Authorization compares the receipt's acceptance digest against this
 * TRUSTED live digest, never against a digest the model echoed back.
 */
export const FAKE_ISSUE_TASK_DIGEST = await reviewTaskStatementDigest({
  issueNumber: 1,
  title: "issue 1",
  body: "",
});

/** One issue-backed record parked on the review of its exact published head. */
export function reviewWaitIssueRecord(head: GitSha): WorkRecordV1 {
  return workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    nextStep: "review",
    wait: { reason: "review_pending", since: T0, until: T0 + 3600_000 },
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1",
      checkpoint: null,
      head,
      pr: 7,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
  });
}

/** Completed review observation for the exact head and chosen acceptance. */
export function acceptedObservation(
  head: GitSha,
  taskAcceptance: ReviewTaskAcceptanceV1 | null,
  at: number,
): ReviewObservationV1 {
  return {
    status: "completed",
    requestId: "review-req-1",
    reviewer: "chatgpt-codex-connector[bot]",
    resultId: "result-1",
    completedAt: at,
    observedHead: head,
    observedBase: SHA1,
    findings: [],
    summary: null,
    receivedAt: at + 1,
    taskAcceptance,
  };
}

/** Issue-backed record at review, served by its exact per-operation fake. */
export async function semanticRig(
  prefix: string,
  head: GitSha,
  reviewRounds = 1,
) {
  const rig = await makeRig(prefix, {
    summaries: false,
    github: {
      candidateLifecycle: {
        ...positiveLifecycle(),
        refs: { "refs/heads/sentinel/repair/issue-1": head },
        pullRequests: [exactOpenPr(7, head, "sentinel/repair/issue-1")],
      },
    },
  });
  const written = await rig.store.writeRepair(
    seededSnapshot([workRecord("issue-1", {
      ...reviewWaitIssueRecord(head),
      counters: { attempts: 1, retries: 0, reviewRounds },
    })]),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  // Leave the seeded review wait behind so the record is eligible again.
  rig.clock.advance(3600_000 + 1);
  return rig;
}

/** Cheap refusal controls use the same loop and budget, without real Git copies. */
export async function missingTaskMemoryRig(
  options: ConstructorParameters<typeof FakeGithub>[0] = {},
  initialRounds = 2,
) {
  const head = SHA2;
  const operationKey = reviewOperationKey(7, head, initialRounds);
  const nextKey = reviewOperationKey(7, head, initialRounds + 1);
  const github = new RelationsFakeGithub({
    baseSha: SHA1,
    candidateLifecycle: {
      ...positiveLifecycle(),
      refs: { "refs/heads/sentinel/repair/issue-1": head },
      pullRequests: [exactOpenPr(7, head, "sentinel/repair/issue-1")],
    },
    ...options,
  });
  github.latest.set(
    1,
    issueRecord(1, { relations: { subIssueCount: 0, openBlockers: [] } }),
  );
  scopeLocalRepairIssues(github);
  const rig = makeMemoryRig(github);
  const observation = {
    ...acceptedObservation(head, null, T0 + 2000),
    requestId: "legacy-memory-request",
    resultId: "legacy-memory-result",
  };
  const legacy = reviewReceipt(await reviewReceiptId(operationKey, head), {
    requestId: observation.requestId,
    observedReviewer: observation.reviewer,
    pullRequest: { number: 7, head, base: SHA1 },
    outcome: "completed",
    resultId: observation.resultId,
    submittedAt: T0 + 1000,
    completedAt: observation.completedAt,
    observedAt: observation.receivedAt,
    taskAcceptance: null,
  });
  const record = workRecord("issue-1", {
    ...reviewWaitIssueRecord(head),
    nextStep: "blocked",
    wait: null,
    blocker: {
      kind: "other",
      message: TASK_ACCEPTANCE_MISSING_DETAIL,
      since: T0 + 3000,
    },
    counters: { attempts: 1, retries: 0, reviewRounds: initialRounds },
    updatedAt: T0 + 3000,
  });
  const charges = Array.from({ length: initialRounds }, (_, index) => index + 1)
    .map((attempt) =>
      reservation(`memory-prior-${attempt}`, {
        taskId: record.id,
        head,
        attempt,
        purpose: "review_request",
        outcome: "submitted",
        settledAt: T0 + 1000,
      })
    );
  const seeded = await rig.state.writeRepair(
    seededSnapshot([record], {
      updatedAt: T0 + 3000,
      reviews: [legacy],
      reservations: charges,
    }),
    null,
  );
  assert.ok(seeded.ok && seeded.value.status === "applied");
  github.releasedHead = head;
  github.reviewObservationsByKey.set(operationKey, observation);
  github.unboundReviewKeys.add(nextKey);
  rig.clock.advance(3600_000 + 1);
  return {
    ...rig,
    head,
    record,
    legacy,
    charges,
    operationKey,
    nextKey,
    observation,
  };
}

/** Issue task in the delivery phase with the given reviewed head and PR. */
export function deliveryRecord(
  head: GitSha,
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return workRecord("issue-1", {
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: SHA1,
      branch: "sentinel/repair/issue-1",
      checkpoint: null,
      head,
      pr: 7,
    },
    nextStep: "delivery",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

/** Completed clean review receipt bound to the exact reviewed PR/head/base. */
export function completedReceipt(
  pullRequest: number,
  head: GitSha,
  base: GitSha,
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: `review-receipt:${pullRequest}:${head}`,
    requestId: "review-req-1",
    expectedReviewer: "chatgpt-codex-connector[bot]",
    observedReviewer: "chatgpt-codex-connector[bot]",
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 7 },
    pullRequest: { number: pullRequest, head, base },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    // The delivery-record fixture source is issue #1: a completed verdict is
    // authorized only with this exact bound positive acceptance, and the digest
    // must bind the blanket fake's live issue #1 text.
    taskAcceptance: {
      issueNumber: 1,
      taskDigest: FAKE_ISSUE_TASK_DIGEST,
      verdict: "fulfilled",
      evidence: ["the exact reviewed change implements the source issue"],
    },
    submittedAt: T0,
    completedAt: T0 + 1000,
    observedAt: T0 + 1001,
    ...overrides,
  });
}

/** Terminal no-verdict observation for the exact published head. */
export function noVerdictObservation(
  head: GitSha,
  summary: string,
  at: number,
): ReviewObservationV1 {
  return {
    status: "unavailable",
    requestId: "review-req-1",
    reviewer: null,
    resultId: null,
    completedAt: at,
    observedHead: head,
    observedBase: SHA1,
    findings: [],
    summary,
    receivedAt: at + 1,
    taskAcceptance: null,
  };
}

/** Drive one task to its first review wait through the real lifecycle. */
export async function rigAtReviewWait(prefix: string) {
  const rig = await makeRig(prefix, {
    github: { candidateLifecycle: positiveLifecycle() },
  });
  const first = await rig.run();
  assert.equal(first.status, "idle", JSON.stringify(first));
  const state = await rig.snapshot();
  const work = state.work[0]!;
  assert.equal(work.nextStep, "review");
  assert.equal(work.wait?.reason, "review_pending");
  assert.equal(work.counters.reviewRounds, 1);
  return { rig, work };
}
