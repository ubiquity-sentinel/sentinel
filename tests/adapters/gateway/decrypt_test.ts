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
  PUBLIC_SYNTHETIC_UPSTREAM_SSE,
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
import type { ProducerGoldenV2Expected } from "./decrypt-fixtures.ts";
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

Deno.test("gateway decrypt: the actual producer v2 golden authenticates and decrypts to the producer's public synthetic request and upstream bytes", async () => {
  const golden = readV2Golden();
  assert.equal(
    golden.sourceSha,
    RECORDED_PRODUCER_SOURCE_SHA_V2,
    "fixture must come from the recorded actual producer source",
  );
  const expected = golden.expected as unknown as ProducerGoldenV2Expected;
  // The producer's private metadata stays version 2; the decryptor's
  // normalized capture result is version 1 — distinct objects, never conflated.
  assert.equal(expected.version, 2);
  const manifest = parseGatewayReplayManifestV1(golden.exported.manifest);
  const ciphertext = goldenV2Ciphertext();
  assert.equal(ciphertext.byteLength, manifest.ciphertextBytes);
  const keyBytes = goldenV2Key();
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
      "actual producer v2 golden must authenticate and decrypt",
    );
    if (!result.ok) return;
    const value = result.value;
    assert.equal(value.version, 1, "normalized capture is version 1");
    // Authenticated manifest identity.
    assert.equal(value.captureId, manifest.captureId);
    assert.equal(value.fingerprint, manifest.fingerprint);
    assert.equal(value.caseGroupDigest, manifest.caseGroupDigest);
    assert.equal(value.capturedAt, expected.captured_at_ms);
    assert.equal(value.expiresAt, manifest.expiresAt);
    // Producer private metadata: exact request identity and observations.
    assert.equal(value.requestId, expected.request_id);
    assert.equal(value.endpoint, expected.endpoint);
    assert.equal(value.method, expected.method);
    assert.equal(value.contentType, expected.content_type);
    assert.deepEqual(
      value.compatibilityHeaders,
      expected.compatibility_headers,
    );
    assert.equal(value.failureSignature, expected.failure_signature);
    assert.equal(value.gitSha, expected.git_sha);
    assert.equal(value.denoRevision, expected.deno_revision);
    assert.deepEqual(value.observation, {
      status: expected.observation.status,
      stream: expected.observation.stream,
      completed: expected.observation.completed,
      terminalType: expected.observation.terminal_type,
      failureKind: expected.observation.failure_kind,
      syntheticTerminalType: expected.observation.synthetic_terminal_type,
      providerRoute: expected.observation.provider_route,
    });
    assert.deepEqual(value.clientObservation, {
      status: expected.client_observation.status,
      stream: expected.client_observation.stream,
      completed: expected.client_observation.completed,
      terminalType: expected.client_observation.terminal_type,
      failureKind: expected.client_observation.failure_kind,
      framingValid: expected.client_observation.framing_valid,
      providerRoute: expected.client_observation.provider_route,
    });
    // Exact original request bytes: the producer recorded this public
    // synthetic body and the decryptor must return it byte-for-byte.
    assert.deepEqual(
      value.body,
      new TextEncoder().encode(expected.body),
      "exact original request bytes must round trip",
    );
    assert.equal(
      new TextDecoder().decode(value.body),
      expected.body,
      "request body fixture string must match exactly",
    );
    // Full validated upstream must equal the producer-recorded trace.
    assert.deepEqual(value.upstream, expected.upstream);
    const attempt = value.upstream.attempts[0]!;
    assert.equal(attempt.provider, "chatgpt_codex");
    assert.equal(attempt.status, 200);
    assert.equal(attempt.content_type, "text/event-stream");
    assert.equal(attempt.terminal, "eof");
    assert.equal(value.upstream.attempts_truncated, false);
    assert.equal(value.upstream.bytes_truncated, false);
    assert.equal(value.upstream.chunks_truncated, false);
    // Independent atob decode proves the raw recorded SSE bytes at rest.
    assert.equal(
      atob(attempt.chunks_base64[0]!),
      PUBLIC_SYNTHETIC_UPSTREAM_SSE,
      "first attempt must decode to the public synthetic raw SSE body",
    );
    // Producer response headers (e.g. x-request-id) never enter the private
    // trace: the public-header-excluded marker must be absent.
    assert.ok(
      !JSON.stringify(value.upstream).includes("public-header-excluded"),
      "response headers must not appear in the upstream trace",
    );
    assertBuffersUnchanged(beforeKey, beforeCiphertext, keyBytes, ciphertext);
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
    assert.equal(value.upstream.version, 1);
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
