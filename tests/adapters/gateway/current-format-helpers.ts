import { createHash } from "node:crypto";

/** Independent current producer fixture framing; no production parser is imported. */
export function currentAttempt(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const chunks = Array.isArray(value.chunks_base64) ? value.chunks_base64 : [];
  return {
    headers: value.status === null
      ? {}
      : { "content-type": value.content_type },
    headers_truncated: false,
    chunk_times_ms: chunks.map(() => 0),
    started_at_ms: 0,
    headers_at_ms: value.status === null ? null : 0,
    ended_at_ms: value.terminal === "pending" ? null : 0,
    ...value,
  };
}

function slug(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)
    ? value
    : null;
}

/** Construct the rich facts a current synthetic producer records before encryption. */
export function currentMetadata(
  metadata: Record<string, unknown>,
  body: Uint8Array,
): Record<string, unknown> {
  if (metadata.version !== 3) return metadata;
  const original = metadata.client_observation as Record<string, unknown>;
  const client: Record<string, unknown> = {
    error_code: null,
    error_param: null,
    terminal_body_base64: "e30=",
    terminal_body_truncated: false,
    ...original,
  };
  const internal = metadata.observation as Record<string, unknown>;
  let settings: Record<string, unknown> = {
    source: "unavailable",
    provider_route: internal.provider_route,
    model_requested: null,
    reasoning_requested: null,
    stream_requested: null,
    stream_observed: internal.stream,
  };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(body));
    if (
      parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ) {
      settings = {
        ...settings,
        source: "recorded_request_body",
        model_requested: slug(parsed.model),
        reasoning_requested: slug(parsed.reasoning?.effort) ??
          slug(parsed.reasoning_effort),
        stream_requested: typeof parsed.stream === "boolean"
          ? parsed.stream
          : null,
      };
    }
  } catch { /* A synthetic invalid request remains explicitly unavailable. */ }
  const trace = metadata.upstream as Record<string, unknown>;
  const attempts = Array.isArray(trace?.attempts) ? trace.attempts : [];
  const unavailable: string[] = [];
  const status = client.status as number;
  if (attempts.length === 0 && !(status >= 400 && status < 500)) {
    unavailable.push("upstream_trace_empty");
  }
  if (
    trace?.attempts_truncated || trace?.bytes_truncated ||
    trace?.chunks_truncated
  ) unavailable.push("upstream_trace_truncated");
  if (attempts.some((attempt) => attempt.terminal === "pending")) {
    unavailable.push("upstream_attempt_pending");
  }
  if (attempts.some((attempt) => attempt.headers_truncated)) {
    unavailable.push("upstream_response_headers_unavailable");
  }
  if (client.terminal_body_base64 === null) {
    unavailable.push("downstream_terminal_body_unavailable");
  }
  const coverage = unavailable.includes("upstream_trace_truncated") ||
      unavailable.includes("upstream_attempt_pending")
    ? "partial"
    : attempts.length === 0
    ? status >= 400 && status < 500 ? "full" : "unavailable"
    : unavailable.length === 0
    ? "full"
    : "partial";
  return {
    settings,
    capture_status: unavailable.length === 0 ? "ready" : "incomplete",
    replay_coverage: coverage,
    unavailable,
    body_sha256: createHash("sha256").update(body).digest("hex"),
    body_bytes: body.byteLength,
    downstream: {
      terminal_type: client.terminal_type,
      failure_kind: client.failure_kind,
      error_code: client.error_code,
      error_param: client.error_param,
      body_base64: client.terminal_body_base64,
      body_truncated: client.terminal_body_truncated,
    },
    ...metadata,
    client_observation: client,
  };
}

/** Stable classification is a distinct SHA domain from either producer HMAC. */
export function currentClassification(
  metadata: Record<string, unknown>,
): string {
  const client = metadata.client_observation as Record<string, unknown>;
  const known: Record<string, string> = {
    "http.error": "http_error",
    "response.failed": "response_failed",
    "response.incomplete": "response_incomplete",
    "error": "error",
    "deadline": "deadline",
    "eof": "eof",
  };
  const rawEndpoint = String(metadata.endpoint).split("?", 1)[0];
  const terminal = client.stream && !client.framing_valid
    ? "stream_framing"
    : typeof client.terminal_type === "string" &&
        Object.hasOwn(known, client.terminal_type)
    ? known[client.terminal_type]
    : "unknown";
  return createHash("sha256").update(JSON.stringify({
    endpoint:
      rawEndpoint === "/v1/responses" || rawEndpoint === "/v1/chat/completions"
        ? rawEndpoint
        : "other",
    method: metadata.method === "POST" ? "POST" : "other",
    status: client.status,
    stream: client.stream,
    completed: client.completed,
    framing_valid: client.framing_valid,
    terminal,
  })).digest("hex");
}
