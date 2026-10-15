import {
  isPlainObject,
  PROTOCOL_TYPES,
} from "./sanitize-protocol-vocabulary.ts";
import type { ProtocolSanitizer } from "./sanitize-protocol-vocabulary.ts";
import {
  decodeCanonicalBase64,
  parseAttemptMetadataV2,
} from "./decrypt-upstream.ts";
import type {
  RetainedGatewayUpstreamAttemptV1,
  RetainedGatewayUpstreamV1,
} from "./decrypt.ts";

// ---------------------------------------------------------------------------
// Captured upstream trace transformation (phase 2, transform only): a
// recorded upstream is re-encoded attempt by attempt with the same fixed
// vocabulary, sharing the supplied sanitizer's per-factory ID map.
// ---------------------------------------------------------------------------

/** Fixed error text for unsupported captured upstream traces; never echoes. */
const UPSTREAM_ERROR = "gateway upstream cannot be sanitized";

/** Minimum attempts on a recorded upstream trace. */
const MIN_ATTEMPTS = 1;
/** Maximum attempts on a recorded upstream trace. */
const MAX_ATTEMPTS = 8;
/** Maximum aggregate chunk count across attempts. */
const MAX_CHUNKS = 4096;
/** Maximum aggregate decoded byte count across attempts. */
const MAX_BYTES = 4 * 1024 * 1024;
/** Encoded-length bound of one base64 chunk before it is decoded. */
const MAX_BASE64_ENCODED = Math.ceil(MAX_BYTES / 3) * 4;

/**
 * SSE event names: exactly the fixed PROTOCOL_TYPES members starting with
 * "response." plus "error"; no wildcard or prefix acceptance.
 */
const SSE_EVENT_SET: ReadonlySet<string> = new Set<string>(
  PROTOCOL_TYPES.filter((t) => t.startsWith("response.") || t === "error"),
);

/** True for the bodyless HTTP statuses 204/205/304. */
function isBodylessStatus(status: number): boolean {
  return status === 204 || status === 205 || status === 304;
}

function failUpstream(): never {
  throw new Error(UPSTREAM_ERROR);
}

/**
 * Reject records with unknown/symbol own keys, hidden non-enumerable keys or
 * accessor properties (even with undefined get/set); the own-key set must
 * match the allowed set exactly with enumerable data descriptors only.
 */
function assertRecordShape(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length) failUpstream();
  for (const key of keys) {
    if (typeof key !== "string" || !allowed.includes(key)) failUpstream();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) failUpstream();
    if ("get" in descriptor || "set" in descriptor) failUpstream();
    if (!descriptor.enumerable) failUpstream();
  }
}

/**
 * Reject arrays with symbol/non-index own keys, hidden non-enumerable keys,
 * accessor properties or missing dense indices: only the built-in own
 * "length" plus the enumerable data indices 0..length-1 are accepted.
 */
function assertArrayShape(value: readonly unknown[]): void {
  let indexCount = 0;
  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") continue; // normal special built-in
    if (typeof key !== "string") failUpstream();
    const index = Number(key);
    if (
      !Number.isInteger(index) || index < 0 || index > 4294967294 ||
      String(index) !== key || index >= value.length
    ) {
      failUpstream();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) failUpstream();
    if ("get" in descriptor || "set" in descriptor) failUpstream();
    if (!descriptor.enumerable) failUpstream();
    indexCount += 1;
  }
  if (indexCount !== value.length) failUpstream();
}

/** Decode a canonical standard base64 chunk into bytes. */
function decodeChunk(chunk: string): Uint8Array {
  if (chunk.length > MAX_BASE64_ENCODED) failUpstream();
  const bytes = decodeCanonicalBase64(chunk);
  if (bytes === null) failUpstream();
  return bytes;
}

/** Concatenate byte arrays into one buffer. */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    out.set(part, pos);
    pos += part.length;
  }
  return out;
}

