/** Bounded notification, loop-guard and terminal settlement state machine. */
import type { ModelRunRequestV1 } from "../contracts/ports.ts";
import type { CodexSessionV1 } from "./codex-transport.ts";
import { FailedCommandLoopGuard } from "./failed-command-loop.ts";
import {
  closedModelErrorInfo,
  type ModelBoundaryDiagnosticV1,
  type ModelInterruptCauseV1,
} from "./model-port-diagnostics.ts";
import type {
  ModelRerouteV1,
  SessionResultItemV1,
} from "./model-port-receipt.ts";
import {
  type CapturedObservationV1,
  inconclusiveObservation,
  normalizeObservation,
} from "./model-port-observation.ts";
import {
  hasValidCommandExecution,
  hasValidCompletedChanges,
  isBoundedId,
  MAX_ACTIVE_COMMAND_IDS,
  MAX_COMMAND_CHARS,
  MAX_CWD_CHARS,
  MAX_ITEM_ID_CHARS,
  MAX_OUTPUT_CHARS,
  MAX_PENDING_OBSERVATIONS,
  MAX_REROUTES,
  MAX_RESULT_ITEMS,
  MAX_UNIQUE_ITEM_IDS,
  SETTLE_GRACE_MS_EXTRA,
  STEER_TEXT,
} from "./model-port-policy.ts";

export interface AwaitedSettlementV1 {
  boundaryDiagnostic: ModelBoundaryDiagnosticV1;
  /** Observed runtime terminal; null when the host's own bounds elapsed first. */
  terminal: {
    status: "completed" | "interrupted" | "failed";
    error: string | null;
    durationMs: number | null;
  } | null;
  /** Terminal evidence origin: runtime observation vs host timeout. */
  terminalOrigin: "runtime" | "host-timeout";
  /**
   * Sticky unavailable-evidence disposition: protocol/routing uncertainty
   * makes the receipt `unavailable` before any verifier/candidate action.
   */
  unavailable: { detail: string } | null;
  outputChars: number;
  /** Bounded complete correlated routing events for the exact thread/turn. */
  reroutes: ModelRerouteV1[];
  /** Bounded correlated successful output items for the exact thread/turn. */
  resultItems: SessionResultItemV1[];
  /** Own failed-command loop stop: early interrupt already decided. */
  loopStopped: boolean;
}

/**
 * Bounded settlement wait. Returns a PRIVATE final-snapshot getter: the
 * settlement promise only signals that the loop guard/turn work has stopped
 * and the bounded drain finished, while the returned getter captures the
 * final routing/terminal evidence at the exact moment the caller has also
 * completed its close/settlement/transport checks. A routing notification
 * delivered during close is therefore still validated into the receipt.
 * `durationBoundMs` (a 429 backoff retry's remaining session budget) can only
 * shorten the request's duration bound; the diagnostic keeps the request's.
 */
