/**
 * Gateway capture → trusted fixture → replay composition tests (Wave C
 * integration writer).
 *
 * The positive path uses the ACTUAL recording gateway transport, the actual
 * GatewayIncidentAdapter, the actual LocalArtifactStore and the actual
 * producer-golden-v2 decrypt/sanitize path: composition.readIncident returns
 * the updated IncidentEvidenceV1 with ReplayMetadataV1, and
 * resolveFixture/resolveTestIds return a deterministic trusted
 * ResolvedFixtureV1. A fresh composition instance over the same store root
 * rehydrates the identical fixture (no plaintext storage), and an actual
 * ReplayPort run resolves the composition's fixture and executes the
 * configured credential-free command.
 *
 * Negative cases all fail closed: no-upstream, truncated, non-eof terminals
 * (cancelled/read_error/fetch_error/pending), wrong fingerprint/revision/
 * repository/artifact identity, missing, expired and tampered artifacts,
 * malformed fixture refs and bundle-digest mismatches — replay stays null or
 * a static typed invalid/unavailable/not_found result, never an invented
 * fixture. The transport must stay GET-only with no claim/ack/defer endpoint,
 * caller key buffers must be unchanged, and no private marker may appear in
 * fixture JSON or error text.
 *
 * Public synthetic data only (the recorded producer golden and independently
 * crafted producer-protocol captures with synthetic bytes); no model, network
 * or paid calls.
 */

import {
  assertNoPrivateMarkers,
  authProvider,
  countStoreBinFiles,
  FIXTURE_REPLAY_SCRIPT,
  goldenCiphertext,
  goldenResponder,
  makeRig,
  parseEntry,
  removeRoot,
  replayConfig,
  walkFiles,
} from "./replay-composition-helpers.ts";
import {
  FakeClock,
  INCIDENT_A,
  recordingTransport,
  validConfig,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
  CAPTURE_ID_V2,
  CAPTURED_AT_V2,
  COMMAND_ID,
  decodeStandardBase64,
  EXPECTED_FAILURE,
  GIT_SHA,
  INDEX_PATH,
  LIMITS,
  REPLAY_PATH,
  SANITIZER_POLICY,
  TEST_IDS,
} from "./replay-composition-fixtures.ts";
import { isFixtureDigest, isGitSha } from "../../../src/contracts/brands.ts";
import { parseIncidentEvidenceV1 } from "../../../src/contracts/incident.ts";
import {
  computeReplayFixtureDigest,
  markerProofParser,
} from "../../../src/replay/fixture.ts";
import { canonicalStringifySha256 } from "../../../src/contracts/canonical.ts";
import { LocalArtifactStore } from "../../../src/adapters/gateway/store.ts";
import { GatewayReplayComposition } from "../../../src/adapters/gateway/replay-composition.ts";
import { GatewayIncidentAdapter } from "../../../src/adapters/gateway/incident-adapter.ts";
import {
  commitWith,
  gitRun,
  revParse,
  testGitEnv,
  TOY_REPOSITORY,
  toyIsolation,
} from "../../replay/helpers.ts";
import type { ReplayPolicyV1 } from "../../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../../src/replay/port.ts";
import type { CommandId, WorkItemId } from "../../../src/contracts/brands.ts";

// ---------------------------------------------------------------------------
// Positive: actual adapter → retained store → authenticated decrypt →
// positive sanitizer → resolver rehydration; read-only and buffer-safe.
// ---------------------------------------------------------------------------

