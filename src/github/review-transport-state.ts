// review transport state.

import type { GitSha } from "../contracts/brands.ts";
import type { GitHubReviewWireV1 } from "./wire.ts";
import {
  finalizeReviewCompletion,
  type PreparedStructuredReviewV1,
  type StructuredReviewCloseV1,
  type StructuredReviewOutcomeV1,
} from "./codex-reviewer.ts";
import type {
  ReviewJournalReadyV1,
  ReviewJournalV1,
} from "./review-journal.ts";
import type {
  ReviewRequestSubmitV1,
  ReviewServiceReadV1,
  ReviewSubmitOutcomeV1,
} from "./review-service.ts";
import type { ReviewRequestReadV1 } from "./review-service.ts";
import type {
  Clock,
  PortResultV1,
  ReviewDrainOperationV1,
  ReviewDrainReportV1,
} from "../contracts/ports.ts";
import type { GitHubApiClient } from "./client.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { ReviewTaskStatementV1 } from "../contracts/review-receipt.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { reviewRecordId } from "./review-normalize.ts";
import {
  type BoundRecordV1,
  DETAIL_FAILURE,
  DETAIL_INPUT,
  DETAIL_PUBLISHER,
  isActiveReview,
  type OwnedReviewV1,
  REVIEW_TRANSPORT_TOTAL_MS,
} from "./review-transport-policy.ts";
import type {
  CodexReviewPrepareCapabilityV1,
  GitHubCodexReviewTransportOptionsV1,
  GitReviewSnapshotCaptureV1,
} from "./review-transport-contracts.ts";

export abstract class GitHubReviewTransportState {
  protected readonly client: GitHubApiClient;
  protected readonly repository: RepositoryIdentityV1;
  protected readonly publisher: string;
  protected readonly clock: Clock;
  protected readonly ownerRunId: string;
  protected readonly snapshot: GitReviewSnapshotCaptureV1;
  protected readonly reviewer: CodexReviewPrepareCapabilityV1;
  protected readonly maxActiveReviews: number | null;
  protected readonly operations = new Map<string, OwnedReviewV1>();
  protected draining = false;

  constructor(options: GitHubCodexReviewTransportOptionsV1) {
    this.client = options.client;
    this.repository = options.repository;
    this.publisher = options.publisher;
    this.clock = options.clock;
    this.ownerRunId = options.ownerRunId;
    this.snapshot = options.snapshot;
    this.reviewer = options.reviewer;
    const maxActive = options.maxActiveReviews ?? null;
    if (
      maxActive !== null &&
      (!Number.isSafeInteger(maxActive) || maxActive < 1)
    ) {
      throw new TypeError(
        "maxActiveReviews must be null or a positive safe integer",
      );
    }
    this.maxActiveReviews = maxActive;
  }

  // -------------------------------------------------------------------------
  // Owned completion
  // -------------------------------------------------------------------------

  protected ownReview(
    op: OwnedReviewV1,
    prepared: PreparedStructuredReviewV1,
  ): Promise<void> {
    const run = (async () => {
      let started: PortResultV1<StructuredReviewOutcomeV1> | null = null;
      let startFailed = false;
      let close: StructuredReviewCloseV1 | null = null;
      try {
        started = await prepared.start();
      } catch {
        startFailed = true;
      } finally {
        // The owned session closes on EVERY path, including a thrown start;
        // the close proves (or refuses to prove) process settlement.
        close = await this.closePrepared(op);
      }
      if (startFailed || started === null || !started.ok || close === null) {
        if (!op.processSettled) {
          op.fault = DETAIL_FAILURE;
          return;
        }
        // A settled start failure keeps its own bounded static reason in the
        // durable disposition; a thrown start has none to keep.
        await this.publishDisposition(
          op,
          null,
          startFailed || started === null || started.ok
            ? null
            : started.error.detail,
        );
        return;
      }
      const final = finalizeReviewCompletion(started, close);
      await this.publishDisposition(
        op,
        final.ok ? final.value : null,
        final.ok ? null : final.error.detail,
      );
    })();
    return run.catch(() => {
      op.fault ??= DETAIL_FAILURE;
    }).finally(() => {
      op.done = true;
      op.runningSettled = true;
    });
  }

  // -------------------------------------------------------------------------
  // Submission validation and small helpers
  // -------------------------------------------------------------------------

