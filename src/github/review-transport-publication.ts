// review transport publication.

import type { StructuredReviewOutcomeV1 } from "./codex-reviewer.ts";
import {
  type ReviewJournalReadyV1,
  reviewResultDigest,
  type ReviewResultV1,
} from "./review-journal.ts";
import type { ReviewRequestReadV1 } from "./review-service.ts";
import type { GitHubReviewWireV1 } from "./wire.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type {
  ReviewServiceReadV1,
  ReviewSubmitOutcomeV1,
} from "./review-service.ts";
import { portOk } from "../contracts/ports.ts";
import { GitHubReviewTransportJournal } from "./review-transport-journal.ts";
import {
  DETAIL_FAILURE,
  DETAIL_PUBLISH,
  DETAIL_READBACK,
  DETAIL_RESULT_BOUND,
  type OwnedReviewV1,
  staticUnavailableSummary,
} from "./review-transport-policy.ts";

export abstract class GitHubReviewTransportPublication
  extends GitHubReviewTransportJournal {
  /**
   * Persist the exact ready journal (or a static unavailable disposition after
   * proved process settlement), reconcile the exact bytes and submit COMMENT.
   */
  protected async publishDisposition(
    op: OwnedReviewV1,
    outcome: StructuredReviewOutcomeV1 | null,
    /** Static sanitized reason of the refusing precondition, when known. */
    reason: string | null = null,
  ): Promise<void> {
    const reviewId = op.reviewId;
    if (reviewId === null) {
      op.fault = DETAIL_FAILURE;
      return;
    }
    // A failed disposition is published ONLY after the owned process is proved
    // settled: an unsettled session stays owned and is never relabelled.
    if (!op.processSettled) {
      op.fault = DETAIL_FAILURE;
      return;
    }
    const completedAt = this.clock.now();
    const result = outcome === null ? null : outcome.result;
    const execution = outcome === null ? null : outcome.execution;
    // The refusing precondition of an unavailable outcome is its own bounded
    // static detail; a settled failure that carries none keeps the generic
    // sentence. Never a raw error, a provider message or child output.
    const unavailableSummary = staticUnavailableSummary(
      reason ?? (outcome === null ? null : outcome.detail),
    );
    let journal: ReviewJournalReadyV1;
    if (
      outcome !== null && outcome.status !== "unavailable" && result !== null &&
      execution !== null && result.verdict !== "unavailable"
    ) {
      journal = {
        ...this.intentJournal(op),
        phase: "ready",
        reviewId,
        completedAt,
        result,
        resultDigest: await reviewResultDigest(result),
        execution,
      };
    } else {
      const unavailableResult: ReviewResultV1 = {
        verdict: "unavailable",
        summary: unavailableSummary,
        findings: [],
      };
      journal = {
        ...this.intentJournal(op),
        phase: "ready",
        reviewId,
        completedAt,
        result: unavailableResult,
        resultDigest: await reviewResultDigest(unavailableResult),
        execution: null,
      };
    }
    // A validated result may still be too large for the journal's duplicated
    // human-readable/base64 representation. Replace only that unpublished
    // result with the bounded terminal disposition; never publish a partial
    // rendering or leave the settled running journal behind.
    let body = this.render(journal);
    if (body === null) {
      const unavailableResult: ReviewResultV1 = {
        verdict: "unavailable",
        summary: staticUnavailableSummary(DETAIL_RESULT_BOUND),
        findings: [],
      };
      journal = {
        ...journal,
        result: unavailableResult,
        resultDigest: await reviewResultDigest(unavailableResult),
        execution: null,
      };
      body = this.render(journal);
    }
    if (body === null) {
      op.fault = DETAIL_PUBLISH;
      return;
    }
    const updated = await this.client.updatePendingReview(
      op.prNumber,
      reviewId,
      body,
    );
    if (!updated.ok) {
      op.fault = DETAIL_PUBLISH;
      return;
    }
    // An ambiguous update is reconciled by this exact readback; the update is
    // never repeated blindly.
    const readback = await this.readPhase(op, reviewId, {
      phase: "ready",
      body,
    });
    if (readback.kind !== "ok") {
      op.fault = DETAIL_READBACK;
      return;
    }
    op.readyDurable = true;
    const published = await this.submitPublication(op, reviewId, body);
    if (!published) return;
    op.phase = "published";
  }

  /**
   * Publication resume for a durable ready journal discovered by the
   * observation path without any live owned process: the ORIGINAL requestedAt/
   * requestId/operation/base/head/reviewId/completedAt and the exact standing
   * body are reused. No snapshot, preparation, model start, budget reservation
   * or journal rewrite happens; only the exact COMMENT submission and its
   * standing readback.
   */
  protected async publishDurableReady(
    request: ReviewRequestReadV1,
    journal: ReviewJournalReadyV1,
    review: GitHubReviewWireV1,
  ): Promise<PortResultV1<ReviewServiceReadV1>> {
    const body = review.body;
    if (body === null || !Number.isSafeInteger(review.id)) {
      return portOk(this.unavailableReceipt(request));
    }
    const now = this.clock.now();
    const op: OwnedReviewV1 = {
      operationKey: journal.operationKey,
      requestId: journal.requestId,
      prNumber: journal.prNumber,
      expectedHead: journal.expectedHead,
      expectedBase: journal.expectedBase,
      requestedAt: journal.requestedAt,
      latestStartAt: now,
      settleBy: now,
      task: null,
      phase: "ready",
      reviewId: review.id,
      remoteJournal: true,
      prepared: null,
      closePromise: null,
      submission: null,
      submissionSettled: true,
      running: null,
      runningSettled: true,
      done: false,
      processSettled: true,
      readyDurable: true,
      fault: null,
    };
    // The publication is owned journal work: drain awaits it and a concurrent
    // submission for the same operation/PR is rejected as overlapping.
    this.operations.set(op.operationKey, op);
    op.submissionSettled = false;
    const publication = (async () => {
      try {
        const published = await this.submitPublication(op, review.id, body);
        if (published) {
          op.phase = "published";
          return true;
        }
        op.fault = DETAIL_PUBLISH;
        return false;
      } catch {
        op.fault = DETAIL_PUBLISH;
        return false;
      } finally {
        op.done = true;
      }
    })();
    op.submission = publication.then(
      () => {
        op.submissionSettled = true;
      },
      () => {
        op.submissionSettled = true;
      },
    );
    if (!await publication) return portOk(this.unavailableReceipt(request));
    const read = await this.client.readPullReview(op.prNumber, review.id);
    if (!read.ok || read.value === null) {
      return portOk(this.unavailableReceipt(request));
    }
    const standing = read.value;
    const standingJournal = await this.parseBody(standing.body);
    if (
      standing.id !== review.id || standing.author !== this.publisher ||
      standing.commitSha !== journal.expectedHead ||
      standing.state !== "commented" || standing.submittedAt === null ||
      standing.body !== body || standingJournal === null ||
      standingJournal.phase !== "ready" ||
      standingJournal.reviewId !== review.id
    ) {
      return portOk(this.unavailableReceipt(request));
    }
    return portOk(this.journalReceipt(standingJournal, standing));
  }

  /**
   * A standing COMMENTED exact journal for this operation already exists (the
   * original submission was published): adopt the durable outcome without any
   * model work and report the submission as admitted.
   */
  protected adoptPublished(
    op: OwnedReviewV1,
    reviewId: number,
  ): PortResultV1<ReviewSubmitOutcomeV1> {
    op.reviewId = reviewId;
    op.phase = "published";
    op.processSettled = true;
    op.remoteJournal = true;
    op.readyDurable = true;
    op.done = true;
    return portOk({
      status: "submitted",
      requestId: op.requestId,
      requestedAt: op.requestedAt,
    });
  }

  /**
   * Submit exactly one COMMENT and prove the standing exact publication: the
   * raw id, authenticated publisher, raw head, commented state, submission
   * timestamp, exact intended body bytes and every journal identity must
   * stand. A lost submit response is reconciled by this exact id read only.
   */
  protected async submitPublication(
    op: OwnedReviewV1,
    reviewId: number,
    body: string,
  ): Promise<boolean> {
    const submitted = await this.client.submitReview(
      op.prNumber,
      reviewId,
      body,
    );
    if (!submitted.ok) return false;
    const read = await this.client.readPullReview(op.prNumber, reviewId);
    if (!read.ok || read.value === null) return false;
    const review = read.value;
    if (
      review.id !== reviewId || review.author !== this.publisher ||
      review.commitSha !== op.expectedHead || review.state !== "commented" ||
      review.submittedAt === null || review.body !== body
    ) {
      return false;
    }
    const journal = await this.parseBody(review.body);
    if (journal === null || journal.phase !== "ready") return false;
    if (!this.journalIdentityMatches(op, reviewId, journal)) return false;
    return true;
  }
}
