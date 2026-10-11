import {
  goldenKey,
  makeArtifact,
  UPSTREAM_MAX_ATTEMPTS,
  UPSTREAM_MAX_CHUNKS,
  UPSTREAM_MAX_DECODED_BYTES,
} from "./decrypt-fixtures.ts";
import {
  baseMetadata,
  expectStaticFailure,
  v2Attempt,
  v2Body,
  v2Upstream,
} from "./decrypt-test-helpers.ts";
import { craftV2Capture, standardBase64 } from "./decrypt-crypto-helpers.ts";
import { sha256hex } from "./helpers.ts";
import { decryptRetainedGatewayCapture } from "../../../src/adapters/gateway/decrypt.ts";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Strict parsing: canonical base64, cross-field relations, bounds
// ---------------------------------------------------------------------------

Deno.test("gateway decrypt: canonical-padding and malformed base64 chunks are rejected", async () => {
  const keyBytes = goldenKey();
  const body = v2Body();
  const cases: Array<[string, string]> = [
    // `QR==` has nonzero trailing pad bits (never produced canonically).
    ["QR==", "nonzero trailing pad bits"],
    ["AA=", "missing padding character"],
    ["", "empty chunk string"],
    ["QQ", "unpadded"],
    ["AA--", "url-safe alphabet character"],
  ];
  for (const [chunk, label] of cases) {
    const metadata = baseMetadata({
      upstream: v2Upstream({
        attempts: [
          v2Attempt({
            chunks_base64: [chunk],
            terminal: "eof",
          }),
        ],
      }),
    });
    const { manifest, ciphertext } = await craftV2Capture(keyBytes, {
      metadata,
      body,
    });
    const artifact = makeArtifact(
      ciphertext,
      manifest,
      await sha256hex(ciphertext),
    );
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    assert.ok(!result.ok, `expected invalid_plaintext for: ${label}`);
    expectStaticFailure(
      result,
      "invalid_plaintext",
      "retained capture plaintext metadata is invalid",
      [chunk, "data: [DONE]"],
    );
  }
});

Deno.test("gateway decrypt: frozen upstream cross-field relationships are enforced", async () => {
  const keyBytes = goldenKey();
  const body = v2Body();
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "status null with content_type set",
      v2Upstream({
        attempts: [
          v2Attempt({ status: null, content_type: "application/json" }),
        ],
      }),
    ],
    [
      "headers present but content_type null",
      v2Upstream({
        attempts: [
          v2Attempt({ status: 200, content_type: null }),
        ],
      }),
    ],
    [
      "fetch_error with headers",
      v2Upstream({
        attempts: [
          v2Attempt({ status: 200, terminal: "fetch_error" }),
        ],
      }),
    ],
    [
      "eof without headers",
      v2Upstream({
        attempts: [
          v2Attempt({
            status: null,
            content_type: null,
            chunks_base64: [],
            terminal: "eof",
          }),
        ],
      }),
    ],
    [
      "read_error without headers",
      v2Upstream({
        attempts: [
          v2Attempt({
            status: null,
            content_type: null,
            chunks_base64: [],
            terminal: "read_error",
          }),
        ],
      }),
    ],
    [
      "cancelled without headers",
      v2Upstream({
        attempts: [
          v2Attempt({
            status: null,
            content_type: null,
            chunks_base64: [],
            terminal: "cancelled",
          }),
        ],
      }),
    ],
    [
      "before-header attempt with chunks",
      v2Upstream({
        attempts: [
          v2Attempt({
            status: null,
            content_type: null,
            chunks_base64: [standardBase64(new TextEncoder().encode("x"))],
          }),
        ],
      }),
    ],
    [
      "status below 100",
      v2Upstream({
        attempts: [v2Attempt({ status: 99 })],
      }),
    ],
    [
      "status above 599",
      v2Upstream({
        attempts: [v2Attempt({ status: 600 })],
      }),
    ],
    [
      "unknown provider",
      v2Upstream({
        attempts: [v2Attempt({ provider: "bogus_provider" })],
      }),
    ],
    [
      "unknown terminal",
      v2Upstream({
        attempts: [v2Attempt({ terminal: "bogus_terminal" })],
      }),
    ],
    [
      "unknown attempt key",
      v2Upstream({
        attempts: [{ ...v2Attempt(), bogus_key: true }],
      }),
    ],
    [
      "missing attempt key",
      v2Upstream({
        attempts: [(() => {
          const attempt = v2Attempt();
          delete attempt.content_type;
          return attempt;
        })()],
      }),
    ],
    ["unknown upstream key", v2Upstream({ bogus_key: true })],
    ["upstream version 2", v2Upstream({ version: 2 })],
    ["non-boolean truncation flag", v2Upstream({ bytes_truncated: "yes" })],
    ["attempts not an array", v2Upstream({ attempts: {} })],
    [
      "chunk not a string",
      v2Upstream({
        attempts: [v2Attempt({ chunks_base64: [42] })],
      }),
    ],
  ];
  for (const [label, upstream] of cases) {
    const metadata = baseMetadata({ upstream });
    const { manifest, ciphertext } = await craftV2Capture(keyBytes, {
      metadata,
      body,
    });
    const artifact = makeArtifact(
      ciphertext,
      manifest,
      await sha256hex(ciphertext),
    );
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    assert.ok(!result.ok, `expected invalid_plaintext for: ${label}`);
    expectStaticFailure(
      result,
      "invalid_plaintext",
      "retained capture plaintext metadata is invalid",
      [manifest.fingerprint, "data: [DONE]"],
    );
  }
});

