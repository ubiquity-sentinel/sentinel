import {
  CAPTURE_ID_V2,
  RETAINED_CASE_GROUP_NAMESPACE,
  RETAINED_FINGERPRINT_NAMESPACE,
  RETAINED_NAMESPACE,
  RETAINED_TTL_MS,
} from "./decrypt-fixtures.ts";
import assert from "node:assert/strict";
import type { GatewayReplayManifestV1 } from "../../../src/adapters/gateway/wire.ts";
import { parseGatewayReplayManifestV1 } from "../../../src/adapters/gateway/wire.ts";
import { b64Url } from "./helpers.ts";

/** Independent producer-compatible envelope: gzip + AES-GCM under HKDF. */
export async function craftEnvelope(
  plaintext: Uint8Array<ArrayBuffer>,
  fingerprint: string,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<
  { ciphertext: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer> }
> {
  const enc = new TextEncoder();
  const salt = enc.encode(RETAINED_NAMESPACE);
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    [
      "deriveBits",
    ],
  );
  const derived = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt, info: enc.encode("encryption") },
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
  const additionalData = enc.encode(
    `${RETAINED_NAMESPACE}\u0000${fingerprint}`,
  );
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      aesKey,
      compressed,
    ),
  );
  compressed.fill(0);
  return { ciphertext: encrypted, iv };
}

/** 4-byte big-endian metadata length + metadata JSON + body (producer layout). */
function encodeEnvelope(
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, metadataBytes.byteLength, false);
  const output = new Uint8Array(4 + metadataBytes.byteLength + body.byteLength);
  output.set(size, 0);
  output.set(metadataBytes, 4);
  output.set(body, 4 + metadataBytes.byteLength);
  return output;
}

// ---------------------------------------------------------------------------
// Independent v2 producer-side helpers (frozen framing, no decryptor imports)
// ---------------------------------------------------------------------------

/** Canonical padded standard-base64 encoder (independent of src code). */
export function standardBase64(bytes: Uint8Array): string {
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

/** Independent standard-base64 decoder (assertions only). */
export function decodeStandardBase64(text: string): Uint8Array<ArrayBuffer> {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of text) {
    if (char === "=") continue;
    const decoded = alphabet.indexOf(char);
    assert.notEqual(decoded, -1, "unexpected standard-base64 character");
    value = (value << 6) | decoded;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Frozen canonical JSON: recursive UTF-16 code-unit key sort, preserved array
 * order, JSON.stringify string/primitive encoding, no whitespace.
 */
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
      const keys = Object.keys(record).sort();
      return `{${
        keys.map((key) =>
          `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        ).join(",")
      }}`;
    }
    default:
      throw new Error(`cannot canonically serialize ${typeof value}`);
  }
}

/** Exact producer stable header text (sorted name:value lines). */
function stableHeaderText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function frameParts(value: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const length = new Uint8Array(8);
  new DataView(length.buffer).setBigUint64(0, BigInt(value.byteLength), false);
  return [length, value];
}

function concatParts(
  parts: readonly Uint8Array[],
): Uint8Array<ArrayBuffer> {
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
  parts: readonly Uint8Array<ArrayBuffer>[],
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
      salt: new TextEncoder().encode(RETAINED_NAMESPACE),
      info: new TextEncoder().encode(purpose),
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
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    concatParts(parts),
  );
  return toHex(new Uint8Array(digest));
}

/** Frozen v2 fingerprint: v2 namespace + method/endpoint/headers/body + framed
 * failure signature + final framed canonical-upstream-JSON frame. */
function v2Fingerprint(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const enc = new TextEncoder();
  const upstreamFrame = enc.encode(canonicalJson(metadata.upstream));
  const parts = [
    ...frameParts(enc.encode(RETAINED_FINGERPRINT_NAMESPACE)),
    ...frameParts(enc.encode(metadata.method as string)),
    ...frameParts(enc.encode(metadata.endpoint as string)),
    ...frameParts(
      enc.encode(
        stableHeaderText(
          metadata.compatibility_headers as Record<string, string>,
        ),
      ),
    ),
    ...frameParts(body),
    ...frameParts(enc.encode(metadata.failure_signature as string)),
    ...frameParts(upstreamFrame),
  ];
  return hmacHex(keyBytes, "fingerprint", parts);
}

/** Unchanged v1 request-only case-group identity (stable grouping). */
function v2CaseGroup(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: Record<string, unknown>,
  body: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const enc = new TextEncoder();
  const parts = [
    ...frameParts(enc.encode(RETAINED_CASE_GROUP_NAMESPACE)),
    ...frameParts(enc.encode(metadata.method as string)),
    ...frameParts(enc.encode(metadata.endpoint as string)),
    ...frameParts(
      enc.encode(
        stableHeaderText(
          metadata.compatibility_headers as Record<string, string>,
        ),
      ),
    ),
    ...frameParts(body),
  ];
  return hmacHex(keyBytes, "case-group", parts);
}

interface CraftedV2Variant {
  metadata: Record<string, unknown>;
  body: Uint8Array<ArrayBuffer>;
  /** Override the advertised identity (stale-fingerprint tamper tests). */
  fingerprint?: string;
  caseGroupDigest?: string;
  /** Manifest capture time; defaults to metadata.captured_at_ms. */
  capturedAtMs?: number;
}

/** Independently crafted v2 capture: valid manifest + encrypted envelope. */
export async function craftV2Capture(
  keyBytes: Uint8Array<ArrayBuffer>,
  variant: CraftedV2Variant,
): Promise<{
  manifest: GatewayReplayManifestV1;
  ciphertext: Uint8Array<ArrayBuffer>;
}> {
  const metadata = variant.metadata;
  const body = variant.body;
  const capturedAtMs = variant.capturedAtMs ??
    (metadata.captured_at_ms as number);
  const fingerprint = variant.fingerprint ??
    await v2Fingerprint(keyBytes, metadata, body);
  const caseGroupDigest = variant.caseGroupDigest ??
    await v2CaseGroup(keyBytes, metadata, body);
  const plaintext = encodeEnvelope(metadata, body);
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    fingerprint,
    keyBytes,
  );
  const manifest = parseGatewayReplayManifestV1({
    version: 1,
    capture_id: CAPTURE_ID_V2,
    fingerprint,
    case_group_digest: caseGroupDigest,
    captured_at_ms: capturedAtMs,
    expires_at_ms: capturedAtMs + RETAINED_TTL_MS,
    algorithm: "AES-256-GCM",
    compression: "gzip",
    iv: b64Url(iv),
    chunk_count: 1,
    ciphertext_bytes: ciphertext.byteLength,
  });
  return { manifest, ciphertext };
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
