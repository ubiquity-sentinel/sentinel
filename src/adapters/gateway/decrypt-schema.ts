/** Producer HKDF/AAD namespace (source: sentinel_replay_capture.ts, frozen). */
export const RETAINED_NAMESPACE = "uos-sentinel-replay-v1";
/** v2 fingerprint frame namespace (frozen upstream capture cutover). */
export const RETAINED_FINGERPRINT_NAMESPACE = "uos-sentinel-replay-v2";
export const RETAINED_KEY_BYTES = 32;
export const RETAINED_IV_BYTES = 12;
/** Private plaintext metadata version after the upstream capture cutover. */
export const RETAINED_METADATA_VERSION = 2;
/** The v1 request-only metadata version: unsupported, never upstream proof. */
export const RETAINED_LEGACY_METADATA_VERSION = 1;
/** Frozen private upstream snapshot version. */
export const RETAINED_UPSTREAM_VERSION = 1;
/** Aggregate upstream capture bounds (frozen; once hit the producer truncates). */
export const RETAINED_UPSTREAM_MAX_ATTEMPTS = 8;
export const RETAINED_UPSTREAM_MAX_DECODED_BYTES = 131_072;
export const RETAINED_UPSTREAM_MAX_CHUNKS = 256;
/** Producer `MAX_REPLAY_METADATA_BYTES`. */
export const RETAINED_METADATA_MAX_BYTES = 256 * 1_024;
/** Producer `MAX_ACCEPTED_JSON_BODY_BYTES`. */
export const RETAINED_BODY_MAX_BYTES = 32 * 1_024 * 1_024;
/** Producer `MAX_REPLAY_PLAINTEXT_BYTES`. */
export const RETAINED_PLAINTEXT_MAX_BYTES = RETAINED_BODY_MAX_BYTES +
  RETAINED_METADATA_MAX_BYTES +
  4;
export const KEY_DERIVATION_SALT = new TextEncoder().encode(RETAINED_NAMESPACE);
export const TEXT_ENCODER = new TextEncoder();
export const TEXT_DECODER = new TextDecoder();

/** Exact producer compatibility-header allow list (frozen in capture.ts). */
const COMPATIBILITY_HEADER_NAMES = [
  "accept",
  "openai-beta",
  "openai-organization",
  "openai-project",
  "originator",
  "user-agent",
  "x-codex-client-version",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
] as const;
export const COMPATIBILITY_HEADER_NAME_SET = new Set<string>(
  COMPATIBILITY_HEADER_NAMES,
);

/** Exact producer metadata key sets (strict; unknown keys are rejected). */
export const METADATA_KEYS = [
  "version",
  "captured_at_ms",
  "endpoint",
  "method",
  "content_type",
  "compatibility_headers",
  "failure_signature",
  "observation",
  "client_observation",
  "request_id",
  "git_sha",
  "deno_revision",
  "upstream",
] as const;
export const OBSERVATION_KEYS = [
  "status",
  "stream",
  "completed",
  "terminal_type",
  "failure_kind",
  "synthetic_terminal_type",
  "provider_route",
] as const;
export const CLIENT_OBSERVATION_KEYS = [
  "status",
  "stream",
  "completed",
  "terminal_type",
  "failure_kind",
  "framing_valid",
  "provider_route",
] as const;

/** Frozen private upstream envelope keys (docs/contracts.md §12). */
export const UPSTREAM_KEYS = [
  "version",
  "attempts",
  "attempts_truncated",
  "bytes_truncated",
  "chunks_truncated",
] as const;
export const UPSTREAM_ATTEMPT_KEYS = [
  "provider",
  "status",
  "content_type",
  "chunks_base64",
  "terminal",
] as const;
const UPSTREAM_PROVIDERS = [
  "chatgpt_codex",
  "surplus",
  "metered",
  "cerebras",
] as const;
const UPSTREAM_CONTENT_TYPES = [
  "text/event-stream",
  "application/json",
  "other",
] as const;
const UPSTREAM_TERMINALS = [
  "pending",
  "fetch_error",
  "eof",
  "read_error",
  "cancelled",
] as const;
export const UPSTREAM_PROVIDER_SET = new Set<string>(UPSTREAM_PROVIDERS);
export const UPSTREAM_CONTENT_TYPE_SET = new Set<string>(
  UPSTREAM_CONTENT_TYPES,
);
export const UPSTREAM_TERMINAL_SET = new Set<string>(UPSTREAM_TERMINALS);