/** Standard base64 encode one byte array. */
function encodeChunk(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Rechunk transformed bytes with the original chunk byte lengths as
 * successive capacities; remaining bytes go to the last chunk and empty
 * chunks are omitted.
 */
function rechunk(bytes: Uint8Array, capacities: readonly number[]): string[] {
  const out: string[] = [];
  let pos = 0;
  for (let i = 0; i < capacities.length; i += 1) {
    if (i === capacities.length - 1) {
      if (pos < bytes.length) {
        out.push(encodeChunk(bytes.subarray(pos, bytes.length)));
        pos = bytes.length;
      }
      break;
    }
    const n = Math.min(capacities[i], bytes.length - pos);
    if (n > 0) {
      out.push(encodeChunk(bytes.subarray(pos, pos + n)));
      pos += n;
    }
  }
  if (pos < bytes.length) out.push(encodeChunk(bytes.subarray(pos)));
  return out;
}

type SseLine = { content: string; ending: string };

/** Split text into lines preserving each exact LF/CRLF/CR ending. */
function splitSseLines(text: string): SseLine[] {
  const lines: SseLine[] = [];
  let pos = 0;
  while (pos < text.length) {
    const lf = text.indexOf("\n", pos);
    const cr = text.indexOf("\r", pos);
    if (lf === -1 && cr === -1) {
      lines.push({ content: text.slice(pos), ending: "" });
      break;
    }
    if (cr !== -1 && (lf === -1 || cr < lf)) {
      const ending = text.charCodeAt(cr + 1) === 10 ? "\r\n" : "\r";
      lines.push({ content: text.slice(pos, cr), ending });
      pos = cr + ending.length;
    } else {
      lines.push({ content: text.slice(pos, lf), ending: "\n" });
      pos = lf + 1;
    }
  }
  return lines;
}

type SseField =
  | { kind: "comment" }
  | { kind: "event" | "data"; separator: string; value: string };

/**
 * Parse one non-empty SSE line. Unknown fields (including id/retry) are
 * rejected; the field separator is one optional standard space.
 */
function parseSseField(content: string): SseField {
  const colon = content.indexOf(":");
  if (colon === 0) return { kind: "comment" };
  const name = colon === -1 ? content : content.slice(0, colon);
  if (name !== "event" && name !== "data") failUpstream();
  const separator = colon !== -1 && content.charAt(colon + 1) === " "
    ? " "
    : "";
  const value = colon === -1
    ? ""
    : content.slice(colon + (separator === " " ? 2 : 1));
  return { kind: name, separator, value };
}

/**
 * One independent JSON object run through the shared protocol sanitizer; a
 * complete object and a string serialization are required.
 */
function transformJsonField(
  value: string,
  protocol: ProtocolSanitizer,
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    failUpstream();
  }
  if (!isPlainObject(parsed)) failUpstream();
  let sanitized: unknown;
  try {
    sanitized = protocol.sanitize(parsed);
  } catch {
    failUpstream();
  }
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(sanitized);
  } catch {
    failUpstream();
  }
  if (typeof serialized !== "string") failUpstream();
  return serialized;
}

/**
 * Transform an SSE body. Every data field is an independent JSON object or
 * the literal [DONE]; more than one data field per event, unknown fields,
 * partial/malformed JSON and unknown event names fail. Line endings, blank
 * boundaries and field separators are preserved exactly.
 */
function transformSseBody(text: string, protocol: ProtocolSanitizer): string {
  const lines = splitSseLines(text);
  const out: string[] = [];
  let dataFieldsInEvent = 0;
  for (const line of lines) {
    if (line.content === "") {
      out.push(line.ending);
      dataFieldsInEvent = 0;
      continue;
    }
    const field = parseSseField(line.content);
    if (field.kind === "comment") {
      out.push(`: fixture comment${line.ending}`);
      continue;
    }
    if (field.kind === "event") {
      if (!SSE_EVENT_SET.has(field.value)) failUpstream();
      out.push(`event:${field.separator}${field.value}${line.ending}`);
      continue;
    }
    dataFieldsInEvent += 1;
    if (dataFieldsInEvent > 1) failUpstream();
    const value = field.value === "[DONE]"
      ? "[DONE]"
      : transformJsonField(field.value, protocol);
    out.push(`data:${field.separator}${value}${line.ending}`);
  }
  return out.join("");
}

interface TraceStats {
  chunks: number;
  outputChunks: number;
  decodedBytes: number;
  outputBytes: number;
}

/**
 * Transform one recorded attempt, or fail the whole trace. fetch_error keeps
 * the no-body shape, bodyless statuses require EOF with zero chunks, and any
 * other status requires a supported MIME with a non-empty transformed body
 * rechunked to the original chunk capacities.
 */
