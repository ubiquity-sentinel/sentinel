/** Request/runtime receipt evidence and candidate finalization gates. */
import type {
  CandidateOutcomeV1,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  candidateCommitRefusalDetail,
  LocalCheckoutResolver,
} from "./model-port-checkout.ts";
import type { CodexImplementationPortOptionsV1 } from "./model-port-session.ts";
import type { AwaitedSettlementV1 } from "./model-port-settlement.ts";
import {
  DEFAULT_MODEL_ID,
  HOST_TIMEOUT_ACCOUNTING_ERROR,
  IDENTITY_POLICY_DETAIL,
  isBoundedId,
  isValidModelId,
  isValidProvider,
  LOOP_STOP_MARKER,
  MAX_REROUTES,
  OUTPUT_EVIDENCE_DETAIL,
  RECEIPT_MISMATCH_DETAIL,
  REQUIRED_REASONING_EFFORT,
  UNAVAILABLE_RECEIPT_DETAIL,
} from "./model-port-policy.ts";

/** One correlated runtime routing event acknowledged for the exact thread/turn. */
export interface ModelRerouteV1 {
  threadId: string;
  turnId: string;
  from: string;
  to: string;
  /** Routing reason when the event carried one; null when absent. */
  reason: string | null;
}

/** One successful correlated output item; notification-byte totals are not proof. */
export interface SessionResultItemV1 {
  itemId: string;
  type: "commandExecution" | "fileChange" | "agentMessage";
}

/**
 * Trusted request/runtime evidence for ONE exact invocation/thread/turn.
 * Values are the submitted provider/model/effort configuration acknowledged by
 * the app-server plus the exact session identities and runtime routing/terminal
 * events the port bound itself — NEVER backend-observed provider attestation.
 */
export interface ActualSessionEvidenceV1 {
  /** Exact invocation identity carried top-level by the receipt. */
  invocationId: string;
  /** Requested runtime model submitted with the run (route-selected id). */
  requestedModel: string;
  /** Requested provider configuration; null when no provider is selected. */
  requestedProvider: string | null;
  /** Requested reasoning effort submitted with the run (frozen max policy). */
  requestedEffort: string;
  /** Exact thread identity acknowledged by thread/start. */
  threadId: string;
  /** Exact turn identity acknowledged by turn/start. */
  turnId: string;
  /** Values the app-server itself acknowledged (configured thread metadata). */
  threadModel: string | null;
  threadModelProvider: string | null;
  threadEffort: string | null;
  /** Bounded complete correlated routing events, oldest first. */
  reroutes: ModelRerouteV1[];
  terminal: {
    /** Observed runtime terminal status; null when none was observed (host timeout). */
    status: "completed" | "interrupted" | "failed" | null;
    error: string | null;
    durationMs: number | null;
  };
  /**
   * Terminal evidence origin: `runtime` when the correlated runtime terminal
   * event was observed; `host-timeout` when the host's own bounds elapsed
   * without any runtime terminal (observed status stays null — the receipt is
   * failed accounting only and never claims an observed terminal).
   */
  terminalOrigin: "runtime" | "host-timeout";
  /**
   * Own failed-command loop stop disposition: the early interrupt already
   * decided the run; a completed runtime terminal racing the stop is preserved
   * but may only ever produce interrupted/no-candidate accounting without
   * successful output.
   */
  loopStopped: boolean;
  /** Bounded successful output items for the exact thread/turn. */
  resultItems: SessionResultItemV1[];
  /** Notification-byte accounting total; never output proof. */
  outputChars: number;
}

/** Validated provider/model/effort values a verifier certifies. */
export interface VerifiedRuntimeValuesV1 {
  provider: string;
  observedModel: string;
  observedReasoning: string;
}

/**
 * Trusted-host verification seam: returns the validated provider/model/effort
 * values only when the request/runtime evidence establishes them; null means
 * the activation boundary stays unresolved and the port must fail closed.
 * The verifier never reads config/env/files and never returns a caller-supplied
 * output string as provider attestation.
 */
export type ReceiptVerifierV1 = (
  evidence: ActualSessionEvidenceV1,
) => VerifiedRuntimeValuesV1 | null;

/**
 * The real request/runtime receipt producer. It certifies ONLY the acknowledged
 * submitted configuration bound to the exact invocation/thread/turn: expected
 * provider plus the exact expected runtime model and the frozen `max` effort
 * policy, correlated terminal status with its explicit origin and bounded
 * complete routing. Exactly the validated provider/model/effort values are
 * returned; the expected provider and the expected model id are the only
 * trusted identities this function accepts (the caller passes the model id the
 * port was constructed with, so a receipt can never keep one model while
 * another was requested). A completed run
 * needs nonempty correlated output items (a command/file-change/agent
 * deliverable — never the notification-byte total) UNLESS the host itself
 * stopped the run (explicit loopStopped disposition), in which case only
 * interrupted/no-candidate accounting is permitted. A host-timeout evidence
 * (null observed status, `host-timeout` origin) stays certifiable for failed
 * accounting without ever claiming an observed terminal. Failed/interrupted
 * runtime evidence is certifiable without output.
 */
