import type {
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { LOOP_STOP_MARKER } from "../repair/model-port.ts";
import {
  STATIC_CHECKOUT,
  STATIC_GIT_BOUND,
  STATIC_GIT_FAILED,
  STATIC_GITHUB_LOGIN,
  STATIC_IMPORT,
  STATIC_LOCAL_CANDIDATE,
  STATIC_MODEL_INPUT,
  STATIC_MODEL_RESULT,
} from "./local-policy.ts";

// ---------------------------------------------------------------------------
// Private local model-result diagnostics (outside every model checkout)
// ---------------------------------------------------------------------------

/**
 * Fixed private classification of one local model result, derived ONLY from
 * the receipt's own evidence. It never invents a cause or a model success.
 */
export type LocalModelResultReasonV1 =
  | "output_limit"
  | "failed_command_loop"
  | "host_timeout"
  | "runtime_error"
  | null;

/** Fixed reason order; no classification is fabricated for a clean run. */
export function localModelResultReason(
  request: ModelRunRequestV1,
  result: PortResultV1<ModelRunReceiptV1>,
): LocalModelResultReasonV1 {
  if (!result.ok) return "runtime_error";
  const receipt = result.value;
  if (receipt.actual.outputChars > request.maxOutputChars) {
    return "output_limit";
  }
  if (receipt.error === LOOP_STOP_MARKER) return "failed_command_loop";
  if (receipt.actual.terminalOrigin === "host-timeout") return "host_timeout";
  if (receipt.error !== null) return "runtime_error";
  return null;
}

/**
 * Public advisory summary of exactly one local model result. It is a separate
 * explicit allow-list, never a serialization of the private projection: no
 * provider/model/reasoning identity, thread/turn identity, task string, raw
 * error, prompt, output, filesystem or candidate path, or credential value can
 * reach this shape. `taskKey` is the stable SHA-256 of the task id and `base`
 * is the exact validated request base.
 */
/**
 * Exact allow-list of static host failures and CodexProtocolError.detail codes.
 * The protocol detail is a closed local enum, never the exception message or
 * server response. Every exported code is a literal defined here; other text
 * maps to null, so no server output, probe output, path, or payload can reach
 * the advisory line. A protocol code identifies its class, not a failing stage.
 */
const HOST_REASON_CODES: readonly (readonly [string, string])[] = [
  [STATIC_MODEL_INPUT, "model_request_invalid"],
  [STATIC_CHECKOUT, "model_checkout_unavailable"],
  [STATIC_IMPORT, "candidate_import_failed"],
  [STATIC_MODEL_RESULT, "model_result_unpersisted"],
  [STATIC_GIT_FAILED, "git_command_failed"],
  [STATIC_GIT_BOUND, "git_output_over_bound"],
  [STATIC_LOCAL_CANDIDATE, "local_candidate_unavailable"],
  [STATIC_GITHUB_LOGIN, "authenticated_login_unavailable"],
  ["malformed_line", "codex_malformed_line"],
  ["unexpected_frame", "codex_unexpected_frame"],
  ["unknown_request_id", "codex_unknown_request_id"],
  ["server_error", "codex_server_error"],
  ["timeout_without_terminal", "codex_timeout_without_terminal"],
  ["child_exited_without_terminal", "codex_child_exited_without_terminal"],
  ["stream_output_bound_exceeded", "codex_stream_output_bound_exceeded"],
  ["operation_deadline", "codex_operation_deadline"],
];

/** Exact code for an allow-listed static host or protocol detail, else null. */
export function hostReasonCode(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  for (const [text, code] of HOST_REASON_CODES) {
    if (detail === text) return code;
  }
  return null;
}

/** True only for one of this module's explicit reason-code literals. */
export function isHostReasonCode(value: unknown): value is string {
  return typeof value === "string" &&
    HOST_REASON_CODES.some(([, code]) => code === value);
}
