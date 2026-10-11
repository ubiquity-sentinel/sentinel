import assert from "node:assert/strict";
import type { CommandId, FixtureDigest } from "../../src/contracts/brands.ts";
import type { ResolvedFixtureV1 } from "../../src/replay/fixture.ts";
import { createToyApp, gitRun, testGitEnv, TOY_REPOSITORY } from "./helpers.ts";
import {
  composedDigest,
  composedRequestBytes,
  composedUpstreamBytes,
  FIXTURE_DIR,
  INCIDENT_ID,
  TEST_ID,
} from "./causal-verifier-helpers.ts";
import {
  assertPortOk,
  evalConfig,
  FAIL_SCRIPT,
  gatewayBundle,
  PASS_SCRIPT,
  portWith,
  runRequest,
  withFixture,
} from "./causal-boundary-helpers.ts";

Deno.test("causal proof boundary: a valid proof suppresses fixture_redacted at the consuming boundary", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);
    const port = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });

    // Before-failure at the exact original revision: intended, zero limitations.
    const before = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.equal(before.outcome, "failed");
    assert.equal(before.exitCode, 1);
    assert.equal(before.failure?.intended, true);
    assert.deepEqual(before.limitations, []);

    // The proof is for the immutable capture/fixture relationship: a
    // candidate revision may differ from proof.originalGitSha.
    const after = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.candidateSha)),
    );
    assert.equal(after.outcome, "failed");
    assert.equal(after.failure?.intended, true);
    assert.deepEqual(after.limitations, []);

    // Pass side: the same permanent fixture passes with zero limitations.
    const passPort = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(PASS_SCRIPT),
    });
    const passed = assertPortOk(
      await passPort.runReplay(
        runRequest(bundle, ref, digest, toy.candidateSha),
      ),
    );
    assert.equal(passed.outcome, "passed");
    assert.equal(passed.exitCode, 0);
    assert.deepEqual(passed.limitations, []);
  });
});