Deno.test("gateway decrypt: aggregate upstream bounds are enforced (at-max accepted, over rejected)", async () => {
  const keyBytes = goldenKey();
  const body = v2Body();

  // At the attempt limit with the truncation flag: accepted.
  const maxAttempts = Array.from(
    { length: UPSTREAM_MAX_ATTEMPTS },
    () =>
      v2Attempt({
        provider: "surplus",
        status: null,
        content_type: null,
        chunks_base64: [],
        terminal: "fetch_error",
      }),
  );
  const atMaxAttempts = await craftV2Capture(keyBytes, {
    metadata: baseMetadata({
      upstream: v2Upstream({
        attempts: maxAttempts,
        attempts_truncated: true,
      }),
    }),
    body,
  });
  const atMaxAttemptsResult = await decryptRetainedGatewayCapture(
    makeArtifact(
      atMaxAttempts.ciphertext,
      atMaxAttempts.manifest,
      await sha256hex(atMaxAttempts.ciphertext),
    ),
    keyBytes,
  );
  assert.equal(
    atMaxAttemptsResult.ok,
    true,
    "8 attempts with truncation flag must be accepted",
  );

  // At the chunk limit with 1-byte chunks: accepted.
  const chunkLimit = Array.from(
    { length: UPSTREAM_MAX_CHUNKS },
    () => "AA==",
  );
  const atMaxChunks = await craftV2Capture(keyBytes, {
    metadata: baseMetadata({
      upstream: v2Upstream({
        attempts: [v2Attempt({ chunks_base64: chunkLimit })],
        chunks_truncated: true,
      }),
    }),
    body,
  });
  const atMaxChunksResult = await decryptRetainedGatewayCapture(
    makeArtifact(
      atMaxChunks.ciphertext,
      atMaxChunks.manifest,
      await sha256hex(atMaxChunks.ciphertext),
    ),
    keyBytes,
  );
  assert.equal(
    atMaxChunksResult.ok,
    true,
    "256 chunks must be accepted",
  );

  // Over the attempt limit: rejected.
  const overAttempts = await craftV2Capture(keyBytes, {
    metadata: baseMetadata({
      upstream: v2Upstream({
        attempts: [
          ...maxAttempts,
          v2Attempt({
            provider: "cerebras",
            status: null,
            content_type: null,
            chunks_base64: [],
            terminal: "fetch_error",
          }),
        ],
        attempts_truncated: true,
      }),
    }),
    body,
  });
  const overAttemptsResult = await decryptRetainedGatewayCapture(
    makeArtifact(
      overAttempts.ciphertext,
      overAttempts.manifest,
      await sha256hex(overAttempts.ciphertext),
    ),
    keyBytes,
  );
  expectStaticFailure(
    overAttemptsResult,
    "invalid_plaintext",
    "retained capture plaintext metadata is invalid",
    [overAttempts.manifest.fingerprint],
  );

  // Over the chunk limit: rejected.
  const overChunks = await craftV2Capture(keyBytes, {
    metadata: baseMetadata({
      upstream: v2Upstream({
        attempts: [v2Attempt({ chunks_base64: [...chunkLimit, "AA=="] })],
        chunks_truncated: true,
      }),
    }),
    body,
  });
  const overChunksResult = await decryptRetainedGatewayCapture(
    makeArtifact(
      overChunks.ciphertext,
      overChunks.manifest,
      await sha256hex(overChunks.ciphertext),
    ),
    keyBytes,
  );
  expectStaticFailure(
    overChunksResult,
    "invalid_plaintext",
    "retained capture plaintext metadata is invalid",
    [overChunks.manifest.fingerprint],
  );

  // Over the decoded-byte limit: the one near-128KiB trace, rejected.
  const bigBytes = new Uint8Array(UPSTREAM_MAX_DECODED_BYTES + 1).fill(0x41);
  const overBytes = await craftV2Capture(keyBytes, {
    metadata: baseMetadata({
      upstream: v2Upstream({
        attempts: [
          v2Attempt({
            chunks_base64: [standardBase64(bigBytes)],
          }),
        ],
        bytes_truncated: true,
      }),
    }),
    body,
  });
  const overBytesResult = await decryptRetainedGatewayCapture(
    makeArtifact(
      overBytes.ciphertext,
      overBytes.manifest,
      await sha256hex(overBytes.ciphertext),
    ),
    keyBytes,
  );
  expectStaticFailure(
    overBytesResult,
    "invalid_plaintext",
    "retained capture plaintext metadata is invalid",
    [overBytes.manifest.fingerprint],
  );
});
