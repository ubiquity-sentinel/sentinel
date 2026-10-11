// review transport lifecycle.

import type {
  PortResultV1,
  ReviewDrainOperationV1,
  ReviewDrainReportV1,
} from "../contracts/ports.ts";
import type { ReviewSubmitOutcomeV1 } from "./review-service.ts";
import type { ReviewJournalRunningV1 } from "./review-journal.ts";
import { portOk } from "../contracts/ports.ts";
import { CLOSE_BOUND_MS } from "./codex-reviewer.ts";
import { GitHubReviewTransportPublication } from "./review-transport-publication.ts";
import {
  DETAIL_CREATE,
  DETAIL_FAILURE,
  DETAIL_INPUT,
  DETAIL_PREPARE,
  DETAIL_READBACK,
  DETAIL_RECONCILE,
  DETAIL_RUNNING,
  DETAIL_SNAPSHOT,
  DETAIL_START,
  type OwnedReviewV1,
  waitUntil,
} from "./review-transport-policy.ts";

export abstract class GitHubReviewTransportLifecycle
  extends GitHubReviewTransportPublication {
  /**
   * One bounded submission run: immutable snapshot -> exhaustive
   * reconciliation -> exact intent create/recovery -> exact authenticated
   * intent readback -> prepare -> durable running journal + byte-exact
   * readback -> deadline recheck -> exactly one start.
   */
  protected async runSubmission(
    op: OwnedReviewV1,
  ): Promise<PortResultV1<ReviewSubmitOutcomeV1>> {
    // Phase A: immutable snapshot of the exact reviewed range. A failure is a
    // retryable transport failure, never a reason to start any model work.
    const captured = await this.snapshot.capture({
      base: op.expectedBase,
      head: op.expectedHead,
    });
    if (!captured.ok) return this.fail(op, DETAIL_SNAPSHOT);

    // The snapshot is awaited work: a deadline that no longer admits the full
    // review bound must not launch a last-second review. Nothing durable was
    // mutated for this operation yet beyond the local record.
    if (!this.admitsStart(op)) return this.reject(op);

    // Phase B: exhaustive reconciliation of the named PR's reviews BEFORE any
    // create. An intent or running record found here was created by an earlier
    // call: it is never permission to prepare or start a model, and a ready
    // pending journal is recovered through the observation path (readReview).
    const reconciled = await this.reconcile(op);
    if (reconciled.kind === "error") {
      return this.fail(op, reconciled.detail);
    }
    if (reconciled.kind === "published") {
      return this.adoptPublished(op, reconciled.reviewId);
    }
    if (reconciled.kind === "record") {
      return this.fail(op, DETAIL_RECONCILE);
    }

    const intentBody = this.render(this.intentJournal(op));
    if (intentBody === null) return this.fail(op, DETAIL_INPUT);
    const created = await this.client.createPendingReview(
      op.prNumber,
      op.expectedHead,
      intentBody,
    );
    if (!created.ok) return this.fail(op, created.error.detail);

    let reviewId: number;
    if (created.value.status === "applied") {
      reviewId = created.value.review.id;
    } else {
      // Lost create response: exactly one exact-identity lookup. Only a record
      // whose EXACT intent bytes are this call's expected intent proves the
      // create applied; uncertain absence never authorizes a second create.
      const recovered = await this.reconcileOwnCreate(op, intentBody);
      if (recovered.kind === "error") return this.fail(op, recovered.detail);
      if (recovered.kind === "create") {
        return this.fail(op, DETAIL_CREATE, true);
      }
      if (recovered.kind === "published") {
        return this.adoptPublished(op, recovered.reviewId);
      }
      if (recovered.kind !== "own-intent") {
        return this.fail(op, DETAIL_RECONCILE);
      }
      reviewId = recovered.reviewId;
    }
    op.reviewId = reviewId;
    op.remoteJournal = true;

    // Phase C: authenticated exact-intent readback. The raw review id, author,
    // head, the complete journal identity and the exact intended body bytes
    // must stand before any producer work.
    const intentReadback = await this.readPhase(op, reviewId, {
      phase: "intent",
      body: intentBody,
    });
    if (intentReadback.kind !== "ok") {
      return this.fail(op, DETAIL_READBACK);
    }

    if (!this.admitsStart(op)) return this.reject(op);

    // Phase D: prepare the producer (bounded; no turn exists yet).
    const prepared = await this.reviewer.prepare({
      snapshot: captured.value,
      task: op.task,
      requestId: op.requestId,
      invocationId: this.invocationId(op),
      ownerRunId: this.ownerRunId,
      latestStartAt: op.latestStartAt,
      settleBy: op.settleBy,
    });
    if (!prepared.ok) {
      return this.fail(op, DETAIL_PREPARE);
    }
    op.prepared = prepared.value;
    // Preparation is awaited work too: recheck before persisting running work.
    if (!this.admitsStart(op)) {
      await this.closePrepared(op);
      return this.reject(op);
    }

    // Phase E: durable running journal with the real prepared identity, then a
    // byte-exact readback (body AND prepared execution) BEFORE the single
    // start. An ambiguous update is reconciled by that same exact readback; the
    // update is never repeated blindly.
    const running: ReviewJournalRunningV1 = {
      ...this.intentJournal(op),
      phase: "running",
      reviewId,
      execution: prepared.value.execution,
    };
    const runningBody = this.render(running);
    if (runningBody === null) {
      await this.closePrepared(op);
      return this.fail(op, DETAIL_INPUT, true);
    }
    const persisted = await this.client.updatePendingReview(
      op.prNumber,
      reviewId,
      runningBody,
    );
    if (!persisted.ok) {
      await this.closePrepared(op);
      return this.fail(op, DETAIL_RUNNING);
    }
    const runningReadback = await this.readPhase(op, reviewId, {
      phase: "running",
      body: runningBody,
      execution: prepared.value.execution,
    });
    if (runningReadback.kind !== "ok") {
      await this.closePrepared(op);
      return this.fail(op, DETAIL_RUNNING, true);
    }
    if (!this.admitsStart(op)) {
      // The durable running journal stands; the review remains charged and a
      // fresh run observes running-without-owned-process as unavailable.
      await this.closePrepared(op);
      return this.fail(op, DETAIL_START, true);
    }
    op.phase = "running";

    // Phase F: exactly one start. The owned promise is registered BEFORE the
    // caller is allowed to advance, with rejection and finalization handlers
    // attached so the run can progress independently.
    op.runningSettled = false;
    op.running = this.ownReview(op, prepared.value);
    return portOk({
      status: "submitted",
      requestId: op.requestId,
      requestedAt: op.requestedAt,
    });
  }

  // -------------------------------------------------------------------------
  // drain
  // -------------------------------------------------------------------------

  /**
   * Stop admission permanently, then await or interrupt every owned review
   * operation — including an in-flight submission and an observation-driven
   * journal publication — and its journal finalization inside the supplied
   * absolute deadline. Never starts a model and never reserves budget.
   */
  async drain(input: {
    deadline: number;
    interrupt: boolean;
  }): Promise<ReviewDrainReportV1> {
    this.draining = true;
    const deadline = Number.isSafeInteger(input.deadline)
      ? input.deadline
      : this.clock.now();
    let interrupted = false;
    const operations: ReviewDrainOperationV1[] = [];
    for (const op of [...this.operations.values()]) {
      operations.push(
        await this.drainOperation(op, deadline, input.interrupt, () => {
          interrupted = true;
        }),
      );
    }
    const faults: string[] = [];
    for (const entry of operations) {
      if (entry.fault !== null) faults.push(entry.fault);
    }
    return {
      ok: operations.every((entry) => entry.outcome !== "faulted"),
      operations,
      faults,
      deadline,
      interrupted,
      completedAt: this.clock.now(),
    };
  }

  /**
   * Drain ONE owned operation inside the caller deadline. The producer's
   * bounded close grace is reserved BEFORE any owned work is awaited, so both
   * an in-flight submission and a running session wait only to the work
   * boundary. Healthy work is awaited (never eagerly interrupted) until that
   * boundary; only then is a still-running session interrupted and closed.
   * `done` is not settlement: a retained prepared handle is always closed
   * inside the caller deadline, and an unsettled session is never reported as
   * a settled process. Closing an unstarted prepared session is not an
   * interruption.
   */
  protected async drainOperation(
    op: OwnedReviewV1,
    deadline: number,
    interrupt: boolean,
    markInterrupted: () => void,
  ): Promise<ReviewDrainOperationV1> {
    const now = () => this.clock.now();
    const remaining = deadline - now();
    const closeReserve = remaining > 0
      ? Math.min(CLOSE_BOUND_MS, remaining)
      : 0;
    // Everything except the reserved close grace is owned work time.
    const workDeadline = deadline - closeReserve;

    // An in-flight submission stays owned: admission already stopped, so it
    // cannot reach a model start, and the drain waits for it to settle inside
    // the work window before the close grace begins.
    const submission = op.submission;
    if (submission !== null && !op.submissionSettled) {
      const raced = await waitUntil(submission, workDeadline, now);
      if (raced === "timeout") op.fault ??= DETAIL_FAILURE;
    }

    const running = op.running;
    if (running !== null && !op.runningSettled) {
      const raced = await waitUntil(running, workDeadline, now);
      if (raced === "timeout") {
        if (interrupt && op.prepared !== null && !op.processSettled) {
          // A session that was actually started is the only interruption.
          markInterrupted();
          await this.closeWithin(op, deadline, now);
        }
        // The owned completion (ready journal write/readback and the COMMENT
        // publication) is proved ONLY by the SAME retained promise settling
        // inside the caller deadline. A proved process close alone is not
        // finalization proof: without this wait a successful drain could be
        // reported while the owned journal work is still in flight.
        if (!op.runningSettled) {
          const finished = await waitUntil(running, deadline, now);
          if (finished === "timeout") op.fault ??= DETAIL_FAILURE;
        }
      }
    } else if (op.prepared !== null && !op.processSettled) {
      // No owned start exists (or the operation is already `done` with an
      // unproved close): close the retained prepared session. This is never
      // reported as an interruption.
      await this.closeWithin(op, deadline, now);
    }
    return this.drainEntry(op);
  }

  /**
   * Start (or reuse) the single owned close and await it only inside the
   * caller deadline. The exact close promise and the retained prepared handle
   * stay owned when caller time is gone: the operation is faulted and never
   * reported as settled.
   */
  protected async closeWithin(
    op: OwnedReviewV1,
    deadline: number,
    now: () => number,
  ): Promise<void> {
    const close = this.closePrepared(op);
    const raced = await waitUntil(close.then(() => {}), deadline, now);
    if (raced === "timeout") op.fault ??= DETAIL_FAILURE;
  }

  protected drainEntry(op: OwnedReviewV1): ReviewDrainOperationV1 {
    const phase: ReviewDrainOperationV1["phase"] = !op.remoteJournal
      ? "none"
      : op.phase === "published"
      ? "published"
      : op.readyDurable
      ? "ready"
      : op.phase === "running"
      ? "running"
      : "intent";
    let outcome: ReviewDrainOperationV1["outcome"];
    if (op.fault !== null) {
      outcome = "faulted";
    } else if (!op.submissionSettled || !op.runningSettled) {
      // Owned submission/journal finalization is still pending: `done` may be
      // set locally, but no successful drain may be reported without proof.
      op.fault ??= DETAIL_FAILURE;
      outcome = "faulted";
    } else if (!op.processSettled && op.prepared !== null) {
      // A producer session is still owned and was not proved settled.
      outcome = "faulted";
    } else if (op.readyDurable && op.phase !== "published") {
      // A durable ready journal awaiting publication is restart-recoverable.
      outcome = "recoverable";
    } else {
      // No owned live process remains: either the review was published, or the
      // operation never materialized remotely, or the durable charge stands as
      // an abandoned intent/running journal that a fresh host reads as
      // unavailable. All are safe to exit with.
      outcome = "settled";
    }
    return {
      operationKey: op.operationKey,
      outcome,
      processSettled: op.processSettled,
      durable: op.readyDurable,
      phase,
      fault: op.fault,
    };
  }
}
