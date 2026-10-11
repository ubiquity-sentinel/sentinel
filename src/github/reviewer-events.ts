// reviewer events.

import type { CodexServerNotificationV1 } from "../repair/codex-transport.ts";
import { PreparedReviewSessionState } from "./reviewer-session-state.ts";
import {
  AGENT_MESSAGE_BOUND_DETAIL,
  AGENT_MESSAGE_DETAIL,
  AMBIGUOUS_FINAL_DETAIL,
  COMMAND_DELTA_DETAIL,
  COMMAND_ITEM_DETAIL,
  COMMAND_TRANSPORT_DETAIL,
  commandItemProvenance,
  COMMENTARY_PHASES,
  COMPACTED_DETAIL,
  DUPLICATE_TERMINAL_DETAIL,
  EARLY_BOUND_DETAIL,
  EVENT_BOUND_DETAIL,
  FINAL_PHASES,
  isBoundedCommand,
  isForbiddenCommandNotification,
  ITEM_IDENTITY_DETAIL,
  MAX_AGENT_MESSAGES,
  MAX_COMMAND_ITEMS,
  MAX_COMMAND_OUTPUT_BYTES,
  MAX_EARLY_BYTES,
  MAX_EARLY_EVENTS,
  MAX_EVENT_BYTES,
  MAX_EVENT_COUNT,
  MAX_REROUTES,
  REROUTE_BOUND_DETAIL,
  REROUTE_DETAIL,
  REROUTE_OFF_POLICY_DETAIL,
  TERMINAL_DETAIL,
  UNSUPPORTED_ITEM_DETAIL,
  USER_ECHO_DETAIL,
} from "./reviewer-policy.ts";
import { asRecord, isBoundedId, utf8Bytes } from "./reviewer-support.ts";

export abstract class PreparedReviewEvents extends PreparedReviewSessionState {
  protected onNotification(event: CodexServerNotificationV1): void {
    this.eventCount++;
    if (this.eventCount > MAX_EVENT_COUNT) {
      this.failEvidence(EVENT_BOUND_DETAIL);
      return;
    }
    const bytes = JSON.stringify(event.params ?? {}).length;
    this.eventBytes += bytes;
    if (this.eventBytes > MAX_EVENT_BYTES) {
      this.failEvidence(EVENT_BOUND_DETAIL);
      return;
    }
    // Structural identity validation runs on reception (including events that
    // arrive after a terminal) so a malformed queued backlog is already sticky
    // before any turn/start is submitted.
    const shape = this.eventShapeFailure(event);
    if (shape !== null) {
      this.failEvidence(shape);
      return;
    }
    if (this.turnId === null) {
      if (
        this.earlyEvents.length >= MAX_EARLY_EVENTS ||
        this.earlyBytes + bytes > MAX_EARLY_BYTES
      ) {
        this.failEvidence(EARLY_BOUND_DETAIL);
        return;
      }
      this.earlyEvents.push(event);
      this.earlyBytes += bytes;
      return;
    }
    this.processEvent(event);
  }

  /** Static sanitized structural failure for one received event, or null. */
  protected eventShapeFailure(event: CodexServerNotificationV1): string | null {
    switch (event.method) {
      case "item/started":
      case "item/completed":
        return this.itemIdentity(event.params) === null
          ? ITEM_IDENTITY_DETAIL
          : null;
      case "turn/completed": {
        const record = asRecord(event.params);
        if (record === null || !isBoundedId(record.threadId)) {
          return TERMINAL_DETAIL;
        }
        const turn = asRecord(record.turn);
        if (turn === null || !isBoundedId(turn.id)) return TERMINAL_DETAIL;
        return null;
      }
      case "model/rerouted": {
        const record = asRecord(event.params);
        const eventThreadId = record?.threadId;
        const eventTurnId = record?.turnId;
        const from = record?.fromModel;
        const to = record?.toModel;
        const rawReason = record?.reason;
        const reason = typeof rawReason === "string" ? rawReason : null;
        if (
          !isBoundedId(eventThreadId) || !isBoundedId(eventTurnId) ||
          !isBoundedId(from) || !isBoundedId(to) ||
          (rawReason !== undefined && rawReason !== null &&
            typeof rawReason !== "string") ||
          (reason !== null && !isBoundedId(reason))
        ) {
          return REROUTE_DETAIL;
        }
        return null;
      }
      case "item/commandExecution/outputDelta": {
        // Installed 0.154 shape: { threadId, turnId, itemId, delta }. The
        // delta is bounded evidence only; exact correlation is enforced when
        // the event is processed with the exact turn identity available.
        const record = asRecord(event.params);
        if (
          record === null || !isBoundedId(record.threadId) ||
          !isBoundedId(record.turnId) || !isBoundedId(record.itemId) ||
          typeof record.delta !== "string"
        ) {
          return COMMAND_DELTA_DETAIL;
        }
        return null;
      }
      case "thread/compacted":
        // A compacted/insufficient context can never yield a clean review:
        // the exact committed evidence may no longer be intact.
        return COMPACTED_DETAIL;
      default:
        // Unrelated ordinary telemetry stays non-evidentiary, but terminal
        // interaction and connection-scoped command/exec/process traffic can
        // never be accepted for this operation.
        return isForbiddenCommandNotification(event.method)
          ? COMMAND_TRANSPORT_DETAIL
          : null;
    }
  }

