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
    version: 1,
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
  const decoded: Uint8Array<ArrayBuffer>[] = [];
  let decodedBytes = 0;
  try {
    for (const encoded of obj.chunks_base64) {
      if (typeof encoded !== "string") return null;
      const bytes = decodeCanonicalBase64(encoded);
      if (bytes === null) return null;
      decoded.push(bytes);
      decodedBytes += bytes.byteLength;
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
    return {
      attempt: {
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

const CANONICAL_PADDED_BASE64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const STANDARD_BASE64_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * Strict canonical padded standard-base64 decode: exact alphabet, `%4 === 0`
 * padded form with `=` only trailing, and zero pad bits (a re-encoding must
 * return the identical string). Empty strings are not chunks (never valid).
 */
function decodeCanonicalBase64(text: string): Uint8Array<ArrayBuffer> | null {
  if (text.length === 0 || !CANONICAL_PADDED_BASE64_RE.test(text)) {
    return null;
  }
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  let lastDataChar = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "=") continue;
    lastDataChar = char;
    const decoded = STANDARD_BASE64_ALPHABET.indexOf(char);
    if (decoded === -1) return null;
    value = (value << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  const lastValue = STANDARD_BASE64_ALPHABET.indexOf(lastDataChar);
  if (text.endsWith("==")) {
    // 8 bits from 12: the last 4 bits must be zero.
    if ((lastValue & 0x0f) !== 0) return null;
  } else if (text.endsWith("=")) {
    // 16 bits from 18: the last 2 bits must be zero.
    if ((lastValue & 0x03) !== 0) return null;
  }
  return new Uint8Array(bytes);
}

/** Private raw trace: passthrough with frozen snake_case names, no extras. */
export function mapUpstream(
  upstream: RetainedUpstreamWire,
): RetainedGatewayUpstreamV1 {
  return {
    version: upstream.version,
    attempts: upstream.attempts.map((attempt) => ({
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
