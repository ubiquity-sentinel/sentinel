import { type GitSha, isGitSha, isSha256Hex } from "../contracts/brands.ts";
import type {
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortErrorKindV1,
  PortResultV1,
} from "../contracts/ports.ts";
import {
  hostReasonCode,
  isHostReasonCode,
  localModelResultReason,
  type LocalModelResultReasonV1,
} from "./local-model-reason.ts";

export interface LocalModelDiagnosticV1 {
  version: "v1";
  kind: "sentinel_model_diagnostic";
  taskKey: string;
  base: GitSha;
  observedAt: number;
  outcome: "completed" | "failed" | "interrupted" | "port_error";
  reason: LocalModelResultReasonV1;
  errorKind: PortErrorKindV1 | null;
  terminalOrigin: "runtime" | "host-timeout" | null;
  observedTerminalStatus: "completed" | "interrupted" | "failed" | null;
  durationMs: number | null;
  outputChars: number | null;
  candidatePresent: boolean;
  /**
   * Exact seam code for a `port_error`, from {@link HOST_REASON_CODES}, else
   * null. It can only ever be one of those literals, which is what makes a
   * failed hosted run diagnosable without exposing raw text.
   */
  reasonCode: string | null;
}

const LOCAL_DIAGNOSTIC_KEYS = [
  "version",
  "kind",
  "taskKey",
  "base",
  "observedAt",
  "outcome",
  "reason",
  "errorKind",
  "terminalOrigin",
  "observedTerminalStatus",
  "durationMs",
  "outputChars",
  "candidatePresent",
  "reasonCode",
] as const;

const PORT_ERROR_KINDS: readonly PortErrorKindV1[] = [
  "unavailable",
  "auth_failed",
  "rate_limited",
  "not_found",
  "conflict",
  "invalid",
];

function isPortErrorKind(value: unknown): value is PortErrorKindV1 {
  return typeof value === "string" &&
    PORT_ERROR_KINDS.includes(value as PortErrorKindV1);
}

function isAdvisoryCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Strict parser of the advisory summary: exact own keys only, fixed enums,
 * non-negative safe integers and the port-error/receipt shapes validated
 * separately so a mixed record is rejected. Null means no summary may be
 * emitted or copied. Only validated fields are copied into the result.
 */
