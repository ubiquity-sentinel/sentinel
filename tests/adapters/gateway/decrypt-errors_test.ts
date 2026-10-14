import {
  goldenCiphertext,
  goldenKey,
  goldenManifest,
  makeArtifact,
  readGolden,
  retainThroughStore,
} from "./decrypt-fixtures.ts";
import { decryptRetainedGatewayCapture } from "../../../src/adapters/gateway/decrypt.ts";
import {
  assertBuffersUnchanged,
  expectStaticFailure,
  manifestWith,
} from "./decrypt-test-helpers.ts";
import { sha256hex } from "./helpers.ts";
import {
  decodeBase64Url,
  replayManifestToWire,
} from "../../../src/adapters/gateway/wire.ts";
import { craftEnvelope } from "./decrypt-crypto-helpers.ts";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Early integrity/authentication negatives (unchanged golden pre-metadata)
// ---------------------------------------------------------------------------

Deno.test("gateway decrypt: wrong key fails closed without plaintext leakage", async () => {
  const manifest = goldenManifest();
  const { artifact, cleanup } = await retainThroughStore(
    goldenCiphertext(),
    manifest,
    manifest.capturedAt,
  );
  try {
    const wrongKey: Uint8Array<ArrayBuffer> = new Uint8Array(32).map(
      (_value, index) => index + 32,
    );
    const beforeKey = new Uint8Array(wrongKey);
    const beforeCiphertext = new Uint8Array(artifact.ciphertext);
    const result = await decryptRetainedGatewayCapture(artifact, wrongKey);
    expectStaticFailure(
      result,
      "authentication_failed",
      "retained capture failed authenticated decryption",
    );
    assertBuffersUnchanged(
      beforeKey,
      beforeCiphertext,
      wrongKey,
      artifact.ciphertext,
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: non-32-byte key is rejected before crypto", async () => {
  const manifest = goldenManifest();
  const { artifact, cleanup } = await retainThroughStore(
    goldenCiphertext(),
    manifest,
    manifest.capturedAt,
  );
  try {
    const shortKey = new Uint8Array(31);
    const result = await decryptRetainedGatewayCapture(artifact, shortKey);
    expectStaticFailure(
      result,
      "invalid_key",
      "retained capture key must be 32 bytes",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: ciphertext tampering fails the retained digest check", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const goldenDigest = await sha256hex(ciphertext);
  const tampered = new Uint8Array(ciphertext);
  tampered[tampered.byteLength - 1] ^= 0x01;
  // Direct construction: the store can never retain mismatched bytes/digest.
  const artifact = makeArtifact(tampered, manifest, goldenDigest);
  const before = new Uint8Array(artifact.ciphertext);
  const keyBytes = goldenKey();
  const beforeKey = new Uint8Array(keyBytes);
  const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
  expectStaticFailure(
    result,
    "tampered_ciphertext",
    "retained capture ciphertext does not match its digest",
  );
  assertBuffersUnchanged(beforeKey, before, keyBytes, artifact.ciphertext);
});

Deno.test("gateway decrypt: ciphertext tampering with re-digested bytes fails authentication", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const tampered = new Uint8Array(ciphertext);
  tampered[10] ^= 0x80;
  const { artifact, cleanup } = await retainThroughStore(
    tampered,
    manifest,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(
      artifact,
      goldenKey(),
    );
    expectStaticFailure(
      result,
      "authentication_failed",
      "retained capture failed authenticated decryption",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: AAD tampering (changed manifest fingerprint) fails authentication", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const withOverrides = manifestWith(
    {
      fingerprint: "e".repeat(64),
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    decodeBase64Url(manifest.iv)!,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    withOverrides,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, goldenKey());
    expectStaticFailure(
      result,
      "authentication_failed",
      "retained capture failed authenticated decryption",
    );
  } finally {
    await cleanup();
  }
});

// ---------------------------------------------------------------------------
// Envelope and size-bounds negatives
// ---------------------------------------------------------------------------

Deno.test("gateway decrypt: envelope length prefix beyond the buffer fails as invalid_envelope", async () => {
  const keyBytes = goldenKey();
  const manifest = goldenManifest();
  const size = new Uint8Array(4);
  new DataView(size.buffer).setUint32(0, 1_000, false);
  const junk = new Uint8Array(8).fill(0x41);
  const plaintext = new Uint8Array(12);
  plaintext.set(size, 0);
  plaintext.set(junk, 4);
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    manifest.fingerprint,
    keyBytes,
  );
  const crafted = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    iv,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    crafted,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "invalid_envelope",
      "retained capture envelope is malformed",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: oversized gzip expansion fails bounded", async () => {
  const keyBytes = goldenKey();
  const manifest = goldenManifest();
  const oversized = new Uint8Array(34 * 1_024 * 1_024);
  const { ciphertext, iv } = await craftEnvelope(
    oversized,
    manifest.fingerprint,
    keyBytes,
  );
  const crafted = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    iv,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    crafted,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "oversized_plaintext",
      "retained capture plaintext exceeds its size bound",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: invalid metadata JSON fails closed", async () => {
  const keyBytes = goldenKey();
  const manifest = goldenManifest();
  const plaintext = new TextEncoder().encode(
    "\u0000\u0000\u0000\u000anot-json!!",
  );
  const { ciphertext, iv } = await craftEnvelope(
    plaintext,
    manifest.fingerprint,
    keyBytes,
  );
  const crafted = manifestWith(
    {
      fingerprint: manifest.fingerprint,
      capture_id: manifest.captureId,
      case_group_digest: manifest.caseGroupDigest,
      captured_at_ms: manifest.capturedAt,
      expires_at_ms: manifest.expiresAt,
      ciphertext_bytes: ciphertext.byteLength,
    },
    ciphertext.byteLength,
    iv,
  );
  const { artifact, cleanup } = await retainThroughStore(
    ciphertext,
    crafted,
    manifest.capturedAt,
  );
  try {
    const result = await decryptRetainedGatewayCapture(artifact, keyBytes);
    expectStaticFailure(
      result,
      "invalid_plaintext",
      "retained capture plaintext metadata is invalid",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("gateway decrypt: retained identity mismatch fails as tampered_metadata", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const goldenDigest = await sha256hex(ciphertext);
  const artifact = makeArtifact(ciphertext, manifest, goldenDigest);
  // The retained metadata must name the exact object it claims to retain.
  artifact.captureId = "other-capture-id";
  const result = await decryptRetainedGatewayCapture(artifact, goldenKey());
  expectStaticFailure(
    result,
    "tampered_metadata",
    "retained capture metadata does not match its manifest",
  );
});

Deno.test("gateway decrypt: non-conforming manifest fails as invalid_manifest", async () => {
  const manifest = goldenManifest();
  const ciphertext = goldenCiphertext();
  const goldenDigest = await sha256hex(ciphertext);
  const artifact = makeArtifact(ciphertext, {
    ...manifest,
    iv: "AA",
  }, goldenDigest);
  const result = await decryptRetainedGatewayCapture(artifact, goldenKey());
  expectStaticFailure(
    result,
    "invalid_manifest",
    "retained capture manifest is not the supported producer shape",
  );
});

Deno.test("gateway decrypt: manifest re-validation preserves exact wire identity", () => {
  // The boundary must hold the frozen wire contract, not a looser local type.
  const manifest = goldenManifest();
  const wire = replayManifestToWire(manifest);
  assert.deepEqual(wire, readGolden().exported.manifest);
});