Deno.test("causal proof boundary: absent or mismatched proofs keep the ordinary redacted limitation", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);

    // No proof at all: ordinary redacted fixture and its limitation.
    const noProof = await gatewayBundle(toy.originalSha);
    delete noProof.bundle.causalProof;
    const noProofPort = portWith(toy.root, `${root}/scratch`, noProof.bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });
    const limited = assertPortOk(
      await noProofPort.runReplay(
        runRequest(
          noProof.bundle,
          noProof.ref,
          noProof.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.equal(limited.outcome, "failed");
    assert.equal(limited.failure?.intended, true);
    assert.deepEqual(limited.limitations, ["fixture_redacted"]);

    // Wrong bundle digest: structurally valid but not bound to the actual
    // bundle bytes → the redaction limitation stays.
    const wrongDigest = await gatewayBundle(toy.originalSha, {
      bundleDigest: "e".repeat(64) as FixtureDigest,
    });
    const wrongDigestPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongDigest.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const mismatched = assertPortOk(
      await wrongDigestPort.runReplay(
        runRequest(
          wrongDigest.bundle,
          wrongDigest.ref,
          wrongDigest.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(mismatched.limitations, ["fixture_redacted"]);

    // Wrong fixture ref (a different capture identity): the resolved bundle
    // still has to be exactly the two gateway entries for the REF's capture
    // (the fixed dispatch protocol), and the proof — which binds the ORIGINAL
    // capture — cannot bind to the different ref, so the ordinary redacted
    // limitation stays.
    const differentCapture = "different-capture";
    const differentDir =
      `tests/fixtures/gateway-replay/${INCIDENT_ID}/${differentCapture}`;
    const differentEntries = [
      {
        path: `${differentDir}/request.json`,
        bytes: composedRequestBytes(),
      },
      {
        path: `${differentDir}/upstream.json`,
        bytes: composedUpstreamBytes(),
      },
    ];
    const differentDigest = await composedDigest(differentEntries);
    const wrongRefBundle: ResolvedFixtureV1 = {
      ...(await gatewayBundle(toy.originalSha)).bundle,
      entries: differentEntries,
    };
    const wrongRefPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongRefBundle,
      { config: evalConfig(FAIL_SCRIPT.replace(FIXTURE_DIR, differentDir)) },
    );
    const wrongRef = assertPortOk(
      await wrongRefPort.runReplay(
        runRequest(
          wrongRefBundle,
          `fixture://gateway-replay/${INCIDENT_ID}/${differentCapture}/${differentDigest}`,
          differentDigest,
          toy.originalSha,
        ),
      ),
    );
    assert.equal(wrongRef.outcome, "failed");
    assert.equal(wrongRef.failure?.intended, true);
    assert.deepEqual(wrongRef.limitations, ["fixture_redacted"]);

    // Wrong command identity: the proof binds the configured test command.
    const wrongCommand = await gatewayBundle(toy.originalSha, {
      testCommandId: "other_test" as CommandId,
    });
    const wrongCommandPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongCommand.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongCommandRun = assertPortOk(
      await wrongCommandPort.runReplay(
        runRequest(
          wrongCommand.bundle,
          wrongCommand.ref,
          wrongCommand.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongCommandRun.limitations, ["fixture_redacted"]);

    // Wrong consumer command identity: never bound.
    const wrongConsumer = await gatewayBundle(toy.originalSha, {
      consumerCommandId: "other_consumer" as CommandId,
    });
    const wrongConsumerPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongConsumer.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongConsumerRun = assertPortOk(
      await wrongConsumerPort.runReplay(
        runRequest(
          wrongConsumer.bundle,
          wrongConsumer.ref,
          wrongConsumer.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongConsumerRun.limitations, ["fixture_redacted"]);

    // Wrong expected-failure identity: strictly bound to the exact failure.
    const staleIdentity = await gatewayBundle(toy.originalSha, {
      expectedFailureIdentity: "9".repeat(64),
    });
    const staleIdentityPort = portWith(
      toy.root,
      `${root}/scratch`,
      staleIdentity.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const staleIdentityRun = assertPortOk(
      await staleIdentityPort.runReplay(
        runRequest(
          staleIdentity.bundle,
          staleIdentity.ref,
          staleIdentity.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(staleIdentityRun.limitations, ["fixture_redacted"]);

    // Wrong test-id list: the proof's exact test identity must match the
    // resolved fixture identity.
    const wrongTestIds = await gatewayBundle(toy.originalSha, {
      testIds: ["other:test"],
    });
    const wrongTestIdsPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongTestIds.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongTestIdsRun = assertPortOk(
      await wrongTestIdsPort.runReplay(
        runRequest(
          wrongTestIds.bundle,
          wrongTestIds.ref,
          wrongTestIds.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongTestIdsRun.limitations, ["fixture_redacted"]);

    // Changed expected-failure matcher (identity re-derived for the changed
    // matcher, so structural validation passes): the resolved fixture's
    // expected failure is the trusted binding and still mismatches.
    const changedMatcher = await gatewayBundle(toy.originalSha, {
      expectedFailure: {
        reason: "different reason",
        match: { kind: "contains", text: "different text" },
      },
    });
    const changedMatcherPort = portWith(
      toy.root,
      `${root}/scratch`,
      changedMatcher.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const changedMatcherRun = assertPortOk(
      await changedMatcherPort.runReplay(
        runRequest(
          changedMatcher.bundle,
          changedMatcher.ref,
          changedMatcher.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(changedMatcherRun.limitations, ["fixture_redacted"]);

    // Wrong repository identity.
    const wrongRepository = await gatewayBundle(toy.originalSha, {
      repository: { ...TOY_REPOSITORY, name: "different-repo" },
    });
    const wrongRepositoryPort = portWith(
      toy.root,
      `${root}/scratch`,
      wrongRepository.bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    );
    const wrongRepositoryRun = assertPortOk(
      await wrongRepositoryPort.runReplay(
        runRequest(
          wrongRepository.bundle,
          wrongRepository.ref,
          wrongRepository.digest,
          toy.originalSha,
        ),
      ),
    );
    assert.deepEqual(wrongRepositoryRun.limitations, ["fixture_redacted"]);
  });
});

Deno.test("causal proof boundary: other limitations still fail closed alongside a valid proof", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);

    // Truncated output keeps output_truncated even when the proof is valid.
    const truncatingConfig = evalConfig(
      "console.log('x'.repeat(4000)); console.log(\"sentinel-replay-test:" +
        TEST_ID +
        '"); console.log("stream terminated unexpectedly"); Deno.exit(1);',
      128,
    );
    const truncating = portWith(toy.root, `${root}/scratch-trunc`, bundle, {
      config: truncatingConfig,
    });
    const truncated = assertPortOk(
      await truncating.runReplay(
        runRequest(bundle, ref, digest, toy.originalSha),
      ),
    );
    assert.equal(truncated.outcome, "failed");
    assert.equal(truncated.failure?.intended, false);
    assert.deepEqual(truncated.limitations, ["output_truncated"]);

    // Unrelated failure: same valid proof, different failure reason — never
    // an intended failure, and never a clean run.
    const unrelated = assertPortOk(
      await portWith(toy.root, `${root}/scratch-unrelated`, bundle, {
        config: evalConfig(
          `console.log("sentinel-replay-test:${TEST_ID}"); console.log("unrelated boom"); Deno.exit(1);`,
        ),
      }).runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.equal(unrelated.outcome, "failed");
    assert.equal(unrelated.failure?.intended, false);
    assert.deepEqual(unrelated.limitations, []);

    // A request carrying test ids that do not match the trusted fixture
    // identity is rejected before any target command runs.
    const wrongRequestIds = await portWith(
      toy.root,
      `${root}/scratch-ids`,
      bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    ).runReplay(
      runRequest(bundle, ref, digest, toy.originalSha, {
        testIds: ["different:test"],
      }),
    );
    assert.ok(!wrongRequestIds.ok);
    assert.match(wrongRequestIds.error.detail, /test identity/);

    // A request fixture ref that is not the gateway grammar cannot bind the
    // proof: the ordinary redacted limitation stays (fail closed).
    const nonGatewayRefRun = await portWith(
      toy.root,
      `${root}/scratch-ref`,
      bundle,
      { config: evalConfig(FAIL_SCRIPT) },
    ).runReplay(
      runRequest(
        bundle,
        "fixture://captures/toy/upstream.json",
        digest,
        toy.originalSha,
      ),
    );
    assert.ok(nonGatewayRefRun.ok);
    if (nonGatewayRefRun.ok) {
      assert.deepEqual(nonGatewayRefRun.value.limitations, [
        "fixture_redacted",
      ]);
    }
  });
});

Deno.test("causal proof boundary: source checkout stays untouched and scratch is cleaned", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const { bundle, digest, ref } = await gatewayBundle(toy.originalSha);
    const port = portWith(toy.root, `${root}/scratch`, bundle, {
      config: evalConfig(FAIL_SCRIPT),
    });
    const result = assertPortOk(
      await port.runReplay(runRequest(bundle, ref, digest, toy.originalSha)),
    );
    assert.deepEqual(result.limitations, []);
    const env = testGitEnv(`${root}/home`);
    const status = await gitRun(toy.root, ["status", "--porcelain"], env);
    assert.equal(status.stdout.trim(), "");
    const scratchLeft: string[] = [];
    try {
      for await (const entry of Deno.readDir(`${root}/scratch`)) {
        scratchLeft.push(entry.name);
      }
    } catch {
      // scratch dir may not exist; no leftovers then
    }
    assert.deepEqual(scratchLeft, []);
  });
});
