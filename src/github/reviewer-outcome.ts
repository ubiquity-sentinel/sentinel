// reviewer outcome.

import {
  classifyReviewResultRejection,
  isJournalBoundExceeded,
  parseReviewResultJson,
  REVIEW_REASONING,
  type ReviewJournalReadyExecutionV1,
  type ReviewJournalRuntimeActualV1,
  type ReviewResultV1,
} from "./review-journal.ts";
import { portOk, type PortResultV1 } from "../contracts/ports.ts";
import {
  type ActualSessionEvidenceV1,
  createRequestRuntimeReceiptVerifier,
} from "../repair/model-port.ts";
import { PreparedReviewEvents } from "./reviewer-events.ts";
import {
  AMBIGUOUS_FINAL_DETAIL,
  COMMAND_UNSETTLED_DETAIL,
  FINAL_PHASES,
  HOST_CLOSED_DETAIL,
  NO_FINAL_MESSAGE_DETAIL,
  NO_TERMINAL_DETAIL,
  RECEIPT_DETAIL,
  RESULT_BOUND_DETAIL,
  RESULT_MALFORMED_DETAIL,
  RESULT_UNAVAILABLE_DETAIL,
  SESSION_FAILURE_DETAIL,
  TASK_ACCEPTANCE_MISMATCH_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  TASK_ACCEPTANCE_UNBOUND_DETAIL,
  TERMINAL_NOT_COMPLETED_DETAIL,
} from "./reviewer-policy.ts";
import type { StructuredReviewOutcomeV1 } from "./codex-reviewer.ts";
import { validateFindingLocations } from "./reviewer-support.ts";

export abstract class PreparedReviewOutcome extends PreparedReviewEvents {
  protected buildActual(): ReviewJournalRuntimeActualV1 | null {
    const turnId = this.turnId;
    if (turnId === null) return null;
    const terminal = this.terminal;
    return {
      evidenceKind: "request-runtime",
      provider: this.provider,
      threadId: this.threadId,
      turnId,
      terminalOrigin: terminal === null ? "host-timeout" : "runtime",
      observedTerminalStatus: terminal === null ? null : terminal.status,
      observedModel: this.model,
      observedReasoning: REVIEW_REASONING,
      durationMs: terminal?.durationMs ??
        Math.max(0, this.now() - this.turnStartedAt),
      outputChars: this.eventBytes,
    };
  }

  /**
   * Exact task acceptance binding check. Returns the static refusal detail, or
   * null when the verdict is bound to exactly the supplied task statement (or
   * when no statement was supplied and none was invented).
   */
  protected taskAcceptanceFailure(result: ReviewResultV1): string | null {
    const task = this.task;
    // An absent key and an explicit null are the same "no acceptance".
    const acceptance = result.taskAcceptance ?? null;
    if (task === null) {
      return acceptance === null ? null : TASK_ACCEPTANCE_UNBOUND_DETAIL;
    }
    if (acceptance === null) return TASK_ACCEPTANCE_MISSING_DETAIL;
    if (
      acceptance.issueNumber !== task.issueNumber ||
      acceptance.taskDigest !== task.digest
    ) {
      return TASK_ACCEPTANCE_MISMATCH_DETAIL;
    }
    return null;
  }

