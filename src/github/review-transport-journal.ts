// review transport journal.

import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitHubReviewWireV1 } from "./wire.ts";
import {
  parseReviewJournalBody,
  renderReviewJournalBody,
  type ReviewJournalV1,
} from "./review-journal.ts";
import type { PreparedStructuredReviewV1 } from "./codex-reviewer.ts";
import type { ReviewServiceReadV1 } from "./review-service.ts";
import type { ReviewRequestReadV1 } from "./review-service.ts";
import { GitHubReviewTransportState } from "./review-transport-state.ts";
import {
  type BoundRecordV1,
  DETAIL_FAILURE,
  DETAIL_READBACK,
  DETAIL_RECONCILE,
  type OwnedReviewV1,
} from "./review-transport-policy.ts";
import { reviewOwnerRegistration } from "./review-owner-evidence.ts";

export abstract class GitHubReviewTransportJournal
  extends GitHubReviewTransportState {
  // -------------------------------------------------------------------------
  // Reconciliation helpers
  // -------------------------------------------------------------------------

  /**
   * Pre-create reconciliation: an intent/running record created by an earlier
   * call is NEVER permission to prepare or start a model, and a ready pending
   * journal is recovered through the observation path only.
   */
  protected async reconcile(
    op: OwnedReviewV1,
  ): Promise<
    | { kind: "create" }
    | { kind: "record"; reviewId: number }
    | { kind: "published"; reviewId: number }
    | { kind: "error"; detail: string }
  > {
    const bound = await this.reconcileRead(op);
    if (bound.kind === "error") return bound;
    if (bound.kind === "conflict") {
      return { kind: "error", detail: DETAIL_RECONCILE };
    }
    if (bound.kind === "none") return { kind: "create" };
    if (bound.review.state === "commented") {
      return { kind: "published", reviewId: bound.review.id };
    }
    return { kind: "record", reviewId: bound.review.id };
  }

  /**
   * Lost-create reconciliation: only a record whose EXACT intent bytes are this
   * call's expected intent proves the create applied; uncertain absence never
   * authorizes a blind second create.
   */
  protected async reconcileOwnCreate(
    op: OwnedReviewV1,
    ownIntentBody: string,
  ): Promise<
    | { kind: "create" }
    | { kind: "own-intent"; reviewId: number }
    | { kind: "record"; reviewId: number }
    | { kind: "published"; reviewId: number }
    | { kind: "error"; detail: string }
  > {
    const bound = await this.reconcileRead(op);
    if (bound.kind === "error") return bound;
    if (bound.kind === "conflict") {
      return { kind: "error", detail: DETAIL_RECONCILE };
    }
    if (bound.kind === "none") return { kind: "create" };
    if (bound.review.state === "commented") {
      return { kind: "published", reviewId: bound.review.id };
    }
    if (
      bound.journal.phase === "intent" && bound.review.body === ownIntentBody
    ) {
      return { kind: "own-intent", reviewId: bound.review.id };
    }
    return { kind: "record", reviewId: bound.review.id };
  }

  protected async reconcileRead(
    op: OwnedReviewV1,
  ): Promise<BoundRecordV1 | { kind: "error"; detail: string }> {
    const read = await this.client.readReviews(op.prNumber);
    if (!read.ok) return { kind: "error", detail: DETAIL_RECONCILE };
    const bound = await this.bindRecords({
      operationKey: op.operationKey,
      requestId: op.requestId,
      prNumber: op.prNumber,
      expectedBase: op.expectedBase,
      expectedHead: op.expectedHead,
    }, read.value);
    if (bound.kind === "conflict") {
      return { kind: "error", detail: DETAIL_RECONCILE };
    }
    return bound;
  }

  /**
   * Exhaustive, strictly bound reconciliation of the named PR's publisher
   * records. Every matching pending AND published record is counted and
   * validated before adoption; exactly ONE fully bound record is required, so
   * a COMMENTED record can never hide a duplicate pending one. A publisher
   * pending draft that is not this exact operation, an unreadable draft, a
   * malformed state, a wrong head or a mismatched review id is a conflict.
   */
  protected async bindRecords(
    expectation: {
      operationKey: string | null;
      requestId: string | null;
      prNumber: number;
      /** When known (submission/reconciliation), the exact reviewed base. */
      expectedBase?: GitSha | null;
      /**
       * When known (submission/reconciliation), the exact reviewed head. The
       * observation path has no caller head and leaves this undefined; the
       * normalizer then binds the requested head itself.
       */
      expectedHead?: GitSha | null;
    },
    reviews: GitHubReviewWireV1[],
  ): Promise<BoundRecordV1> {
    const candidates: {
      review: GitHubReviewWireV1;
      journal: ReviewJournalV1;
    }[] = [];
    for (const review of reviews) {
      if (review.author !== this.publisher) continue;
      const journal = await this.parseBody(review.body);
      if (journal === null) {
        // An unreadable publisher draft can never be adopted or overwritten.
        if (review.state === "pending") return { kind: "conflict" };
        continue;
      }
      const exactIdentity = (expectation.operationKey === null ||
        journal.operationKey === expectation.operationKey) &&
        (expectation.requestId === null ||
          journal.requestId === expectation.requestId) &&
        (expectation.expectedBase === undefined ||
          expectation.expectedBase === null ||
          journal.expectedBase === expectation.expectedBase) &&
        (expectation.expectedHead === undefined ||
          expectation.expectedHead === null ||
          journal.expectedHead === expectation.expectedHead) &&
        journal.repository.owner === this.repository.owner &&
        journal.repository.name === this.repository.name &&
        journal.prNumber === expectation.prNumber &&
        journal.publisher === this.publisher &&
        review.commitSha !== null && journal.expectedHead === review.commitSha;
      if (!exactIdentity) {
        // A publisher pending draft that is not this exact operation is a
        // foreign/unrelated/conflicting draft: never edited, never adopted.
        if (review.state === "pending") return { kind: "conflict" };
        continue;
      }
      if (journal.phase === "intent") {
        if (review.state !== "pending" || review.submittedAt !== null) {
          return { kind: "conflict" };
        }
        candidates.push({ review, journal });
        continue;
      }
      // Only running/ready journals carry the durable review id.
      if (journal.reviewId !== review.id) return { kind: "conflict" };
      if (journal.phase === "running") {
        if (review.state !== "pending" || review.submittedAt !== null) {
          return { kind: "conflict" };
        }
        candidates.push({ review, journal });
        continue;
      }
      if (review.state === "commented") {
        if (review.submittedAt === null) return { kind: "conflict" };
        candidates.push({ review, journal });
        continue;
      }
      if (review.state !== "pending" || review.submittedAt !== null) {
        return { kind: "conflict" };
      }
      candidates.push({ review, journal });
    }
    if (candidates.length === 0) return { kind: "none" };
    if (candidates.length > 1) return { kind: "conflict" };
    return {
      kind: "one",
      review: candidates[0].review,
      journal: candidates[0].journal,
    };
  }

  /**
   * Finish only this transport's exact failed operation after its retained
   * submission, completion and session have all proved settlement. A fresh
   * host, elapsed deadline or a changed execution supplies no such authority.
   */
  protected async recoverSettledPending(
    op: OwnedReviewV1,
    journal: ReviewJournalV1,
    review: GitHubReviewWireV1,
  ): Promise<boolean> {
    if (
      !op.done || !op.submissionSettled || !op.runningSettled ||
      !op.processSettled || op.prepared !== null || !op.remoteJournal ||
      op.readyDurable || op.reviewId !== review.id ||
      review.author !== this.publisher ||
      review.commitSha !== op.expectedHead ||
      review.state !== "pending" || review.submittedAt !== null ||
      journal.phase === "ready" || this.clock.now() < journal.requestedAt ||
      !this.journalIdentityMatches(op, review.id, journal)
    ) return false;
    if (
      journal.phase === "running" &&
      (op.preparedExecution === null ||
        journal.execution.ownerRunId !== this.ownerRunId ||
        canonicalStringify(journal.execution) !==
          canonicalStringify(op.preparedExecution))
    ) return false;

    // Retain finalization ownership before the first await. Concurrent starts
    // for this operation/PR and drain observe the same owned promise.
    op.done = false;
    op.submissionSettled = false;
    op.fault = null;
    const publication = (async () => {
      try {
        await this.publishDisposition(op, null, DETAIL_FAILURE);
        return op.phase === "published";
      } catch {
        op.fault ??= DETAIL_FAILURE;
        return false;
      } finally {
        op.done = true;
      }
    })();
    op.submission = publication.then(() => {
      op.submissionSettled = true;
    });
    return await publication;
  }

  /**
   * Exact phase readback: raw review id, authenticated publisher, raw head,
   * the complete journal identity (repository/PR/base/head/operation/request/
   * publisher/requestedAt), exact intended body bytes and the pending state
   * with NO submission timestamp. Running additionally requires the persisted
   * execution to equal the prepared execution.
   */
  protected async readPhase(
    op: OwnedReviewV1,
    reviewId: number,
    expected: {
      phase: "intent" | "running" | "ready";
      body: string;
      execution?: PreparedStructuredReviewV1["execution"];
    },
  ): Promise<
    { kind: "ok"; journal: ReviewJournalV1 } | { kind: "error"; detail: string }
  > {
    const read = await this.client.readPullReview(op.prNumber, reviewId);
    if (!read.ok || read.value === null) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    const review = read.value;
    if (
      review.id !== reviewId || review.author !== this.publisher ||
      review.commitSha !== op.expectedHead
    ) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    const journal = await this.parseBody(review.body);
    if (journal === null) return { kind: "error", detail: DETAIL_READBACK };
    if (!this.journalIdentityMatches(op, reviewId, journal)) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    if (journal.phase !== expected.phase) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    if (review.body !== expected.body) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    // A durable pending journal has no submission timestamp.
    if (review.state !== "pending" || review.submittedAt !== null) {
      return { kind: "error", detail: DETAIL_READBACK };
    }
    if (expected.phase === "running") {
      if (journal.phase !== "running") {
        return { kind: "error", detail: DETAIL_READBACK };
      }
      if (
        JSON.stringify(journal.execution) !== JSON.stringify(expected.execution)
      ) {
        return { kind: "error", detail: DETAIL_READBACK };
      }
    }
    if (
      journal.phase !== "ready" && this.ownerCustody !== undefined &&
      journal.ownerExecution !== undefined
    ) {
      try {
        await this.ownerCustody.register(
          await reviewOwnerRegistration(
            this.repository,
            reviewId,
            journal,
            expected.body,
          ),
        );
      } catch {
        return { kind: "error", detail: DETAIL_READBACK };
      }
    }
    return { kind: "ok", journal };
  }

  /**
   * Exact journal identity against one owned operation. Intent journals carry
   * no durable review id: the raw review id readback binds them instead.
   */
  protected journalIdentityMatches(
    op: OwnedReviewV1,
    reviewId: number,
    journal: ReviewJournalV1,
  ): boolean {
    if (journal.repository.owner !== this.repository.owner) return false;
    if (journal.repository.name !== this.repository.name) return false;
    if (journal.prNumber !== op.prNumber) return false;
    if (journal.expectedHead !== op.expectedHead) return false;
    if (journal.expectedBase !== op.expectedBase) return false;
    if (journal.operationKey !== op.operationKey) return false;
    if (journal.requestId !== op.requestId) return false;
    if (journal.publisher !== this.publisher) return false;
    if (journal.requestedAt !== op.requestedAt) return false;
    if (
      canonicalStringify(journal.ownerExecution ?? null) !==
        canonicalStringify(op.ownerExecution ?? null)
    ) return false;
    if (journal.phase === "intent") return true;
    return journal.reviewId === reviewId;
  }

  protected async parseBody(
    body: string | null,
  ): Promise<ReviewJournalV1 | null> {
    if (body === null) return null;
    try {
      return await parseReviewJournalBody(body);
    } catch {
      return null;
    }
  }

  protected render(journal: ReviewJournalV1): string | null {
    try {
      return renderReviewJournalBody(journal);
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Receipts
  // -------------------------------------------------------------------------

  protected liveReceipt(op: OwnedReviewV1): ReviewServiceReadV1 {
    return {
      status: "pending",
      requestId: op.requestId,
      resultId: null,
      completedAt: null,
      summary: null,
      resultDigest: null,
      terminalTurnSucceeded: false,
      outputPresent: false,
      taskAcceptance: null,
      operationKey: op.operationKey,
      githubReviewId: op.reviewId,
      repository: this.repository,
      prNumber: op.prNumber,
      expectedHead: op.expectedHead,
      expectedBase: op.expectedBase,
      expectedReviewer: this.publisher,
    };
  }

  protected unavailableReceipt(
    request: ReviewRequestReadV1,
  ): ReviewServiceReadV1 {
    return {
      status: "unavailable",
      requestId: request.requestId,
      resultId: null,
      completedAt: null,
      summary: null,
      resultDigest: null,
      terminalTurnSucceeded: false,
      outputPresent: false,
      taskAcceptance: null,
      operationKey: request.operationKey,
      githubReviewId: null,
      repository: this.repository,
      prNumber: request.prNumber,
      expectedHead: null,
      expectedBase: null,
      expectedReviewer: null,
    };
  }

  /**
   * Exact receipt derived from one standing authenticated review record. Only
   * a COMMENTED exact ready journal by the publisher on the exact head can be
   * `completed`; clean/findings additionally require observed runtime
   * completion and a bound result identity.
   */
  protected journalReceipt(
    journal: ReviewJournalV1,
    review: GitHubReviewWireV1,
  ): ReviewServiceReadV1 {
    const base: ReviewServiceReadV1 = {
      status: "unavailable",
      requestId: journal.requestId,
      resultId: null,
      completedAt: null,
      summary: null,
      resultDigest: null,
      terminalTurnSucceeded: false,
      outputPresent: false,
      // Only the COMPLETED branch below may surface a task acceptance: a
      // journal without an accepted verdict never carries one.
      taskAcceptance: null,
      operationKey: journal.operationKey,
      githubReviewId: review.id,
      repository: this.repository,
      prNumber: journal.prNumber,
      expectedHead: journal.expectedHead,
      expectedBase: journal.expectedBase,
      expectedReviewer: journal.publisher,
    };
    if (
      journal.phase !== "ready" || review.state !== "commented" ||
      review.submittedAt === null
    ) {
      return base;
    }
    if (journal.result.verdict === "unavailable") {
      return {
        ...base,
        completedAt: journal.completedAt,
        summary: journal.result.summary,
        resultDigest: journal.resultDigest,
      };
    }
    const execution = journal.execution;
    if (
      execution === null || execution.nativeReview?.mode !== "review/start" ||
      execution.actual.evidenceKind !== "native-review" ||
      execution.actual.terminalOrigin !== "runtime" ||
      execution.actual.observedTerminalStatus !== "completed"
    ) {
      return {
        ...base,
        completedAt: journal.completedAt,
        summary: journal.result.summary,
        resultDigest: journal.resultDigest,
      };
    }
    return {
      ...base,
      status: "completed",
      resultId: execution.resultId,
      completedAt: journal.completedAt,
      summary: journal.result.summary,
      resultDigest: journal.resultDigest,
      terminalTurnSucceeded: true,
      outputPresent: true,
      // The durable journal is the only source: the acceptance was bound to
      // the submitted task statement by the producer before this ready record
      // was persisted, and an absent key remains "no acceptance".
      taskAcceptance: journal.result.taskAcceptance ?? null,
    };
  }
}
