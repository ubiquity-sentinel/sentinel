// reviewer session state.

import type {
  CodexServerNotificationV1,
  CodexSessionV1,
} from "../repair/codex-transport.ts";
import type {
  ReviewJournalExecutionV1,
  ReviewJournalRuntimeActualV1,
  ReviewResultV1,
} from "./review-journal.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type { ReviewSnapshotV1 } from "./review-snapshot.ts";
import type { ReviewTaskStatementV1 } from "../contracts/review-receipt.ts";
import type { ModelRerouteV1 } from "../repair/model-port.ts";
import type {
  StructuredReviewCloseV1,
  StructuredReviewOutcomeV1,
  StructuredReviewPrepareV1,
} from "./codex-reviewer.ts";
import {
  type ActiveCommandV1,
  type AgentMessageV1,
  commandItemProvenance,
  isBoundedCommand,
  type ThreadAckV1,
  TURN_INTERRUPT_GRACE_MS,
  type TurnTerminalV1,
} from "./reviewer-policy.ts";
import { asRecord, isBoundedId } from "./reviewer-support.ts";

export abstract class PreparedReviewSessionState {
  readonly execution: ReviewJournalExecutionV1;
  readonly threadId: string;
  readonly invocationId: string;
  readonly requestId: string;
  readonly ownerRunId: string;
  readonly latestStartAt: number;
  readonly settleBy: number;

  protected readonly session: CodexSessionV1;
  protected readonly provider: string;
  protected readonly prompt: string;
  protected readonly snapshot: ReviewSnapshotV1;
  /** Exact task statement this review was prepared with, or null. */
  protected readonly task: ReviewTaskStatementV1 | null;
  protected readonly now: () => number;
  protected readonly hardSettleBy: number;
  protected readonly turnDeadline: number;
  /** Required trusted configured named permission profile. */
  protected readonly permissionProfile: string;
  /** Trusted exact session cwd every correlated command must report. */
  protected readonly sessionCwd: string;
  protected readonly targetDigest: string;
  protected enteredReviewItemId: string | null = null;
  protected exitedReviewItemId: string | null = null;
  protected enteredReviewCompleted = false;
  protected nativeExitStartedId: string | null = null;

  protected phase: "prepared" | "started" | "closed" = "prepared";
  protected attempted = false;
  protected hostClosed = false;
  protected turnId: string | null = null;
  protected turnStartedAt = 0;
  protected interruptSent = false;
  protected terminal: TurnTerminalV1 | null = null;
  protected terminalOrigin: "runtime" | "host-timeout" = "host-timeout";
  protected unavailable: string | null = null;
  protected readonly reroutes: ModelRerouteV1[] = [];
  protected finalMessage: AgentMessageV1 | null = null;
  protected exactFinalSeen = false;
  /** Missing retained evidence refuses acceptance only after native settlement. */
  protected deferredUnavailable: string | null = null;
  protected commandEvidenceIncomplete = false;
  /**
   * Active command items correlated by exact item id: a start records the exact
   * command/cwd/agent-source binding, only a matching terminal completion
   * settles it, and an output delta may only reference a live correlated item.
   */
  protected readonly commandItems = new Map<string, ActiveCommandV1>();
  /** First exact-correlated echoed user item id; null without any echo. */
  protected userEchoId: string | null = null;
  protected readonly earlyEvents: CodexServerNotificationV1[] = [];
  protected earlyBytes = 0;
  protected eventCount = 0;
  protected eventBytes = 0;
  protected settled = false;
  protected readonly settlement: Promise<void>;
  protected resolveSettlement: (() => void) | null = null;
  protected turnTimer: ReturnType<typeof setTimeout> | null = null;
  protected graceTimer: ReturnType<typeof setTimeout> | null = null;
  protected closePromise: Promise<StructuredReviewCloseV1> | null = null;

  constructor(input: {
    session: CodexSessionV1;
    prompt: string;
    snapshot: ReviewSnapshotV1;
    task: ReviewTaskStatementV1 | null;
    now: () => number;
    request: StructuredReviewPrepareV1;
    thread: ThreadAckV1;
    hardSettleBy: number;
    turnDeadline: number;
    permissionProfile: string;
    sessionCwd: string;
    targetDigest: string;
  }) {
    this.session = input.session;
    this.provider = input.thread.modelProvider;
    this.prompt = input.prompt;
    this.snapshot = input.snapshot;
    this.task = input.task;
    this.now = input.now;
    this.requestId = input.request.requestId;
    this.invocationId = input.request.invocationId;
    this.ownerRunId = input.request.ownerRunId;
    this.latestStartAt = input.request.latestStartAt;
    this.settleBy = input.request.settleBy;
    this.hardSettleBy = input.hardSettleBy;
    this.turnDeadline = input.turnDeadline;
    this.threadId = input.thread.threadId;
    this.permissionProfile = input.permissionProfile;
    this.sessionCwd = input.sessionCwd;
    this.targetDigest = input.targetDigest;
    this.execution = {
      ownerRunId: this.ownerRunId,
      invocationId: this.invocationId,
      threadId: this.threadId,
      submittedProvider: this.provider,
      model: null,
      reasoning: null,
      nativeReview: { mode: "review/start", targetDigest: this.targetDigest },
      startMayOccur: true,
    };
    this.settlement = new Promise<void>((resolve) => {
      this.resolveSettlement = () => resolve();
    });
  }

