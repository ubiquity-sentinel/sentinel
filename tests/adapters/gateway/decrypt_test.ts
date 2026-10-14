/**
 * Retained-capture decryption boundary tests (Wave C integration writer).
 *
 * The real producer-golden-v1 fixture is the ORIGINAL target
 * `9331946ef10d3b7259b5ca4933598dd380c1d794` v1 request-only plaintext and is
 * never modified. Under the frozen v2 cutover it is an explicit
 * unsupported-metadata regression plus an early-authentication/integrity
 * negative fixture: its ciphertext still exercises every pre-metadata check
 * (key, manifest, digest, AES-GCM), while its plaintext must be rejected as
 * unsupported — never upstream proof, never a legacy fallback.
 *
 * The v2 success path is crafted independently in this file (producing the
 * producer protocol outside the decryptor: HKDF + AES-GCM + gzip, the frozen
 * 8-byte length frames, the `uos-sentinel-replay-v2:fingerprint` input
 * namespace with the final canonical-upstream-JSON frame, the unchanged
 * request-only `uos-sentinel-replay-v1:case-group` identity, and
 * LocalArtifactStore put/get) and then run through
 * `decryptRetainedGatewayCapture`, proving the exact request and private raw
 * upstream trace round trip. The helpers never import the decryptor's
 * parsers/canonicalizer: every expected value is produced from public
 * synthetic bytes by this file's own framing, HMAC and canonical-JSON code.
 * The separate actual-producer golden (producer-golden-v2.json, generated
 * from the committed target m06 producer at the recorded source SHA) is the
 * cross-repository compatibility fixture: its exported capture is parsed with
 * the real wire helpers and must decrypt to the producer's recorded public
 * synthetic request and upstream bytes. Both fixtures are public protocol
 * fixtures: they prove producer/consumer protocol compatibility, never
 * sanitization, replay, runtime or live delivery behavior. Every tamper/bound
 * case uses public synthetic bytes and
 * the public synthetic key only; failures return static sanitized typed
 * errors with no plaintext, trace or key leakage, and caller-owned buffers
 * are never mutated. No model/network calls, no Deno KV access, no target
 * source imports.
 */

import {
  CAPTURED_AT_V2,
  goldenCiphertext,
  goldenKey,
  goldenManifest,
  goldenV2Ciphertext,
  goldenV2Key,
  readGolden,
  readV2Golden,
  RECORDED_PRODUCER_SOURCE_SHA_V2,
  RECORDED_SOURCE_SHA,
  retainThroughStore,
} from "./decrypt-fixtures.ts";
import assert from "node:assert/strict";
import { decryptRetainedGatewayCapture } from "../../../src/adapters/gateway/decrypt.ts";
import {
  assertBuffersUnchanged,
  baseMetadata,
  expectStaticFailure,
  v2Body,
} from "./decrypt-test-helpers.ts";
import { parseGatewayReplayManifestV1 } from "../../../src/adapters/gateway/wire.ts";
import {
  craftV2Capture,
  decodeStandardBase64,
} from "./decrypt-crypto-helpers.ts";

// ---------------------------------------------------------------------------
// Real producer v1 golden: explicit unsupported regression
// ---------------------------------------------------------------------------

