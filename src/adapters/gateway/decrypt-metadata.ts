import type {
  EnvelopeResult,
  ParsedRetainedMetadata,
  RetainedClientObservationWire,
  RetainedObservationWire,
} from "./decrypt-schema.ts";
import {
  CLIENT_OBSERVATION_KEYS,
  COMPATIBILITY_HEADER_NAME_SET,
  hasExactKeys,
  METADATA_KEYS,
  OBSERVATION_KEYS,
  RETAINED_BODY_MAX_BYTES,
  RETAINED_LEGACY_METADATA_VERSION,
  RETAINED_METADATA_MAX_BYTES,
  RETAINED_METADATA_VERSION,
  RETAINED_PLAINTEXT_MAX_BYTES,
  TEXT_DECODER,
} from "./decrypt-schema.ts";
import { parseUpstream } from "./decrypt-upstream.ts";

/**
 * Provenance-free envelope layout: 4-byte big-endian metadata length,
 * metadata JSON, then the exact request bytes (producer `decodePlaintext`).
 */
export function decodeEnvelope(
  bytes: Uint8Array<ArrayBuffer>,
): EnvelopeResult {
  if (
    bytes.byteLength < 4 || bytes.byteLength > RETAINED_PLAINTEXT_MAX_BYTES
  ) {
    return { ok: false, reason: "invalid_envelope" };
  }
  const metadataLength = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    4,
  ).getUint32(0, false);
  if (metadataLength > RETAINED_METADATA_MAX_BYTES) {
    return { ok: false, reason: "invalid_envelope" };
  }
  const bodyOffset = 4 + metadataLength;
  if (bodyOffset > bytes.byteLength) {
    return { ok: false, reason: "invalid_envelope" };
  }
  if (bytes.byteLength - bodyOffset > RETAINED_BODY_MAX_BYTES) {
    return { ok: false, reason: "oversized_plaintext" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      TEXT_DECODER.decode(bytes.subarray(4, bodyOffset)),
    );
  } catch {
    return { ok: false, reason: "invalid_plaintext" };
  }
  const metadata = parseMetadataObject(parsed);
  if (!metadata.ok) {
    return { ok: false, reason: metadata.reason };
  }
  return {
    ok: true,
    metadata: {
      ...metadata.value,
      bodyBytes: bytes.subarray(bodyOffset),
    },
  };
}

function parseMetadataObject(
  value: unknown,
):
  | { ok: true; value: Omit<ParsedRetainedMetadata, "bodyBytes"> }
  | {
    ok: false;
    reason: "invalid_plaintext" | "unsupported_metadata_version";
  } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  const obj = value as Record<string, unknown>;
  // Hard cutover: request-only v1 plaintext is unsupported and never counts
  // as upstream evidence; check the version before shape validation so the
  // real v1 golden gets the explicit unsupported error.
  if (obj.version === RETAINED_LEGACY_METADATA_VERSION) {
    return { ok: false, reason: "unsupported_metadata_version" };
  }
  if (obj.version !== RETAINED_METADATA_VERSION) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (!hasExactKeys(obj, METADATA_KEYS)) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (
    !Number.isSafeInteger(obj.captured_at_ms) ||
    (obj.captured_at_ms as number) < 0
  ) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (obj.endpoint === null || typeof obj.endpoint !== "string") {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (obj.method === null || typeof obj.method !== "string") {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (
    obj.content_type !== null && typeof obj.content_type !== "string"
  ) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (!isCompatibilityHeaders(obj.compatibility_headers)) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  if (
    obj.failure_signature === null || typeof obj.failure_signature !== "string"
  ) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  const observation = parseObservation(obj.observation);
  if (observation === null) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  const clientObservation = parseClientObservation(obj.client_observation);
  if (clientObservation === null) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  for (const key of ["request_id", "git_sha", "deno_revision"] as const) {
    if (obj[key] === null || typeof obj[key] !== "string") {
      return { ok: false, reason: "invalid_plaintext" };
    }
  }
  const upstream = parseUpstream(obj.upstream);
  if (upstream === null) {
    return { ok: false, reason: "invalid_plaintext" };
  }
  return {
    ok: true,
    value: {
      version: obj.version as number,
      captured_at_ms: obj.captured_at_ms as number,
      endpoint: obj.endpoint as string,
      method: obj.method as string,
      content_type: obj.content_type as string | null,
      compatibility_headers: obj.compatibility_headers as Record<
        string,
        string
      >,
      failure_signature: obj.failure_signature as string,
      observation,
      client_observation: clientObservation,
      request_id: obj.request_id as string,
      git_sha: obj.git_sha as string,
      deno_revision: obj.deno_revision as string,
      upstream,
    },
  };
}

function parseObservation(
  value: unknown,
): RetainedObservationWire | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, OBSERVATION_KEYS)) return null;
  if (!Number.isSafeInteger(obj.status)) return null;
  if (obj.stream !== null && typeof obj.stream !== "boolean") return null;
  if (typeof obj.completed !== "boolean") return null;
  for (
    const key of [
      "terminal_type",
      "failure_kind",
      "synthetic_terminal_type",
    ] as const
  ) {
    if (obj[key] !== null && typeof obj[key] !== "string") return null;
  }
  if (typeof obj.provider_route !== "string") return null;
  return {
    status: obj.status as number,
    stream: obj.stream as boolean | null,
    completed: obj.completed as boolean,
    terminal_type: obj.terminal_type as string | null,
    failure_kind: obj.failure_kind as string | null,
    synthetic_terminal_type: obj.synthetic_terminal_type as string | null,
    provider_route: obj.provider_route as string,
  };
}

function parseClientObservation(
  value: unknown,
): RetainedClientObservationWire | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (!hasExactKeys(obj, CLIENT_OBSERVATION_KEYS)) return null;
  if (!Number.isSafeInteger(obj.status)) return null;
  if (typeof obj.stream !== "boolean") return null;
  if (typeof obj.completed !== "boolean") return null;
  for (const key of ["terminal_type", "failure_kind"] as const) {
    if (obj[key] !== null && typeof obj[key] !== "string") return null;
  }
  if (typeof obj.framing_valid !== "boolean") return null;
  if (typeof obj.provider_route !== "string") return null;
  return {
    status: obj.status as number,
    stream: obj.stream as boolean,
    completed: obj.completed as boolean,
    terminal_type: obj.terminal_type as string | null,
    failure_kind: obj.failure_kind as string | null,
    framing_valid: obj.framing_valid as boolean,
    provider_route: obj.provider_route as string,
  };
}

function isCompatibilityHeaders(
  value: unknown,
): value is Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    if (!COMPATIBILITY_HEADER_NAME_SET.has(name)) return false;
    if (typeof headerValue !== "string") return false;
    if (headerValue.length === 0 || headerValue.trim() !== headerValue) {
      return false;
    }
  }
  return true;
}
