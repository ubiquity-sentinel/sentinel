import {
  baseMetadata,
  CAPTURE_ID_V2,
  CAPTURED_AT_V2,
  COMMAND_ID,
  EXPECTED_FAILURE,
  hexToBytes,
  LIMITS,
  readGolden,
  SANITIZER_POLICY,
  standardBase64,
  TEST_IDS,
  TEXT_ENCODER,
  v2Attempt,
  v2Upstream,
} from "./replay-composition-fixtures.ts";
import {
  assertNoPrivateMarkers,
  goldenResponder,
  makeRig,
  readCrafted,
  removeRoot,
} from "./replay-composition-helpers.ts";
import assert from "node:assert/strict";
import { FakeClock, INCIDENT_A, sha256hex } from "./helpers.ts";
import { artifactRef } from "../../../src/adapters/gateway/incident-adapter.ts";
import type {
  CommandId,
  FixtureDigest,
} from "../../../src/contracts/brands.ts";
import { GatewayReplayComposition } from "../../../src/adapters/gateway/replay-composition.ts";

Deno.test("composition: no upstream trace keeps replay null and never invents a fixture", async () => {
  const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
  const fabricated = await readCrafted(
    baseMetadata({ upstream: v2Upstream({ attempts: [] }) }),
    keyBytes,
  );
  try {
    const read = await fabricated.read;
    assert.ok(read.ok, JSON.stringify(read));
    if (read.ok && read.value !== null) {
      assert.equal(read.value.replay, null);
      assert.equal(read.value.artifacts.length, 1);
      assertNoPrivateMarkers(read.value);
    }
  } finally {
    await fabricated.cleanup();
  }
});

Deno.test("composition: truncated traces keep replay null", async () => {
  const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
  const variants = [
    v2Upstream({ attempts: [v2Attempt()], attempts_truncated: true }),
    v2Upstream({ attempts: [v2Attempt()], bytes_truncated: true }),
    v2Upstream({ attempts: [v2Attempt()], chunks_truncated: true }),
  ];
  for (const [index, upstream] of variants.entries()) {
    const fabricated = await readCrafted(
      baseMetadata({ upstream }),
      keyBytes,
    );
    try {
      const read = await fabricated.read;
      assert.ok(read.ok, `variant ${index}: ${JSON.stringify(read)}`);
      if (read.ok && read.value !== null) {
        assert.equal(
          read.value.replay,
          null,
          `variant ${index} must stay null`,
        );
      }
    } finally {
      await fabricated.cleanup();
    }
  }
});

Deno.test("composition: non-eof terminals (cancelled/read_error/fetch_error/pending) keep replay null", async () => {
  const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
  const variants: Array<Record<string, unknown>> = [
    v2Attempt({
      provider: "cerebras",
      status: 200,
      content_type: "application/json",
      chunks_base64: [],
      terminal: "cancelled",
    }),
    v2Attempt({
      provider: "metered",
      status: 503,
      content_type: "other",
      chunks_base64: [standardBase64(TEXT_ENCODER.encode("partial"))],
      terminal: "read_error",
    }),
    v2Attempt({
      provider: "surplus",
      status: null,
      content_type: null,
      chunks_base64: [],
      terminal: "fetch_error",
    }),
    v2Attempt({
      provider: "cerebras",
      status: 200,
      content_type: "application/json",
      chunks_base64: [],
      terminal: "pending",
    }),
  ];
  for (const [index, attempt] of variants.entries()) {
    const fabricated = await readCrafted(
      baseMetadata({ upstream: v2Upstream({ attempts: [attempt] }) }),
      keyBytes,
    );
    try {
      const read = await fabricated.read;
      assert.ok(read.ok, `variant ${index}: ${JSON.stringify(read)}`);
      if (read.ok && read.value !== null) {
        assert.equal(
          read.value.replay,
          null,
          `variant ${index} must stay null`,
        );
      }
    } finally {
      await fabricated.cleanup();
    }
  }
});

// ---------------------------------------------------------------------------
// Negative: wrong fingerprint/revision/repository/missing-revision bindings
// ---------------------------------------------------------------------------

