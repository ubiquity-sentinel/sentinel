import {
  CAPTURED_AT_V2,
  goldenKey,
  makeArtifact,
  retainThroughStore,
} from "./decrypt-fixtures.ts";
import {
  baseMetadata,
  expectStaticFailure,
  manifestVariant,
  v2Attempt,
  v2Body,
  v2Upstream,
} from "./decrypt-test-helpers.ts";
import { craftV2Capture, standardBase64 } from "./decrypt-crypto-helpers.ts";
import { sha256hex } from "./helpers.ts";
import { decryptRetainedGatewayCapture } from "../../../src/adapters/gateway/decrypt.ts";
import assert from "node:assert/strict";

Deno.test("gateway decrypt: all terminal variants and truncation flags are truthfully represented", async () => {
  const keyBytes = goldenKey();
  const attempts = [
    // pending without headers: no chunks.
    v2Attempt({
      provider: "metered",
      status: null,
      content_type: null,
      chunks_base64: [],
      terminal: "pending",
    }),
    // pending after headers: partial body, empty consumed chunk list.
    v2Attempt({
      provider: "cerebras",
      status: 200,
      content_type: "application/json",
      chunks_base64: [],
      terminal: "pending",
    }),
    // dispatch failure: no headers.
    v2Attempt({
      provider: "surplus",
      status: null,
      content_type: null,
      chunks_base64: [],
      terminal: "fetch_error",
    }),
    // consumed to network EOF with raw bytes.
    v2Attempt({
      provider: "chatgpt_codex",
      status: 502,
      content_type: "text/event-stream",
      chunks_base64: [
        standardBase64(new TextEncoder().encode("data: one\n\n")),
        standardBase64(new TextEncoder().encode("data: two\n\n")),
      ],
      terminal: "eof",
    }),
    // interrupted read with bytes consumed so far and normalized MIME "other".
    v2Attempt({
      provider: "metered",
      status: 503,
      content_type: "other",
      chunks_base64: [
        standardBase64(new TextEncoder().encode("partial")),
      ],
      terminal: "read_error",
    }),
    // cancellation after response start with an empty body.
    v2Attempt({
      provider: "cerebras",
      status: 200,
      content_type: "application/json",
      chunks_base64: [],
      terminal: "cancelled",
    }),
  ];
  const metadata = baseMetadata({
    upstream: v2Upstream({
      attempts,
      attempts_truncated: false,
      bytes_truncated: true,
      chunks_truncated: true,
    }),
  });
  const body = v2Body();
  const { manifest, ciphertext } = await craftV2Capture(keyBytes, {
    metadata,
    body,
  });
  const digest = await sha256hex(ciphertext);
  const artifact = makeArtifact(ciphertext, manifest, digest);
  const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
  assert.equal(result.ok, true, "all terminal variants must decrypt");
  if (!result.ok) return;
  const upstream = result.value.upstream;
  assert.equal(upstream.attempts_truncated, false);
  assert.equal(upstream.bytes_truncated, true);
  assert.equal(upstream.chunks_truncated, true);
  assert.deepEqual(
    upstream.attempts.map((attempt) => ({
      provider: attempt.provider,
      status: attempt.status,
      content_type: attempt.content_type,
      terminal: attempt.terminal,
      chunks: attempt.chunks_base64.length,
    })),
    [
      {
        provider: "metered",
        status: null,
        content_type: null,
        terminal: "pending",
        chunks: 0,
      },
      {
        provider: "cerebras",
        status: 200,
        content_type: "application/json",
        terminal: "pending",
        chunks: 0,
      },
      {
        provider: "surplus",
        status: null,
        content_type: null,
        terminal: "fetch_error",
        chunks: 0,
      },
      {
        provider: "chatgpt_codex",
        status: 502,
        content_type: "text/event-stream",
        terminal: "eof",
        chunks: 2,
      },
      {
        provider: "metered",
        status: 503,
        content_type: "other",
        terminal: "read_error",
        chunks: 1,
      },
      {
        provider: "cerebras",
        status: 200,
        content_type: "application/json",
        terminal: "cancelled",
        chunks: 0,
      },
    ],
    "terminals, header state and chunks must survive exactly",
  );
});

Deno.test("gateway decrypt: an empty upstream trace is accepted and returned truthfully", async () => {
  const keyBytes = goldenKey();
  const metadata = baseMetadata({
    upstream: v2Upstream({ attempts: [] }),
  });
  const body = v2Body();
  const { manifest, ciphertext } = await craftV2Capture(keyBytes, {
    metadata,
    body,
  });
  const digest = await sha256hex(ciphertext);
  const artifact = makeArtifact(ciphertext, manifest, digest);
  const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
  assert.equal(result.ok, true, "empty trace must decrypt");
  if (!result.ok) return;
  assert.deepEqual(result.value.upstream, {
    version: 1,
    attempts: [],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
  });
});

// ---------------------------------------------------------------------------
// HMAC negatives: reach the identity checks with valid v2 metadata
// ---------------------------------------------------------------------------

