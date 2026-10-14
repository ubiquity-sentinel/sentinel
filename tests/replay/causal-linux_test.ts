import assert from "node:assert/strict";
import {
  CAUSAL_CONSUMER_PATH,
  GatewayLocalCausalVerifier,
} from "../../src/replay/causal-verifier.ts";
import {
  decode,
  makeCapture,
  REQUEST_PATH,
  scratchEntries,
  TEST_ID,
  UPSTREAM_PATH,
  verifierInput,
} from "./causal-verifier-helpers.ts";
import {
  causalConsumerSource,
  denialConsumerSource,
  linuxOnly,
  makeCausalRepo,
  recordingLinuxIsolation,
} from "./causal-sandbox-helpers.ts";

Deno.test({
  name:
    "causal verifier (Linux): the real bwrap boundary reproduces the intended failure in two independent read-only executions",
  ignore: linuxOnly,
  fn: async () => {
    const toy = await makeCausalRepo(
      "linux-positive",
      () => causalConsumerSource(),
    );
    const scratch =
      `${Deno.cwd()}/.causal-verifier-linux-${crypto.randomUUID()}`;
    await Deno.mkdir(scratch);
    try {
      const { isolation, runs } = recordingLinuxIsolation(scratch);
      const verifier = new GatewayLocalCausalVerifier({
        sourcePath: toy.root,
        scratchDir: scratch,
        consumerPath: CAUSAL_CONSUMER_PATH,
        consumerRequestPath: REQUEST_PATH,
        consumerUpstreamPath: UPSTREAM_PATH,
        denoPath: Deno.execPath(),
        maxDurationMs: 10_000,
        maxOutputBytes: 262_144,
        isolation,
      });
      const input = await verifierInput({
        capture: { ...makeCapture(), gitSha: toy.sha },
      });
      const proof = await verifier.verify(input);
      assert.notEqual(
        proof,
        null,
        "no proof under the real Linux bwrap boundary",
      );
      if (proof === null) return;
      assert.equal(proof.originalGitSha, toy.sha);
      assert.equal(proof.originalObservation.exitCode, 1);
      assert.equal(proof.sanitizedObservation.exitCode, 1);
      assert.deepEqual(proof.originalObservation.observedTestIds, [TEST_ID]);
      assert.deepEqual(proof.sanitizedObservation.observedTestIds, [TEST_ID]);
      // The two INDEPENDENT executions actually went through the injected
      // boundary, each against its own read-only checkout.
      assert.equal(runs.length, 2);
      assert.equal(runs[0]!.access, "read-only");
      assert.equal(runs[1]!.access, "read-only");
      assert.notEqual(runs[0]!.input.cwd, runs[1]!.input.cwd);
      assert.ok(runs[0]!.input.cwd.endsWith("/original"));
      assert.ok(runs[1]!.input.cwd.endsWith("/sanitized"));
      assert.deepEqual(await scratchEntries(scratch), []);
    } finally {
      await toy.cleanup();
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "causal verifier (Linux): an outside-snapshot read is denied by the real boundary, never a missing file",
  ignore: linuxOnly,
  fn: async () => {
    const toy = await makeCausalRepo(
      "linux-denial",
      (root) =>
        denialConsumerSource(
          `try {
  await Deno.readTextFile(${JSON.stringify(`${root}/outside.ts`)});
} catch (error) {
  if (error instanceof Deno.errors.NotCapable || error instanceof Deno.errors.PermissionDenied) {
    console.log("sentinel-causal-failure:denied");
    Deno.exit(2);
  }
  console.log("sentinel-causal-failure:unexpected-read-error");
  Deno.exit(3);
}`,
        ),
    );
    const scratch =
      `${Deno.cwd()}/.causal-verifier-linux-denial-${crypto.randomUUID()}`;
    await Deno.mkdir(scratch);
    try {
      const outsideInfo = await Deno.lstat(`${toy.root}/outside.ts`);
      assert.equal(
        outsideInfo.isFile,
        true,
        "the public outside target must exist as a regular file",
      );
      const { isolation, runs } = recordingLinuxIsolation(scratch);
      const verifier = new GatewayLocalCausalVerifier({
        sourcePath: toy.root,
        scratchDir: scratch,
        consumerPath: CAUSAL_CONSUMER_PATH,
        consumerRequestPath: REQUEST_PATH,
        consumerUpstreamPath: UPSTREAM_PATH,
        denoPath: Deno.execPath(),
        maxDurationMs: 10_000,
        maxOutputBytes: 262_144,
        isolation,
      });
      const input = await verifierInput({
        capture: { ...makeCapture(), gitSha: toy.sha },
      });
      const proof = await verifier.verify(input);
      assert.equal(proof, null, "a denied outside read must produce no proof");
      assert.equal(
        runs.length,
        1,
        "the settled denial aborts before the sanitized execution",
      );
      const run = runs[0]!;
      assert.equal(run.access, "read-only");
      assert.equal(run.result.outcome, "exited");
      assert.equal(run.result.settled, true);
      assert.equal(run.result.exitCode, 2);
      assert.equal(
        decode(run.result.stdout),
        "sentinel-causal-failure:denied\n",
      );
      assert.deepEqual(await scratchEntries(scratch), []);
    } finally {
      await toy.cleanup();
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "causal verifier (Linux): a missing isolation capability is no proof and writes no private scratch",
  ignore: linuxOnly,
  fn: async () => {
    const toy = await makeCausalRepo(
      "linux-missing-capability",
      () => causalConsumerSource(),
    );
    // Fresh path: never created in this case (no capability is no proof
    // BEFORE any private filesystem write).
    const scratch =
      `${Deno.cwd()}/.causal-verifier-linux-missing-${crypto.randomUUID()}`;
    try {
      const verifier = new GatewayLocalCausalVerifier({
        sourcePath: toy.root,
        scratchDir: scratch,
        consumerPath: CAUSAL_CONSUMER_PATH,
        consumerRequestPath: REQUEST_PATH,
        consumerUpstreamPath: UPSTREAM_PATH,
        denoPath: Deno.execPath(),
        maxDurationMs: 10_000,
        maxOutputBytes: 262_144,
      });
      const input = await verifierInput({
        capture: { ...makeCapture(), gitSha: toy.sha },
      });
      const proof = await verifier.verify(input);
      assert.equal(
        proof,
        null,
        "no proof without an injected Linux isolation capability",
      );
      await assert.rejects(
        () => Deno.lstat(scratch),
        Deno.errors.NotFound,
        "no private scratch may be created without a capability",
      );
    } finally {
      await toy.cleanup();
    }
  },
});
