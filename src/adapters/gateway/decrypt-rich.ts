import {
  GATEWAY_CAPTURE_MAX_DOWNSTREAM_BYTES,
  GATEWAY_CAPTURE_UNAVAILABLE_REASONS,
  type GatewayCaptureDownstreamV3,
  type GatewayCaptureFactsV3,
  type GatewayCaptureSettingsV3,
} from "../../contracts/gateway-capture.ts";
import {
  hasExactKeys,
  type ParsedRetainedMetadata,
  type RetainedClientObservationWire,
  type RetainedObservationWire,
} from "./decrypt-schema.ts";

const SETTINGS_KEYS = [
  "source",
  "provider_route",
  "model_requested",
  "reasoning_requested",
  "stream_requested",
  "stream_observed",
];
const DOWNSTREAM_KEYS = [
  "terminal_type",
  "failure_kind",
  "error_code",
  "error_param",
  "body_base64",
  "body_truncated",
];
const SLUG = /^[A-Za-z0-9_.:-]{1,128}$/;
const PARAM = /^[A-Za-z0-9_.:[\]-]{1,128}$/;
const REASONS = new Set<string>(GATEWAY_CAPTURE_UNAVAILABLE_REASONS);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export function richNullableText(
  value: unknown,
  param = false,
): value is string | null {
  return value === null ||
    typeof value === "string" && (param ? PARAM : SLUG).test(value);
}

/** Downstream bytes remain restricted and cannot exceed the producer's 64KiB cap. */
export function isDownstreamBody(value: unknown): value is string | null {
  if (value === null) return true;
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(GATEWAY_CAPTURE_MAX_DOWNSTREAM_BYTES / 3) * 4
  ) return false;
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) return false;
  try {
    const decoded = atob(value);
    return decoded.length <= GATEWAY_CAPTURE_MAX_DOWNSTREAM_BYTES &&
      btoa(decoded) === value;
  } catch {
    return false;
  }
}

function settings(value: unknown): GatewayCaptureSettingsV3 | null {
  if (!record(value) || !hasExactKeys(value, SETTINGS_KEYS)) return null;
  if (
    value.source !== "recorded_request_body" && value.source !== "unavailable"
  ) return null;
  if (
    typeof value.provider_route !== "string" ||
    !richNullableText(value.model_requested) ||
    !richNullableText(value.reasoning_requested)
  ) return null;
  if (
    value.stream_requested !== null &&
    typeof value.stream_requested !== "boolean"
  ) return null;
  if (
    value.stream_observed !== null && typeof value.stream_observed !== "boolean"
  ) return null;
  return {
    source: value.source,
    provider_route: value.provider_route,
    model_requested: value.model_requested,
    reasoning_requested: value.reasoning_requested,
    stream_requested: value.stream_requested as boolean | null,
    stream_observed: value.stream_observed as boolean | null,
  };
}

function downstream(
  value: unknown,
  client: RetainedClientObservationWire,
): GatewayCaptureDownstreamV3 | null {
  if (!record(value) || !hasExactKeys(value, DOWNSTREAM_KEYS)) return null;
  if (
    value.terminal_type !== client.terminal_type ||
    value.failure_kind !== client.failure_kind ||
    value.error_code !== client.error_code ||
    value.error_param !== client.error_param
  ) return null;
  if (
    value.body_base64 !== client.terminal_body_base64 ||
    value.body_truncated !== client.terminal_body_truncated
  ) return null;
  return {
    terminal_type: client.terminal_type,
    failure_kind: client.failure_kind,
    error_code: client.error_code,
    error_param: client.error_param,
    body_base64: client.terminal_body_base64,
    body_truncated: client.terminal_body_truncated,
  };
}