  protected processEvent(event: CodexServerNotificationV1): void {
    switch (event.method) {
      case "item/started":
        this.onItemStarted(event.params);
        return;
      case "item/completed":
        this.onItemCompleted(event.params);
        return;
      case "item/commandExecution/outputDelta":
        this.onCommandOutputDelta(event.params);
        return;
      case "turn/completed":
        this.onTerminal(event.params);
        return;
      case "model/rerouted":
        this.onReroute(event.params);
        return;
      default:
        // Well-formed unrelated notifications are tolerated; nothing else is
        // inferred from them.
        return;
    }
  }

  protected itemIdentity(
    params: unknown,
  ): { item: Record<string, unknown>; exact: boolean } | null {
    const record = asRecord(params);
    if (record === null) return null;
    const item = asRecord(record.item);
    if (
      !isBoundedId(record.threadId) || !isBoundedId(record.turnId) ||
      item === null
    ) {
      return null;
    }
    const itemType = item.type;
    if (!isBoundedId(itemType)) return null;
    const exact = record.threadId === this.threadId &&
      record.turnId === this.turnId;
    return { item, exact };
  }

  /**
   * Bounded validation of one echoed `userMessage` item. The echo is input
   * evidence for the exact submitted prompt only: a bounded nonempty item id
   * and exactly one text content part whose text equals this session's prompt
   * with an empty `text_elements` list. Images, tool content, extra or missing
   * parts and any mismatched text fail closed.
   */
  protected userEchoFailure(item: Record<string, unknown>): string | null {
    if (!isBoundedId(item.id)) return ITEM_IDENTITY_DETAIL;
    const content = item.content;
    if (!Array.isArray(content) || content.length !== 1) {
      return USER_ECHO_DETAIL;
    }
    const part = asRecord(content[0]);
    if (part === null || part.type !== "text") return USER_ECHO_DETAIL;
    if (part.text !== this.prompt) return USER_ECHO_DETAIL;
    const elements = part.text_elements;
    if (!Array.isArray(elements) || elements.length !== 0) {
      return USER_ECHO_DETAIL;
    }
    return null;
  }

  /**
   * Accept one exact-correlated prompt echo as input evidence only. The first
   * echoed user item id is recorded; `item/started`/`item/completed` of that
   * same id are ordinary, while any other user item or mismatched content is
   * sticky. An echo is never result evidence and its absence proves nothing.
   */
  protected onUserEcho(item: Record<string, unknown>): void {
    const failure = this.userEchoFailure(item);
    if (failure !== null) {
      this.failEvidence(failure);
      return;
    }
    const itemId = item.id as string;
    if (this.userEchoId === null) {
      this.userEchoId = itemId;
      return;
    }
    if (this.userEchoId !== itemId) this.failEvidence(USER_ECHO_DETAIL);
  }

  protected onItemStarted(params: unknown): void {
    const identity = this.itemIdentity(params);
    if (identity === null) {
      this.failEvidence(ITEM_IDENTITY_DETAIL);
      return;
    }
    if (!identity.exact) return;
    const type = identity.item.type;
    if (type === "agentMessage" || type === "reasoning") return;
    if (type === "userMessage") {
      this.onUserEcho(identity.item);
      return;
    }
    if (type === "commandExecution") {
      this.onCommandStarted(identity.item);
      return;
    }
    this.failEvidence(UNSUPPORTED_ITEM_DETAIL);
  }

