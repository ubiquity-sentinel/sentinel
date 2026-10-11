/**
 * GitHubCodexReviewTransport: durable review-service transport.
 *
 * The durable operation journal is the authenticated pending GitHub review
 * itself: an intent body is created before any model work, a running body is
 * persisted (and read back byte-exact) before the single turn/start, and a
 * ready body carrying the full validated structured result is persisted before
 * publication. A fresh transport instance reconciles exclusively through those
 * authoritative records — no in-memory-only success, no process adoption from
 * remote metadata, no blind mutation retry and no duplicate model start.
 *
 * Lifecycle (hard enforced):
 *   validate identity/deadline -> immutable snapshot -> exhaustive PR review
 *   reconciliation -> exact pending intent create (lost-create reconciliation
 *   by exact identity, never a second create) -> authenticated intent readback
 *   -> prepare producer -> running journal + byte-exact readback -> deadline
 *   recheck -> exactly one start (owned promise registered before returning).
 *
 * The owned promise closes the producer session, folds the close outcome into
 * the completion (`finalizeReviewCompletion`), persists the exact ready journal
 * (or a static unavailable disposition only after process settlement is
 * proved), reconciles the exact ready bytes and submits COMMENT. Lost submit
 * responses are reconciled by exact review id; only a standing COMMENTED exact
 * author/head/body proves publication.
 *
 * There is no independent model-admission authority here: the caller's durable
 * reservation/work intent is the authority for the submission. The concurrent
 * operation bound is explicit configuration: null or omitted means no
 * artificial bound, and a finite positive integer is honored exactly.
 * Overlapping submissions per operation key or per PR are rejected, and
 * admission stops permanently once drain starts.
 */

import type {
  ReviewRequestSubmitV1,
  ReviewServiceReadV1,
  ReviewServiceTransportV1,
  ReviewSubmitOutcomeV1,
} from "./review-service.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import {
  checkReviewTaskStatement,
  type ReviewTaskStatementV1,
} from "../contracts/review-receipt.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { ReviewRequestReadV1 } from "./review-service.ts";
import { GitHubReviewTransportLifecycle } from "./review-transport-lifecycle.ts";
import {
  DETAIL_CAPACITY,
  DETAIL_DRAIN,
  DETAIL_FAILURE,
  DETAIL_INPUT,
  DETAIL_OVERLAP,
  DETAIL_READ,
  DETAIL_TASK,
  isActiveReview,
} from "./review-transport-policy.ts";

export class GitHubCodexReviewTransport extends GitHubReviewTransportLifecycle
  implements ReviewServiceTransportV1 {
  // -------------------------------------------------------------------------
  // submitReview
  // -------------------------------------------------------------------------

  async submitReview(
    request: ReviewRequestSubmitV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>> {
    const now = this.clock.now();
    // The optional task statement is validated BEFORE any operation is
    // registered: a malformed statement or a digest that does not bind its
    // own text is refused statically and never reaches a model.
    let task: ReviewTaskStatementV1 | null = null;
    if (request?.task !== undefined && request?.task !== null) {
      const checked = await checkReviewTaskStatement(request.task);
      if (!checked.ok) return portError("invalid", DETAIL_TASK);
      task = checked.statement;
    }
    const validated = this.validateSubmission(request, now, task);
    if (!validated.ok) return validated.error;
    const op = validated.value;
    if (this.draining) return portError("unavailable", DETAIL_DRAIN);
    const existing = this.operations.get(op.operationKey);
    if (existing !== undefined && isActiveReview(existing)) {
      return portError("conflict", DETAIL_OVERLAP);
    }
    for (const other of this.operations.values()) {
      if (isActiveReview(other) && other.prNumber === op.prNumber) {
        return portError("conflict", DETAIL_OVERLAP);
      }
    }
    if (
      this.maxActiveReviews !== null &&
      this.activeCount() >= this.maxActiveReviews
    ) {
      return portError("conflict", DETAIL_CAPACITY);
    }
    this.operations.set(op.operationKey, op);

    // The admission work is owned from the first await: the promise is
    // registered before the caller can advance, and drain awaits it so a
    // submission in flight can never start a model after admission stopped.
    op.submissionSettled = false;
    const submission = (async () => {
      try {
        return await this.runSubmission(op);
      } catch {
        // A thrown transport fault is sanitized; any owned prepared session is
        // still closed (settlement is never assumed) and the operation settles
        // locally so no handle is left unowned.
        await this.closePrepared(op);
        op.phase = "failed";
        op.done = true;
        return portError("unavailable", DETAIL_FAILURE);
      }
    })();
    op.submission = submission.then(
      () => {
        op.submissionSettled = true;
      },
      () => {
        op.submissionSettled = true;
      },
    );
    return await submission;
  }

  // -------------------------------------------------------------------------
  // readReview
  // -------------------------------------------------------------------------

  async readReview(
    request: ReviewRequestReadV1,
  ): Promise<PortResultV1<ReviewServiceReadV1>> {
    const operationKey = request.operationKey;
    const requestId = request.requestId;
    if (
      (operationKey === null && requestId === null) ||
      !Number.isSafeInteger(request.prNumber) || request.prNumber < 1
    ) {
      return portError("invalid", DETAIL_INPUT);
    }
    // The local fast path binds the requested PR and EVERY supplied identity:
    // the first map match alone is never an exact live operation.
    const local = this.matchLocal(request);
    if (local !== undefined && isActiveReview(local)) {
      // An exact live owned operation is the only source of a `pending` read.
      return portOk(this.liveReceipt(local));
    }

    const read = await this.client.readReviews(request.prNumber);
    if (!read.ok) return portError(read.error.kind, DETAIL_READ);
    const bound = await this.bindRecords({
      operationKey,
      requestId,
      prNumber: request.prNumber,
    }, read.value);
    if (bound.kind !== "one") return portOk(this.unavailableReceipt(request));

    // A durable ready journal awaiting publication is recovered EXACTLY here,
    // on the actual observation path: the original body and identities are
    // reused, and no snapshot, preparation, model start or new budget
    // reservation happens.
    if (bound.journal.phase === "ready" && bound.review.state === "pending") {
      return await this.publishDurableReady(
        request,
        bound.journal,
        bound.review,
      );
    }
    if (bound.journal.phase === "ready" && bound.review.state !== "commented") {
      return portOk(this.unavailableReceipt(request));
    }
    if (
      bound.journal.phase !== "ready" &&
      (bound.review.state !== "pending" || bound.review.submittedAt !== null)
    ) {
      return portOk(this.unavailableReceipt(request));
    }
    return portOk(this.journalReceipt(bound.journal, bound.review));
  }
}

export type { GitReviewSnapshotCaptureV1 } from "./review-transport-contracts.ts";
export type { CodexReviewPrepareCapabilityV1 } from "./review-transport-contracts.ts";
export type { GitHubCodexReviewTransportOptionsV1 } from "./review-transport-contracts.ts";
export { REVIEW_TRANSPORT_TOTAL_MS } from "./review-transport-policy.ts";
export { MAX_UNAVAILABLE_REASON_CHARS } from "./review-transport-policy.ts";
export { staticUnavailableSummary } from "./review-transport-policy.ts";