export function parseCaptureFactsV3(
  value: Record<string, unknown>,
  client: RetainedClientObservationWire,
  observation: RetainedObservationWire,
): GatewayCaptureFactsV3 | null {
  const request = settings(value.settings);
  const observed = downstream(value.downstream, client);
  if (
    request === null || observed === null ||
    request.provider_route !== observation.provider_route ||
    request.stream_observed !== observation.stream
  ) return null;
  if (
    value.capture_status !== "ready" && value.capture_status !== "incomplete"
  ) return null;
  if (
    value.replay_coverage !== "full" && value.replay_coverage !== "partial" &&
    value.replay_coverage !== "unavailable"
  ) return null;
  if (
    !Array.isArray(value.unavailable) ||
    value.unavailable.length > REASONS.size ||
    value.unavailable.some((reason) =>
      typeof reason !== "string" || !REASONS.has(reason)
    )
  ) return null;
  if (new Set(value.unavailable).size !== value.unavailable.length) return null;
  if ((value.capture_status === "ready") !== (value.unavailable.length === 0)) {
    return null;
  }
  if (
    typeof value.body_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.body_sha256)
  ) return null;
  if (
    !Number.isSafeInteger(value.body_bytes) ||
    (value.body_bytes as number) < 0 ||
    (value.body_bytes as number) > 32 * 1024 * 1024
  ) return null;
  return {
    settings: request,
    capture_status: value.capture_status,
    replay_coverage: value.replay_coverage,
    unavailable: [...value.unavailable] as GatewayCaptureFactsV3["unavailable"],
    body_sha256: value.body_sha256,
    body_bytes: value.body_bytes as number,
    downstream: observed,
  };
}

/** Recompute producer-derived facts from the exact authenticated request and trace. */
export function captureFactsMatchBytes(
  metadata: ParsedRetainedMetadata,
): boolean {
  const observed = metadata.settings;
  let model: string | null = null;
  let reasoning: string | null = null;
  let stream: boolean | null = null;
  let source = "unavailable";
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(metadata.bodyBytes),
    );
    if (record(parsed)) {
      source = "recorded_request_body";
      model = richNullableText(parsed.model) && parsed.model !== null
        ? parsed.model
        : null;
      const nested = record(parsed.reasoning) ? parsed.reasoning.effort : null;
      reasoning = richNullableText(nested) && nested !== null
        ? nested
        : richNullableText(parsed.reasoning_effort) &&
            parsed.reasoning_effort !== null
        ? parsed.reasoning_effort
        : null;
      stream = typeof parsed.stream === "boolean" ? parsed.stream : null;
    }
  } catch {
    /* Producer explicitly records unavailable settings for non-JSON bodies. */
  }
  if (
    observed.source !== source || observed.model_requested !== model ||
    observed.reasoning_requested !== reasoning ||
    observed.stream_requested !== stream
  ) return false;
  const trace = metadata.upstream;
  const reasons: string[] = [];
  if (
    trace.attempts.length === 0 &&
    !(metadata.client_observation.status >= 400 &&
      metadata.client_observation.status < 500)
  ) reasons.push("upstream_trace_empty");
  if (
    trace.attempts_truncated || trace.bytes_truncated || trace.chunks_truncated
  ) reasons.push("upstream_trace_truncated");
  if (trace.attempts.some((attempt) => attempt.terminal === "pending")) {
    reasons.push("upstream_attempt_pending");
  }
  if (trace.attempts.some((attempt) => attempt.headers_truncated)) {
    reasons.push("upstream_response_headers_unavailable");
  }
  if (metadata.client_observation.terminal_body_base64 === null) {
    reasons.push("downstream_terminal_body_unavailable");
  }
  if (JSON.stringify(reasons) !== JSON.stringify(metadata.unavailable)) {
    return false;
  }
  const coverage = reasons.includes("upstream_trace_truncated") ||
      reasons.includes("upstream_attempt_pending")
    ? "partial"
    : trace.attempts.length === 0
    ? metadata.client_observation.status >= 400 &&
        metadata.client_observation.status < 500
      ? "full"
      : "unavailable"
    : reasons.length === 0
    ? "full"
    : "partial";
  return metadata.replay_coverage === coverage;
}