  startAttempted(): boolean {
    return this.attempted;
  }

  protected extractTurnId(response: unknown): string | null {
    const record = asRecord(response);
    const turn = asRecord(record?.turn);
    const turnId = turn?.id;
    return isBoundedId(turnId) ? turnId : null;
  }

  protected armTurnDeadline(): void {
    const remaining = Math.max(1, this.turnDeadline - this.now());
    this.turnTimer = setTimeout(() => this.onTurnDeadline(), remaining);
  }

  protected onTurnDeadline(): void {
    if (this.settled) return;
    if (this.turnId !== null && !this.interruptSent) {
      this.interruptSent = true;
      try {
        this.session.send("turn/interrupt", {
          threadId: this.threadId,
          turnId: this.turnId,
        }).catch(() => {});
      } catch {
        // The interrupt request failed; the bounded grace still settles.
      }
    }
    if (this.graceTimer !== null) return;
    const grace = Math.max(
      1,
      Math.min(TURN_INTERRUPT_GRACE_MS, this.hardSettleBy - this.now()),
    );
    this.graceTimer = setTimeout(() => {
      // No runtime terminal inside the bounded grace: the settlement keeps the
      // null observed terminal and the `host-timeout` origin.
      if (this.settled) return;
      this.terminalOrigin = "host-timeout";
      this.settleNow();
    }, grace);
  }

  protected clearTimers(): void {
    if (this.turnTimer !== null) {
      clearTimeout(this.turnTimer);
      this.turnTimer = null;
    }
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  protected settleNow(): void {
    if (this.settled) return;
    this.settled = true;
    this.clearTimers();
    const resolve = this.resolveSettlement;
    this.resolveSettlement = null;
    resolve?.();
  }

  /**
   * Sticky unavailable disposition: unsupported/malformed/ambiguous evidence.
   * Waking the result waiter is separate from evidence collection, so a fatal
   * evidence violation keeps this sticky detail while later events are still
   * validated through the awaited close.
   */
  protected failEvidence(detail: string): void {
    if (this.unavailable === null) this.unavailable = detail;
    this.settleNow();
  }

  protected deferEvidence(detail: string): void {
    if (this.deferredUnavailable === null) this.deferredUnavailable = detail;
  }

  /**
   * One bounded, content-free fingerprint line for a REFUSED command item.
   *
   * The durable disposition can only carry a static reason, so this is the
   * only place a refusal is diagnosable: it reports the structural predicates
   * that decided the refusal (never the command, its output, a path or any
   * other payload) as a single run-log line. It never runs for an accepted
   * item.
   */
  protected reportRefusedCommandItem(
    site: string,
    item: Record<string, unknown>,
  ): void {
    const source = item.source;
    const provenance = commandItemProvenance(item);
    console.log(JSON.stringify({
      event: "sentinel_review_command_item_refused",
      site,
      type: item.type === "commandExecution" ? "commandExecution" : "other",
      status: typeof item.status === "string" ? item.status : null,
      idBounded: isBoundedId(item.id),
      commandBounded: isBoundedCommand(item.command),
      commandChars: typeof item.command === "string"
        ? item.command.length
        : null,
      hasActions: Array.isArray(item.commandActions),
      cwdMatches: typeof item.cwd === "string" && item.cwd === this.sessionCwd,
      source: typeof source === "string" ? source : null,
      provenance: provenance === null ? "refused" : "agent-origin",
      pluginId: item.pluginId === undefined || item.pluginId === null
        ? "absent"
        : "present",
      scriptPath: item.scriptPath === undefined || item.scriptPath === null
        ? "absent"
        : "present",
      knownItem: typeof item.id === "string" &&
        this.commandItems.has(item.id),
    }));
  }
  protected abstract onNotification(event: CodexServerNotificationV1): void;

  protected abstract eventShapeFailure(
    event: CodexServerNotificationV1,
  ): string | null;

  protected abstract processEvent(event: CodexServerNotificationV1): void;

  protected abstract itemIdentity(
    params: unknown,
  ): { item: Record<string, unknown>; exact: boolean } | null;

  protected abstract userEchoFailure(
    item: Record<string, unknown>,
  ): string | null;

  protected abstract onUserEcho(item: Record<string, unknown>): void;

  protected abstract onItemStarted(params: unknown): void;

  protected abstract onItemCompleted(params: unknown): void;

  protected abstract onCommandStarted(item: Record<string, unknown>): void;

  protected abstract onCommandCompleted(item: Record<string, unknown>): void;

  protected abstract onCommandOutputDelta(params: unknown): void;

  protected abstract onTerminal(params: unknown): void;

  protected abstract onReroute(params: unknown): void;

  protected abstract buildActual(): ReviewJournalRuntimeActualV1 | null;

  protected abstract taskAcceptanceFailure(
    result: ReviewResultV1,
  ): string | null;

  protected abstract buildOutcome(): PortResultV1<StructuredReviewOutcomeV1>;

  abstract start(): Promise<PortResultV1<StructuredReviewOutcomeV1>>;

  abstract close(): Promise<StructuredReviewCloseV1>;

  protected abstract closeOwned(): Promise<StructuredReviewCloseV1>;
}
