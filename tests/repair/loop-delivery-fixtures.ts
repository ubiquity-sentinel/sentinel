/** Exact local-release request and receipt fixtures. */
import type { GitSha } from "../../src/contracts/brands.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { parseLocalReleaseReceiptV1 } from "../../src/contracts/local-release.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  releaseRequest,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import { LOCAL_SENTINEL_REPO } from "./loop-rig.ts";

/**
 * Another repository that also uses the explicit no-App credential scope
 * (installationId 0) but is not `Ubiquity-Sentinel/sentinel`. It is not the local
 * Sentinel scope, so it must never consult or consume the Sentinel local
 * receipt.
 */
export const OTHER_SCOPE_ZERO_REPO = {
  owner: "ubiquity",
  name: "sentinel-fork",
  installationId: 0,
} as const;

/** One local production request bound to the delivery record below. */
export function localDeliveryRequest(
  id: string,
  revision: GitSha,
): ReleaseRequestV1 {
  return releaseRequest(id, {
    target: { repository: LOCAL_SENTINEL_REPO, environment: "production" },
    revision,
    source: {
      pullRequest: 12,
      reviewRequestId: `review-req-${id}`,
      reviewReceiptId: `review-receipt-${id}`,
      head: SHA1,
      base: SHA2,
    },
    createdAt: T0,
  });
}

/** A local production request for the same PR/head with a different base. */
export function wrongBaseLocalRequest(id: string): ReleaseRequestV1 {
  return releaseRequest(id, {
    target: { repository: LOCAL_SENTINEL_REPO, environment: "production" },
    revision: SHA3,
    source: {
      pullRequest: 12,
      reviewRequestId: `review-req-${id}`,
      reviewReceiptId: `review-receipt-${id}`,
      head: SHA1,
      base: SHA3,
    },
    createdAt: T0,
  });
}

/** A strict accepted local receipt for one exact request. */
export function localAcceptedReceipt(request: ReleaseRequestV1) {
  return parseLocalReleaseReceiptV1({
    version: "v1",
    kind: "local_release_receipt",
    request,
    priorRevision: SHA2,
    phase: "accepted",
    candidateProof: {
      invocationId: "inv-candidate",
      controllerSha: request.revision,
      startedAt: T0 + 1000,
      finishedAt: T0 + 2000,
      outcome: "idle",
    },
    priorProof: {
      invocationId: "inv-prior",
      controllerSha: SHA2,
      startedAt: T0,
      finishedAt: T0 + 500,
      outcome: "idle",
    },
    createdAt: T0,
    updatedAt: T0 + 2000,
  });
}

/**
 * The default local delivery issue: a valid positive number with a coherent
 * issue source id. Issue tasks never carry a null `related.issueNumber`.
 */
export const LOCAL_DELIVERY_ISSUE = 42;

/**
 * A local-scope delivery record: it targets the configured local
 * (installationId 0) repository scope and carries a coherent issue source, so
 * the frozen parser accepts it and the real local consumer is exercised.
 */
export function localDeliveryRecord(
  issueNumber: number = LOCAL_DELIVERY_ISSUE,
): WorkRecordV1 {
  return workRecord("local-delivery-1", {
    repository: LOCAL_SENTINEL_REPO,
    source: { kind: "issue", id: String(issueNumber), revision: SHA1 },
    related: { incidentId: null, issueNumber },
    target: { base: SHA2, branch: null, checkpoint: null, head: SHA1, pr: 12 },
    nextStep: "delivery",
    updatedAt: T0 + 1000,
  });
}

/** The explicit nonlocal control record: ai.ubq.fi under installation 7. */
export function gatewayDeliveryRecord(): WorkRecordV1 {
  return workRecord("local-delivery-1", {
    repository: REPO,
    source: { kind: "issue", id: String(LOCAL_DELIVERY_ISSUE), revision: SHA1 },
    related: { incidentId: null, issueNumber: LOCAL_DELIVERY_ISSUE },
    target: { base: SHA2, branch: null, checkpoint: null, head: SHA1, pr: 12 },
    nextStep: "delivery",
    updatedAt: T0 + 1000,
  });
}

/** Digest of the blanket fake's synthesized issue #42 text (empty body). */
export const LOCAL_DELIVERY_TASK_DIGEST = await reviewTaskStatementDigest({
  issueNumber: LOCAL_DELIVERY_ISSUE,
  title: `issue ${LOCAL_DELIVERY_ISSUE}`,
  body: "",
});

/**
 * The EXACT review receipt a delivery release request references: the id and
 * review request id the request persisted, bound to the record's repository,
 * PR/head/base and live source-issue text so the shared FULL authorization
 * predicate holds (trusted reviewer, zero uncounted findings, no unresolved
 * P0/P1, positive bound acceptance). `overrides` changes one dimension at a
 * time in the refusal cases, so each refusal proves that exact dimension while
 * every other field stays the genuine bound proof.
 */
export function referencedDeliveryReceipt(
  request: ReleaseRequestV1,
  record: WorkRecordV1,
  taskDigest: string,
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  const receiptId = request.source.reviewReceiptId;
  const issueNumber = record.related.issueNumber;
  if (receiptId === null || issueNumber === null) {
    throw new Error("an issue-backed delivery fixture needs both identities");
  }
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: receiptId,
    requestId: request.source.reviewRequestId,
    expectedReviewer: "chatgpt-codex-connector[bot]",
    observedReviewer: "chatgpt-codex-connector[bot]",
    repository: record.repository,
    pullRequest: {
      number: request.source.pullRequest,
      head: request.source.head,
      base: request.source.base,
    },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    taskAcceptance: {
      issueNumber,
      taskDigest,
      verdict: "fulfilled",
      evidence: ["the exact reviewed change implements the source issue"],
    },
    submittedAt: T0,
    completedAt: T0 + 1000,
    observedAt: T0 + 1001,
    ...overrides,
  });
}

/**
 * Matching-request accepted receipts whose proof is missing, failed or bound
 * to the wrong revision: cast values an injected reader may return and that
 * the consumer must reject before any accepted/closure/blocked transition.
 */
export function malformedAcceptedReceipts(
  request: ReleaseRequestV1,
): unknown[] {
  const valid = localAcceptedReceipt(request);
  return [
    { ...valid, candidateProof: null },
    {
      ...valid,
      candidateProof: {
        invocationId: "inv-candidate-failed",
        controllerSha: request.revision,
        startedAt: T0 + 1000,
        finishedAt: T0 + 2000,
        outcome: "state_error",
      },
    },
    {
      ...valid,
      candidateProof: {
        invocationId: "inv-candidate-wrong",
        controllerSha: SHA2,
        startedAt: T0 + 1000,
        finishedAt: T0 + 2000,
        outcome: "idle",
      },
    },
  ];
}
