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
 * Fixed code table for this module's own static failure strings. It exists so a
 * failed model run names the exact seam it failed at instead of reporting only
 * `unavailable`. Every code is a literal defined HERE; text that is not in this
 * table maps to null, so no server output, probe output, path, or payload can
 * ever reach the advisory line.
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
];

/** Exact code for one of this module's own static strings, else null. */
export function hostReasonCode(detail: unknown): string | null {
  if (typeof detail !== "string") return null;
  for (const [text, code] of HOST_REASON_CODES) {
    if (detail === text) return code;
  }
  return null;
}

/** True only for one of this module's own reason-code literals. */
export function isHostReasonCode(value: unknown): value is string {
  return typeof value === "string" &&
    HOST_REASON_CODES.some(([, code]) => code === value);
}