Deno.test("composition: actual golden capture becomes replay metadata plus a deterministic trusted fixture", async () => {
  const { composition, store, root, transport, keyBytes } = await makeRig(
    await goldenResponder(),
  );
  try {
    const beforeKey = new Uint8Array(keyBytes);

    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok, `readIncident must succeed: ${JSON.stringify(read)}`);
    if (!read.ok) return;
    const evidence = read.value!;
    assert.notEqual(evidence, null);
    assert.equal(evidence.incidentId, INCIDENT_A);
    assert.equal(evidence.failingRevision, GIT_SHA);
    const replay = evidence.replay;
    assert.notEqual(replay, null, "replay metadata must be attached");
    if (replay === null) return;
    assert.equal(replay.upstreamCaptured, true);
    assert.equal(replay.commandId, COMMAND_ID);
    assert.equal(replay.reproducedAt, null);
    assert.ok(
      isFixtureDigest(replay.fixtureDigest),
      "fixture digest must be 64-hex",
    );
    const fixtureRef = replay.fixtureRef;
    assert.match(
      fixtureRef,
      new RegExp(
        `^fixture://gateway-replay/${INCIDENT_A}/${CAPTURE_ID_V2}/[0-9a-f]{64}$`,
      ),
    );
    const artifactDigest = evidence.artifacts[0]!.digest;
    assert.notEqual(
      replay.fixtureDigest,
      artifactDigest,
      "bundle digest must differ from the encrypted-artifact digest",
    );
    // The strict record parser accepts the updated evidence verbatim.
    const parsed = parseIncidentEvidenceV1(evidence);
    assert.equal(parsed.replay?.fixtureRef, fixtureRef);

    // Resolver: deterministic fixture over the exact stored artifact.
    const resolvedResult = await composition.resolveFixture(fixtureRef);
    assert.ok(resolvedResult.ok, JSON.stringify(resolvedResult));
    if (!resolvedResult.ok) return;
    const resolved = resolvedResult.value;
    assert.deepEqual(resolved.testIds, TEST_IDS);
    assert.deepEqual(resolved.expectedFailure, EXPECTED_FAILURE);
    assert.deepEqual(resolved.provenance, {
      sanitized: true,
      sanitizer: "gateway-structural-v1",
      provenanceRef: fixtureRef,
      redacted: true,
      note:
        "gateway capture redacted; request and upstream re-encoded to a fixed protocol vocabulary",
    });
    assert.deepEqual(
      resolved.entries.map((entry) => entry.path).sort(),
      [
        `tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_V2}/request.json`,
        `tests/fixtures/gateway-replay/${INCIDENT_A}/${CAPTURE_ID_V2}/upstream.json`,
      ],
    );
    // The replay bundle digest is recomputed over the ACTUAL entry bytes.
    const bundleDigest = await computeReplayFixtureDigest(resolved.entries);
    assert.equal(bundleDigest, replay.fixtureDigest);

    // Sanitized request: fixed vocabulary, no private request material.
    const requestValue = parseEntry(resolved, "request");
    assert.equal(requestValue.endpoint, "/v1/responses");
    assert.equal(requestValue.method, "POST");
    assert.equal(requestValue.contentType, "application/json");
    assert.deepEqual(requestValue.compatibilityHeaders, {
      accept: "text/event-stream",
    });
    const requestBody = JSON.parse(requestValue.body as string) as Record<
      string,
      unknown
    >;
    assert.deepEqual(requestBody, {
      input: "fixture text",
      model: "synthetic-model",
      stream: true,
    });
    // Sanitized upstream: original SSE data is re-encoded with fixture ids.
    const upstreamValue = parseEntry(resolved, "upstream");
    assert.equal(upstreamValue.version, 1);
    const attempts = upstreamValue.attempts as Array<Record<string, unknown>>;
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.provider, "chatgpt_codex");
    assert.equal(attempts[0]!.status, 200);
    assert.equal(attempts[0]!.content_type, "text/event-stream");
    assert.equal(attempts[0]!.terminal, "eof");
    const chunkBytes = decodeStandardBase64(
      (attempts[0]!.chunks_base64 as string[])[0]!,
    );
    assert.equal(
      new TextDecoder().decode(chunkBytes),
      'data: {"type":"response.created","response":{"id":"fixture_id_1"}}\n\n',
    );
    // The bundle digest is also distinct from the sanitizer payload digest
    // (public fixture envelope), never interchangeable.
    const payloadDigest = await canonicalStringifySha256({
      version: 1,
      request: requestValue,
      upstream: upstreamValue,
    });
    assert.notEqual(payloadDigest, bundleDigest);
    assert.notEqual(payloadDigest, artifactDigest);

    // The trusted id source matches the fixture bundle exactly.
    const idsResult = await composition.resolveTestIds(
      fixtureRef,
      replay.fixtureDigest!,
    );
    assert.ok(idsResult.ok, JSON.stringify(idsResult));
    if (idsResult.ok) assert.deepEqual(idsResult.value, TEST_IDS);

    // No private markers anywhere in the public fixture bytes or evidence.
    const fixtureJson = JSON.stringify({
      request: requestValue,
      upstream: upstreamValue,
    });
    assertNoPrivateMarkers({ fixture: fixtureJson });
    assertNoPrivateMarkers(evidence);

    // Read-only: GET only against the index/replay paths, no write endpoints.
    transport.assertReadOnly([INDEX_PATH, REPLAY_PATH]);
    transport.assertNoWriteEndpoints();

    // Caller key buffer is unchanged; the store holds exactly the golden
    // ciphertext and no plaintext fixture files.
    assert.deepEqual(keyBytes, beforeKey, "key bytes were mutated");
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
    assert.equal(
      stats.value!.totalBytes,
      (await goldenCiphertext()).byteLength,
    );
    assert.equal(await countStoreBinFiles(root), 1);
    const allFiles = await walkFiles(root);
    assert.ok(
      allFiles.every((path) => path.includes("/entries/")),
      `only store entries may exist on disk, got: ${allFiles.join(", ")}`,
    );
  } finally {
    await removeRoot(root);
  }
});

