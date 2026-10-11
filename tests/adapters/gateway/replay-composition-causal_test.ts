import {
  CAPTURE_ID_V2,
  CAPTURED_AT_V2,
  COMMAND_ID,
  EXPECTED_FAILURE,
  GIT_SHA,
  hexToBytes,
  LIMITS,
  readGolden,
  SANITIZER_POLICY,
  TEST_IDS,
} from "./replay-composition-fixtures.ts";
import {
  causalReplayConfig,
  causalScript,
  craftedCausalResponder,
  PRIVATE_MARKER,
  trustedVerifier,
  VERIFIER_TEST_COMMAND,
} from "./replay-composition-causal-helpers.ts";
import {
  assertNoPrivateMarkers,
  authProvider,
  makeRig,
  removeRoot,
} from "./replay-composition-helpers.ts";
import {
  FakeClock,
  INCIDENT_A,
  recordingTransport,
  validConfig,
} from "./helpers.ts";
import assert from "node:assert/strict";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "../../../src/replay/causal-proof.ts";
import { LocalArtifactStore } from "../../../src/adapters/gateway/store.ts";
import { GatewayReplayComposition } from "../../../src/adapters/gateway/replay-composition.ts";
import { GatewayIncidentAdapter } from "../../../src/adapters/gateway/incident-adapter.ts";
import type { GatewayCausalProofV1 } from "../../../src/replay/causal-proof.ts";
import {
  asFixtureDigest,
  asGitSha,
  isGitSha,
} from "../../../src/contracts/brands.ts";
import type { CommandId, WorkItemId } from "../../../src/contracts/brands.ts";
import {
  commitWith,
  gitRun,
  revParse,
  testGitEnv,
  TOY_REPOSITORY,
  toyIsolation,
} from "../../replay/helpers.ts";
import type { ReplayPolicyV1 } from "../../../src/replay/fixture.ts";
import { markerProofParser } from "../../../src/replay/fixture.ts";
import { ReplayPortImpl } from "../../../src/replay/port.ts";

Deno.test("composition: a fully bound trusted causal proof is attached and the fixture stays redacted", async () => {
  const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
  const responder = await craftedCausalResponder(
    keyBytes,
    `{"model":"synthetic-model","input":"${PRIVATE_MARKER}","stream":true}`,
  );
  const rig = await makeRig(responder, {
    composition: {
      testCommandId: VERIFIER_TEST_COMMAND,
      verifier: trustedVerifier(),
    },
  });
  try {
    const read = await rig.composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null, JSON.stringify(read));
    const replay = read.value!.replay!;
    const resolvedResult = await rig.composition.resolveFixture(
      replay.fixtureRef,
    );
    assert.ok(resolvedResult.ok, JSON.stringify(resolvedResult));
    if (!resolvedResult.ok) return;
    const resolved = resolvedResult.value;
    const proof = resolved.causalProof;
    assert.notEqual(proof, undefined, "fully bound proof must be attached");
    if (proof === undefined) return;
    assert.equal(proof.version, "v1");
    assert.equal(proof.kind, "gateway_causal_proof");
    assert.equal(proof.verifier, GATEWAY_CAUSAL_VERIFIER_ID);
    assert.equal(proof.incidentId, INCIDENT_A);
    assert.equal(proof.captureId, CAPTURE_ID_V2);
    assert.equal(proof.originalGitSha, GIT_SHA);
    assert.equal(proof.fixtureRef, replay.fixtureRef);
    assert.equal(proof.bundleDigest, replay.fixtureDigest);
    assert.equal(proof.artifactDigest, read.value!.artifacts[0]!.digest);
    assert.equal(proof.replayCommandId, COMMAND_ID);
    assert.equal(proof.testCommandId, VERIFIER_TEST_COMMAND);
    assert.equal(proof.consumerCommandId, CAUSAL_CONSUMER_COMMAND_ID);
    assert.deepEqual(proof.testIds, TEST_IDS);
    assert.deepEqual(proof.expectedFailure, EXPECTED_FAILURE);
    assert.equal(
      proof.expectedFailureIdentity,
      await deriveExpectedFailureIdentity(EXPECTED_FAILURE),
    );
    assert.equal(
      proof.proofRef,
      gatewayCausalProofRef(INCIDENT_A, CAPTURE_ID_V2, proof.bundleDigest),
    );
    // Observed execution evidence per run: intended failure, nonzero
    // observed exit, the EXACT observed test identity and the observed
    // output digest — never a matcher hash, and kept separate from the
    // canonical expected-failure identity.
    for (
      const observation of [
        proof.originalObservation,
        proof.sanitizedObservation,
      ]
    ) {
      assert.equal(observation.intended, true);
      assert.equal(observation.exitCode, 1);
      assert.deepEqual(observation.observedTestIds, TEST_IDS);
      assert.match(observation.outputDigest, /^[0-9a-f]{64}$/);
      assert.notEqual(observation.outputDigest, proof.expectedFailureIdentity);
    }
    // Structural sanitization and causal verification stay separate: the
    // fixture provenance remains redacted and never carries the private
    // marker.
    assert.equal(resolved.provenance.redacted, true);
    assertNoPrivateMarkers(resolved);
    const fixtureJson = JSON.stringify(resolved);
    assert.ok(
      !fixtureJson.includes(PRIVATE_MARKER),
      "private marker leaked into the resolved fixture",
    );

    // Rehydration from the same retained artifact reproduces the same proof
    // identity (deterministic verifier, identical bindings).
    const freshStore = new LocalArtifactStore({
      root: rig.root,
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
      testCommandId: VERIFIER_TEST_COMMAND,
      testIds: TEST_IDS,
      expectedFailure: EXPECTED_FAILURE,
      clock: new FakeClock(CAPTURED_AT_V2),
      verifier: trustedVerifier(),
    });
    const rehydrated = await fresh.resolveFixture(replay.fixtureRef);
    assert.ok(rehydrated.ok, JSON.stringify(rehydrated));
    if (rehydrated.ok) {
      assert.deepEqual(rehydrated.value, resolved);
    }
  } finally {
    await removeRoot(rig.root);
  }
});