function transformAttempt(
  attemptValue: unknown,
  protocol: ProtocolSanitizer,
  path: Set<object>,
  stats: TraceStats,
): RetainedGatewayUpstreamAttemptV1 {
  if (!isPlainObject(attemptValue)) failUpstream();
  const attempt = attemptValue;
  assertRecordShape(attempt, [
    "provider",
    "status",
    "content_type",
    "chunks_base64",
    "terminal",
    "headers",
    "headers_truncated",
    "chunk_times_ms",
    "started_at_ms",
    "headers_at_ms",
    "ended_at_ms",
  ]);
  if (path.has(attempt)) failUpstream();
  path.add(attempt);

  const provider = attempt.provider;
  if (
    provider !== "chatgpt_codex" && provider !== "surplus" &&
    provider !== "metered" && provider !== "cerebras" &&
    provider !== "deepseek" && provider !== "lithos" &&
    provider !== "openrouter"
  ) {
    failUpstream();
  }
  const status = attempt.status;
  if (
    status !== null &&
    (typeof status !== "number" || !Number.isInteger(status) ||
      status < 200 || status > 599)
  ) {
    failUpstream();
  }
  const contentType = attempt.content_type;
  if (
    contentType !== null && contentType !== "text/event-stream" &&
    contentType !== "application/json" && contentType !== "other"
  ) {
    failUpstream();
  }
  const terminal = attempt.terminal;
  if (
    terminal !== "fetch_error" && terminal !== "eof" &&
    terminal !== "read_error" && terminal !== "cancelled"
  ) {
    failUpstream();
  }

  const chunksValue = attempt.chunks_base64;
  if (!Array.isArray(chunksValue)) failUpstream();
  if (chunksValue.length > MAX_CHUNKS - stats.chunks) failUpstream();
  assertArrayShape(chunksValue);
  if (path.has(chunksValue)) failUpstream();
  path.add(chunksValue);

  const capacities: number[] = [];
  const bytesParts: Uint8Array[] = [];
  let decoded = 0;
  for (const chunk of chunksValue) {
    if (typeof chunk !== "string") failUpstream();
    const part = decodeChunk(chunk);
    decoded += part.length;
    if (stats.decodedBytes + decoded > MAX_BYTES) failUpstream();
    capacities.push(part.length);
    bytesParts.push(part);
  }
  path.delete(chunksValue);

  let outChunks: string[];
  let outputBytes = 0;

  if (terminal === "fetch_error") {
    if (status !== null || contentType !== null || chunksValue.length !== 0) {
      failUpstream();
    }
    outChunks = [];
  } else if (status !== null && isBodylessStatus(status)) {
    if (terminal !== "eof" || chunksValue.length !== 0) failUpstream();
    outChunks = [];
  } else {
    if (status === null) failUpstream();
    if (
      contentType !== "application/json" &&
      contentType !== "text/event-stream"
    ) {
      failUpstream();
    }
    if (decoded === 0) failUpstream();
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        concatBytes(bytesParts),
      );
    } catch {
      failUpstream();
    }
    const transformed = contentType === "application/json"
      ? transformJsonField(text, protocol)
      : transformSseBody(text, protocol);
    const outBytes = new TextEncoder().encode(transformed);
    if (outBytes.length === 0) failUpstream();
    if (outBytes.length > MAX_BYTES) failUpstream();
    outputBytes = outBytes.length;
    outChunks = rechunk(outBytes, capacities);
  }

  stats.chunks += chunksValue.length;
  stats.outputChunks += outChunks.length;
  stats.decodedBytes += decoded;
  stats.outputBytes += outputBytes;
  if (stats.outputChunks > MAX_CHUNKS) failUpstream();
  if (stats.outputBytes > MAX_BYTES) failUpstream();
  path.delete(attempt);

  const metadata = parseAttemptMetadataV2(
    attempt,
    status as number | null,
    terminal as string,
    chunksValue.length,
  );
  if (metadata === null || outChunks.length > metadata.chunk_times_ms.length) {
    failUpstream();
  }
  // A fixed positive epoch hides recorded wall time and satisfies the frozen reader.
  const headersAtMs = metadata.headers_at_ms === null
    ? null
    : 1 + (metadata.headers_at_ms - metadata.started_at_ms);
  const endedAtMs = metadata.ended_at_ms === null
    ? null
    : 1 + (metadata.ended_at_ms - metadata.started_at_ms);
  if (
    (headersAtMs !== null && !Number.isSafeInteger(headersAtMs)) ||
    (endedAtMs !== null && !Number.isSafeInteger(endedAtMs))
  ) failUpstream();
  const headers: Record<string, string> = {};
  let headersTruncated = metadata.headers_truncated;
  for (const [name, value] of Object.entries(metadata.headers)) {
    if (
      name === "content-type" &&
      (contentType === "application/json" ||
        contentType === "text/event-stream")
    ) headers[name] = contentType;
    else if (name === "content-length") headers[name] = String(outputBytes);
    else if (/^\d+(?:\.\d+)?(?:ms|s|m|h|d)?$/.test(value)) {
      headers[name] = value;
    } else if (
      name === "cache-control" &&
      /^(?:no-store|no-cache|private|public|must-revalidate)(?:, ?(?:no-store|no-cache|private|public|must-revalidate))*$/
        .test(value)
    ) headers[name] = value;
    else headersTruncated = true;
  }

  return {
    headers,
    headers_truncated: headersTruncated,
    chunk_times_ms: metadata.chunk_times_ms.slice(0, outChunks.length),
    started_at_ms: 1,
    headers_at_ms: headersAtMs,
    ended_at_ms: endedAtMs,
    provider,
    status,
    content_type: contentType,
    chunks_base64: outChunks,
    terminal,
  };
}