Deno.test("composition: wrong fingerprint/revision/repository bindings are rejected with static typed errors", async () => {
  const wrongFingerprint = await makeRig(
    await goldenResponder({ fingerprint: "a".repeat(64) }),
  );
  try {
    const read = await wrongFingerprint.composition.readIncident(INCIDENT_A);
    assert.ok(!read.ok && read.error.kind === "invalid");
    assert.equal(
      (read as { error: { detail: string } }).error.detail,
      "retained capture does not match the exact incident identity",
    );
    assertNoPrivateMarkers(read);
  } finally {
    await removeRoot(wrongFingerprint.root);
  }

  const wrongRevision = await makeRig(
    await goldenResponder({ failing_revision: "2".repeat(40) }),
  );
  try {
    const read = await wrongRevision.composition.readIncident(INCIDENT_A);
    assert.ok(!read.ok && read.error.kind === "invalid");
    assertNoPrivateMarkers(read);
  } finally {
    await removeRoot(wrongRevision.root);
  }

  const wrongRepository = await makeRig(await goldenResponder(), {
    repository: { owner: "other", name: "other-repo", installationId: 7 },
  });
  try {
    const read = await wrongRepository.composition.readIncident(INCIDENT_A);
    assert.ok(!read.ok && read.error.kind === "invalid");
    assert.equal(
      (read as { error: { detail: string } }).error.detail,
      "incident evidence does not belong to the configured repository",
    );
    assertNoPrivateMarkers(read);
  } finally {
    await removeRoot(wrongRepository.root);
  }
});