Deno.test("composition: absent/bound-mismatched verifier proofs are the same as no proof and the redaction limitation stays", async () => {
  const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
  const markerBody =
    `{"model":"synthetic-model","input":"${PRIVATE_MARKER}","stream":true}`;
  const publicBody =
    '{"model":"synthetic-model","input":"public text","stream":true}';

  // Verifier refuses when the private marker is absent (unrelated capture).
  const noMarkerRig = await makeRig(
    await craftedCausalResponder(keyBytes, publicBody),
    {
      composition: {
        testCommandId: VERIFIER_TEST_COMMAND,
        verifier: trustedVerifier(),
      },
    },
  );
  try {
    const read = await noMarkerRig.composition.readIncident(INCIDENT_A);
    assert.ok(read.ok && read.value !== null);
    const resolved = await noMarkerRig.composition.resolveFixture(
      read.value!.replay!.fixtureRef,
    );
    assert.ok(resolved.ok);
    if (resolved.ok) {
      assert.equal(resolved.value.causalProof, undefined);
      assert.equal(resolved.value.provenance.redacted, true);
    }
  } finally {
    await removeRoot(noMarkerRig.root);
  }

  // Bound mismatches: the composition re-binds every identity the verifier
  // returns; a single mismatch means no proof is attached.
  const mismatchCases: Array<
    [string, (proof: GatewayCausalProofV1) => GatewayCausalProofV1]
  > = [
    [
      "wrong original Git SHA",
      (proof) => ({ ...proof, originalGitSha: asGitSha("2".repeat(40)) }),
    ],
    [
      "wrong bundle digest",
      (proof) => ({ ...proof, bundleDigest: asFixtureDigest("d".repeat(64)) }),
    ],
    [
      "wrong test command id",
      (proof) => ({ ...proof, testCommandId: "other_test" as CommandId }),
    ],
    [
      "wrong incident id",
      (proof) => ({
        ...proof,
        incidentId: "provider-00000000-0000-4000-8000-000000000002",
      }),
    ],
  ];
  for (const [name, mutate] of mismatchCases) {
    const rig = await makeRig(
      await craftedCausalResponder(keyBytes, markerBody),
      {
        composition: {
          testCommandId: VERIFIER_TEST_COMMAND,
          verifier: trustedVerifier(mutate),
        },
      },
    );
    try {
      const read = await rig.composition.readIncident(INCIDENT_A);
      assert.ok(read.ok && read.value !== null, name);
      const resolved = await rig.composition.resolveFixture(
        read.value!.replay!.fixtureRef,
      );
      assert.ok(resolved.ok, name);
      if (resolved.ok) {
        assert.equal(
          resolved.value.causalProof,
          undefined,
          `${name}: mismatched proof must not be attached`,
        );
      }
    } finally {
      await removeRoot(rig.root);
    }
  }

  // A verifier without the trusted target-test command identity is refused
  // at construction (fail fast, never a silently defaulted bind).
  assert.throws(
    () =>
      new GatewayReplayComposition({
        adapter: {} as never,
        store: {} as never,
        repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
        keyBytes: new Uint8Array(32),
        policy: SANITIZER_POLICY,
        commandId: COMMAND_ID,
        testIds: TEST_IDS,
        expectedFailure: EXPECTED_FAILURE,
        clock: new FakeClock(0),
        verifier: trustedVerifier(),
      }),
    /target-test command id/,
  );
});

