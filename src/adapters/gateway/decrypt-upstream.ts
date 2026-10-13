import {
  GATEWAY_CAPTURE_MAX_TIMING_MS,
  GATEWAY_CAPTURE_RESPONSE_HEADER_NAMES,
  type GatewayCaptureAttemptMetadataV2,
} from "../../contracts/gateway-capture.ts";
import type {
  ParsedUpstreamAttempt,
  RetainedGatewayUpstreamV1,
  RetainedUpstreamAttemptWire,
  RetainedUpstreamContentType,
  RetainedUpstreamProvider,
  RetainedUpstreamTerminal,
  RetainedUpstreamWire,
} from "./decrypt-schema.ts";
import {
  hasExactKeys,
  RETAINED_UPSTREAM_MAX_ATTEMPTS,
  RETAINED_UPSTREAM_MAX_CHUNKS,
  RETAINED_UPSTREAM_MAX_DECODED_BYTES,
  RETAINED_UPSTREAM_VERSION,
  UPSTREAM_ATTEMPT_KEYS,
  UPSTREAM_CONTENT_TYPE_SET,
  UPSTREAM_KEYS,
  UPSTREAM_PROVIDER_SET,
  UPSTREAM_TERMINAL_SET,
} from "./decrypt-schema.ts";
import { zeroAll } from "./decrypt-crypto.ts";

// ---------------------------------------------------------------------------
// Private upstream trace parsing (docs/contracts.md §12)
// ---------------------------------------------------------------------------

/**
 * Strict internal snapshot parser. Crypto-authenticated JSON is still
 * untrusted input: exact keys, frozen enums, canonical padded base64, the
 * aggregate decoded-byte/chunk/attempt bounds and every frozen cross-field
 * relation are enforced before the trace is canonicalized or used.
 */
export function parseUpstream(value: unknown): RetainedUpstreamWire | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, UPSTREAM_KEYS)) return null;
  if (obj.version !== RETAINED_UPSTREAM_VERSION) return null;
  for (
    const key of [
      "attempts_truncated",
      "bytes_truncated",
      "chunks_truncated",
    ] as const
  ) {
    if (typeof obj[key] !== "boolean") return null;
  }
  if (!Array.isArray(obj.attempts)) return null;
  if (obj.attempts.length > RETAINED_UPSTREAM_MAX_ATTEMPTS) return null;
  const attempts: RetainedUpstreamAttemptWire[] = [];
  let decodedBytes = 0;
  let chunkCount = 0;
  for (const item of obj.attempts) {
    const parsed = parseUpstreamAttempt(item);
    if (parsed === null) return null;
    attempts.push(parsed.attempt);
    decodedBytes += parsed.decodedBytes;
    chunkCount += parsed.chunkCount;
    if (decodedBytes > RETAINED_UPSTREAM_MAX_DECODED_BYTES) return null;
    if (chunkCount > RETAINED_UPSTREAM_MAX_CHUNKS) return null;
  }
  return {
    version: 2,
    attempts,
    attempts_truncated: obj.attempts_truncated as boolean,
    bytes_truncated: obj.bytes_truncated as boolean,
    chunks_truncated: obj.chunks_truncated as boolean,
  };
}

function parseUpstreamAttempt(value: unknown): ParsedUpstreamAttempt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, UPSTREAM_ATTEMPT_KEYS)) return null;
  if (typeof obj.provider !== "string") return null;
  if (!UPSTREAM_PROVIDER_SET.has(obj.provider)) return null;
  if (typeof obj.terminal !== "string") return null;
  if (!UPSTREAM_TERMINAL_SET.has(obj.terminal)) return null;
  let status: number | null;
  if (obj.status === null) {
    status = null;
  } else if (
    Number.isSafeInteger(obj.status) &&
    (obj.status as number) >= 100 &&
    (obj.status as number) <= 599
  ) {
    status = obj.status as number;
  } else {
    return null;
  }
  let contentType: RetainedUpstreamContentType | null;
  if (obj.content_type === null) {
    contentType = null;
  } else if (typeof obj.content_type === "string") {
    if (!UPSTREAM_CONTENT_TYPE_SET.has(obj.content_type)) return null;
    contentType = obj.content_type as RetainedUpstreamContentType;
  } else {
    return null;
  }
  // Frozen header state: status and content_type are null together.
  if ((status === null) !== (contentType === null)) return null;
  if (!Array.isArray(obj.chunks_base64)) return null;
  if (obj.chunks_base64.length > RETAINED_UPSTREAM_MAX_CHUNKS) return null;
  const decoded: Uint8Array<ArrayBuffer>[] = [];
  let decodedBytes = 0;
  try {
    for (const encoded of obj.chunks_base64) {
      if (typeof encoded !== "string") return null;
      const bytes = decodeCanonicalBase64(encoded);
      if (bytes === null) return null;
      decoded.push(bytes);
      decodedBytes += bytes.byteLength;
      if (decodedBytes > RETAINED_UPSTREAM_MAX_DECODED_BYTES) return null;
    }
    // Before-header attempts have no chunks; a fetch_error never got headers.
    if (status === null && decoded.length !== 0) return null;
    if (obj.terminal === "fetch_error" && status !== null) return null;
    // Header-bearing read_error/cancelled/eof require a status (frozen §12).
    if (
      status === null &&
      (obj.terminal === "eof" ||
        obj.terminal === "read_error" ||
        obj.terminal === "cancelled")
    ) {
      return null;
    }
    const metadata = parseAttemptMetadataV2(
      obj,
      status,
      obj.terminal,
      decoded.length,
    );
    if (metadata === null) return null;
    return {
      attempt: {
        ...metadata,
        provider: obj.provider as RetainedUpstreamProvider,
        status,
        content_type: contentType,
        chunks_base64: obj.chunks_base64 as string[],
        terminal: obj.terminal as RetainedUpstreamTerminal,
      },
      decodedBytes,
      chunkCount: decoded.length,
    };
  } finally {
    // Decoded chunk buffers exist only for validation/bounds; zero them.
    zeroAll(decoded);
  }
}