  protected validateSubmission(
    request: ReviewRequestSubmitV1,
    now: number,
    task: ReviewTaskStatementV1 | null,
  ): { ok: true; value: OwnedReviewV1 } | {
    ok: false;
    error: PortResultV1<never>;
  } {
    const invalid = portError("invalid", DETAIL_INPUT);
    if (typeof request !== "object" || request === null) {
      return { ok: false, error: invalid };
    }
    if (
      typeof request.operationKey !== "string" ||
      request.operationKey.length === 0 ||
      request.operationKey.length > 256
    ) {
      return { ok: false, error: invalid };
    }
    if (!Number.isSafeInteger(request.prNumber) || request.prNumber < 1) {
      return { ok: false, error: invalid };
    }
    if (
      typeof request.expectedHead !== "string" ||
      typeof request.expectedBase !== "string" ||
      !/^[0-9a-f]{40}$/.test(request.expectedHead) ||
      !/^[0-9a-f]{40}$/.test(request.expectedBase)
    ) {
      return { ok: false, error: invalid };
    }
    if (request.expectedReviewer !== this.publisher) {
      return { ok: false, error: portError("invalid", DETAIL_PUBLISHER) };
    }
    if (
      !Number.isSafeInteger(request.latestStartAt) ||
      !Number.isSafeInteger(request.settleBy) ||
      request.latestStartAt <= now ||
      request.settleBy <= request.latestStartAt ||
      request.settleBy - request.latestStartAt > this.reviewTotalMs()
    ) {
      return { ok: false, error: invalid };
    }
    const op: OwnedReviewV1 = {
      operationKey: request.operationKey,
      requestId: reviewRecordId(request.operationKey),
      prNumber: request.prNumber,
      expectedHead: request.expectedHead as GitSha,
      expectedBase: request.expectedBase as GitSha,
      requestedAt: now,
      latestStartAt: request.latestStartAt,
      settleBy: request.settleBy,
      task,
      phase: "intent",
      reviewId: null,
      remoteJournal: false,
      prepared: null,
      closePromise: null,
      submission: null,
      submissionSettled: true,
      running: null,
      runningSettled: true,
      done: false,
      processSettled: false,
      readyDurable: false,
      fault: null,
    };
    return { ok: true, value: op };
  }

  protected reviewTotalMs(): number {
    return REVIEW_TRANSPORT_TOTAL_MS;
  }

  /**
   * True while the full review bound still fits before latestStartAt/settleBy
   * AND admission has not stopped. Once drain starts, an admitted submission
   * that is still awaiting work can never reach a model start.
   */
  protected admitsStart(op: OwnedReviewV1): boolean {
    if (this.draining) return false;
    const now = this.clock.now();
    return now < op.latestStartAt && now < op.settleBy;
  }

  protected invocationId(op: OwnedReviewV1): string {
    return `review-invocation-${op.operationKey}`.slice(0, 256);
  }

  protected intentJournal(op: OwnedReviewV1) {
    return {
      version: "v1" as const,
      phase: "intent" as const,
      repository: {
        owner: this.repository.owner,
        name: this.repository.name,
      },
      prNumber: op.prNumber,
      expectedHead: op.expectedHead,
      expectedBase: op.expectedBase,
      operationKey: op.operationKey,
      publisher: this.publisher,
      requestId: op.requestId,
      requestedAt: op.requestedAt,
    };
  }

  protected activeCount(): number {
    let count = 0;
    for (const op of this.operations.values()) {
      if (isActiveReview(op)) count++;
    }
    return count;
  }

  /**
   * The local fast-path match binds the requested PR and EVERY supplied
   * identity on every path: an unknown operation key never falls back to a
   * request-id match, and a request id never matches a different operation
   * key. A supplied identifier that does not match exactly is `undefined`.
   */
  protected matchLocal(
    request: ReviewRequestReadV1,
  ): OwnedReviewV1 | undefined {
    for (const op of this.operations.values()) {
      if (op.prNumber !== request.prNumber) continue;
      if (
        request.operationKey !== null &&
        op.operationKey !== request.operationKey
      ) {
        continue;
      }
      if (request.requestId !== null && op.requestId !== request.requestId) {
        continue;
      }
      return op;
    }
    return undefined;
  }

  /**
   * Close the one owned prepared session. The single close promise is reused
   * (never a concurrent duplicate close), the handle is retained until
   * settlement is actually proved, and an unproved close is a fault — never a
   * silent success.
   */
  protected closePrepared(op: OwnedReviewV1): Promise<StructuredReviewCloseV1> {
    const prepared = op.prepared;
    if (op.closePromise === null && prepared !== null) {
      op.closePromise = (async () => {
        try {
          return await prepared.close();
        } catch {
          return {
            settled: false,
            failure: DETAIL_FAILURE,
            timedOut: false,
          };
        }
      })();
    }
    const close = op.closePromise;
    if (close === null) {
      return Promise.resolve({
        settled: op.processSettled,
        failure: null,
        timedOut: false,
      });
    }
    return close.then((result) => {
      if (result.settled) {
        op.processSettled = true;
        op.prepared = null;
        return result;
      }
      // The handle stays owned: an unsettled process is never discarded and
      // is never reported as settled.
      op.fault ??= DETAIL_FAILURE;
      return result;
    });
  }