Deno.test("composition: a fully bound proof suppresses fixture_redacted through the real ReplayPort", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-wave-c-causal-port-",
  });
  let storeRoot: string | null = null;
  try {
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
              test: "deno run --allow-read=tests/ scripts/check.ts",
            },
          },
          null,
          2,
        ) + "\n",
        "scripts/replay.ts": causalScript(false),
        "scripts/check.ts": causalScript(true),
      },
      "target: composed causal replay command",
    );
    const repoSha = await revParse(repoRoot, env);
    assert.ok(isGitSha(repoSha));

    const keyBytes = hexToBytes(readGolden().syntheticKeyHex);
    const responder = await craftedCausalResponder(
      keyBytes,
      `{"model":"synthetic-model","input":"${PRIVATE_MARKER}","stream":true}`,
    );
    const rig = await makeRig(responder, {
      composition: {
        testCommandId: VERIFIER_TEST_COMMAND,
        verifier: trustedVerifier(),
      },
    });
    storeRoot = rig.root;
    try {
      const read = await rig.composition.readIncident(INCIDENT_A);
      assert.ok(read.ok && read.value !== null);
      const replay = read.value!.replay!;
      const policy: ReplayPolicyV1 = {
        bundleScopes: ["tests/"],
        maxFixtureBytes: 512 * 1024,
        maxEntryBytes: 256 * 1024,
        proof: markerProofParser(),
      };
      const port = new ReplayPortImpl({
        config: causalReplayConfig(),
        source: { kind: "local", path: repoRoot },
        scratchDir: `${root}/scratch`,
        fixtures: rig.composition,
        policy,
        isolation: toyIsolation(),
      });
      const before = await port.runReplay({
        taskId: "incident:gateway-causal-0001" as WorkItemId,
        repository: TOY_REPOSITORY,
        revision: repoSha,
        commandId: COMMAND_ID,
        fixtureRef: replay.fixtureRef,
        fixtureDigest: replay.fixtureDigest!,
        testIds: TEST_IDS,
        outputLimitBytes: 262144,
      });
      assert.ok(before.ok, JSON.stringify(before));
      if (before.ok) {
        assert.equal(before.value.outcome, "failed");
        assert.equal(before.value.failure?.intended, true);
        assert.deepEqual(
          before.value.limitations,
          [],
          "the bound causal proof suppresses fixture_redacted",
        );
      }
      const after = await port.runReplay({
        taskId: "incident:gateway-causal-0001" as WorkItemId,
        repository: TOY_REPOSITORY,
        revision: repoSha,
        commandId: VERIFIER_TEST_COMMAND,
        fixtureRef: replay.fixtureRef,
        fixtureDigest: replay.fixtureDigest!,
        testIds: TEST_IDS,
        outputLimitBytes: 262144,
      });
      assert.ok(after.ok, JSON.stringify(after));
      if (after.ok) {
        assert.equal(after.value.outcome, "passed");
        assert.equal(after.value.exitCode, 0);
        assert.deepEqual(after.value.limitations, []);
      }
    } finally {
      await removeRoot(storeRoot);
    }
  } finally {
    await removeRoot(root);
  }
});
