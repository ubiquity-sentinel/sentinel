/** Private receipt-object-bound diagnostics; never an authoritative wire field. */
import type {
  ModelRunReceiptV1,
  ModelRunRequestV1,
} from "../contracts/ports.ts";

/**
 * Codex app-server0.154.0, installed by supervisor.yml (not the rubric pin):
 * rust-v0.154.0 ->6b9826e3aa83b1a5947db50f4332cb9c65f1b340;
 * v2 schema blob1c2e7d2edfa82a05c8fee9d4dfa01d33675b5f9c, CodexErrorInfo.
 */
const ERROR_TAGS = {
  contextWindowExceeded: "model_context_window_exceeded",
  sessionBudgetExceeded: "model_session_budget_exceeded",
  usageLimitExceeded: "model_usage_limit_exceeded",
  rateLimitExceeded: "model_rate_limit_exceeded",
  serverOverloaded: "model_server_overloaded",
  cyberPolicy: "model_cyber_policy",
  misalignmentPolicyViolation: "model_misalignment_policy_violation",
  internalServerError: "model_internal_server_error",
  unauthorized: "model_unauthorized",
  badRequest: "model_bad_request",
  threadRollbackFailed: "model_thread_rollback_failed",
  sandboxError: "model_sandbox_error",
  other: "model_other",
  httpConnectionFailed: "model_http_connection_failed",
  responseStreamConnectionFailed: "model_response_stream_connection_failed",
  responseStreamDisconnected: "model_response_stream_disconnected",
  responseTooManyFailedAttempts: "model_response_too_many_failed_attempts",
  activeTurnNotSteerable: "model_active_turn_not_steerable",
} as const;

const UNIT_TAGS = Object.keys(ERROR_TAGS).slice(0, 13);
const HTTP_TAGS = Object.keys(ERROR_TAGS).slice(13, 17);
export type ModelBoundaryErrorCodeV1 =
  | typeof ERROR_TAGS[keyof typeof ERROR_TAGS]
  | "model_unknown";
export type ModelInterruptCauseV1 =
  | "none"
  | "duration_limit"
  | "output_limit"
  | "failed_command_loop";

export interface ClosedModelErrorInfoV1 {
  errorCode: ModelBoundaryErrorCodeV1;
  httpStatusCode: number | null;
}

export interface ModelBoundaryDiagnosticV1 {
  errorCode: ModelBoundaryErrorCodeV1 | null;
  httpStatusCode: number | null;
  interruptCause: ModelInterruptCauseV1;
  maxDurationMs: number;
  maxOutputChars: number;
  interruptSettlementGraceMs: number;
}

function record(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some((key) =>
      typeof key !== "string" || !("value" in descriptors[key])
    )
  ) return null;
  return value as Record<string, unknown>;
}

function httpStatus(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value <= 65_535;
}

/** The structured discriminator only: never infer a code from message prose. */
function parseClosedModelErrorInfo(error: unknown): ClosedModelErrorInfoV1 {
  const unknown = { errorCode: "model_unknown", httpStatusCode: null } as const;
  const outer = record(error);
  if (outer === null) return unknown;
  const info = outer.codexErrorInfo;
  if (typeof info === "string" && UNIT_TAGS.includes(info)) {
    return {
      errorCode: ERROR_TAGS[info as keyof typeof ERROR_TAGS],
      httpStatusCode: null,
    };
  }
  const object = record(info);
  if (object === null || Object.keys(object).length !== 1) return unknown;
  const tag = Object.keys(object)[0];
  const payload = record(object[tag]);
  if (payload === null) return unknown;
  if (tag === "activeTurnNotSteerable") {
    if (payload.turnKind !== "review" && payload.turnKind !== "compact") {
      return unknown;
    }
    return {
      errorCode: ERROR_TAGS.activeTurnNotSteerable,
      httpStatusCode: null,
    };
  }
  if (!HTTP_TAGS.includes(tag)) return unknown;
  const status = payload.httpStatusCode;
  if (status !== undefined && status !== null && !httpStatus(status)) {
    return unknown;
  }
  return {
    errorCode: ERROR_TAGS[tag as keyof typeof ERROR_TAGS],
    httpStatusCode: status ?? null,
  };
}

