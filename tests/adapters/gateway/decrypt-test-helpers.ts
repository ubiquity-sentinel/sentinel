import { CAPTURED_AT_V2, readGolden } from "./decrypt-fixtures.ts";
import { standardBase64 } from "./decrypt-crypto-helpers.ts";
import type { GatewayReplayManifestV1 } from "../../../src/adapters/gateway/wire.ts";
import { parseGatewayReplayManifestV1 } from "../../../src/adapters/gateway/wire.ts";
import { b64Url } from "./helpers.ts";
import type {
  RetainedCaptureErrorV1,
  RetainedCaptureResultV1,
} from "../../../src/adapters/gateway/decrypt.ts";
import assert from "node:assert/strict";

/** One frozen upstream attempt; `status`/`content_type` are null together. */
export function v2Attempt(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider: "surplus",
    status: 200,
    content_type: "text/event-stream",
    chunks_base64: [] as string[],
    terminal: "eof",
    ...overrides,
  };
}

export function v2Upstream(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 1,
    attempts: [] as Record<string, unknown>[],
    attempts_truncated: false,
    bytes_truncated: false,
    chunks_truncated: false,
    ...overrides,
  };
}

export function v2Body(): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    '{"model":"synthetic-model","input":"v2 independently crafted fixture","stream":true}',
  );
}

export function baseMetadata(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 2,
    captured_at_ms: CAPTURED_AT_V2,
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
    git_sha: "1".repeat(40),
    deno_revision: "synthetic-revision-2",
    upstream: v2Upstream({
      attempts: [
        v2Attempt({
          provider: "surplus",
          status: 200,
          content_type: "text/event-stream",
          chunks_base64: [
            standardBase64(new TextEncoder().encode(
              'event: message\ndata: {"ok":true}\n\n',
            )),
            standardBase64(new TextEncoder().encode("data: [DONE]\n\n")),
          ],
          terminal: "eof",
        }),
        v2Attempt({
          provider: "chatgpt_codex",
          status: null,
          content_type: null,
          chunks_base64: [],
          terminal: "fetch_error",
        }),
      ],
    }),
    ...overrides,
  };
}

export function manifestWith(
  overrides: Record<string, unknown>,
  ciphertextBytes: number,
  iv: Uint8Array,
): GatewayReplayManifestV1 {
  const golden = readGolden().exported.manifest as Record<string, unknown>;
  return parseGatewayReplayManifestV1({
    ...golden,
    iv: b64Url(iv),
    ciphertext_bytes: ciphertextBytes,
    ...overrides,
  });
}

/** Re-parse a manifest with frozen overrides (for on-wire tamper cases). */
export function manifestVariant(
  manifest: GatewayReplayManifestV1,
  overrides: Record<string, unknown>,
): GatewayReplayManifestV1 {
  return parseGatewayReplayManifestV1({
    version: 1,
    capture_id: manifest.captureId,
    fingerprint: manifest.fingerprint,
    case_group_digest: manifest.caseGroupDigest,
    captured_at_ms: manifest.capturedAt,
    expires_at_ms: manifest.expiresAt,
    algorithm: manifest.algorithm,
    compression: manifest.compression,
    iv: manifest.iv,
    chunk_count: manifest.chunkCount,
    ciphertext_bytes: manifest.ciphertextBytes,
    ...overrides,
  });
}

export function expectStaticFailure(
  result: RetainedCaptureResultV1,
  kind: RetainedCaptureErrorV1["kind"],
  detail: string,
  neverContains: readonly string[] = [],
): void {
  assert.equal(result.ok, false, `expected ${kind} failure`);
  assert.deepEqual(
    result.ok ? null : result.error,
    { kind, detail },
    "failure must be the exact static sanitized error",
  );
  if (!result.ok) {
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("synthetic-model"), "body leaked");
    assert.ok(!serialized.includes("/v1/responses"), "endpoint leaked");
    assert.ok(
      !serialized.includes(
        readGolden().exported.manifest.fingerprint as string,
      ),
      "fingerprint leaked",
    );
    for (const marker of neverContains) {
      if (marker.length === 0) continue;
      assert.ok(
        !serialized.includes(marker),
        `private marker leaked: ${marker}`,
      );
    }
  }
}

export function assertBuffersUnchanged(
  beforeKey: Uint8Array,
  beforeCiphertext: Uint8Array,
  keyBytes: Uint8Array,
  ciphertext: Uint8Array<ArrayBuffer>,
): void {
  assert.deepEqual(keyBytes, beforeKey, "key bytes were mutated");
  assert.deepEqual(
    ciphertext,
    beforeCiphertext,
    "ciphertext bytes were mutated",
  );
}