  protected buildOutcome(): PortResultV1<StructuredReviewOutcomeV1> {
    const actual = this.buildActual();
    const unavailable = (
      detail: string,
      result: ReviewResultV1 | null = null,
      resultId: string | null = null,
    ): PortResultV1<StructuredReviewOutcomeV1> =>
      portOk({
        status: "unavailable",
        result,
        resultId,
        actual,
        execution: null,
        detail,
      });

    // A host close before any runtime terminal is an interruption; an ordinary
    // close after a completed result is not.
    if (this.hostClosed && this.terminal === null) {
      return unavailable(HOST_CLOSED_DETAIL);
    }
    if (this.unavailable !== null) return unavailable(this.unavailable);
    const turnId = this.turnId;
    const terminal = this.terminal;
    if (turnId === null || terminal === null) {
      return unavailable(NO_TERMINAL_DETAIL);
    }
    if (terminal.status !== "completed") {
      return unavailable(TERMINAL_NOT_COMPLETED_DETAIL);
    }
    // Every correlated shell command must have settled before a clean or
    // findings review can be reported: an unfinished command leaves exact
    // evidence unknown and can never be folded into a verdict.
    for (const entry of this.commandItems.values()) {
      if (!entry.completed) return unavailable(COMMAND_UNSETTLED_DETAIL);
    }
    const candidates = this.agentMessages.filter((message) =>
      message.phase === null || FINAL_PHASES.has(message.phase)
    );
    if (candidates.length === 0) return unavailable(NO_FINAL_MESSAGE_DETAIL);
    if (candidates.length > 1) return unavailable(AMBIGUOUS_FINAL_DETAIL);
    const message = candidates[0];

    let result: ReviewResultV1;
    try {
      result = parseReviewResultJson(message.text);
    } catch (error) {
      if (isJournalBoundExceeded(error)) {
        return unavailable(RESULT_BOUND_DETAIL);
      }
      // The existing malformed detail carries only the fixed closed category
      // derived from the first static parser issue; raw model text, parser
      // messages, paths and indexes never reach the sanitized disposition.
      const category = classifyReviewResultRejection(error);
      return unavailable(`${RESULT_MALFORMED_DETAIL} [${category}]`);
    }
    const location = validateFindingLocations(result, this.snapshot);
    if (location !== null) return unavailable(location);
    // Semantic acceptance binding: a supplied task statement REQUIRES a
    // result-bound acceptance that names exactly that task; a result that
    // invents an acceptance without a task statement is refused too. This is
    // what makes a clean code-quality-only review unable to establish task
    // completion.
    const acceptanceFailure = this.taskAcceptanceFailure(result);
    if (acceptanceFailure !== null) {
      return unavailable(acceptanceFailure, result, message.itemId);
    }
    // A throwing failure probe is treated as a reported fatal transport
    // failure; it never escapes as a raw error.
    let sessionFailed = false;
    try {
      sessionFailed = (this.session.getFailure?.() ?? null) !== null;
    } catch {
      sessionFailed = true;
    }
    if (sessionFailed) return unavailable(SESSION_FAILURE_DETAIL);

    const evidence: ActualSessionEvidenceV1 = {
      invocationId: this.invocationId,
      requestedModel: this.model,
      requestedProvider: this.provider,
      requestedEffort: REVIEW_REASONING,
      threadId: this.threadId,
      turnId,
      threadModel: this.threadModel,
      threadModelProvider: this.threadModelProvider,
      threadEffort: this.threadEffort,
      reroutes: [...this.reroutes],
      terminal: {
        status: terminal.status,
        error: null,
        durationMs: terminal.durationMs,
      },
      terminalOrigin: "runtime",
      loopStopped: false,
      resultItems: [{ itemId: message.itemId, type: "agentMessage" }],
      outputChars: this.eventBytes,
    };
    if (
      createRequestRuntimeReceiptVerifier(this.provider, this.model)(
        evidence,
      ) ===
        null
    ) {
      return unavailable(RECEIPT_DETAIL, result, message.itemId);
    }
    if (result.verdict === "unavailable") {
      return unavailable(RESULT_UNAVAILABLE_DETAIL, result, message.itemId);
    }
    if (actual === null) {
      return unavailable(RECEIPT_DETAIL, result, message.itemId);
    }
    const execution: ReviewJournalReadyExecutionV1 = {
      ownerRunId: this.ownerRunId,
      invocationId: this.invocationId,
      threadId: this.threadId,
      submittedProvider: this.provider,
      model: this.model,
      reasoning: REVIEW_REASONING,
      startMayOccur: true,
      turnId,
      resultId: message.itemId,
      actual,
    };
    return portOk({
      status: result.verdict,
      result,
      resultId: message.itemId,
      actual,
      execution,
      detail: null,
    });
  }
}
