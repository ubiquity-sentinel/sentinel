/**
 * Trusted decryption boundary for retained gateway replay captures.
 *
 * The producer (`ai.ubq.fi/src/sentinel_replay_capture.ts` at the recorded
 * snapshot) encrypts each failed-request capture with AES-256-GCM under an
 * HKDF-SHA256-derived key, then publishes a manifest whose `fingerprint` is an
 * HMAC identity over the request (method/endpoint/compatibility headers/body +
 * failure signature) and whose `case_group_digest` is the same HMAC minus the
 * signature. This module is the deterministic inverse: it consumes a
 * `StoredArtifactV1` retained by the local restricted store and the existing
 * key bytes supplied by its caller (never a key source, credential loader or
 * configuration surface).
 *
 * Verification performed here, in order, each fail-closed:
 *
 * - key length is exactly the producer's 32 bytes;
 * - the preserved producer manifest re-parses under the frozen wire parser;
 * - the retained metadata identities match the manifest (capture id,
 *   fingerprint, case-group digest, capture/expiry times, byte counts);
 * - SHA-256 of the actual ciphertext equals the retained encrypted-artifact
 *   digest (reader-side integrity);
 * - AES-GCM decryption under HKDF-SHA256 (salt `uos-sentinel-replay-v1`,
 *   purpose `encryption`), the 12-byte manifest IV and the exact producer AAD
 *   `uos-sentinel-replay-v1\0<fingerprint>` (authenticity);
 * - bounded streaming gzip expansion (never Response.arrayBuffer());
 * - the 4-byte big-endian metadata-length envelope, request-body bound and
 *   strict producer metadata v2 shape (request plus the private upstream
 *   trace; v1 request-only plaintext is an explicit unsupported version);
 * - both producer HMAC identities (`fingerprint` now framed with canonical
 *   upstream JSON under `uos-sentinel-replay-v2`, `case-group` unchanged as
 *   the request-only v1 identity), the failure signature recomputed from the
 *   client observation, and the capture time.
 *
 * Every failure returns a static sanitized typed error: no thrown messages,
 * payload excerpts, trace bytes or key material ever cross this boundary.
 * Caller-owned key and ciphertext buffers are never mutated, and temporary
 * plaintext/crypto buffers are zeroed after use. The returned plaintext and
 * private upstream trace are explicitly restricted: they are not sanitized
 * and never a replay fixture, and this module makes no sanitization,
 * provenance or complete-coverage claims (`ReplayMetadataV1.upstreamCaptured`
 * and fixture digests remain out of scope).
 */

import type { StoredArtifactV1 } from "./store.ts";
import type {
  RetainedCaptureErrorV1,
  RetainedCaptureResultV1,
  RetainedClientObservationWire,
  RetainedGatewayClientObservationV1,
  RetainedGatewayObservationV1,
  RetainedObservationWire,
} from "./decrypt-schema.ts";
import { RETAINED_IV_BYTES, RETAINED_KEY_BYTES } from "./decrypt-schema.ts";
import {
  aesGcmDecrypt,
  cloneBytes,
  gunzipBounded,
  sha256Hex,
  verifyProducerIdentities,
} from "./decrypt-crypto.ts";
import {
  decodeBase64Url,
  parseGatewayReplayManifestV1,
  replayManifestToWire,
} from "./wire.ts";
import { decodeEnvelope } from "./decrypt-metadata.ts";
import { mapUpstream } from "./decrypt-upstream.ts";
import type { GatewayReplayManifestV1 } from "./wire.ts";
export type { RetainedGatewayObservationV1 } from "./decrypt-schema.ts";
export type { RetainedGatewayClientObservationV1 } from "./decrypt-schema.ts";
export type { RetainedGatewayUpstreamAttemptV1 } from "./decrypt-schema.ts";
export type { RetainedGatewayUpstreamV1 } from "./decrypt-schema.ts";
export type { RetainedGatewayCaptureV1 } from "./decrypt-schema.ts";
export type { RetainedCaptureErrorV1 } from "./decrypt-schema.ts";
export type { RetainedCaptureResultV1 } from "./decrypt-schema.ts";
/**
 * Authenticate and decrypt one retained capture. Caller supplies the existing
 * producer key bytes; verified 32-byte length, then every producer identity is
 * recomputed. The caller-owned key and ciphertext buffers are never mutated.
 */