export function closedModelErrorInfo(error: unknown): ClosedModelErrorInfoV1 {
  try {
    return parseClosedModelErrorInfo(error);
  } catch {
    return { errorCode: "model_unknown", httpStatusCode: null };
  }
}

export function isModelBoundaryReasonCode(
  value: unknown,
): value is ModelBoundaryErrorCodeV1 {
  return typeof value === "string" &&
    (value === "model_unknown" ||
      Object.values(ERROR_TAGS).some((code) => code === value));
}

const BOUNDARY_KEYS = [
  "errorCode",
  "httpStatusCode",
  "interruptCause",
  "maxDurationMs",
  "maxOutputChars",
  "interruptSettlementGraceMs",
] as const;

/** Strict advisory projection; no unrecognized key or raw value is copied. */
export function parseModelBoundaryDiagnostic(
  value: unknown,
): ModelBoundaryDiagnosticV1 | null {
  const object = record(value);
  if (
    object === null || Object.keys(object).length !== BOUNDARY_KEYS.length ||
    !BOUNDARY_KEYS.every((key) => Object.hasOwn(object, key))
  ) return null;
  if (
    object.errorCode !== null && !isModelBoundaryReasonCode(object.errorCode)
  ) return null;
  if (object.httpStatusCode !== null && !httpStatus(object.httpStatusCode)) {
    return null;
  }
  if (
    object.interruptCause !== "none" &&
    object.interruptCause !== "duration_limit" &&
    object.interruptCause !== "output_limit" &&
    object.interruptCause !== "failed_command_loop"
  ) return null;
  for (
    const key of [
      "maxDurationMs",
      "maxOutputChars",
      "interruptSettlementGraceMs",
    ] as const
  ) {
    if (
      typeof object[key] !== "number" || !Number.isSafeInteger(object[key]) ||
      object[key] <= 0
    ) return null;
  }
  return {
    errorCode: object.errorCode,
    httpStatusCode: object.httpStatusCode,
    interruptCause: object.interruptCause,
    maxDurationMs: object.maxDurationMs as number,
    maxOutputChars: object.maxOutputChars as number,
    interruptSettlementGraceMs: object.interruptSettlementGraceMs as number,
  };
}

interface ReceiptDiagnosticBinding {
  taskId: string;
  base: string;
  invocationId: string;
  outcome: ModelRunReceiptV1["outcome"];
  actual: string;
  diagnostic: Readonly<ModelBoundaryDiagnosticV1>;
}

const diagnostics = new WeakMap<ModelRunReceiptV1, ReceiptDiagnosticBinding>();

/** Called only after owned close/settlement and core receipt validation. */
export function retainModelBoundaryDiagnostic(
  receipt: ModelRunReceiptV1,
  request: ModelRunRequestV1,
  diagnostic: ModelBoundaryDiagnosticV1,
): void {
  try {
    const safe = parseModelBoundaryDiagnostic(diagnostic);
    if (safe === null) return;
    diagnostics.set(receipt, {
      taskId: request.taskId,
      base: request.base,
      invocationId: receipt.invocationId,
      outcome: receipt.outcome,
      actual: JSON.stringify(receipt.actual),
      diagnostic: Object.freeze(safe),
    });
  } catch {
    // Private observation is advisory and cannot change the native receipt.
  }
}

/** Clones, serialized receipts and other attempts have no retained authority. */
export function readModelBoundaryDiagnostic(
  receipt: ModelRunReceiptV1,
  request: ModelRunRequestV1,
): ModelBoundaryDiagnosticV1 | null {
  try {
    const binding = diagnostics.get(receipt);
    if (
      binding === undefined || binding.taskId !== request.taskId ||
      binding.base !== (request.checkoutBase ?? request.base) ||
      binding.invocationId !== receipt.invocationId ||
      binding.outcome !== receipt.outcome ||
      binding.actual !== JSON.stringify(receipt.actual) ||
      binding.diagnostic.maxDurationMs !== request.maxDurationMs ||
      binding.diagnostic.maxOutputChars !== request.maxOutputChars
    ) return null;
    return { ...binding.diagnostic };
  } catch {
    return null;
  }
}