export type RetainedUpstreamProvider = (typeof UPSTREAM_PROVIDERS)[number];
export type RetainedUpstreamContentType =
  (typeof UPSTREAM_CONTENT_TYPES)[number];
export type RetainedUpstreamTerminal = (typeof UPSTREAM_TERMINALS)[number];

/** One authenticated provider dispatch attempt (frozen snake_case). */
export interface RetainedUpstreamAttemptWire {
  provider: RetainedUpstreamProvider;
  /** null until headers; otherwise an HTTP status code. */
  status: number | null;
  /** null before headers; otherwise the normalized MIME literal. */
  content_type: RetainedUpstreamContentType | null;
  /** Canonical padded standard-base64 chunk strings, in consumed order. */
  chunks_base64: string[];
  terminal: RetainedUpstreamTerminal;
}

/** Authenticated private upstream trace (frozen snake_case, no extras). */
export interface RetainedUpstreamWire {
  version: 1;
  attempts: RetainedUpstreamAttemptWire[];
  attempts_truncated: boolean;
  bytes_truncated: boolean;
  chunks_truncated: boolean;
}

/** Producer internal failure observation (snake_case wire shape). */
export interface RetainedObservationWire {
  status: number;
  stream: boolean | null;
  completed: boolean;
  terminal_type: string | null;
  failure_kind: string | null;
  synthetic_terminal_type: string | null;
  provider_route: string;
}

/** Producer client body observation (snake_case wire shape). */
export interface RetainedClientObservationWire {
  status: number;
  stream: boolean;
  completed: boolean;
  terminal_type: string | null;
  failure_kind: string | null;
  framing_valid: boolean;
  provider_route: string;
}

/**
 * Private captured request/observation fields, authenticated against the
 * producer manifest. `body` is plaintext and intentionally NOT sanitized:
 * callers treat the whole value as restricted.
 */
export interface RetainedGatewayObservationV1 {
  status: number;
  stream: boolean | null;
  completed: boolean;
  terminalType: string | null;
  failureKind: string | null;
  syntheticTerminalType: string | null;
  providerRoute: string;
}

/** Authenticated client-side body observation (SSE framing facts). */
export interface RetainedGatewayClientObservationV1 {
  status: number;
  stream: boolean;
  completed: boolean;
  terminalType: string | null;
  failureKind: string | null;
  framingValid: boolean;
  providerRoute: string;
}

/** One authenticated upstream dispatch attempt (frozen snake_case names). */
export interface RetainedGatewayUpstreamAttemptV1 {
  provider: "chatgpt_codex" | "surplus" | "metered" | "cerebras";
  status: number | null;
  content_type: "text/event-stream" | "application/json" | "other" | null;
  chunks_base64: readonly string[];
  terminal: "pending" | "fetch_error" | "eof" | "read_error" | "cancelled";
}

/**
 * Required private upstream trace, returned exactly as validated. No
 * `complete`/`sanitized` flags are invented here: truthfulness is carried by
 * the frozen terminals and truncation booleans only.
 */
export interface RetainedGatewayUpstreamV1 {
  version: 1;
  attempts: readonly RetainedGatewayUpstreamAttemptV1[];
  attempts_truncated: boolean;
  bytes_truncated: boolean;
  chunks_truncated: boolean;
}

/**
 * The authenticated private-capture result: exactly the request and
 * observation fields the producer stored, plus the manifest identity that
 * authenticated them. No sanitization, provenance or upstream-capture fields
 * are invented here.
 */