export function createRequestRuntimeReceiptVerifier(
  expectedProvider: string,
  expectedModel: string = DEFAULT_MODEL_ID,
): ReceiptVerifierV1 {
  return (evidence: ActualSessionEvidenceV1) => {
    if (!isValidProvider(expectedProvider)) return null;
    if (!isValidModelId(expectedModel)) return null;
    // Request/thread/turn correlation: exact identities and requested policy.
    if (
      evidence.requestedModel !== expectedModel ||
      evidence.requestedEffort !== REQUIRED_REASONING_EFFORT ||
      evidence.requestedProvider !== expectedProvider ||
      !isBoundedId(evidence.threadId) || !isBoundedId(evidence.turnId) ||
      !isBoundedId(evidence.invocationId)
    ) {
      return null;
    }
    // The thread response must acknowledge exactly the requested configuration.
    if (
      evidence.threadModel !== evidence.requestedModel ||
      evidence.threadEffort !== evidence.requestedEffort ||
      evidence.threadModelProvider !== expectedProvider
    ) {
      return null;
    }
    // Terminal origin must be explicit and consistent: an observed terminal is
    // only certifiable as runtime evidence; a null observed status is only
    // certifiable as a host-timeout (never an observed terminal).
    if (evidence.terminalOrigin === "runtime") {
      if (evidence.terminal.status === null) return null;
    } else if (evidence.terminalOrigin === "host-timeout") {
      if (evidence.terminal.status !== null) return null;
    } else {
      return null;
    }
    // Terminal status: completed runs need nonempty correlated output — unless
    // the host itself stopped the run (loopStopped), where only interrupted/
    // no-candidate accounting is permitted without successful output. A
    // failed/interrupted/host-timeout receipt may lack output and stays
    // certifiable for accounting (it can never authorize a candidate).
    if (
      evidence.terminal.status === "completed" &&
      evidence.resultItems.length === 0 && !evidence.loopStopped
    ) {
      return null;
    }
    // Bounded complete routing: any matching reroute off the configured
    // runtime model fails even if the run was routed back later; well-formed
    // unrelated events are ignored; over-bound or matching malformed events
    // fail closed.
    if (evidence.reroutes.length > MAX_REROUTES) return null;
    for (const reroute of evidence.reroutes) {
      if (
        reroute.threadId !== evidence.threadId ||
        reroute.turnId !== evidence.turnId
      ) {
        continue;
      }
      if (
        !isBoundedId(reroute.from) || !isBoundedId(reroute.to) ||
        reroute.from === reroute.to ||
        reroute.from !== evidence.requestedModel ||
        reroute.to !== evidence.requestedModel ||
        (reroute.reason !== null && !isBoundedId(reroute.reason))
      ) {
        return null;
      }
    }
    return {
      provider: expectedProvider,
      observedModel: evidence.requestedModel,
      observedReasoning: evidence.requestedEffort,
    };
  };
}

/** The default verifier never certifies; nothing is ever synthesized. */
export const unavailableReceiptVerifier: ReceiptVerifierV1 = () => null;