Deno.test("gateway decrypt: case-group HMAC tampering fails as tampered_manifest", async () => {
  const keyBytes = goldenKey();
  const body = v2Body();
  const { manifest, ciphertext } = await craftV2Capture(keyBytes, {
    metadata: baseMetadata(),
    body,
  });
  const tamperedManifest = manifestVariant(manifest, {
    case_group_digest: "a".repeat(64),
  });
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    tamperedManifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "tampered_manifest",
      "retained capture HMAC identity does not match its manifest",
      [manifest.fingerprint, "data: [DONE]"],
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: client observation tampering fails the failure-signature identity", async () => {
  const keyBytes = goldenKey();
  const metadata = baseMetadata({
    client_observation: {
      status: 503,
      stream: true,
      completed: false,
      terminal_type: null,
      failure_kind: "missing_sse_terminal",
      framing_valid: true,
      provider_route: "synthetic",
    },
  });
  const body = v2Body();
  const { manifest, ciphertext } = await craftV2Capture(keyBytes, {
    metadata,
    body,
  });
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    manifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    // The v2 fingerprint and case-group identities both match; only the
    // recomputed failure signature disagrees with the bound signature text.
    expectStaticFailure(
      result,
      "tampered_manifest",
      "retained capture HMAC identity does not match its manifest",
      [manifest.fingerprint, "data: [DONE]"],
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: capture-time tampering fails against the manifest", async () => {
  const keyBytes = goldenKey();
  const shifted = CAPTURED_AT_V2 + 60_000;
  const metadata = baseMetadata({ captured_at_ms: shifted });
  const body = v2Body();
  const { manifest, ciphertext } = await craftV2Capture(keyBytes, {
    metadata,
    body,
    // Manifest keeps the true capture time; only the authenticated plaintext
    // was shifted, so the producer capture-time identity must reject it.
    capturedAtMs: CAPTURED_AT_V2,
  });
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    manifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "tampered_manifest",
      "retained capture HMAC identity does not match its manifest",
      [manifest.fingerprint, "data: [DONE]"],
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: changed trace with recomputed ciphertext but stale fingerprint fails HMAC", async () => {
  const keyBytes = goldenKey();
  const body = v2Body();
  const original = await craftV2Capture(keyBytes, {
    metadata: baseMetadata(),
    body,
  });
  // Same request, same signature: reuse the computed identities of the
  // original trace while the plaintext carries a CHANGED trace. The ciphertext
  // is re-encrypted under the stale fingerprint (AAD), so AES-GCM succeeds and
  // the HMAC check is what rejects the capture.
  const changed = await craftV2Capture(keyBytes, {
    metadata: baseMetadata({
      upstream: v2Upstream({
        attempts: [
          v2Attempt({
            provider: "surplus",
            status: 200,
            content_type: "text/event-stream",
            chunks_base64: [
              standardBase64(new TextEncoder().encode("data: one\n\n")),
            ],
            terminal: "eof",
          }),
        ],
      }),
    }),
    body,
    fingerprint: original.manifest.fingerprint,
    caseGroupDigest: original.manifest.caseGroupDigest,
  });
  assert.equal(changed.manifest.fingerprint, original.manifest.fingerprint);
  const digest = await sha256hex(changed.ciphertext);
  const artifact = makeArtifact(changed.ciphertext, changed.manifest, digest);
  const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
  expectStaticFailure(
    result,
    "tampered_manifest",
    "retained capture HMAC identity does not match its manifest",
    [original.manifest.fingerprint, "data: one"],
  );
});

Deno.test("gateway decrypt: partial and complete traces share the case-group but not the fingerprint", async () => {
  const keyBytes = goldenKey();
  const body = v2Body();
  const sharedRequest = baseMetadata();
  const completeMetadata = {
    ...sharedRequest,
    upstream: v2Upstream({
      attempts: [
        v2Attempt({
          provider: "surplus",
          status: 200,
          content_type: "text/event-stream",
          chunks_base64: [
            standardBase64(new TextEncoder().encode("data: one\n\n")),
            standardBase64(new TextEncoder().encode("data: two\n\n")),
            standardBase64(new TextEncoder().encode("data: [DONE]\n\n")),
          ],
          terminal: "eof",
        }),
      ],
    }),
  };
  const partialMetadata = {
    ...sharedRequest,
    upstream: v2Upstream({
      attempts: [
        v2Attempt({
          provider: "surplus",
          status: 200,
          content_type: "text/event-stream",
          chunks_base64: [
            standardBase64(new TextEncoder().encode("data: one\n\n")),
          ],
          terminal: "eof",
        }),
      ],
      attempts_truncated: false,
      bytes_truncated: true,
      chunks_truncated: true,
    }),
  };
  const complete = await craftV2Capture(keyBytes, {
    metadata: completeMetadata,
    body,
  });
  const partial = await craftV2Capture(keyBytes, {
    metadata: partialMetadata,
    body,
  });
  const completeResult = await decryptRetainedGatewayCapture(
    makeArtifact(
      complete.ciphertext,
      complete.manifest,
      await sha256hex(complete.ciphertext),
    ),
    keyBytes,
  );
  const partialResult = await decryptRetainedGatewayCapture(
    makeArtifact(
      partial.ciphertext,
      partial.manifest,
      await sha256hex(partial.ciphertext),
    ),
    keyBytes,
  );
  assert.equal(completeResult.ok, true, "complete trace must decrypt");
  assert.equal(partialResult.ok, true, "partial trace must decrypt");
  if (!completeResult.ok || !partialResult.ok) return;
  // Same request-only case-group; the upstream frame separates the traces.
  assert.equal(
    partialResult.value.caseGroupDigest,
    completeResult.value.caseGroupDigest,
  );
  assert.notEqual(
    partialResult.value.fingerprint,
    completeResult.value.fingerprint,
    "partial and complete traces must not suppress one another",
  );
  // Truthful coverage: the partial trace reports its own truncation state.
  assert.equal(completeResult.value.upstream.bytes_truncated, false);
  assert.equal(completeResult.value.upstream.chunks_truncated, false);
  assert.equal(
    completeResult.value.upstream.attempts[0]!.chunks_base64.length,
    3,
  );
  assert.equal(partialResult.value.upstream.bytes_truncated, true);
  assert.equal(partialResult.value.upstream.chunks_truncated, true);
  assert.equal(
    partialResult.value.upstream.attempts[0]!.chunks_base64.length,
    1,
  );
});