export function parseLocalModelDiagnosticV1(
  value: unknown,
): LocalModelDiagnosticV1 | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== LOCAL_DIAGNOSTIC_KEYS.length) return null;
  if (!LOCAL_DIAGNOSTIC_KEYS.every((key) => Object.hasOwn(record, key))) {
    return null;
  }
  const version = record.version;
  const kind = record.kind;
  const taskKey = record.taskKey;
  const base = record.base;
  const observedAt = record.observedAt;
  const outcome = record.outcome;
  const reason = record.reason;
  const errorKind = record.errorKind;
  const terminalOrigin = record.terminalOrigin;
  const observedTerminalStatus = record.observedTerminalStatus;
  const durationMs = record.durationMs;
  const outputChars = record.outputChars;
  const candidatePresent = record.candidatePresent;

  if (version !== "v1") return null;
  if (kind !== "sentinel_model_diagnostic") return null;
  if (!isSha256Hex(taskKey)) return null;
  if (!isGitSha(base)) return null;
  if (!isAdvisoryCount(observedAt)) return null;
  if (
    terminalOrigin !== null && terminalOrigin !== "runtime" &&
    terminalOrigin !== "host-timeout"
  ) {
    return null;
  }
  if (
    observedTerminalStatus !== null && observedTerminalStatus !== "completed" &&
    observedTerminalStatus !== "interrupted" &&
    observedTerminalStatus !== "failed"
  ) {
    return null;
  }

  if (outcome === "port_error") {
    // A port error has one fixed shape: its kind, no terminal, no counters and
    // no candidate. Any other combination is not this record.
    if (reason !== "runtime_error") return null;
    if (!isPortErrorKind(errorKind)) return null;
    if (terminalOrigin !== null || observedTerminalStatus !== null) return null;
    if (durationMs !== null || outputChars !== null) return null;
    if (candidatePresent !== false) return null;
    const reasonCode = record.reasonCode;
    if (reasonCode !== null && !isHostReasonCode(reasonCode)) return null;
    return {
      version: "v1",
      kind: "sentinel_model_diagnostic",
      taskKey,
      base,
      observedAt,
      outcome: "port_error",
      reason: "runtime_error",
      errorKind,
      terminalOrigin: null,
      observedTerminalStatus: null,
      durationMs: null,
      outputChars: null,
      candidatePresent: false,
      reasonCode,
    };
  }

  if (
    outcome !== "completed" && outcome !== "failed" && outcome !== "interrupted"
  ) {
    return null;
  }
  if (
    reason !== null && reason !== "output_limit" &&
    reason !== "failed_command_loop" && reason !== "host_timeout" &&
    reason !== "runtime_error"
  ) {
    return null;
  }
  if (errorKind !== null) return null;
  if (terminalOrigin === null) return null;
  if (terminalOrigin === "host-timeout" && observedTerminalStatus !== null) {
    return null;
  }
  if (!isAdvisoryCount(durationMs) || !isAdvisoryCount(outputChars)) {
    return null;
  }
  if (typeof candidatePresent !== "boolean") return null;
  // A settled session carries no seam failure, so its code is exactly null.
  if (record.reasonCode !== null) return null;
  return {
    version: "v1",
    kind: "sentinel_model_diagnostic",
    taskKey,
    base,
    observedAt,
    outcome,
    reason,
    errorKind: null,
    terminalOrigin,
    observedTerminalStatus,
    durationMs,
    outputChars,
    candidatePresent,
    reasonCode: null,
  };
}

/**
 * Rebuild the advisory summary through the explicit allow-list. Only typed
 * receipt/port fields are copied; no untrusted object is spread.
 */
function projectLocalModelDiagnostic(
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
  observedAt: number,
  taskKey: string,
): LocalModelDiagnosticV1 {
  const reason = localModelResultReason(request, result);
  if (!result.ok) {
    return {
      version: "v1",
      kind: "sentinel_model_diagnostic",
      taskKey,
      base: request.base,
      observedAt,
      outcome: "port_error",
      reason,
      errorKind: result.error.kind,
      terminalOrigin: null,
      observedTerminalStatus: null,
      durationMs: null,
      outputChars: null,
      candidatePresent: false,
      // Exactly one code from our own fixed table, never the raw detail.
      reasonCode: hostReasonCode(result.error.detail),
    };
  }
  const receipt = result.value;
  return {
    version: "v1",
    kind: "sentinel_model_diagnostic",
    taskKey,
    base: request.base,
    observedAt,
    outcome: receipt.outcome,
    reason,
    errorKind: null,
    terminalOrigin: receipt.actual.terminalOrigin,
    observedTerminalStatus: receipt.actual.observedTerminalStatus,
    durationMs: receipt.actual.durationMs,
    outputChars: receipt.actual.outputChars,
    candidatePresent: receipt.candidate !== null,
    reasonCode: null,
  };
}

/**
 * Emit the one advisory summary line after the private report is saved. A
 * projection that fails the strict parser prints nothing, and any preparation
 * or emission failure stays local: the saved private report and the caller's
 * result are never changed by advisory diagnostics.
 */
export function emitLocalModelDiagnostic(
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
  observedAt: number,
  taskKey: string,
): void {
  try {
    const safe = parseLocalModelDiagnosticV1(
      projectLocalModelDiagnostic(request, result, observedAt, taskKey),
    );
    if (safe === null) return;
    console.log(JSON.stringify(safe));
  } catch {
    // Advisory only: never affect the successful private persistence.
  }
}