/** Finalize validated session evidence after the owned session has settled. */
export async function finishReceipt(
  options: CodexImplementationPortOptionsV1,
  customVerifier: ReceiptVerifierV1 | null,
  customVerifierReceiver: unknown,
  request: ModelRunRequestV1,
  invocationId: string,
  thread: {
    threadId: string;
    model: string | null;
    effort: string | null;
    provider: string | null;
  },
  turnId: string,
  settled: AwaitedSettlementV1,
  verifier: ReceiptVerifierV1,
): Promise<PortResultV1<ModelRunReceiptV1>> {
  // Sticky unavailable-evidence disposition FIRST: protocol/routing
  // uncertainty (malformed reroute/terminal identity, off-policy route,
  // registration failure) returns unavailable before ANY verifier or
  // candidate action — it is never certified as a failed runtime receipt.
  if (settled.unavailable !== null) {
    return portError("unavailable", settled.unavailable.detail);
  }
  const evidence: ActualSessionEvidenceV1 = {
    invocationId,
    requestedModel: request.model,
    requestedProvider: options.modelProvider ?? null,
    requestedEffort: request.reasoning,
    threadId: thread.threadId,
    turnId,
    threadModel: thread.model,
    threadModelProvider: thread.provider,
    threadEffort: thread.effort,
    reroutes: settled.reroutes,
    terminal: {
      // Observed runtime terminal status; null means a host timeout, which
      // never pretends a terminal was observed.
      status: settled.terminal?.status ?? null,
      error: settled.terminal?.error ?? null,
      durationMs: settled.terminal?.durationMs ?? null,
    },
    terminalOrigin: settled.terminalOrigin,
    loopStopped: settled.loopStopped,
    resultItems: settled.resultItems,
    outputChars: settled.outputChars,
  };
  // Port-side correlation and output-evidence validation: it runs for EVERY
  // verifier (including a permissive injected one), so no custom callback
  // can bypass exact-identity/routing/model-policy checks.
  if (
    !isBoundedId(evidence.threadId) || !isBoundedId(evidence.turnId) ||
    !isBoundedId(evidence.invocationId)
  ) {
    return portError("unavailable", IDENTITY_POLICY_DETAIL);
  }
  if (
    settled.terminal?.status === "completed" && !settled.loopStopped &&
    settled.resultItems.length === 0
  ) {
    return portError("unavailable", OUTPUT_EVIDENCE_DETAIL);
  }
  // The concrete core request/runtime checks ALWAYS run first: correlation,
  // thread acknowledgment, routing and output evidence are port duties and
  // cannot be bypassed by a permissive injected verifier. The verifier is
  // the one bound to this attempt's model, so a failover retry certifies
  // exactly the model it requested.
  const verified = verifier(evidence);
  if (verified === null) {
    return portError("unavailable", UNAVAILABLE_RECEIPT_DETAIL);
  }
  // A custom verifier is only an ADDITIONAL restriction applied after the
  // core checks; it can never bypass and its returned values must agree
  // with the core validation.
  if (customVerifier !== null) {
    const custom = customVerifier.call(customVerifierReceiver, evidence);
    if (
      custom === null ||
      custom.provider !== verified.provider ||
      custom.observedModel !== verified.observedModel ||
      custom.observedReasoning !== verified.observedReasoning
    ) {
      return portError("unavailable", RECEIPT_MISMATCH_DETAIL);
    }
  }
  if (settled.terminal?.status === "completed" && !settled.loopStopped) {
    if (options.commitCandidate !== undefined) {
      const committed = await options.commitCandidate.commit(
        request.base,
      );
      if (!committed) {
        return portError(
          "unavailable",
          candidateCommitRefusalDetail(options.commitCandidate),
        );
      }
    }
  }
  const checkout = options.checkout ?? new LocalCheckoutResolver(
    options.checkoutDir,
    request.base,
  );
  const resolved = settled.terminal?.status === "completed" &&
      !settled.loopStopped
    ? await checkout.resolve()
    : null;
  const candidate: CandidateOutcomeV1 | null = resolved !== null &&
      resolved.head !== null && resolved.head !== request.base &&
      resolved.changedPaths.length > 0
    ? {
      head: resolved.head,
      checkpointSha: resolved.checkpointSha,
      changedPaths: resolved.changedPaths,
    }
    : null;
  const actual = buildActual(thread.threadId, turnId, settled, verified);
  if (settled.loopStopped) {
    // Own early loop stop: the model/session did not fail as an application
    // defect and no candidate may be produced — even if a completed runtime
    // terminal races the interrupt, the completed terminal is preserved in
    // the evidence but only interrupted/no-candidate accounting is
    // permitted without successful output. The receipt carries only the
    // sanitized marker.
    return portOk({
      invocationId,
      outcome: settled.terminal?.status === "failed" ? "failed" : "interrupted",
      actual,
      candidate: null,
      error: LOOP_STOP_MARKER,
    });
  }
  if (settled.terminal === null) {
    // HOST timeout: the host's own bounds elapsed without any runtime
    // terminal. The run may retain failed ACCOUNTING with the explicit
    // `host-timeout` origin and the exact invocation/thread/turn identities,
    // but it never pretends a terminal was observed (observed status null).
    return portOk({
      invocationId,
      outcome: "failed",
      actual,
      candidate: null,
      error: HOST_TIMEOUT_ACCOUNTING_ERROR,
    });
  }
  if (settled.terminal.status !== "completed") {
    return portOk({
      invocationId,
      outcome: settled.terminal.status === "interrupted"
        ? "interrupted"
        : "failed",
      actual,
      candidate: null,
      error: settled.terminal.error ?? null,
    });
  }
  return portOk({
    invocationId,
    outcome: "completed",
    actual,
    candidate,
    error: null,
  });
}

/** Identity-bound `actual` block: exact session identities copied from the port state. */
function buildActual(
  threadId: string,
  turnId: string,
  settled: AwaitedSettlementV1,
  verified: VerifiedRuntimeValuesV1,
): ModelRunReceiptV1["actual"] {
  return {
    evidenceKind: "request-runtime",
    provider: verified.provider,
    threadId,
    turnId,
    terminalOrigin: settled.terminalOrigin,
    observedTerminalStatus: settled.terminal?.status ?? null,
    observedModel: verified.observedModel,
    observedReasoning: verified.observedReasoning,
    durationMs: settled.terminal?.durationMs ?? 0,
    outputChars: settled.outputChars,
  };
}
