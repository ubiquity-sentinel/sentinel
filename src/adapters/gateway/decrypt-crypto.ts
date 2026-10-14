import {
  canonicalUpstreamJson,
  KEY_DERIVATION_SALT,
  RETAINED_FINGERPRINT_NAMESPACE,
  RETAINED_NAMESPACE,
  RETAINED_PLAINTEXT_MAX_BYTES,
  TEXT_ENCODER,
} from "./decrypt-schema.ts";
import type {
  GunzipResult,
  ParsedRetainedMetadata,
  RetainedClientObservationWire,
} from "./decrypt-schema.ts";
import type { GatewayReplayManifestV1 } from "./wire.ts";

// ---------------------------------------------------------------------------
// AES-GCM decryption and bounded gzip expansion
// ---------------------------------------------------------------------------

async function deriveKeyBytes(
  keyBytes: Uint8Array<ArrayBuffer>,
  purpose: "encryption" | "fingerprint" | "case-group",
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: KEY_DERIVATION_SALT,
      info: TEXT_ENCODER.encode(purpose),
    },
    material,
    256,
  );
  return new Uint8Array(bits);
}

async function importAesKey(
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  const derived = await deriveKeyBytes(keyBytes, "encryption");
  try {
    return await crypto.subtle.importKey(
      "raw",
      derived,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
  } finally {
    derived.fill(0);
  }
}

export async function aesGcmDecrypt(
  keyBytes: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
  ciphertext: Uint8Array<ArrayBuffer>,
  fingerprint: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const key = await importAesKey(keyBytes);
  try {
    const additionalData = TEXT_ENCODER.encode(
      `${RETAINED_NAMESPACE}\u0000${fingerprint}`,
    );
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      ciphertext,
    );
    return new Uint8Array(decrypted);
  } catch {
    return null;
  }
}

/**
 * Streaming bounded decompression — never `Response.arrayBuffer()` on the
 * expanded body. The bound is the exact producer plaintext maximum; every
 * collected partial chunk is zeroed on any failure, the over-bound chunk is
 * cleared, and an early failure cancels the stream before the reader lock is
 * released so the producer pipeline settles (no lingering plaintext).
 */
export async function gunzipBounded(
  compressed: Uint8Array<ArrayBuffer>,
): Promise<GunzipResult> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const stream = new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("gzip"),
    );
    reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RETAINED_PLAINTEXT_MAX_BYTES) {
        zeroAll(parts);
        value.fill(0);
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "oversized" };
      }
      parts.push(cloneBytes(value));
      value.fill(0);
    }
    const output = concatBytes(parts);
    zeroAll(parts);
    return { ok: true, value: output };
  } catch {
    zeroAll(parts);
    await reader?.cancel().catch(() => {});
    return { ok: false, reason: "invalid" };
  } finally {
    reader?.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Producer identity recomputation (source: fingerprintParts, frozen)
// ---------------------------------------------------------------------------

/** Exact producer `sentinelFailureSignature` (field order is significant). */
function sentinelFailureSignature(
  observation: RetainedClientObservationWire,
): string {
  return JSON.stringify({
    status: observation.status,
    stream: observation.stream,
    completed: observation.completed,
    terminal_type: observation.terminal_type,
    failure_kind: observation.failure_kind,
    framing_valid: observation.framing_valid,
    provider_route: observation.provider_route,
  });
}

/** Exact producer `stableHeaderText` (sorted name:value lines). */
function stableHeaderText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `${name}:${value}`)
    .join("\n");
}

/**
 * Exact producer `fingerprintParts` message: 8-byte big-endian length frame
 * around [purpose label, method, endpoint, stable headers, body] plus, for the
 * fingerprint purpose only, the framed failure signature and one final frame
 * of canonical upstream JSON under the v2 namespace. The case-group purpose
 * stays exactly the v1 request-only identity.
 */
function fingerprintParts(
  metadata: ParsedRetainedMetadata,
  purpose: "fingerprint" | "case-group",
  upstreamFrame: Uint8Array<ArrayBuffer> | null,
): Uint8Array<ArrayBuffer>[] {
  const frame = (value: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] => {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(
      0,
      BigInt(value.byteLength),
      false,
    );
    return [length, value];
  };
  const namespace = purpose === "fingerprint"
    ? `${RETAINED_FINGERPRINT_NAMESPACE}:fingerprint`
    : `${RETAINED_NAMESPACE}:case-group`;
  const common = [
    ...frame(TEXT_ENCODER.encode(namespace)),
    ...frame(TEXT_ENCODER.encode(metadata.method)),
    ...frame(TEXT_ENCODER.encode(metadata.endpoint)),
    ...frame(
      TEXT_ENCODER.encode(stableHeaderText(metadata.compatibility_headers)),
    ),
  ];
  return purpose === "fingerprint"
    ? [
      ...common,
      ...frame(metadata.bodyBytes),
      ...frame(TEXT_ENCODER.encode(metadata.failure_signature)),
      ...frame(upstreamFrame!),
    ]
    : [...common, ...frame(metadata.bodyBytes)];
}

async function hmacHex(
  keyBytes: Uint8Array<ArrayBuffer>,
  purpose: "fingerprint" | "case-group",
  parts: readonly Uint8Array<ArrayBuffer>[],
): Promise<string> {
  const derived = await deriveKeyBytes(keyBytes, purpose);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "raw",
      derived,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } finally {
    derived.fill(0);
  }
  const message = concatBytes(parts);
  try {
    const digest = await crypto.subtle.sign("HMAC", key, message);
    return toHex(new Uint8Array(digest));
  } finally {
    message.fill(0);
  }
}

/**
 * Recompute both producer HMAC identities plus the failure signature and
 * capture time against the manifest. `fingerprint` binds the failure signature
 * (it is framed into the message) and `captured_at_ms` is compared directly.
 */
export async function verifyProducerIdentities(
  keyBytes: Uint8Array<ArrayBuffer>,
  metadata: ParsedRetainedMetadata,
  manifest: GatewayReplayManifestV1,
): Promise<boolean> {
  const upstreamFrame = TEXT_ENCODER.encode(
    canonicalUpstreamJson(metadata.upstream),
  );
  let fingerprint: string;
  try {
    fingerprint = await hmacHex(
      keyBytes,
      "fingerprint",
      fingerprintParts(metadata, "fingerprint", upstreamFrame),
    );
  } finally {
    // The canonical frame embeds private base64 trace bytes: zero it.
    upstreamFrame.fill(0);
  }
  const caseGroupDigest = await hmacHex(
    keyBytes,
    "case-group",
    fingerprintParts(metadata, "case-group", null),
  );
  if (fingerprint !== manifest.fingerprint) return false;
  if (caseGroupDigest !== manifest.caseGroupDigest) return false;
  if (metadata.captured_at_ms !== manifest.capturedAt) return false;
  if (
    sentinelFailureSignature(metadata.client_observation) !==
      metadata.failure_signature
  ) {
    return false;
  }
  return true;
}

export function cloneBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(value);
}

function concatBytes(
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

export function zeroAll(parts: readonly Uint8Array[]): void {
  for (const part of parts) part.fill(0);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return toHex(new Uint8Array(digest));
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