  /** Bounded deferral of a submission that no longer fits admission. */
  protected reject(op: OwnedReviewV1): PortResultV1<ReviewSubmitOutcomeV1> {
    op.phase = "failed";
    op.done = true;
    return portOk({ status: "rejected" });
  }

  protected fail(
    op: OwnedReviewV1,
    detail: string,
    ambiguous = false,
  ): PortResultV1<ReviewSubmitOutcomeV1> {
    op.phase = "failed";
    op.done = true;
    if (ambiguous) {
      return portOk({ status: "ambiguous" });
    }
    return portError("unavailable", detail);
  }
  protected abstract reconcile(
    op: OwnedReviewV1,
  ): Promise<
    | { kind: "create" }
    | { kind: "record"; reviewId: number }
    | { kind: "published"; reviewId: number }
    | { kind: "error"; detail: string }
  >;

  protected abstract reconcileOwnCreate(
    op: OwnedReviewV1,
    ownIntentBody: string,
  ): Promise<
    | { kind: "create" }
    | { kind: "own-intent"; reviewId: number }
    | { kind: "record"; reviewId: number }
    | { kind: "published"; reviewId: number }
    | { kind: "error"; detail: string }
  >;

  protected abstract reconcileRead(
    op: OwnedReviewV1,
  ): Promise<BoundRecordV1 | { kind: "error"; detail: string }>;

  protected abstract bindRecords(
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
  ): Promise<BoundRecordV1>;

  protected abstract readPhase(
    op: OwnedReviewV1,
    reviewId: number,
    expected: {
      phase: "intent" | "running" | "ready";
      body: string;
      execution?: PreparedStructuredReviewV1["execution"];
    },
  ): Promise<
    { kind: "ok"; journal: ReviewJournalV1 } | { kind: "error"; detail: string }
  >;

  protected abstract journalIdentityMatches(
    op: OwnedReviewV1,
    reviewId: number,
    journal: ReviewJournalV1,
  ): boolean;

  protected abstract parseBody(
    body: string | null,
  ): Promise<ReviewJournalV1 | null>;

  protected abstract render(journal: ReviewJournalV1): string | null;

  protected abstract liveReceipt(op: OwnedReviewV1): ReviewServiceReadV1;

  protected abstract unavailableReceipt(
    request: ReviewRequestReadV1,
  ): ReviewServiceReadV1;

  protected abstract journalReceipt(
    journal: ReviewJournalV1,
    review: GitHubReviewWireV1,
  ): ReviewServiceReadV1;

  protected abstract publishDisposition(
    op: OwnedReviewV1,
    outcome: StructuredReviewOutcomeV1 | null,
    /** Static sanitized reason of the refusing precondition, when known. */
    reason?: string | null,
  ): Promise<void>;

  protected abstract publishDurableReady(
    request: ReviewRequestReadV1,
    journal: ReviewJournalReadyV1,
    review: GitHubReviewWireV1,
  ): Promise<PortResultV1<ReviewServiceReadV1>>;

  protected abstract adoptPublished(
    op: OwnedReviewV1,
    reviewId: number,
  ): PortResultV1<ReviewSubmitOutcomeV1>;

  protected abstract submitPublication(
    op: OwnedReviewV1,
    reviewId: number,
    body: string,
  ): Promise<boolean>;

  protected abstract runSubmission(
    op: OwnedReviewV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>>;

  abstract drain(input: {
    deadline: number;
    interrupt: boolean;
  }): Promise<ReviewDrainReportV1>;

  protected abstract drainOperation(
    op: OwnedReviewV1,
    deadline: number,
    interrupt: boolean,
    markInterrupted: () => void,
  ): Promise<ReviewDrainOperationV1>;

  protected abstract closeWithin(
    op: OwnedReviewV1,
    deadline: number,
    now: () => number,
  ): Promise<void>;

  protected abstract drainEntry(op: OwnedReviewV1): ReviewDrainOperationV1;

  abstract submitReview(
    request: ReviewRequestSubmitV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>>;

  abstract readReview(
    request: ReviewRequestReadV1,
  ): Promise<PortResultV1<ReviewServiceReadV1>>;
}