Deno.test("composition: missing failing revision leaves replay null", async () => {
  const { composition, root } = await makeRig(
    await goldenResponder({ failing_revision: null }),
  );
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    if (read.ok && read.value !== null) {
      assert.equal(read.value.replay, null);
    }
  } finally {
    await removeRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Negative: missing, expired and tampered artifacts; malformed refs; digests
// ---------------------------------------------------------------------------

Deno.test("composition: missing artifact and expired artifact fail closed", async () => {
  const { composition, root } = await makeRig(await goldenResponder());
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;
    // Remove the retained entry from disk: the store no longer holds it.
    for await (const entry of Deno.readDir(`${root}/entries`)) {
      await Deno.remove(`${root}/entries/${entry.name}`);
    }
    const missing = await composition.resolveFixture(replay.fixtureRef);
    assert.ok(!missing.ok && missing.error.kind === "not_found");
    assert.equal(
      (missing as { error: { detail: string } }).error.detail,
      "retained artifact is missing or expired",
    );
    assertNoPrivateMarkers(missing);
  } finally {
    await removeRoot(root);
  }

  // Expired: the accepted retention boundary passed, so the retained entry is
  // purged and the source capture is also expired: the evidence read is the
  // typed null (evidence_expired), never an invented fixture.
  const expired = await makeRig(await goldenResponder(), {
    clockStart: CAPTURED_AT_V2 + LIMITS.retentionMaxAgeMs + 1,
  });
  try {
    const read = await expired.composition.readIncident(INCIDENT_A);
    assert.ok(read.ok);
    if (read.ok) assert.equal(read.value, null);
  } finally {
    await removeRoot(expired.root);
  }
});

Deno.test("composition: tampered artifact bytes and wrong artifact identity fail closed with static invalid errors", async () => {
  const { composition, root } = await makeRig(await goldenResponder());
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;

    // Tampered ciphertext bytes at the exact retained ref.
    const entryKey = await sha256hex(
      TEXT_ENCODER.encode(artifactRef(INCIDENT_A, CAPTURE_ID_V2)),
    );
    const binPath = `${root}/entries/${entryKey}.bin`;
    const bin = await Deno.readFile(binPath);
    bin[0] = (bin[0]! + 1) & 0xff;
    await Deno.writeFile(binPath, bin);
    const tampered = await composition.resolveFixture(replay.fixtureRef);
    assert.ok(!tampered.ok && tampered.error.kind === "invalid");
    assert.equal(
      (tampered as { error: { detail: string } }).error.detail,
      "retained artifact identity cannot be verified",
    );
    assertNoPrivateMarkers(tampered);
    // Restore the original bytes before the identity tamper below.
    bin[0] = (bin[0]! - 1) & 0xff;
    await Deno.writeFile(binPath, bin);

    // Wrong artifact identity: metadata names a different capture id.
    const metaPath = `${root}/entries/${entryKey}.json`;
    const metadata = JSON.parse(
      await Deno.readTextFile(metaPath),
    ) as Record<string, unknown>;
    metadata.captureId = "different-capture-identity";
    await Deno.writeTextFile(metaPath, JSON.stringify(metadata));
    const wrongIdentity = await composition.resolveFixture(replay.fixtureRef);
    assert.ok(!wrongIdentity.ok && wrongIdentity.error.kind === "invalid");
    assertNoPrivateMarkers(wrongIdentity);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("composition: malformed fixture refs and bundle-digest mismatches are rejected with static errors", async () => {
  const { composition, root } = await makeRig(await goldenResponder());
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;

    for (
      const malformed of [
        "",
        "artifact://sentinel/provider-00000000-0000-4000-8000-000000000001/synthetic-capture-2",
        "fixture://gateway-replay/not-an-incident/synthetic-capture-2/" +
        "a".repeat(64),
        "fixture://gateway-replay/provider-00000000-0000-4000-8000-000000000001/synthetic-capture-2/" +
        "a".repeat(63),
        "fixture://gateway-replay/provider-00000000-0000-4000-8000-000000000001/../../etc/" +
        "a".repeat(64),
      ]
    ) {
      const result = await composition.resolveFixture(malformed);
      assert.ok(!result.ok && result.error.kind === "invalid", malformed);
      assert.equal(
        (result as { error: { detail: string } }).error.detail,
        "fixture reference is not a supported gateway replay reference",
      );
    }

    // Bundle-digest mismatch: one hex digit of the embedded digest changed.
    const corruptedDigest = `${replay.fixtureRef.slice(0, -1)}${
      replay.fixtureRef.endsWith("0") ? "1" : "0"
    }`;
    const mismatch = await composition.resolveFixture(corruptedDigest);
    assert.ok(!mismatch.ok && mismatch.error.kind === "invalid");
    assert.equal(
      (mismatch as { error: { detail: string } }).error.detail,
      "fixture bundle digest does not match the reference identity",
    );
    assertNoPrivateMarkers(mismatch);

    // resolveTestIds also rejects a supplied digest that does not match.
    const wrongDigest = replay.fixtureDigest!.startsWith("0")
      ? `1${replay.fixtureDigest!.slice(1)}`
      : `0${replay.fixtureDigest!.slice(1)}`;
    const idsMismatch = await composition.resolveTestIds(
      replay.fixtureRef,
      wrongDigest as FixtureDigest,
    );
    assert.ok(!idsMismatch.ok && idsMismatch.error.kind === "invalid");
    assert.equal(
      (idsMismatch as { error: { detail: string } }).error.detail,
      "fixture bundle digest does not match the reference identity",
    );

    const idsBadDigest = await composition.resolveTestIds(
      replay.fixtureRef,
      "zz" as unknown as FixtureDigest,
    );
    assert.ok(!idsBadDigest.ok && idsBadDigest.error.kind === "invalid");
  } finally {
    await removeRoot(root);
  }
});

// ---------------------------------------------------------------------------
// Wiring sanity: malformed caller-supplied capabilities are refused at
// construction (fail fast, before any artifact is touched).
// ---------------------------------------------------------------------------

Deno.test("composition: refuses caller-supplied capabilities that violate the trusted shape", () => {
  assert.throws(
    () =>
      new GatewayReplayComposition({
        adapter: {} as never,
        store: {} as never,
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
        keyBytes: new Uint8Array(16),
        policy: SANITIZER_POLICY,
        commandId: COMMAND_ID,
        testIds: TEST_IDS,
        expectedFailure: EXPECTED_FAILURE,
        clock: new FakeClock(0),
      }),
    /32-byte key/,
  );
  assert.throws(
    () =>
      new GatewayReplayComposition({
        adapter: {} as never,
        store: {} as never,
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
        keyBytes: new Uint8Array(32),
        policy: SANITIZER_POLICY,
        commandId: "not allowed" as CommandId,
        testIds: TEST_IDS,
        expectedFailure: EXPECTED_FAILURE,
        clock: new FakeClock(0),
      }),
    /replay command id/,
  );
  assert.throws(
    () =>
      new GatewayReplayComposition({
        adapter: {} as never,
        store: {} as never,
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
        keyBytes: new Uint8Array(32),
        policy: SANITIZER_POLICY,
        commandId: COMMAND_ID,
        testIds: [],
        expectedFailure: EXPECTED_FAILURE,
        clock: new FakeClock(0),
      }),
    /test identity/,
  );
});
