import assert from "node:assert/strict";
import { GatewayIncidentAdapter } from "../../../src/adapters/gateway/incident-adapter.ts";
import { GatewayReplayComposition } from "../../../src/adapters/gateway/replay-composition.ts";
import { LocalArtifactStore } from "../../../src/adapters/gateway/store.ts";
import { decryptRetainedGatewayCapture } from "../../../src/adapters/gateway/decrypt.ts";
import { plainUpstream } from "../../../src/replay/causal-verifier-protocol.ts";
import { craftV2Capture, hexToBytes } from "./decrypt-crypto-helpers.ts";
import { sha256hex, validConfig } from "./helpers.ts";

const GOLDEN = new URL(
  "../../fixtures/gateway/producer-golden-v3.json",
  import.meta.url,
);
const PRODUCER_SHA = "a858a6ed6cc72a8ff9ed0f1cbc310803120d5726";
const POLICY = { publicModels: ["synthetic-model"], publicHeaders: {} };

function golden() {
  return JSON.parse(Deno.readTextFileSync(GOLDEN));
}

async function rig(
  transform: (row: ReturnType<typeof golden>["index"]) => void = () => {},
) {
  const fixture = golden();
  const row = fixture.index;
  transform(row);
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-current-format-",
  });
  const limits = {
    totalMaxBytes: 16 * 1024 * 1024,
    artifactMaxBytes: 8 * 1024 * 1024,
    retentionMaxAgeMs: 7 * 24 * 60 * 60 * 1000,
  };
  const store = new LocalArtifactStore({ root, limits });
  assert.ok((await store.open()).ok);
  const clock = { now: () => fixture.exported.manifest.captured_at_ms };
  const config = validConfig();
  const adapter = new GatewayIncidentAdapter({
    config,
    store,
    clock,
    auth: {
      headers: () =>
        Promise.resolve({
          ok: true,
          value: { authorization: "Bearer public-synthetic-token" },
        }),
    },
    transport: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      assert.equal(init?.method, "GET");
      assert.equal(url.searchParams.get("limit"), "1");
      assert.equal(url.searchParams.get("incident_id"), row.incident_id);
      return Promise.resolve(
        new Response(JSON.stringify(
          url.pathname === "/admin/sentinel/incidents"
            ? { data: [row], cursor: null, coverage: { status: "complete" } }
            : { data: [fixture.exported], cursor: null },
        )),
      );
    },
  });
  const key = hexToBytes(fixture.syntheticKeyHex);
  const composition = new GatewayReplayComposition({
    adapter,
    store,
    clock,
    repository: config.repository,
    keyBytes: key,
    policy: POLICY,
    commandId: config.commands.replay,
    testIds: ["current-producer"],
    expectedFailure: {
      reason: "synthetic server failure",
      match: { kind: "contains", text: "server_error" },
    },
  });
  return {
    fixture,
    row,
    root,
    limits,
    store,
    clock,
    adapter,
    composition,
    key,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("current producer golden authenticates exact rich request, downstream and timed upstream facts", async () => {
  const test = await rig();
  try {
    assert.equal(test.fixture.sourceSha, PRODUCER_SHA);
    assert.equal(test.fixture.expected.version, 3);
    const read = await test.adapter.readIncident(test.row.incident_id);
    assert.ok(read.ok && read.value !== null);
    const stored = await test.store.get(
      test.row.evidence_ref.ref,
      test.clock.now(),
    );
    assert.ok(stored.ok && stored.value !== null);
    const decoded = await decryptRetainedGatewayCapture(stored.value, test.key);
    assert.ok(decoded.ok);
    assert.notEqual(decoded.value.fingerprint, test.row.fingerprint);
    assert.equal(decoded.value.classificationDigest, test.row.fingerprint);
    assert.equal(decoded.value.gitSha, test.row.failing_revision);
    assert.equal(decoded.value.requestId, test.fixture.expected.request_id);
    assert.equal(
      new TextDecoder().decode(decoded.value.body),
      test.fixture.expected.body,
    );
    assert.deepEqual(decoded.value.upstream, test.fixture.expected.upstream);
    for (
      const field of [
        "settings",
        "capture_status",
        "replay_coverage",
        "unavailable",
        "body_sha256",
        "body_bytes",
        "downstream",
      ] as const
    ) {
      assert.deepEqual(
        decoded.value.metadata[field],
        test.fixture.expected[field],
      );
    }
    assert.deepEqual(
      plainUpstream(decoded.value.upstream),
      test.fixture.expected.upstream,
    );
    assert.equal(
      decoded.value.clientObservation.terminalBodyBase64,
      test.fixture.expected.client_observation.terminal_body_base64,
    );
    const binding = await test.adapter.readGatewayCaptureBinding(
      test.row.incident_id,
    );
    assert.ok(binding.ok && binding.value !== null);
    assert.equal(binding.value.ciphertextDigest, test.row.evidence_ref.digest);
    assert.equal(binding.value.artifactRef, test.row.evidence_ref.ref);
    const composed = await test.composition.readIncident(test.row.incident_id);
    assert.ok(composed.ok && composed.value?.replay);
    const resolved = await test.composition.resolveFixture(
      composed.value.replay.fixtureRef,
    );
    assert.ok(resolved.ok);
    const text = resolved.value.entries.map((entry) =>
      new TextDecoder().decode(entry.bytes)
    ).join("\n");
    assert.ok(
      !text.includes("private-request-text") &&
        !text.includes("private-response-id") &&
        !text.includes("synthetic-request"),
    );
    const upstreamEntry = resolved.value.entries.find((entry) =>
      entry.path.endsWith("upstream.json")
    );
    assert.ok(upstreamEntry);
    const safeTrace = JSON.parse(new TextDecoder().decode(upstreamEntry.bytes));
    assert.equal(safeTrace.version, 2);
    assert.equal(safeTrace.attempts[0].headers["retry-after"], "1");
    assert.equal(safeTrace.attempts[0].started_at_ms, 1);
    assert.deepEqual(
      safeTrace.attempts[0].chunk_times_ms,
      test.fixture.expected.upstream.attempts[0].chunk_times_ms,
    );
  } finally {
    await test.cleanup();
  }
});

Deno.test("current source binding rejects foreign classification, original revision, capture time and expiry", async (ctx) => {
  for (
    const [name, mutate] of [
      [
        "classification",
        (row: ReturnType<typeof golden>["index"]) =>
          row.fingerprint = "f".repeat(64),
      ],
      [
        "revision",
        (row: ReturnType<typeof golden>["index"]) =>
          row.failing_revision = "1".repeat(40),
      ],
      [
        "capture time",
        (row: ReturnType<typeof golden>["index"]) =>
          row.provenance.captured_at_ms += 1,
      ],
      [
        "expiry",
        (row: ReturnType<typeof golden>["index"]) =>
          row.evidence_expires_at_ms += 1,
      ],
    ] as const
  ) {
    await ctx.step(name, async () => {
      const test = await rig(mutate);
      try {
        const result = await test.composition.readIncident(
          test.row.incident_id,
        );
        assert.ok(!result.ok);
        assert.equal(result.error.kind, "invalid");
      } finally {
        await test.cleanup();
      }
    });
  }
});

Deno.test("current exact ref and ciphertext digest cannot select an unrelated capture", async () => {
  const test = await rig((row) =>
    row.evidence_ref.ref = row.evidence_ref.ref.replace(
      "current-synthetic-capture",
      "foreign-capture",
    )
  );
  try {
    const result = await test.composition.readIncident(test.row.incident_id);
    assert.ok(result.ok && result.value?.replay === null);
  } finally {
    await test.cleanup();
  }
});

Deno.test("authenticated current metadata refuses stale HMAC, wrong request digest, unsupported providers and open fields", async (ctx) => {
  const test = await rig();
  try {
    const read = await test.adapter.readIncident(test.row.incident_id);
    assert.ok(read.ok && read.value !== null);
    const stored = await test.store.get(
      test.row.evidence_ref.ref,
      test.clock.now(),
    );
    assert.ok(stored.ok && stored.value !== null);
    const { body, ...metadata } = test.fixture.expected;
    const cases = [
      [
        "timed trace HMAC",
        (value: typeof metadata) =>
          value.upstream.attempts[0].headers["retry-after"] = "2",
        "tampered_manifest",
      ],
      [
        "request digest",
        (value: typeof metadata) => value.body_sha256 = "0".repeat(64),
        "tampered_metadata",
      ],
      [
        "request settings",
        (value: typeof metadata) =>
          value.settings.model_requested = "foreign-model",
        "tampered_metadata",
      ],
      [
        "downstream identity",
        (value: typeof metadata) =>
          value.downstream.error_code = "foreign_error",
        "invalid_plaintext",
      ],
      [
        "unsupported provider",
        (value: typeof metadata) =>
          value.upstream.attempts[0].provider = "claude_code",
        "invalid_plaintext",
      ],
      [
        "unknown metadata key",
        (value: typeof metadata) => value.foreign = true,
        "invalid_plaintext",
      ],
      [
        "unknown trace key",
        (value: typeof metadata) => value.upstream.attempts[0].foreign = true,
        "invalid_plaintext",
      ],
      [
        "foreign response header",
        (value: typeof metadata) =>
          value.upstream.attempts[0].headers.authorization =
            "public-synthetic-token",
        "invalid_plaintext",
      ],
      [
        "untruthful coverage",
        (value: typeof metadata) => value.replay_coverage = "partial",
        "tampered_metadata",
      ],
    ] as const;
    for (const [name, mutate, kind] of cases) {
      await ctx.step(name, async () => {
        const value = structuredClone(metadata);
        mutate(value);
        const crafted = await craftV2Capture(test.key, {
          metadata: value,
          body: new TextEncoder().encode(body),
          fingerprint: stored.value!.fingerprint,
          capturedAtMs: stored.value!.sourceCapturedAt,
        });
        const original = stored.value!;
        const artifact = {
          ...original,
          ciphertext: crafted.ciphertext,
          manifest: crafted.manifest,
          captureId: crafted.manifest.captureId,
          digest: await sha256hex(crafted.ciphertext) as typeof original.digest,
          sizeBytes: crafted.ciphertext.byteLength,
        };
        const result = await decryptRetainedGatewayCapture(artifact, test.key);
        assert.ok(!result.ok);
        assert.equal(result.error.kind, kind);
        assert.ok(!JSON.stringify(result).includes("private-request-text"));
      });
    }
  } finally {
    await test.cleanup();
  }
});