Deno.test("gateway decrypt: the producer v1 golden is an explicit unsupported-metadata regression", async () => {
  const golden = readGolden();
  assert.equal(
    golden.sourceSha,
    RECORDED_SOURCE_SHA,
    "fixture must come from the recorded producer source",
  );
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  assert.equal(ciphertext.byteLength, manifest.ciphertextBytes);
  const keyBytes = goldenKey();
  const beforeKey = new Uint8Array(keyBytes);
  const beforeCiphertext = new Uint8Array(ciphertext);

  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    manifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    // The v1 request-only plaintext is not upstream proof and never a legacy
    // fallback: the decryptor must report the frozen unsupported-version error
    // with the static message, and no v1 value may be returned.
    expectStaticFailure(
      result,
      "unsupported_metadata_version",
      "retained capture metadata version is unsupported",
    );
    assertBuffersUnchanged(
      beforeKey,
      beforeCiphertext,
      keyBytes,
      ciphertext,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: archived producer v2 plaintext is explicitly unsupported", async () => {
  const golden = readV2Golden();
  assert.equal(golden.sourceSha, RECORDED_PRODUCER_SOURCE_SHA_V2);
  const manifest = parseGatewayReplayManifestV1(golden.exported.manifest);
  const ciphertext = goldenV2Ciphertext();
  const keyBytes = goldenV2Key();
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    manifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "unsupported_metadata_version",
      "retained capture metadata version is unsupported",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Independently crafted v2 success + truthful trace representation
// ---------------------------------------------------------------------------

Deno.test("gateway decrypt: independently crafted v2 capture round-trips through the actual store", async () => {
  const keyBytes = goldenKey();
  const body = v2Body();
  const metadata = baseMetadata();
  const expectedAttempts = metadata.upstream as {
    attempts: Record<string, unknown>[];
    attempts_truncated: boolean;
    bytes_truncated: boolean;
    chunks_truncated: boolean;
  };
  const { manifest, ciphertext } = await craftV2Capture(keyBytes, {
    metadata,
    body,
  });
  const beforeKey = new Uint8Array(keyBytes);
  const beforeCiphertext = new Uint8Array(ciphertext);

  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    manifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    assert.equal(
      result.ok,
      true,
      "independently crafted v2 capture must decrypt",
    );
    if (!result.ok) return;
    const value = result.value;
    assert.equal(value.version, 1);
    assert.equal(value.captureId, manifest.captureId);
    assert.equal(value.fingerprint, manifest.fingerprint);
    assert.equal(value.caseGroupDigest, manifest.caseGroupDigest);
    assert.equal(value.capturedAt, CAPTURED_AT_V2);
    assert.equal(value.expiresAt, manifest.expiresAt);
    assert.equal(value.requestId, "synthetic-request-2");
    assert.equal(value.endpoint, "/v1/responses");
    assert.equal(value.method, "POST");
    assert.equal(value.contentType, "application/json");
    assert.deepEqual(value.compatibilityHeaders, {
      accept: "text/event-stream",
    });
    assert.equal(
      value.failureSignature,
      '{"status":502,"stream":true,"completed":false,"terminal_type":null,"failure_kind":"missing_sse_terminal","framing_valid":true,"provider_route":"synthetic"}',
    );
    assert.deepEqual(value.observation, {
      status: 502,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "missing_sse_terminal",
      syntheticTerminalType: null,
      providerRoute: "synthetic",
    });
    assert.deepEqual(value.clientObservation, {
      errorCode: null,
      errorParam: null,
      terminalBodyBase64: "e30=",
      terminalBodyTruncated: false,
      status: 502,
      stream: true,
      completed: false,
      terminalType: null,
      failureKind: "missing_sse_terminal",
      framingValid: true,
      providerRoute: "synthetic",
    });
    // Exact request must round trip byte-for-byte.
    assert.deepEqual(value.body, body, "exact request bytes must round trip");
    // Private raw upstream trace: exact frozen snake_case shape and bytes.
    assert.equal(value.upstream.version, 2);
    assert.equal(value.upstream.attempts_truncated, false);
    assert.equal(value.upstream.bytes_truncated, false);
    assert.equal(value.upstream.chunks_truncated, false);
    assert.equal(value.upstream.attempts.length, 2);
    assert.deepEqual(
      value.upstream.attempts.map((attempt) => ({
        provider: attempt.provider,
        status: attempt.status,
        content_type: attempt.content_type,
        terminal: attempt.terminal,
      })),
      [
        {
          provider: "surplus",
          status: 200,
          content_type: "text/event-stream",
          terminal: "eof",
        },
        {
          provider: "chatgpt_codex",
          status: null,
          content_type: null,
          terminal: "fetch_error",
        },
      ],
      "attempt fields must survive exactly",
    );
    const firstChunks = (expectedAttempts.attempts[0] as {
      chunks_base64: string[];
    }).chunks_base64;
    assert.deepEqual(
      value.upstream.attempts[0]!.chunks_base64,
      firstChunks,
      "canonical base64 chunk strings must survive exactly",
    );
    // Independent decoding proves the raw upstream bytes survived.
    assert.deepEqual(
      decodeStandardBase64(value.upstream.attempts[0]!.chunks_base64[0]!),
      new TextEncoder().encode('event: message\ndata: {"ok":true}\n\n'),
      "raw upstream chunk bytes must survive",
    );
    assert.deepEqual(
      decodeStandardBase64(value.upstream.attempts[0]!.chunks_base64[1]!),
      new TextEncoder().encode("data: [DONE]\n\n"),
      "raw upstream chunk bytes must survive",
    );
    assert.deepEqual(
      value.upstream.attempts[1]!.chunks_base64,
      [],
      "before-header attempt must have no chunks",
    );
    assertBuffersUnchanged(beforeKey, beforeCiphertext, keyBytes, ciphertext);
  } finally {
    await cleanup();
  }
});