  protected onItemCompleted(params: unknown): void {
    const identity = this.itemIdentity(params);
    if (identity === null) {
      this.failEvidence(ITEM_IDENTITY_DETAIL);
      return;
    }
    if (!identity.exact) return;
    const item = identity.item;
    const type = item.type;
    if (type === "reasoning") return;
    if (type === "userMessage") {
      this.onUserEcho(item);
      return;
    }
    if (type === "commandExecution") {
      this.onCommandCompleted(item);
      return;
    }
    if (type !== "agentMessage") {
      this.failEvidence(UNSUPPORTED_ITEM_DETAIL);
      return;
    }
    if (!isBoundedId(item.id)) {
      this.failEvidence(ITEM_IDENTITY_DETAIL);
      return;
    }
    if (typeof item.text !== "string") {
      this.failEvidence(AGENT_MESSAGE_DETAIL);
      return;
    }
    let phase: string | null = null;
    const rawPhase = item.phase;
    if (rawPhase !== undefined && rawPhase !== null) {
      if (!isBoundedId(rawPhase)) {
        this.failEvidence(AGENT_MESSAGE_DETAIL);
        return;
      }
      phase = rawPhase;
      if (!COMMENTARY_PHASES.has(phase) && !FINAL_PHASES.has(phase)) {
        this.failEvidence(AGENT_MESSAGE_DETAIL);
        return;
      }
    }
    if (this.agentMessages.length >= MAX_AGENT_MESSAGES) {
      this.failEvidence(AGENT_MESSAGE_BOUND_DETAIL);
      return;
    }
    this.agentMessages.push({ itemId: item.id, text: item.text, phase });
    // A second final candidate is contradictory output: it is sticky even when
    // it arrives after the first terminal (during the awaited close).
    const finalCandidates =
      this.agentMessages.filter((message) =>
        message.phase === null || FINAL_PHASES.has(message.phase)
      ).length;
    if (finalCandidates > 1) this.failEvidence(AMBIGUOUS_FINAL_DETAIL);
  }

  /**
   * Accept one exact-correlated read-only `commandExecution` start using the
   * installed 0.154 shape. The exact `inProgress` status, trusted session cwd,
   * bounded id/command, `commandActions` array and agent-only provenance are
   * all required BEFORE the exact command/cwd/source binding is recorded; a
   * duplicate start is contradictory.
   */
  protected onCommandStarted(item: Record<string, unknown>): void {
    const id = item.id;
    const command = item.command;
    const cwd = item.cwd;
    const source = commandItemProvenance(item);
    if (
      item.type !== "commandExecution" || !isBoundedId(id) ||
      !isBoundedCommand(command) || !Array.isArray(item.commandActions) ||
      item.status !== "inProgress" || typeof cwd !== "string" ||
      cwd !== this.sessionCwd || source === null
    ) {
      this.reportRefusedCommandItem("start", item);
      this.failEvidence(COMMAND_ITEM_DETAIL);
      return;
    }
    if (this.commandItems.has(id)) {
      this.reportRefusedCommandItem("duplicate-start", item);
      this.failEvidence(COMMAND_ITEM_DETAIL);
      return;
    }
    if (this.commandItems.size >= MAX_COMMAND_ITEMS) {
      this.failEvidence(EVENT_BOUND_DETAIL);
      return;
    }
    this.commandItems.set(id, {
      command,
      cwd,
      source,
      completed: false,
    });
  }

  /**
   * Accept one exact-correlated `commandExecution` completion. Only an active
   * start with the identical command/cwd/source binding and an installed
   * terminal `completed`/`failed` status settles it; `declined`, unmatched,
   * duplicate and mismatched completions are unavailable.
   */
  protected onCommandCompleted(item: Record<string, unknown>): void {
    const id = item.id;
    const command = item.command;
    const cwd = item.cwd;
    const status = item.status;
    const source = commandItemProvenance(item);
    if (
      item.type !== "commandExecution" || !isBoundedId(id) ||
      !isBoundedCommand(command) || !Array.isArray(item.commandActions) ||
      (status !== "completed" && status !== "failed") ||
      typeof cwd !== "string" || cwd !== this.sessionCwd || source === null
    ) {
      this.reportRefusedCommandItem("completion", item);
      this.failEvidence(COMMAND_ITEM_DETAIL);
      return;
    }
    const active = this.commandItems.get(id);
    if (
      active === undefined || active.completed ||
      active.command !== command || active.cwd !== cwd ||
      active.source !== source
    ) {
      this.reportRefusedCommandItem("completion-mismatch", item);
      this.failEvidence(COMMAND_ITEM_DETAIL);
      return;
    }
    active.completed = true;
  }

