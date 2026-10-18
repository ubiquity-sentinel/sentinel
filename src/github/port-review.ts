// port review.

import type {
  PortResultV1,
  ReviewDrainReportV1,
  ReviewDrainRequestV1,
  ReviewObservationRequestV1,
  ReviewObservationV1,
  ReviewRequestOutcomeV1,
  ReviewSubmissionV1,
} from "../contracts/ports.ts";
import type { TakeoverEffectAuthorization } from "../contracts/existing-pr-takeover.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { GitHubReviewCommentWireV1, GitHubReviewWireV1 } from "./wire.ts";
import { normalizeReviewObservation } from "./review-normalize.ts";
import { GitHubPortPublication } from "./port-publication.ts";

export abstract class GitHubPortReview extends GitHubPortPublication {
  // -------------------------------------------------------------------------
  // requestReview / observeReview
  // -------------------------------------------------------------------------

  async requestReview(
    request: ReviewSubmissionV1,
    takeover?: TakeoverEffectAuthorization,
  ): Promise<PortResultV1<ReviewRequestOutcomeV1>> {
    if (request.operationKey.length === 0) {
      return portError("invalid", "operation key is required");
    }
    if (request.expectedReviewer !== this.trustedReviewer) {
      return portError(
        "invalid",
        "reviewer identity is not the trusted reviewer",
      );
    }
    const queueGuard = await this.queueEffect({
      operation: "resume",
      pullRequest: request.prNumber,
      expectedHead: request.expectedHead,
    });
    if (!queueGuard.ok) return queueGuard;
    const pull = await this.client.readPullRequest(request.prNumber);
    if (!pull.ok) return pull;
    if (pull.value === null) {
      return portError("not_found", "pull request not found");
    }
    if (pull.value.head !== request.expectedHead) {
      return portError(
        "conflict",
        "pull request head differs from the expected head",
      );
    }
    if (pull.value.base !== request.expectedBase) {
      return portError(
        "conflict",
        "pull request base differs from the expected base",
      );
    }
    if (pull.value.state !== "open") {
      return portError("conflict", "pull request is not open");
    }
    if (
      !Number.isSafeInteger(request.latestStartAt) ||
      !Number.isSafeInteger(request.settleBy) ||
      request.settleBy <= request.latestStartAt
    ) {
      return portError("invalid", "review deadline bounds are invalid");
    }
    // Exactly one transport submission; a lost response stays ambiguous and is
    // reconciled later by the operation key.
    const submitted = await this.gatedRemoteCall(async () => {
      const finalGuard = await this.queueEffect({
        operation: "resume",
        pullRequest: request.prNumber,
        expectedHead: request.expectedHead,
      });
      if (!finalGuard.ok) return finalGuard;
      const custody = await this.takeoverEffect(
        { kind: "review", request },
        takeover,
      );
      if (!custody.ok) return custody;
      return this.reviewService.submitReview({
        operationKey: request.operationKey,
        prNumber: request.prNumber,
        expectedHead: request.expectedHead,
        expectedBase: request.expectedBase,
        expectedReviewer: request.expectedReviewer,
        latestStartAt: request.latestStartAt,
        settleBy: request.settleBy,
        task: request.task ?? null,
      });
    });
    if (!submitted.ok) return submitted;
    switch (submitted.value.status) {
      case "submitted":
        return portOk({
          outcome: "applied",
          requestId: submitted.value.requestId,
          requestedAt: submitted.value.requestedAt,
        });
      case "ambiguous":
        return portOk({
          outcome: "ambiguous",
          requestId: null,
          requestedAt: this.clock.now(),
        });
      case "rejected":
        return portError("conflict", "review request was rejected");
    }
  }

  async observeReview(
    request: ReviewObservationRequestV1,
  ): Promise<PortResultV1<ReviewObservationV1>> {
    if (request.operationKey.length === 0) {
      return portError("invalid", "operation key is required");
    }
    const pull = await this.client.readPullRequest(request.prNumber);
    if (!pull.ok) return pull;
    const service = await this.gatedRemoteCall(() =>
      this.reviewService.readReview({
        operationKey: request.operationKey,
        requestId: null,
        prNumber: request.prNumber,
      })
    );
    if (!service.ok) return service;
    let reviews: GitHubReviewWireV1[] = [];
    let comments: GitHubReviewCommentWireV1[] = [];
    if (pull.value !== null) {
      const readReviews = await this.client.readReviews(request.prNumber);
      if (!readReviews.ok) return readReviews;
      reviews = readReviews.value;
      const readComments = await this.client.readReviewComments(
        request.prNumber,
      );
      if (!readComments.ok) return readComments;
      comments = readComments.value;
    }
    return normalizeReviewObservation({
      request,
      service: service.value,
      repository: this.repository,
      expectedOperationKey: request.operationKey,
      pullRequest: pull.value,
      reviews,
      comments,
      expectedReviewer: this.trustedReviewer,
      findingCap: this.findingCap,
      receivedAt: this.clock.now(),
    });
  }

  // -------------------------------------------------------------------------
  // drainReviews
  // -------------------------------------------------------------------------

  /**
   * Forward the bounded review-lifecycle drain to the SAME review-service
   * transport instance this port submits through. Never starts a model,
   * never reserves budget and never writes repair state.
   */
  async drainReviews(
    request: ReviewDrainRequestV1,
  ): Promise<PortResultV1<ReviewDrainReportV1>> {
    if (
      typeof request !== "object" || request === null ||
      !Number.isSafeInteger(request.deadline) ||
      typeof request.interrupt !== "boolean"
    ) {
      return portError("invalid", "review drain request is invalid");
    }
    try {
      const report = await this.reviewService.drain({
        deadline: request.deadline,
        interrupt: request.interrupt,
      });
      return portOk(report);
    } catch {
      // A thrown drain is reported as sanitized unavailable, never as raw
      // transport detail; the entrypoint owns the typed drain failure.
      return portError("unavailable", "review drain failed");
    }
  }
}