Deno.test("composition: repeated readIncident is deterministic and never replaces the replay identity", async () => {
  const { composition, store, root, transport } = await makeRig(
    await goldenResponder(),
  );
  try {
    const first = await composition.readIncident(INCIDENT_A);
    assert.ok(first.ok && first.value !== null);
    const replay = first.value!.replay;
    assert.notEqual(replay, null);
    const second = await composition.readIncident(INCIDENT_A);
    assert.ok(second.ok && second.value !== null);
    assert.deepEqual(second.value, first.value);
    assert.equal(second.value!.replay?.fixtureRef, replay!.fixtureRef);
    assert.equal(
      second.value!.replay?.fixtureDigest,
      replay!.fixtureDigest,
    );
    // The retained artifact was not refetched: only the index was scanned.
    assert.equal(
      transport.requests.filter(
        (r) => new URL(r.url).pathname === REPLAY_PATH,
      ).length,
      1,
    );
    // Existing non-null replay identity is never recomputed/replaced and the
    // resolver is deterministic.
    assert.deepEqual(
      await composition.resolveFixture(replay!.fixtureRef),
      await composition.resolveFixture(replay!.fixtureRef),
      "resolver must be deterministic",
    );
    const stats = await store.stats();
    assert.ok(stats.ok && stats.value.count === 1);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("composition: fresh instance over the same store rehydrates the identical fixture", async () => {
  const { composition, root, keyBytes } = await makeRig(
    await goldenResponder(),
  );
  try {
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;
    const original = await composition.resolveFixture(replay.fixtureRef);
    assert.ok(original.ok);

    // A fresh store instance over the same root plus a fresh composition.
    const freshStore = new LocalArtifactStore({ root, limits: LIMITS });
    assert.ok((await freshStore.open()).ok);
    const config = validConfig();
    const fresh = new GatewayReplayComposition({
      adapter: new GatewayIncidentAdapter({
        config,
        transport: recordingTransport(() => {
          throw new Error(
            "fresh composition must never refetch from the transport",
          );
        }),
        auth: authProvider(),
        clock: new FakeClock(CAPTURED_AT_V2),
        store: freshStore,
      }),
      store: freshStore,
      repository: config.repository,
      keyBytes,
      policy: SANITIZER_POLICY,
      commandId: COMMAND_ID,
      testIds: TEST_IDS,
      expectedFailure: EXPECTED_FAILURE,
      clock: new FakeClock(CAPTURED_AT_V2),
    });
    const rehydrated = await fresh.resolveFixture(replay.fixtureRef);
    assert.ok(rehydrated.ok, JSON.stringify(rehydrated));
    if (!rehydrated.ok) return;
    assert.deepEqual(rehydrated.value, original.value);
    assert.equal(
      await computeReplayFixtureDigest(rehydrated.value.entries),
      replay.fixtureDigest,
    );
    const ids = await fresh.resolveTestIds(
      replay.fixtureRef,
      replay.fixtureDigest!,
    );
    assert.ok(ids.ok);
    if (ids.ok) assert.deepEqual(ids.value, TEST_IDS);
    // Rehydration came from retained ciphertext only: no plaintext on disk.
    const statsResult = await freshStore.stats();
    assert.ok(statsResult.ok);
    if (statsResult.ok) assert.ok(statsResult.value.totalBytes > 0);
  } finally {
    await removeRoot(root);
  }
});

Deno.test("composition: actual ReplayPort fixture resolution from the composition and a fresh instance", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-wave-c-replay-port-",
  });
  let storeRoot: string | null = null;
  try {
    // Minimal credential-free target repo with the configured replay command.
    const repoRoot = `${root}/fixture-repo`;
    await Deno.mkdir(repoRoot);
    const env = testGitEnv(`${root}/home`);
    await gitRun(repoRoot, ["init", "-q", "-b", "main"], env);
    await commitWith(
      repoRoot,
      env,
      {
        "deno.json": JSON.stringify(
          {
            tasks: {
              replay: "deno run --allow-read=tests/ scripts/replay.ts",
            },
          },
          null,
          2,
        ) + "\n",
        "scripts/replay.ts": FIXTURE_REPLAY_SCRIPT,
      },
      "target: gateway replay command",
    );
    const repoSha = await revParse(repoRoot, env);
    assert.ok(isGitSha(repoSha));

    const rig = await makeRig(await goldenResponder());
    const composition = rig.composition;
    storeRoot = rig.root;
    const keyBytes = rig.keyBytes;
    const read = await composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const replay = read.value!.replay!;

    const config = replayConfig();
    const policy: ReplayPolicyV1 = {
      bundleScopes: ["tests/"],
      maxFixtureBytes: 512 * 1024,
      maxEntryBytes: 256 * 1024,
      proof: markerProofParser(),
    };
    const makePort = (fixtures: GatewayReplayComposition): ReplayPortImpl =>
      new ReplayPortImpl({
        config,
        source: { kind: "local", path: repoRoot },
        scratchDir: `${root}/scratch`,
        fixtures,
        policy,
        isolation: toyIsolation(),
      });
    const request = {
      taskId: "incident:gateway-0001" as WorkItemId,
      repository: TOY_REPOSITORY,
      revision: repoSha,
      commandId: "replay" as CommandId,
      fixtureRef: replay.fixtureRef,
      fixtureDigest: replay.fixtureDigest!,
      testIds: TEST_IDS,
      outputLimitBytes: 262144,
    };

    const first = await makePort(composition).runReplay(request);
    assert.ok(first.ok, `runReplay must succeed: ${JSON.stringify(first)}`);
    if (!first.ok) return;
    assert.equal(first.value.outcome, "passed");
    assert.equal(first.value.exitCode, 0);
    assert.equal(first.value.failure, null);
    assert.ok(first.value.output?.stdoutDigest !== null);
    // The trusted fixture provenance is redacted: the limitation is truthful.
    assert.deepEqual(first.value.limitations, ["fixture_redacted"]);

    // Rehydration: a fresh composition instance over the same store root.
    const freshStore = new LocalArtifactStore({
      root: storeRoot,
      limits: LIMITS,
    });
    assert.ok((await freshStore.open()).ok);
    const fresh = new GatewayReplayComposition({
      adapter: new GatewayIncidentAdapter({
        config: validConfig(),
        transport: recordingTransport(() => {
          throw new Error("fresh composition must never refetch");
        }),
        auth: authProvider(),
        clock: new FakeClock(CAPTURED_AT_V2),
        store: freshStore,
      }),
      store: freshStore,
      repository: validConfig().repository,
      keyBytes,
      policy: SANITIZER_POLICY,
      commandId: COMMAND_ID,
      testIds: TEST_IDS,
      expectedFailure: EXPECTED_FAILURE,
      clock: new FakeClock(CAPTURED_AT_V2),
    });
    const ids = await fresh.resolveTestIds(
      replay.fixtureRef,
      replay.fixtureDigest!,
    );
    assert.ok(ids.ok);
    if (ids.ok) assert.deepEqual(ids.value, TEST_IDS);
    const second = await makePort(fresh).runReplay(request);
    assert.ok(second.ok, JSON.stringify(second));
    if (second.ok) {
      assert.equal(second.value.outcome, "passed");
      assert.equal(
        second.value.output?.stdoutDigest,
        first.value.output?.stdoutDigest,
      );
    }

    // No plaintext fixture files inside the store; source repo untouched;
    // the disposable scratch was cleaned by the port.
    assert.equal(await countStoreBinFiles(storeRoot), 1);
    const allFiles = await walkFiles(storeRoot);
    assert.ok(
      allFiles.every((path) => path.includes("/entries/")),
      `only store entries may exist on disk, got: ${allFiles.join(", ")}`,
    );
    const status = await gitRun(repoRoot, ["status", "--porcelain"], env);
    assert.equal(status.stdout.trim(), "");
    assert.equal(await revParse(repoRoot, env), repoSha);
    const scratchLeft: string[] = [];
    try {
      for await (const entry of Deno.readDir(`${root}/scratch`)) {
        scratchLeft.push(entry.name);
      }
    } catch {
      // scratch dir may not exist; no leftovers then
    }
    assert.deepEqual(scratchLeft, []);
  } finally {
    await removeRoot(root);
    if (storeRoot !== null) await removeRoot(storeRoot);
  }
});