export interface RetainedGatewayCaptureV1 {
  version: 1;
  captureId: string;
  /** Producer HMAC identity over the authenticated request + failure signature. */
  fingerprint: string;
  /** Producer HMAC identity over the authenticated request. */
  caseGroupDigest: string;
  capturedAt: number;
  expiresAt: number;
  requestId: string;
  gitSha: string;
  denoRevision: string;
  endpoint: string;
  method: string;
  contentType: string | null;
  compatibilityHeaders: Readonly<Record<string, string>>;
  /** Exact producer failure signature; bound by the fingerprint HMAC. */
  failureSignature: string;
  observation: RetainedGatewayObservationV1;
  clientObservation: RetainedGatewayClientObservationV1;
  /**
   * Private raw upstream trace (frozen snake_case), authenticated by the
   * v2 fingerprint HMAC. Traces and request bytes stay restricted: never
   * sanitized and never a replay fixture.
   */
  upstream: RetainedGatewayUpstreamV1;
  /** Private plaintext request body; never sanitized, never a replay fixture. */
  body: Uint8Array<ArrayBuffer>;
}

/** Static sanitized failure; `detail` is a fixed literal, never input data. */
export type RetainedCaptureErrorV1 =
  | { kind: "invalid_key"; detail: "retained capture key must be 32 bytes" }
  | {
    kind: "invalid_manifest";
    detail: "retained capture manifest is not the supported producer shape";
  }
  | {
    kind: "tampered_metadata";
    detail: "retained capture metadata does not match its manifest";
  }
  | {
    kind: "tampered_ciphertext";
    detail: "retained capture ciphertext does not match its digest";
  }
  | {
    kind: "authentication_failed";
    detail: "retained capture failed authenticated decryption";
  }
  | {
    kind: "invalid_envelope";
    detail: "retained capture envelope is malformed";
  }
  | {
    kind: "oversized_plaintext";
    detail: "retained capture plaintext exceeds its size bound";
  }
  | {
    kind: "invalid_plaintext";
    detail: "retained capture plaintext metadata is invalid";
  }
  | {
    kind: "unsupported_metadata_version";
    detail: "retained capture metadata version is unsupported";
  }
  | {
    kind: "tampered_manifest";
    detail: "retained capture HMAC identity does not match its manifest";
  };

export type RetainedCaptureResultV1 =
  | { ok: true; value: RetainedGatewayCaptureV1 }
  | { ok: false; error: RetainedCaptureErrorV1 };

export type GunzipResult =
  | { ok: true; value: Uint8Array<ArrayBuffer> }
  | { ok: false; reason: "invalid" | "oversized" };

// ---------------------------------------------------------------------------
// Envelope and producer metadata parsing
// ---------------------------------------------------------------------------

export type EnvelopeResult =
  | {
    ok: true;
    metadata: ParsedRetainedMetadata;
  }
  | {
    ok: false;
    reason:
      | "invalid_envelope"
      | "oversized_plaintext"
      | "invalid_plaintext"
      | "unsupported_metadata_version";
  };

export interface ParsedRetainedMetadata {
  version: number;
  captured_at_ms: number;
  endpoint: string;
  method: string;
  content_type: string | null;
  compatibility_headers: Record<string, string>;
  failure_signature: string;
  observation: RetainedObservationWire;
  client_observation: RetainedClientObservationWire;
  request_id: string;
  git_sha: string;
  deno_revision: string;
  upstream: RetainedUpstreamWire;
  /** Exact body slice of the envelope buffer (view, not a copy). */
  bodyBytes: Uint8Array<ArrayBuffer>;
}

export interface ParsedUpstreamAttempt {
  attempt: RetainedUpstreamAttemptWire;
  decodedBytes: number;
  chunkCount: number;
}

// ---------------------------------------------------------------------------
// Canonical upstream JSON (fingerprint frame, docs/contracts.md §12)
// ---------------------------------------------------------------------------

/**
 * Frozen upstream frame: recursive lexicographic (UTF-16 code-unit) object-key
 * sort, preserved array order, JSON.stringify primitive/string encoding and no
 * whitespace. Only called after strict validation, so every value is a
 * validated JSON primitive/array/plain object.
 */
export function canonicalUpstreamJson(upstream: RetainedUpstreamWire): string {
  return canonicalJson(upstream);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("non-finite number in canonical upstream JSON");
      }
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        const items = value.map((item) => canonicalJson(item));
        return `[${items.join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      const fields = keys.map((key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key])}`
      );
      return `{${fields.join(",")}}`;
    }
    default:
      throw new Error(`cannot canonically serialize ${typeof value}`);
  }
}

export function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  if (actual.length !== expected.size) return false;
  for (const key of actual) {
    if (!expected.has(key)) return false;
  }
  return true;
}
