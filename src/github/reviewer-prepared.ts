// reviewer prepared.

import { portError, type PortResultV1 } from "../contracts/ports.ts";
import { REVIEW_REASONING } from "./review-journal.ts";
import { reviewResultOutputSchema } from "./review-result-contracts.ts";
import { PreparedReviewOutcome } from "./reviewer-outcome.ts";
import type {
  PreparedStructuredReviewV1,
  StructuredReviewCloseV1,
  StructuredReviewOutcomeV1,
} from "./codex-reviewer.ts";
import {
  CLOSE_FAILED_MARKER,
  LATEST_START_DETAIL,
  REGISTRATION_DETAIL,
  SERVER_REQUEST_DETAIL,
  SETTLE_BY_DETAIL,
  START_REJECTED_DETAIL,
  TURN_RESPONSE_DETAIL,
  TURN_SUBMIT_DETAIL,
} from "./reviewer-policy.ts";
import { boundedClose, racePromise } from "./reviewer-support.ts";

export class PreparedStructuredReview extends PreparedReviewOutcome
  implements PreparedStructuredReviewV1 {
  async start(): Promise<PortResultV1<StructuredReviewOutcomeV1>> {
    if (this.phase !== "prepared" || this.attempted) {
      return portError("unavailable", START_REJECTED_DETAIL);
    }
    // Atomic single-attempt marker BEFORE any recheck or send: a repeated
    // start can never reach a second turn/start request.
    this.phase = "started";
    this.attempted = true;

    const now = this.now();
    if (now >= this.latestStartAt) {
      this.clearTimers();
      return portError("unavailable", LATEST_START_DETAIL);
    }
    if (now >= this.turnDeadline) {
      this.clearTimers();
      return portError("unavailable", SETTLE_BY_DETAIL);
    }
    this.turnStartedAt = now;

    // Register the bounded early-event buffering BEFORE the single send: a
    // terminal/output arriving before the turn/start response is buffered and
    // consumed exactly once after the exact returned turn id is known.
    try {
      this.session.onNotification((event) => this.onNotification(event));
      this.session.onServerRequest(() =>
        this.failEvidence(SERVER_REQUEST_DETAIL)
      );
    } catch {
      this.failEvidence(REGISTRATION_DETAIL);
    }
    this.armTurnDeadline();
    // Registration may have thrown or replayed an invalid queued backlog: a
    // sticky evidence failure forbids the single send entirely.
    if (this.unavailable !== null) {
      this.clearTimers();
      this.settleNow();
      return portError("unavailable", this.unavailable);
    }
    // Recheck the absolute gates after registration/backlog work and
    // immediately before the one send: no request is ever submitted at or
    // after either deadline.
    const gate = this.now();
    if (gate >= this.latestStartAt) {
      this.clearTimers();
      this.settleNow();
      return portError("unavailable", LATEST_START_DETAIL);
    }
    if (gate >= this.turnDeadline) {
      this.clearTimers();
      this.settleNow();
      return portError("unavailable", SETTLE_BY_DETAIL);
    }

    let sendPromise: Promise<unknown>;
    const turnParams: Record<string, unknown> = {
      threadId: this.threadId,
      model: this.model,
      effort: REVIEW_REASONING,
      input: [{ type: "text", text: this.prompt, text_elements: [] }],
      outputSchema: reviewResultOutputSchema(this.task),
      approvalPolicy: "never",
    };
    // The acknowledged named profile is carried into the single turn: the
    // installed schema forbids combining `permissions` with `sandboxPolicy`,
    // and there is no profile-less read-only fallback.
    turnParams.permissions = this.permissionProfile;
    try {
      sendPromise = this.session.send("turn/start", turnParams);
    } catch {
      this.clearTimers();
      this.settleNow();
      return portError("unavailable", TURN_SUBMIT_DETAIL);
    }
    const submitted = await racePromise(
      sendPromise,
      this.turnDeadline,
      this.now,
    );
    if (!submitted.ok) {
      // Lost/failed/over-deadline submission: no terminal identity is invented.
      this.clearTimers();
      this.settleNow();
      return portError("unavailable", TURN_SUBMIT_DETAIL);
    }
    const turnId = this.extractTurnId(submitted.value);
    if (turnId === null) {
      this.clearTimers();
      this.settleNow();
      return portError("unavailable", TURN_RESPONSE_DETAIL);
    }
    this.turnId = turnId;
    if (this.now() >= this.turnDeadline) this.onTurnDeadline();
    // Every buffered event is validated: a contradictory terminal, duplicate
    // final output, off-policy reroute or server request after the first
    // terminal is sticky and cannot be skipped by an early break.
    const buffered = [...this.earlyEvents];
    this.earlyEvents.length = 0;
    this.earlyBytes = 0;
    for (const event of buffered) this.processEvent(event);
    await this.settlement;
    return this.buildOutcome();
  }

  async close(): Promise<StructuredReviewCloseV1> {
    let pending = this.closePromise;
    if (pending === null) {
      this.phase = "closed";
      this.hostClosed = true;
      this.clearTimers();
      this.settleNow();
      pending = this.closeOwned();
      this.closePromise = pending;
    }
    return await pending;
  }

  /**
   * Bounded idempotent close of the owned transport. Evidence arriving during
   * the close window is still validated; a sticky evidence failure is folded
   * into the sanitized close outcome so `finalizeReviewCompletion` invalidates
   * an earlier tentative clean result.
   */
  protected async closeOwned(): Promise<StructuredReviewCloseV1> {
    const closed = await boundedClose(
      this.session,
      this.now,
      this.hardSettleBy,
    );
    if (
      this.unavailable === null && this.deferredUnavailable === null &&
      this.finalMessage?.truncated !== true
    ) return closed;
    return { ...closed, failure: CLOSE_FAILED_MARKER };
  }
}