export async function decryptRetainedGatewayCapture(
  artifact: StoredArtifactV1,
  keyBytes: Uint8Array<ArrayBuffer>,
): Promise<RetainedCaptureResultV1> {
  if (keyBytes.byteLength !== RETAINED_KEY_BYTES) {
    return fail("invalid_key");
  }
  const manifest = validateManifest(artifact.manifest);
  if (manifest === null) return fail("invalid_manifest");
  if (!matchesRetainedIdentity(artifact, manifest)) {
    return fail("tampered_metadata");
  }
  if (artifact.ciphertext.byteLength !== manifest.ciphertextBytes) {
    return fail("tampered_metadata");
  }
  if (await sha256Hex(artifact.ciphertext) !== artifact.digest) {
    return fail("tampered_ciphertext");
  }
  const iv = decodeBase64Url(manifest.iv);
  if (iv === null || iv.byteLength !== RETAINED_IV_BYTES) {
    // The wire parser already enforces this; stay fail-closed regardless.
    return fail("invalid_manifest");
  }

  let compressed: Uint8Array<ArrayBuffer> | null = null;
  let plaintext: Uint8Array<ArrayBuffer> | null = null;
  try {
    const aesResult = await aesGcmDecrypt(
      keyBytes,
      iv,
      artifact.ciphertext,
      manifest.fingerprint,
    );
    if (aesResult === null) return fail("authentication_failed");
    compressed = aesResult;

    const gunzipResult = await gunzipBounded(compressed);
    if (!gunzipResult.ok) {
      return fail(
        gunzipResult.reason === "oversized"
          ? "oversized_plaintext"
          : "invalid_envelope",
      );
    }
    plaintext = gunzipResult.value;

    const envelope = decodeEnvelope(plaintext);
    if (!envelope.ok) return fail(envelope.reason);

    const metadata = envelope.metadata;

    const hmacResult = await verifyProducerIdentities(
      keyBytes,
      metadata,
      manifest,
    );
    if (!hmacResult) return fail("tampered_manifest");

    return {
      ok: true,
      value: {
        version: 1,
        captureId: manifest.captureId,
        fingerprint: manifest.fingerprint,
        caseGroupDigest: manifest.caseGroupDigest,
        capturedAt: manifest.capturedAt,
        expiresAt: manifest.expiresAt,
        requestId: metadata.request_id,
        gitSha: metadata.git_sha,
        denoRevision: metadata.deno_revision,
        endpoint: metadata.endpoint,
        method: metadata.method,
        contentType: metadata.content_type,
        compatibilityHeaders: metadata.compatibility_headers,
        failureSignature: metadata.failure_signature,
        observation: mapObservation(metadata.observation),
        clientObservation: mapClientObservation(metadata.client_observation),
        upstream: mapUpstream(metadata.upstream),
        body: cloneBytes(metadata.bodyBytes),
      },
    };
  } finally {
    compressed?.fill(0);
    plaintext?.fill(0);
  }
}

// ---------------------------------------------------------------------------
// Manifest and retained-metadata identity
// ---------------------------------------------------------------------------

/**
 * Re-parse the preserved producer manifest through the frozen wire parser:
 * every structural rule (version, IV, chunk grid, byte bounds, lifetime) is
 * enforced again at the decryption boundary.
 */
function validateManifest(
  manifest: GatewayReplayManifestV1,
): GatewayReplayManifestV1 | null {
  try {
    return parseGatewayReplayManifestV1(replayManifestToWire(manifest));
  } catch {
    return null;
  }
}

/** Stored metadata must name the exact object it claims to retain. */
function matchesRetainedIdentity(
  artifact: StoredArtifactV1,
  manifest: GatewayReplayManifestV1,
): boolean {
  if (artifact.captureId !== manifest.captureId) return false;
  if (artifact.fingerprint !== manifest.fingerprint) return false;
  if (artifact.caseGroupDigest !== manifest.caseGroupDigest) return false;
  if (artifact.sourceCapturedAt !== manifest.capturedAt) return false;
  if (artifact.sourceExpiresAt !== manifest.expiresAt) return false;
  if (artifact.sizeBytes !== manifest.ciphertextBytes) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Mapping and byte helpers
// ---------------------------------------------------------------------------

function mapObservation(
  observation: RetainedObservationWire,
): RetainedGatewayObservationV1 {
  return {
    status: observation.status,
    stream: observation.stream,
    completed: observation.completed,
    terminalType: observation.terminal_type,
    failureKind: observation.failure_kind,
    syntheticTerminalType: observation.synthetic_terminal_type,
    providerRoute: observation.provider_route,
  };
}

function mapClientObservation(
  observation: RetainedClientObservationWire,
): RetainedGatewayClientObservationV1 {
  return {
    status: observation.status,
    stream: observation.stream,
    completed: observation.completed,
    terminalType: observation.terminal_type,
    failureKind: observation.failure_kind,
    framingValid: observation.framing_valid,
    providerRoute: observation.provider_route,
  };
}

function fail(
  kind: RetainedCaptureErrorV1["kind"],
): RetainedCaptureResultV1 {
  const error = ERROR_DETAILS[kind];
  return {
    ok: false,
    error: { kind, detail: error } as RetainedCaptureErrorV1,
  };
}

const ERROR_DETAILS: Record<RetainedCaptureErrorV1["kind"], string> = {
  invalid_key: "retained capture key must be 32 bytes",
  invalid_manifest:
    "retained capture manifest is not the supported producer shape",
  tampered_metadata: "retained capture metadata does not match its manifest",
  tampered_ciphertext: "retained capture ciphertext does not match its digest",
  authentication_failed: "retained capture failed authenticated decryption",
  invalid_envelope: "retained capture envelope is malformed",
  oversized_plaintext: "retained capture plaintext exceeds its size bound",
  invalid_plaintext: "retained capture plaintext metadata is invalid",
  unsupported_metadata_version:
    "retained capture metadata version is unsupported",
  tampered_manifest:
    "retained capture HMAC identity does not match its manifest",
};