/** Current timing/header fields are authenticated as part of canonical upstream. */
export function parseAttemptMetadataV2(
  obj: Record<string, unknown>,
  status: number | null,
  terminal: string,
  chunkCount: number,
): GatewayCaptureAttemptMetadataV2 | null {
  const rawHeaders = obj.headers;
  if (
    rawHeaders === null || typeof rawHeaders !== "object" ||
    Array.isArray(rawHeaders)
  ) return null;
  const allowed = new Set<string>(GATEWAY_CAPTURE_RESPONSE_HEADER_NAMES);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (
      !allowed.has(name) || typeof value !== "string" || value.length < 1 ||
      value.length > 512 || value.trim() !== value
    ) return null;
    headers[name] = value;
  }
  if (typeof obj.headers_truncated !== "boolean") return null;
  if (
    !Array.isArray(obj.chunk_times_ms) ||
    obj.chunk_times_ms.length !== chunkCount
  ) return null;
  const times: number[] = [];
  let previous = 0;
  for (const value of obj.chunk_times_ms) {
    if (
      !Number.isSafeInteger(value) || value < previous ||
      value > GATEWAY_CAPTURE_MAX_TIMING_MS
    ) return null;
    times.push(value);
    previous = value;
  }
  if (
    !Number.isSafeInteger(obj.started_at_ms) ||
    (obj.started_at_ms as number) < 0
  ) return null;
  for (const name of ["headers_at_ms", "ended_at_ms"] as const) {
    if (
      obj[name] !== null &&
      (!Number.isSafeInteger(obj[name]) || (obj[name] as number) < 0)
    ) return null;
  }
  const start = obj.started_at_ms as number;
  const head = obj.headers_at_ms as number | null;
  const end = obj.ended_at_ms as number | null;
  if ((status === null) !== (head === null) || head !== null && head < start) {
    return null;
  }
  if (
    (terminal === "pending") !== (end === null) ||
    end !== null && end < (head ?? start)
  ) return null;
  if (
    end !== null &&
    (end - start > GATEWAY_CAPTURE_MAX_TIMING_MS ||
      times.some((time) => time > end - start))
  ) return null;
  return {
    headers,
    headers_truncated: obj.headers_truncated,
    chunk_times_ms: times,
    started_at_ms: start,
    headers_at_ms: head,
    ended_at_ms: end,
  };
}

/**
 * Strict canonical padded standard-base64 decode: exact alphabet, `%4 === 0`
 * padded form with `=` only trailing, and zero pad bits (a re-encoding must
 * return the identical string). Empty strings are not chunks (never valid).
 */
export function decodeCanonicalBase64(
  text: string,
): Uint8Array<ArrayBuffer> | null {
  if (text.length === 0 || text.length % 4 !== 0) return null;
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  const byteLength = text.length / 4 * 3 - padding;
  if (byteLength < 1 || byteLength > RETAINED_UPSTREAM_MAX_DECODED_BYTES) {
    return null;
  }
  const bytes = new Uint8Array(byteLength);
  let bits = 0;
  let value = 0;
  let offset = 0;
  let lastValue = 0;
  for (let index = 0; index < text.length - padding; index++) {
    const code = text.charCodeAt(index);
    const decoded = code >= 65 && code <= 90
      ? code - 65
      : code >= 97 && code <= 122
      ? code - 71
      : code >= 48 && code <= 57
      ? code + 4
      : code === 43
      ? 62
      : code === 47
      ? 63
      : -1;
    if (decoded === -1) {
      bytes.fill(0);
      return null;
    }
    lastValue = decoded;
    value = (value << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[offset++] = (value >>> bits) & 0xff;
    }
  }
  if (
    offset !== byteLength || padding === 2 && (lastValue & 0x0f) !== 0 ||
    padding === 1 && (lastValue & 0x03) !== 0
  ) {
    bytes.fill(0);
    return null;
  }
  return bytes;
}

/** Private raw trace: passthrough with frozen snake_case names, no extras. */
export function mapUpstream(
  upstream: RetainedUpstreamWire,
): RetainedGatewayUpstreamV1 {
  return {
    version: upstream.version,
    attempts: upstream.attempts.map((attempt) => ({
      headers: { ...attempt.headers },
      headers_truncated: attempt.headers_truncated,
      chunk_times_ms: [...attempt.chunk_times_ms],
      started_at_ms: attempt.started_at_ms,
      headers_at_ms: attempt.headers_at_ms,
      ended_at_ms: attempt.ended_at_ms,
      provider: attempt.provider,
      status: attempt.status,
      content_type: attempt.content_type,
      chunks_base64: attempt.chunks_base64,
      terminal: attempt.terminal,
    })),
    attempts_truncated: upstream.attempts_truncated,
    bytes_truncated: upstream.bytes_truncated,
    chunks_truncated: upstream.chunks_truncated,
  };
}
