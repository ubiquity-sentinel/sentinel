/**
 * GitHub REST client: the default authenticated HTTP path behind the port.
 *
 * Reads use the actual API endpoints with exhaustive pagination and explicit
 * bounds: a page-size/cycle/edge cut is `unavailable`, never a partial
 * success. Writes return raw non-2xx outcomes to the port so the port can
 * reconcile ambiguous effects against authoritative state instead of guessing
 * from an HTTP status alone.
 *
 * Error discipline: every failure is a sanitized typed port error — no
 * response body, URL, header or token value is ever echoed into `detail`.
 */

import type { PortResultV1 } from "../contracts/ports.ts";
import type { GitHubReviewWireV1 } from "./wire.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { parseReviewWire } from "./wire.ts";
import type { GitSha } from "../contracts/brands.ts";
import { GitHubClientHostedExecution } from "./client-hosted-execution.ts";
import { validateReviewOperationInput } from "./client-review-wire.ts";
import { parseWire, repoPath } from "./client-response.ts";
import type {
  RawSendResult,
  ReviewMutationOutcomeV1,
} from "./client-contracts.ts";

export class GitHubApiClient extends GitHubClientHostedExecution {
  // -------------------------------------------------------------------------
  // Review journal operations (pending-draft lifecycle)
  // -------------------------------------------------------------------------
  // The review body is the durable operation journal; all four operations go
  // through the same authenticated gate/deadline/cooldown path as every other
  // client call. There is no automatic retry of a mutating call and no create
  // on ambiguity: the caller reconciles the exact review id first.

  /** Read the exact review for the PR (404 is a real observed null). */
  async readPullReview(
    number: number,
    reviewId: number,
  ): Promise<PortResultV1<GitHubReviewWireV1 | null>> {
    const invalid = validateReviewOperationInput(
      { prNumber: number, reviewId },
      ["reviewId"],
    );
    if (invalid !== null) return portError(invalid.kind, invalid.detail);
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/pulls/${number}/reviews/${reviewId}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    return parseWire(response.value, (v) => parseReviewWire(v, "$"));
  }

  /** Create a PENDING review on the exact head (no event is ever sent). */
  async createPendingReview(
    number: number,
    head: GitSha,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>> {
    const invalid = validateReviewOperationInput(
      { prNumber: number, head, body },
      ["head", "body"],
    );
    if (invalid !== null) return portError(invalid.kind, invalid.detail);
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${number}/reviews`,
      { commit_id: head, body },
    );
    return this.reviewMutationOutcome(raw, "pending");
  }

  /** Replace the body of the exact pending review (no event is ever sent). */
  async updatePendingReview(
    number: number,
    reviewId: number,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>> {
    const invalid = validateReviewOperationInput(
      { prNumber: number, reviewId, body },
      ["reviewId", "body"],
    );
    if (invalid !== null) return portError(invalid.kind, invalid.detail);
    const raw = await this.sendCore(
      "PUT",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${number}/reviews/${reviewId}`,
      { body },
    );
    return this.reviewMutationOutcome(raw, "pending");
  }

  /**
   * Submit the exact review with event COMMENT. APPROVE is never sent: the
   * publisher is the PR author identity and must not approve its own work.
   */
  async submitReview(
    number: number,
    reviewId: number,
    body: string,
  ): Promise<PortResultV1<ReviewMutationOutcomeV1>> {
    const invalid = validateReviewOperationInput(
      { prNumber: number, reviewId, body },
      ["reviewId", "body"],
    );
    if (invalid !== null) return portError(invalid.kind, invalid.detail);
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${number}/reviews/${reviewId}/events`,
      { event: "COMMENT", body },
    );
    return this.reviewMutationOutcome(raw, "commented");
  }

  protected reviewMutationOutcome(
    raw: RawSendResult,
    expectedState: "pending" | "commented",
  ): PortResultV1<ReviewMutationOutcomeV1> {
    if (raw.status === "error") {
      // Typed auth/rate-limit errors (including metadata) are preserved.
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      // The request may have applied; reconciliation is the caller's job. No
      // second request is issued by this method.
      return portOk({ status: "ambiguous" });
    }
    if (raw.response.status !== 200 && raw.response.status !== 201) {
      return portError(...this.mapError(raw.response));
    }
    const parsed = parseWire(raw.response, (v) => parseReviewWire(v, "$"));
    if (!parsed.ok) return parsed;
    if (parsed.value.state !== expectedState) {
      return portError("invalid", "GitHub API response is malformed");
    }
    return portOk({ status: "applied", review: parsed.value });
  }
}

export { MAX_OPEN_ISSUES } from "./client-contracts.ts";
export { MAX_OPEN_ISSUE_PAGES } from "./client-contracts.ts";
export type { GitHubApiClientOptionsV1 } from "./client-contracts.ts";
export type { CreatePullWireV1 } from "./client-contracts.ts";
export type { MergePutWireV1 } from "./client-contracts.ts";
export type { ReviewMutationOutcomeV1 } from "./client-contracts.ts";
export type { ApproveExactCiRunInputV1 } from "./client-contracts.ts";
export type { CiApprovalOutcomeV1 } from "./client-contracts.ts";