export async function awaitSettlement(
  checkoutDir: string,
  graceMs: number,
  session: CodexSessionV1,
  request: ModelRunRequestV1,
  threadId: string,
  turnId: string,
  maxOutputChars: number,
  durationBoundMs: number = request.maxDurationMs,
): Promise<() => AwaitedSettlementV1> {
  const boundMs = Number.isSafeInteger(durationBoundMs) && durationBoundMs > 0
    ? Math.min(durationBoundMs, request.maxDurationMs)
    : request.maxDurationMs;
  let outputChars = 0;
  let interruptCause: ModelInterruptCauseV1 = "none";
  let errorInfo: ReturnType<typeof closedModelErrorInfo> | null = null;
  // Bounded COMPLETE correlated routing events for this exact thread/turn
  // (well-formed events for other threads/turns are ignored at receipt);
  // a malformed or matching off-route-model event fails closed immediately.
  const reroutes: ModelRerouteV1[] = [];
  // Bounded correlated successful output items (command/file-change/agent
  // output) for this exact thread/turn; notification-byte totals are never
  // output proof.
  const resultItems: SessionResultItemV1[] = [];
  let terminal: AwaitedSettlementV1["terminal"] = null;
  // Host-timeout until a runtime terminal is actually observed; a settlement
  // without a runtime terminal is never presented as an observed terminal.
  let terminalOrigin: AwaitedSettlementV1["terminalOrigin"] = "host-timeout";
  // Sticky unavailable-evidence disposition: protocol/routing uncertainty
  // (malformed reroute/terminal identity, off-policy route, registration
  // failure) makes the receipt `unavailable` before ANY verifier/candidate
  // action — it is never certified as a valid failed runtime receipt.
  let unavailable: AwaitedSettlementV1["unavailable"] = null;
  // Evidence-capture finalization: set by the returned getter. Once set, no
  // later notification — including a late correlated reroute — can mutate
  // the captured receipt evidence.
  let evidenceFinalized = false;
  let resolver: (() => void) | null = null;
  const terminalPromise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  const resolveSettlement = () => {
    resolver?.();
  };

  // --- loop-guard observability state. Every field below is initialized
  // BEFORE the notification listener is registered: the terminal listener
  // may fire synchronously from the pre-registration backlog, so a
  // half-built handler must never be reachable.
  let loopStopped = false;
  let interruptRequested = false;
  let generation = 0;
  let steerSent = false;
  let steerAcked = false;
  let guardDisabled = false;
  // Bounded EXACT active command ids: only unique started ids are added and
  // a completion deletes only that exact id, so a completion can never
  // consume an unrelated command's active state (see collectStarted /
  // collectCompleted).
  const activeCommandIds = new Set<string>();
  const seenItemIds = new Set<string>();
  const guard = new FailedCommandLoopGuard(threadId, turnId);
  const jobs: CapturedObservationV1[] = [];
  let draining: Promise<void> | null = null;
  let stopped = false;
  // Private cancellation for a pending steer/settlement wait: resolved by
  // settleNow so a terminal (or any other stop) resolves the pending steer
  // race immediately instead of leaving its default-grace timer (or a hung
  // steer send) alive past settlement.
  let cancelSettlement: (() => void) | null = null;
  const cancelled = new Promise<void>((resolve) => {
    cancelSettlement = resolve;
  });

  const settleNow = () => {
    if (stopped) return;
    stopped = true;
    jobs.length = 0;
    clearTimeout(durationTimer);
    clearTimeout(settleTimer);
    // Cancel the pending steer FIRST: a drain in-flight inside `sendSteer`
    // must not wait (or depend) on the default-grace steer timer once the
    // terminal stop has happened; the race loses to this resolution and the
    // sendSteer continuation observes `stopped` and returns without sending.
    cancelSettlement?.();
    // The settlement signal carries no evidence snapshot: the final
    // snapshot is captured separately by the returned getter AFTER the
    // caller's close/settlement/transport checks, so a routing event
    // delivered during close is still validated and counted.
    if (draining === null) {
      resolveSettlement();
      return;
    }
    // Await the bounded drain after canceling the steer: queued jobs were
    // dropped above, the in-flight job observes `stopped` and performs no
    // side effects, and the checkpoint work is privately bounded, so the
    // wait is finite and no separate cleanup timer can outlive settlement.
    // A rejection never escapes as a dangling rejecting finally chain.
    void draining.catch(() => {}).finally(() => {
      resolveSettlement();
    });
  };

  /**
   * Request a turn interrupt and start the settlement grace NOW: every
   * interrupt path (duration ceiling, output-bound crossing, own loop stop)
   * uses the same immediate grace, so a stopped run never waits for the old
   * duration ceiling. Once the wait is settled, no callback sends anything.
   */
  const requestInterrupt = (cause: Exclude<ModelInterruptCauseV1, "none">) => {
    if (stopped || interruptRequested) return;
    interruptCause = cause;
    interruptRequested = true;
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      // Host timeout: no runtime terminal arrived inside the grace. The
      // settlement keeps the null observed terminal and the `host-timeout`
      // origin — the run may retain failed accounting but never pretends it
      // observed a terminal.
      settleNow();
    }, graceMs + SETTLE_GRACE_MS_EXTRA);
    try {
      session.send("turn/interrupt", { threadId, turnId }).catch(() => {
        // The interrupt request itself failed; the wait continues to the
        // grace deadline and then settles as a host timeout.
      });
    } catch {
      // A synchronously-throwing session must never escape the receiver.
    }
  };

  /**
   * Early loop stop: the repair loop guard owns the stop, so settlement
   * grace starts NOW (never at the old duration ceiling) and the exact
   * terminal is awaited from this point.
   */
  const earlyLoopInterrupt = () => {
    if (loopStopped || stopped) return;
    loopStopped = true;
    requestInterrupt("failed_command_loop");
  };

  /**
   * Sticky unavailable-evidence disposition: protocol/routing uncertainty.
   * It latches even AFTER the loop guard stopped (a correlated routing
   * event can arrive during close), preserving the FIRST failure, and only
   * drives the stop path when the run has not stopped yet.
   */
  const failEvidence = (detail: string) => {
    if (evidenceFinalized) return;
    if (unavailable === null) unavailable = { detail };
    if (stopped) return;
    settleNow();
  };

  /**
   * Record one successful correlated output item (bounded, earliest first).
   * Only adequately identified items of the exact thread/turn qualify; an
   * unidentifiable deliverable is never output proof and a completed run
   * then fails closed instead of counting bytes.
   */
  const recordResultItem = (
    item: Record<string, unknown>,
    type: SessionResultItemV1["type"],
  ) => {
    if (resultItems.length >= MAX_RESULT_ITEMS) return;
    const itemId = typeof item.id === "string" && isBoundedId(item.id)
      ? item.id
      : null;
    if (itemId === null) return;
    resultItems.push({ itemId, type });
  };

  /**
   * Correlated routing validation for the EXACT thread/turn. Well-formed
   * events for other threads/turns are ignored; a missing/malformed identity
   * or a matching malformed/off-route-model event sets the sticky unavailable
   * disposition (this routing uncertainty is never certified as a failed
   * runtime receipt). Any matching reroute off the route-selected model
   * rejects the run even when it is routed back later; no route fallback or
   * synthesized identity exists. The bounded complete history is preserved
   * (the well-formed event is recorded) BEFORE the off-policy rejection.
   */
  const collectReroute = (params: unknown) => {
    const record = params as Record<string, unknown> | null;
    const eventThreadId = typeof record?.threadId === "string"
      ? record.threadId
      : null;
    const eventTurnId = typeof record?.turnId === "string"
      ? record.turnId
      : null;
    if (
      eventThreadId === null || eventTurnId === null ||
      !isBoundedId(eventThreadId) || !isBoundedId(eventTurnId)
    ) {
      failEvidence("malformed reroute identity");
      return;
    }
    if (eventThreadId !== threadId || eventTurnId !== turnId) return;
    const from = typeof record?.fromModel === "string"
      ? record.fromModel
      : null;
    const to = typeof record?.toModel === "string" ? record.toModel : null;
    const rawReason = record?.reason;
    const reason = typeof rawReason === "string" ? rawReason : null;
    if (
      from === null || to === null || !isBoundedId(from) ||
      !isBoundedId(to) ||
      (rawReason !== undefined && typeof rawReason !== "string") ||
      (reason !== null && !isBoundedId(reason))
    ) {
      failEvidence("malformed matching reroute");
      return;
    }
    if (reroutes.length >= MAX_REROUTES) {
      failEvidence("reroute evidence exceeded bound");
      return;
    }
    // Preserve the bounded correlated history before rejecting an off-policy
    // route: the well-formed event is recorded, then the rejection is set.
    reroutes.push({ threadId, turnId, from, to, reason });
    if (
      from === to || from !== request.model || to !== request.model
    ) {
      failEvidence("run routed off required Luna/max");
    }
  };

  const collectStarted = (params: unknown) => {
    const record = params as Record<string, unknown> | null;
    if (record?.threadId !== threadId || record?.turnId !== turnId) return;
    const item = record?.item as Record<string, unknown> | null;
    if (item?.type === "fileChange") {
      // Any edit is state progress: the repeated-failure sequence resets
      // even when the committed HEAD did not change (the model is changing
      // files), and pending observations no longer attest their state.
      generation++;
      guard.resetProgress();
      return;
    }
    if (item?.type !== "commandExecution") return;
    if (
      typeof item.id !== "string" || item.id.length === 0 ||
      item.id.length > MAX_ITEM_ID_CHARS
    ) {
      // An unidentifiable start makes active-command bookkeeping
      // untrustworthy: disable the early guard conservatively and reset the
      // sequence; the start is still progress for pending observations.
      guardDisabled = true;
      generation++;
      guard.resetProgress();
      return;
    }
    if (activeCommandIds.has(item.id) || seenItemIds.has(item.id)) {
      // Duplicate start: no state change. An id that already completed
      // (seenItemIds) must never re-enter active bookkeeping as a ghost
      // active command, or pending failure evidence would be invalidated.
      return;
    }
    if (activeCommandIds.size >= MAX_ACTIVE_COMMAND_IDS) {
      // The active-id bound is exceeded: conservatively disable the guard.
      guardDisabled = true;
      generation++;
      guard.resetProgress();
      return;
    }
    activeCommandIds.add(item.id);
    // The start is a progress generation: any observation still pending
    // when this start was received is invalid (see observeWork below).
    generation++;
  };

  const captureCompleted = (
    item: Record<string, unknown>,
    itemId: string,
    receivedOthersActive: boolean,
  ): CapturedObservationV1 => {
    const rawCommand = typeof item.command === "string" ? item.command : null;
    const rawCwd = typeof item.cwd === "string" ? item.cwd : null;
    const rawOutput = typeof item.aggregatedOutput === "string"
      ? item.aggregatedOutput
      : null;
    return {
      receivedGeneration: generation,
      receivedSteerAcked: steerAcked,
      receivedOthersActive,
      itemId,
      command: rawCommand !== null && rawCommand.length <= MAX_COMMAND_CHARS
        ? rawCommand
        : null,
      cwd: rawCwd !== null && rawCwd.length <= MAX_CWD_CHARS ? rawCwd : null,
      status: typeof item.status === "string" ? item.status : null,
      output: rawOutput !== null && rawOutput.length <= MAX_OUTPUT_CHARS
        ? rawOutput
        : null,
      exitCode: typeof item.exitCode === "number" ? item.exitCode : null,
    };
  };

  const collectCompleted = (params: unknown) => {
    const record = params as Record<string, unknown> | null;
    // Normalize exact completed items for this thread/turn only; events for
    // other threads/turns are stale and ignored (never a sequence break).
    if (record?.threadId !== threadId || record?.turnId !== turnId) return;
    const item = record?.item as Record<string, unknown> | null;
    if (item?.type === "fileChange") {
      // Any edit is state progress (the repeated-failure sequence resets);
      // only a COMPLETED file change with a nonempty valid changes array
      // (required path/kind/diff fields per the installed ThreadItem schema)
      // is genuine successful output — failed/declined/missing-status/empty-
      // or-malformed changes can never prove output.
      generation++;
      guard.resetProgress();
      if (hasValidCompletedChanges(item)) {
        recordResultItem(item, "fileChange");
      }
      return;
    }
    if (item?.type === "agentMessage") {
      // Only the supported nonblank bounded `text` field is genuine output
      // evidence; the unsupported `content` fallback was removed and
      // anything missing/blank/over-bound is never recorded as proof.
      const text = typeof item.text === "string" ? item.text : null;
      if (
        text !== null && text.trim().length > 0 &&
        text.length <= MAX_OUTPUT_CHARS
      ) {
        recordResultItem(item, "agentMessage");
      }
      return;
    }
    if (item?.type !== "commandExecution") return;
    // Only a schema-valid successful command proves output: status
    // completed, exit code 0, nonempty bounded command/cwd and a bounded
    // schema-valid commandActions array (empty supported). The failed-
    // command-loop classification below is untouched by this proof gate.
    if (hasValidCommandExecution(item)) {
      recordResultItem(item, "commandExecution");
    }
    let itemId: string | null = null;
    if (
      typeof item.id === "string" && item.id.length > 0 &&
      item.id.length <= MAX_ITEM_ID_CHARS
    ) {
      itemId = item.id;
    }
    if (itemId === null) {
      // A completion without an exact bounded id cannot be attributed or
      // deduplicated: it never becomes an observation (no empty-string item
      // id through the helper) — reset the sequence directly and discard it.
      guard.resetProgress();
      return;
    }
    // Dedup before any async work or active-state change; a duplicate
    // stream delivery of an already-observed item is ignored (same evidence,
    // never re-counted).
    if (seenItemIds.has(itemId)) return;
    if (seenItemIds.size >= MAX_UNIQUE_ITEM_IDS) {
      guardDisabled = true;
      guard.resetProgress();
      return;
    }
    seenItemIds.add(itemId);
    // Delete only this exact id from the active set (never decrement a
    // count for an unrelated completion); what remains are the OTHER
    // commands still active at receipt, captured before any async work.
    activeCommandIds.delete(itemId);
    const job = captureCompleted(item, itemId, activeCommandIds.size > 0);
    enqueue(job);
  };

  const enqueue = (job: CapturedObservationV1) => {
    if (stopped) return;
    if (jobs.length >= MAX_PENDING_OBSERVATIONS) {
      // Bounded queue overflow: the guard is disabled (stale evidence), the
      // accumulated sequence is conservatively reset, and the overflow item
      // is dropped.
      guardDisabled = true;
      guard.resetProgress();
      return;
    }
    jobs.push(job);
    if (draining === null) {
      draining = drain().catch(() => {}).finally(() => {
        draining = null;
      });
    }
  };

  const drain = async () => {
    while (!stopped) {
      const job = jobs.shift();
      if (job === undefined) break;
      await handleWork(job);
    }
  };

  const handleWork = async (job: CapturedObservationV1) => {
    if (stopped || guardDisabled || interruptRequested) return;
    await observeWork(job);
  };

  const observeWork = async (job: CapturedObservationV1) => {
    // Receipt-time capture: an observation that was received while another
    // command was active, before the steer acknowledgement, or that somehow
    // aged in the bounded queue is uncertain — never counted, conservatively
    // reset instead of turning it into post-ack or concurrent evidence.
    if (
      job.receivedOthersActive ||
      job.receivedGeneration !== generation ||
      job.receivedSteerAcked !== steerAcked
    ) {
      guard.resetProgress();
      return;
    }
    const normalized = await normalizeObservation(
      job,
      checkoutDir,
    );
    if (stopped || interruptRequested || guardDisabled) return;
    // A new command start or edit during the pending checkpoint/hash work
    // invalidates this observation (its checkpoint no longer attests the
    // state the failure ran in) and resets the repeated sequence; a
    // serial start after this observation fully settles is preserved.
    if (
      job.receivedOthersActive ||
      activeCommandIds.size > 0 ||
      job.receivedGeneration !== generation ||
      job.receivedSteerAcked !== steerAcked
    ) {
      guard.resetProgress();
      return;
    }
    const observation = normalized.inconclusive
      ? inconclusiveObservation(threadId, turnId, job)
      : {
        threadId,
        turnId,
        itemId: job.itemId,
        command: normalized.command!,
        cwd: normalized.cwd!,
        exitCode: normalized.exitCode!,
        outputDigest: normalized.outputDigest!,
        checkpoint: normalized.checkpoint!,
        conclusiveFailure: true,
      };
    const result = await guard.observe(observation);
    if (stopped || interruptRequested || guardDisabled) return;
    // Recheck generation/active/ack state AFTER the observe await as well:
    // a stale result must never fire a steer/interrupt.
    if (
      job.receivedOthersActive ||
      activeCommandIds.size > 0 ||
      job.receivedGeneration !== generation ||
      job.receivedSteerAcked !== steerAcked
    ) {
      guard.resetProgress();
      return;
    }
    if (result.kind === "steer") {
      await sendSteer(result.evidenceDigest);
    } else if (result.kind === "interrupt") {
      earlyLoopInterrupt();
    }
  };

  const sendSteer = async (evidenceDigest: string) => {
    if (steerSent) return;
    steerSent = true;
    // Private bounded wait for the acknowledgement: one bounded race inside
    // the existing duration/grace bounds. No replacement turn, session or
    // admission authority; awaiting this can never become unbounded.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const bound = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("steer acknowledgement timeout")),
        graceMs + SETTLE_GRACE_MS_EXTRA,
      );
    });
    try {
      const response = await Promise.race([
        session.send("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: [{
            type: "text",
            text: `${STEER_TEXT}\n[Sanitized evidence: ${evidenceDigest}]`,
            text_elements: [],
          }],
        }),
        bound,
        // A terminal (or any other stop) resolves this race immediately:
        // the default-grace steer timer is cleared in finally and no late
        // response processing can create a request after settlement.
        cancelled,
      ]);
      // Late resolution after a stop/interrupt must not mark anything.
      if (stopped || loopStopped) return;
      const record = response as Record<string, unknown> | null;
      // Acknowledged only by an exact returned turn id for THIS same turn;
      // malformed/rejected/unsupported/unavailable -> interrupt, and the
      // single steer is never retried. The ack state flips at this exact
      // boundary, so pre-ack jobs (captured with their false flag) are
      // discarded/reset by the recheck instead of counting as post-ack.
      if (typeof record?.turnId !== "string" || record.turnId !== turnId) {
        earlyLoopInterrupt();
        return;
      }
      steerAcked = true;
      guard.markSteered();
    } catch {
      if (stopped || loopStopped) return;
      earlyLoopInterrupt();
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  };

  const handleTerminal = (params: unknown) => {
    const record = params as Record<string, unknown> | null;
    // Identity validation happens BEFORE the stale comparison: a nonempty
    // bounded thread id and turn id are required for a successful or
    // interrupted settlement. A missing/nonobject turn (or missing,
    // empty/over-bound thread or turn identity) sets the sticky unavailable
    // disposition (protocol uncertainty is never certified as a failed
    // runtime receipt); valid bounded unrelated identities are ignored.
    const eventThreadId = typeof record?.threadId === "string"
      ? record.threadId
      : null;
    if (eventThreadId === null || !isBoundedId(eventThreadId)) {
      failEvidence("malformed terminal thread id");
      return;
    }
    const turn = record?.turn;
    if (typeof turn !== "object" || turn === null) {
      failEvidence("malformed terminal turn");
      return;
    }
    const turnRecord = turn as Record<string, unknown>;
    const eventTurnId = typeof turnRecord.id === "string"
      ? turnRecord.id
      : null;
    if (eventTurnId === null || !isBoundedId(eventTurnId)) {
      failEvidence("malformed terminal turn id");
      return;
    }
    if (eventThreadId !== threadId || eventTurnId !== turnId) return;
    const status = turnRecord.status;
    if (
      status !== "completed" && status !== "interrupted" &&
      status !== "failed"
    ) {
      failEvidence("malformed terminal turn status");
      return;
    }
    const turnError = (turnRecord.error ?? null) as
      | Record<string, unknown>
      | null;
    const error = typeof turnError?.message === "string"
      ? turnError.message.slice(0, 300)
      : null;
    errorInfo = status === "completed" ? null : closedModelErrorInfo(turnError);
    terminal = {
      status,
      error,
      durationMs: typeof turnRecord.durationMs === "number"
        ? turnRecord.durationMs
        : null,
    };
    // An actual runtime terminal was observed for the exact thread/turn.
    terminalOrigin = "runtime";
    settleNow();
  };

  const onEvent = (method: string, params: unknown) => {
    // Once the final evidence is captured nothing can change the receipt.
    if (evidenceFinalized) return;
    if (stopped) {
      // Post-terminal/stop: the loop guard and every turn/output/job path
      // stay stopped. ONLY bounded correlated routing evidence remains
      // live, because a reroute can be emitted during close after the
      // terminal; it uses the same identity/bound/off-policy validation and
      // still counts toward routing output.
      if (method === "model/rerouted") {
        outputChars += JSON.stringify(params ?? {}).length;
        if (outputChars > maxOutputChars) {
          failEvidence("routing evidence exceeded output bound");
          return;
        }
        collectReroute(params);
      }
      return;
    }
    // Bounded output accounting FIRST: every nonterminal event contributes
    // to the total (malformed, over-bound and unknown events included) and
    // crossing the bound interrupts the turn — no event bypasses the total
    // through an event-specific early return.
    outputChars += JSON.stringify(params ?? {}).length;
    if (method !== "turn/completed" && outputChars > maxOutputChars) {
      requestInterrupt("output_limit");
    }
    if (method === "item/started") {
      collectStarted(params);
      return;
    }
    if (method === "item/completed") {
      collectCompleted(params);
      return;
    }
    if (method === "turn/completed") {
      handleTerminal(params);
      return;
    }
    if (method === "model/rerouted") {
      // Bounded complete correlated routing validation; the port alone
      // decides reroute policy, never the injected verifier.
      collectReroute(params);
      return;
    }
    // Unknown methods were counted above; nothing else is inferred.
  };

  // Timers are armed before the listener registers so a synchronous
  // terminal at registration still observes fully initialized state. Every
  // interrupt path re-arms the settlement grace immediately
  // (see requestInterrupt), so the initial arm is only the fully initialized
  // placeholder never observed by a live interrupt.
  const durationTimer = setTimeout(
    () => requestInterrupt("duration_limit"),
    boundMs,
  );
  let settleTimer: ReturnType<typeof setTimeout>;
  settleTimer = setTimeout(() => {
    // Final host timeout: no runtime terminal was ever observed, so the
    // settlement keeps the null observed terminal and the `host-timeout`
    // origin — never a synthesized failed terminal.
    settleNow();
  }, boundMs + graceMs + SETTLE_GRACE_MS_EXTRA);

  try {
    session.onNotification((event) => onEvent(event.method, event.params));
  } catch {
    // Registration is part of the bounded session lifecycle. If a trusted
    // transport rejects it synchronously, settle through the same path as
    // every other protocol failure so both timers are cleared immediately;
    // a registration failure is protocol uncertainty and sets the sticky
    // unavailable disposition (never a certifiable failed receipt).
    failEvidence("notification registration failed");
  }

  await terminalPromise;
  clearTimeout(durationTimer);
  clearTimeout(settleTimer);
  // Private final-snapshot getter: cloned arrays plus the CURRENT terminal
  // and sticky unavailable values, captured only after the caller closed
  // and verified the session. It finalizes evidence capture so a later
  // notification can never change the returned receipt.
  return () => {
    evidenceFinalized = true;
    return {
      boundaryDiagnostic: {
        errorCode: terminal === null
          ? "model_unknown"
          : errorInfo?.errorCode ?? null,
        httpStatusCode: errorInfo?.httpStatusCode ?? null,
        interruptCause,
        maxDurationMs: request.maxDurationMs,
        maxOutputChars,
        interruptSettlementGraceMs: graceMs,
      },
      terminal,
      terminalOrigin,
      unavailable,
      outputChars,
      reroutes: [...reroutes],
      resultItems: [...resultItems],
      loopStopped,
    };
  };
}
