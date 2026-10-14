/** Current restricted gateway capture format, pinned to producer a858a6ed. */
export const GATEWAY_CAPTURE_METADATA_VERSION = 3;
export const GATEWAY_CAPTURE_UPSTREAM_VERSION = 2;
export const GATEWAY_CAPTURE_MAX_METADATA_BYTES = 8 * 1024 * 1024;
export const GATEWAY_CAPTURE_MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
export const GATEWAY_CAPTURE_MAX_UPSTREAM_CHUNKS = 4096;
export const GATEWAY_CAPTURE_MAX_DOWNSTREAM_BYTES = 64 * 1024;
export const GATEWAY_CAPTURE_MAX_TIMING_MS = 7 * 24 * 60 * 60 * 1000;

export const GATEWAY_CAPTURE_UPSTREAM_PROVIDERS = [
  "chatgpt_codex",
  "surplus",
  "metered",
  "cerebras",
  "deepseek",
  "lithos",
  "openrouter",
] as const;
export type GatewayCaptureProviderV2 =
  typeof GATEWAY_CAPTURE_UPSTREAM_PROVIDERS[number];

export const GATEWAY_CAPTURE_RESPONSE_HEADER_NAMES = [
  "cache-control",
  "content-length",
  "content-type",
  "openai-processing-ms",
  "retry-after",
  "x-ratelimit-limit-requests",
  "x-ratelimit-limit-tokens",
  "x-ratelimit-remaining-requests",
  "x-ratelimit-remaining-tokens",
  "x-ratelimit-reset-requests",
  "x-ratelimit-reset-tokens",
] as const;

export const GATEWAY_CAPTURE_UNAVAILABLE_REASONS = [
  "request_body_omitted",
  "upstream_trace_empty",
  "upstream_trace_truncated",
  "upstream_attempt_pending",
  "upstream_timing_unavailable",
  "upstream_response_headers_unavailable",
  "downstream_terminal_body_unavailable",
  "observed_serving_model_unavailable",
  "provider_state_not_reproducible",
] as const;
export type GatewayCaptureUnavailableReasonV3 =
  typeof GATEWAY_CAPTURE_UNAVAILABLE_REASONS[number];

export interface GatewayCaptureSettingsV3 {
  source: "recorded_request_body" | "unavailable";
  provider_route: string;
  model_requested: string | null;
  reasoning_requested: string | null;
  stream_requested: boolean | null;
  stream_observed: boolean | null;
}

export interface GatewayCaptureDownstreamV3 {
  terminal_type: string | null;
  failure_kind: string | null;
  error_code: string | null;
  error_param: string | null;
  body_base64: string | null;
  body_truncated: boolean;
}

export interface GatewayCaptureFactsV3 {
  settings: GatewayCaptureSettingsV3;
  capture_status: "ready" | "incomplete";
  replay_coverage: "full" | "partial" | "unavailable";
  unavailable: GatewayCaptureUnavailableReasonV3[];
  body_sha256: string;
  body_bytes: number;
  downstream: GatewayCaptureDownstreamV3;
}

export interface GatewayCaptureAttemptMetadataV2 {
  headers: Record<string, string>;
  headers_truncated: boolean;
  chunk_times_ms: number[];
  started_at_ms: number;
  headers_at_ms: number | null;
  ended_at_ms: number | null;
}