  /**
   * Accept one correlated shell output delta as bounded evidence only. The
   * exact thread, turn and live command item identity must match; the delta is
   * never parsed as the structured result, and the aggregate shell output has
   * its own finite bound.
   */
  protected onCommandOutputDelta(params: unknown): void {
    const record = asRecord(params);
    const threadId = record?.threadId;
    const turnId = record?.turnId;
    const itemId = record?.itemId;
    const delta = record?.delta;
    if (
      !isBoundedId(threadId) || !isBoundedId(turnId) ||
      !isBoundedId(itemId) || typeof delta !== "string"
    ) {
      this.failEvidence(COMMAND_DELTA_DETAIL);
      return;
    }
    if (threadId !== this.threadId || turnId !== this.turnId) {
      this.failEvidence(COMMAND_DELTA_DETAIL);
      return;
    }
    const entry = this.commandItems.get(itemId);
    if (entry === undefined || entry.completed) {
      this.failEvidence(COMMAND_DELTA_DETAIL);
      return;
    }
    this.commandOutputBytes += utf8Bytes(delta);
    if (this.commandOutputBytes > MAX_COMMAND_OUTPUT_BYTES) {
      this.failEvidence(EVENT_BOUND_DETAIL);
    }
  }

  protected onTerminal(params: unknown): void {
    const record = asRecord(params);
    if (record === null || !isBoundedId(record.threadId)) {
      this.failEvidence(TERMINAL_DETAIL);
      return;
    }
    const turn = asRecord(record.turn);
    if (turn === null || !isBoundedId(turn.id)) {
      this.failEvidence(TERMINAL_DETAIL);
      return;
    }
    if (record.threadId !== this.threadId || turn.id !== this.turnId) return;
    if (this.terminal !== null) {
      this.failEvidence(DUPLICATE_TERMINAL_DETAIL);
      return;
    }
    const status = turn.status;
    if (
      status !== "completed" && status !== "interrupted" && status !== "failed"
    ) {
      this.failEvidence(TERMINAL_DETAIL);
      return;
    }
    const rawDuration = turn.durationMs;
    const durationMs = typeof rawDuration === "number" &&
        Number.isFinite(rawDuration) && rawDuration >= 0
      ? Math.floor(rawDuration)
      : null;
    this.terminal = { status, error: null, durationMs };
    this.terminalOrigin = "runtime";
    this.settleNow();
  }

  protected onReroute(params: unknown): void {
    const record = asRecord(params);
    const eventThreadId = record?.threadId;
    const eventTurnId = record?.turnId;
    if (!isBoundedId(eventThreadId) || !isBoundedId(eventTurnId)) {
      this.failEvidence(REROUTE_DETAIL);
      return;
    }
    if (eventThreadId !== this.threadId || eventTurnId !== this.turnId) return;
    const from = record?.fromModel;
    const to = record?.toModel;
    const rawReason = record?.reason;
    const reason = typeof rawReason === "string" ? rawReason : null;
    if (
      !isBoundedId(from) || !isBoundedId(to) ||
      (rawReason !== undefined && rawReason !== null &&
        typeof rawReason !== "string") ||
      (reason !== null && !isBoundedId(reason))
    ) {
      this.failEvidence(REROUTE_DETAIL);
      return;
    }
    if (this.reroutes.length >= MAX_REROUTES) {
      this.failEvidence(REROUTE_BOUND_DETAIL);
      return;
    }
    this.reroutes.push({
      threadId: this.threadId,
      turnId: eventTurnId,
      from,
      to,
      reason,
    });
    if (from === to || from !== this.model || to !== this.model) {
      this.failEvidence(REROUTE_OFF_POLICY_DETAIL);
    }
  }
}
