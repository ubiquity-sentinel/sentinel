import type { CommandId, GitSha } from "../../src/contracts/brands.ts";
import type { ArtifactStoreLimitsV1 } from "../../src/adapters/gateway/store.ts";
import { CAPTURE_ID_A, sha256hex } from "../adapters/gateway/helpers.ts";

export const INDEX_PATH = "/admin/sentinel/incidents";
export const REPLAY_PATH = "/admin/sentinel/replay-captures";

export const TEST_ID = "gateway:stream-termination";
export const GATEWAY_COMMAND = "replay" as CommandId;
export const EXPECTED_FAILURE = {
  reason: "fixture reproduced the recorded upstream failure",
  match: { kind: "contains" as const, text: "stream terminated unexpectedly" },
};

export const GATEWAY_LIMITS: ArtifactStoreLimitsV1 = {
  totalMaxBytes: 1_000_000,
  artifactMaxBytes: 100_000,
  retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
};

// ---------------------------------------------------------------------------
// Producer capture crafting (independent of the decryptor: same frozen
// HKDF/AES-GCM/gzip framing and HMAC identities over public synthetic bytes).
// ---------------------------------------------------------------------------

const RETAINED_NAMESPACE = "uos-sentinel-replay-v1";
const RETAINED_FINGERPRINT_NAMESPACE = "uos-sentinel-replay-v2:fingerprint";
const RETAINED_CASE_GROUP_NAMESPACE = "uos-sentinel-replay-v1:case-group";
const TEXT_ENCODER = new TextEncoder();
const RETAINED_TTL_MS = 48 * 60 * 60 * 1_000;

function standardBase64(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const remaining = bytes.byteLength - offset;
    const a = bytes[offset]!;
    const b = remaining > 1 ? bytes[offset + 1]! : 0;
    const c = remaining > 2 ? bytes[offset + 2]! : 0;
    output += alphabet[a >> 2]!;
    output += alphabet[((a & 0x03) << 4) | (b >> 4)]!;
    output += remaining > 1 ? alphabet[((b & 0x0f) << 2) | (c >> 6)]! : "=";
    output += remaining > 2 ? alphabet[c & 0x3f]! : "=";
  }
  return output;
}

function toBase64Url(bytes: Uint8Array): string {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 3) {
    const remaining = bytes.byteLength - offset;
    const a = bytes[offset]!;
    const b = remaining > 1 ? bytes[offset + 1]! : 0;
    const c = remaining > 2 ? bytes[offset + 2]! : 0;
    output += alphabet[a >> 2]!;
    output += alphabet[((a & 0x03) << 4) | (b >> 4)]!;
    output += remaining > 1 ? alphabet[((b & 0x0f) << 2) | (c >> 6)]! : "";
    output += remaining > 2 ? alphabet[c & 0x3f]! : "";
  }
  return output;
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "number":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const record = value as Record<string, unknown>;
      return `{${
        Object.keys(record).sort().map((key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        ).join(",")
      }}`;
    }
    default:
      throw new Error(`cannot canonically serialize ${typeof value}`);
  }
}

function stableHeaderText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
}

function frameParts(value: Uint8Array): Uint8Array[] {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(value.byteLength), false);
  return [length, value];
}

function concatParts(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

async function hmacHex(
  keyBytes: Uint8Array<ArrayBuffer>,
  purpose: "fingerprint" | "case-group",
  parts: readonly Uint8Array[],
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: TEXT_ENCODER.encode(RETAINED_NAMESPACE),
      info: TEXT_ENCODER.encode(purpose),
    },
    material,
    256,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, concatParts(parts));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function v2Fingerprint(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const parts = [
    ...frameParts(TEXT_ENCODER.encode(RETAINED_FINGERPRINT_NAMESPACE)),
    ...frameParts(TEXT_ENCODER.encode(metadata.method as string)),
    ...frameParts(TEXT_ENCODER.encode(metadata.endpoint as string)),
    ...frameParts(
      TEXT_ENCODER.encode(
        stableHeaderText(
          metadata.compatibility_headers as Record<string, string>,
        ),
      ),
    ),
    ...frameParts(body),
    ...frameParts(TEXT_ENCODER.encode(metadata.failure_signature as string)),
    ...frameParts(TEXT_ENCODER.encode(canonicalJson(metadata.upstream))),
  ];
  return hmacHex(keyBytes, "fingerprint", parts);
}