/** Validate and transform the whole recorded upstream trace. */
function sanitizeTrace(
  upstream: unknown,
  protocol: ProtocolSanitizer,
): RetainedGatewayUpstreamV1 {
  if (!isPlainObject(upstream)) failUpstream();
  assertRecordShape(upstream, [
    "version",
    "attempts",
    "attempts_truncated",
    "bytes_truncated",
    "chunks_truncated",
  ]);
  if (upstream.version !== 2) failUpstream();
  if (upstream.attempts_truncated !== false) failUpstream();
  if (upstream.bytes_truncated !== false) failUpstream();
  if (upstream.chunks_truncated !== false) failUpstream();
  const attemptsValue = upstream.attempts;
  if (!Array.isArray(attemptsValue)) failUpstream();
  if (
    attemptsValue.length < MIN_ATTEMPTS ||
    attemptsValue.length > MAX_ATTEMPTS
  ) {
    failUpstream();
  }
  assertArrayShape(attemptsValue);

  const path = new Set<object>();
  path.add(upstream);
  const stats: TraceStats = {
    chunks: 0,
    outputChunks: 0,
    decodedBytes: 0,
    outputBytes: 0,
  };
  const outAttempts: RetainedGatewayUpstreamAttemptV1[] = [];
  for (const attempt of attemptsValue) {
    outAttempts.push(transformAttempt(attempt, protocol, path, stats));
  }
  if (stats.chunks > MAX_CHUNKS) failUpstream();
  if (stats.outputChunks > MAX_CHUNKS) failUpstream();
  if (stats.decodedBytes > MAX_BYTES) failUpstream();
  if (stats.outputBytes > MAX_BYTES) failUpstream();

  return {
    version: 2,
    attempts: outAttempts,
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
}

/**
 * Transform a recorded upstream trace into an independent sanitized trace:
 * attempt order, provider, status, MIME type and terminal are preserved while
 * every parsed JSON object is re-encoded through the supplied protocol
 * sanitizer, so the per-factory ID map is shared. All failures throw the
 * fixed "gateway upstream cannot be sanitized" error; input is never echoed
 * or mutated and no partial trace is returned.
 */
export function sanitizeRecordedUpstream(
  upstream: RetainedGatewayUpstreamV1,
  protocol: ProtocolSanitizer,
): RetainedGatewayUpstreamV1 {
  try {
    return sanitizeTrace(upstream, protocol);
  } catch {
    // Any validation or unexpected exception (including proxy/accessor traps
    // and protocol sanitizer failures) is normalized to the fixed error text;
    // captured input is never echoed.
    throw new Error(UPSTREAM_ERROR);
  }
}