function v2CaseGroup(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const parts = [
    ...frameParts(TEXT_ENCODER.encode(RETAINED_CASE_GROUP_NAMESPACE)),
    ...frameParts(TEXT_ENCODER.encode(metadata.method as string)),
    ...frameParts(TEXT_ENCODER.encode(metadata.endpoint as string)),
    ...frameParts(
      TEXT_ENCODER.encode(
        stableHeaderText(
          metadata.compatibility_headers as Record<string, string>,
        ),
      ),
    ),
    ...frameParts(body),
  ];
  return hmacHex(keyBytes, "case-group", parts);
}

async function craftEnvelope(
  plaintext: Uint8Array<ArrayBuffer>,
  fingerprint: string,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<
  { ciphertext: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }
> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: TEXT_ENCODER.encode(RETAINED_NAMESPACE),
      info: TEXT_ENCODER.encode("encryption"),
    },
    material,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    derived,
    { name: "AES-GCM" },
    false,
    ["encrypt"],
  );
  const compressed = new Uint8Array(
    await new Response(
      new Blob([plaintext]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: TEXT_ENCODER.encode(
          `${RETAINED_NAMESPACE}\u0000${fingerprint}`,
        ),
      },
      aesKey,
      compressed,
    ),
  );
  compressed.fill(0);
  return { ciphertext: encrypted, iv };
}

function encodeEnvelope(
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const metadataBytes = TEXT_ENCODER.encode(JSON.stringify(metadata));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, metadataBytes.byteLength, false);
  const output = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  output.set(size, 0);
  output.set(metadataBytes, 4);
  output.set(body, 4 + metadataBytes.byteLength);
  return output;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** One captured gateway incident bound to the real toy original SHA. */
export async function craftCapture(
  keyBytes: Uint8Array<ArrayBuffer>,
  originalSha: GitSha,
  capturedAtMs: number,
): Promise<{
  manifest: Record<string, unknown>;
  chunks: string[];
  digest: string;
}> {
  const upstream = {
    version: 1,
    attempts: [{
      provider: "chatgpt_codex",
      status: 200,
      content_type: "text/event-stream",
      chunks_base64: [standardBase64(TEXT_ENCODER.encode(
        'data: {"type":"response.created","response":{"id":"fixture_id_1"}}\n\n',
      ))],
      terminal: "eof",
    }],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  };
  const body = TEXT_ENCODER.encode(
    '{"model":"synthetic-model","input":"public regression fixture","stream":true}',
  );
  const metadata = {
    version: 2,
    captured_at_ms: capturedAtMs,
    endpoint: "/v1/responses",
    method: "POST",
    content_type: "application/json",
    compatibility_headers: { accept: "text/event-stream" },
    failure_signature:
      '{"status":502,"stream":true,"completed":false,"terminal_type":null,"failure_kind":"missing_sse_terminal","framing_valid":true,"provider_route":"synthetic"}',
    observation: {
      status: 502,
      stream: true,
      completed: false,
      terminal_type: null,
      failure_kind: "missing_sse_terminal",
      synthetic_terminal_type: null,
      provider_route: "synthetic",
    },
    client_observation: {
      status: 502,
      stream: true,
      completed: false,
      terminal_type: null,
      failure_kind: "missing_sse_terminal",
      framing_valid: true,
      provider_route: "synthetic",
    },
    request_id: "synthetic-request-2",
    git_sha: originalSha,
    deno_revision: "synthetic-revision-2",
    upstream,
  };
  const fingerprint = await v2Fingerprint(keyBytes, metadata, body);
  const caseGroupDigest = await v2CaseGroup(keyBytes, metadata, body);
  const plaintext = encodeEnvelope(metadata, body);
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    fingerprint,
    keyBytes,
  );
  const manifest = {
    version: 1,
    capture_id: CAPTURE_ID_A,
    fingerprint,
    case_group_digest: caseGroupDigest,
    captured_at_ms: capturedAtMs,
    expires_at_ms: capturedAtMs + RETAINED_TTL_MS,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv: toBase64Url(iv),
    chunk_count: 1,
    ciphertext_bytes: ciphertext.byteLength,
  };
  return {
    manifest,
    chunks: [toBase64Url(ciphertext)],
    digest: await sha256hex(ciphertext),
  };
}
