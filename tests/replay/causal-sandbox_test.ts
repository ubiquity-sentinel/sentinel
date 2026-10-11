import assert from "node:assert/strict";
import { CAUSAL_CONSUMER_COMMAND_ID } from "../../src/replay/causal-proof.ts";
import { computeReplayFixtureDigest } from "../../src/replay/fixture.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import {
  encode,
  makeCapture,
  REQUEST_PATH,
  TEST_ID,
  UPSTREAM_PATH,
} from "./causal-verifier-helpers.ts";
import {
  causalConsumerSource,
  completedUpstream,
  darwinOnly,
  makeCausalRepo,
  realVerify,
} from "./causal-sandbox-helpers.ts";
import {
  assertDenialRun,
  DENIAL_CASES,
  RecordingRealRuntime,
} from "./causal-denial-helpers.ts";

Deno.test({
  name:
    "causal verifier (macOS): two independent original-SHA executions both reproduce the intended failure under the sandboxed fixed consumer protocol",
  ignore: darwinOnly,
  fn: async () => {
    const toy = await makeCausalRepo("positive", () => causalConsumerSource());
    const scratch =
      `${Deno.cwd()}/.causal-verifier-real-${crypto.randomUUID()}`;
    try {
      const proof = await realVerify(toy, scratch);
      assert.notEqual(proof, null, "no proof under the real macOS boundary");
      if (proof === null) return;
      assert.equal(proof.originalGitSha, toy.sha);
      assert.equal(proof.consumerCommandId, CAUSAL_CONSUMER_COMMAND_ID);
      assert.equal(proof.originalObservation.exitCode, 1);
      assert.equal(proof.sanitizedObservation.exitCode, 1);
      assert.deepEqual(proof.originalObservation.observedTestIds, [TEST_ID]);
      assert.deepEqual(proof.sanitizedObservation.observedTestIds, [TEST_ID]);
      // Both observations carry distinct observed outputs bound to the
      // intended specific failure, not a matcher hash.
      assert.notEqual(
        proof.originalObservation.outputDigest,
        proof.expectedFailureIdentity,
      );
      assert.notEqual(
        proof.sanitizedObservation.outputDigest,
        proof.expectedFailureIdentity,
      );
      // Cleanup verified: no restricted task dir remains.
      const leftovers: string[] = [];
      try {
        for await (const entry of Deno.readDir(scratch)) {
          leftovers.push(entry.name);
        }
      } catch {
        // never created
      }
      assert.deepEqual(leftovers, []);
    } finally {
      await toy.cleanup();
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "causal verifier (macOS): real OS/Deno denials are no proof without any fallback",
  ignore: darwinOnly,
  fn: async () => {
    for (const denialCase of DENIAL_CASES) {
      const name = denialCase.name;
      const toy = await makeCausalRepo(
        name.replaceAll(" ", "-"),
        (root) => denialCase.source(root),
        { symlinkSrc: denialCase.symlinkSrc === true },
      );
      const scratch =
        `${Deno.cwd()}/.causal-verifier-denial-${crypto.randomUUID()}`;
      const recording = new RecordingRealRuntime(
        new DenoReplayRuntime(Deno.env.get("PATH") ?? "/usr/bin:/bin"),
        denialCase.prepareConsumer,
      );
      try {
        const proof = await realVerify(toy, scratch, {}, recording);
        assert.equal(proof, null, `${name}: a denied op must produce no proof`);
        if (denialCase.denialInOriginal !== undefined) {
          assertDenialRun(recording, name, denialCase.denialInOriginal);
        }
        // Settled denial: the restricted scratch is cleaned up.
        const leftovers: string[] = [];
        try {
          for await (const entry of Deno.readDir(scratch)) {
            leftovers.push(entry.name);
          }
        } catch {
          // never created
        }
        assert.deepEqual(
          leftovers,
          [],
          `${name}: no private scratch may remain after a settled denial`,
        );
      } finally {
        await toy.cleanup();
        await Deno.remove(scratch, { recursive: true }).catch(() => {});
      }
    }
  },
});

/** Upstream trace whose chunk completes (no intended failure remains). */
Deno.test({
  name:
    "causal verifier (macOS): a redaction-damaged capture (private trigger lost) is no proof",
  ignore: darwinOnly,
  fn: async () => {
    const toy = await makeCausalRepo(
      "textdamage",
      () => causalConsumerSource(),
    );
    const scratch =
      `${Deno.cwd()}/.causal-verifier-damage-${crypto.randomUUID()}`;
    try {
      const triggerBody =
        `{"model":"synthetic-model","input":"PRIVATE-TRIGGER-4c9b1e27","stream":true}`;
      // The actual composition sanitizes the SAME capture: the completed
      // upstream trace plus a public request body (trigger removed). The
      // original run fails ONLY because of the private trigger; the
      // sanitized run passes → no proof.
      const sanitizedEntries = [
        {
          path: REQUEST_PATH,
          bytes: encode(JSON.stringify({
            endpoint: "/v1/responses",
            method: "POST",
            contentType: "application/json",
            body:
              '{"model":"public-model","input":"fixture text","stream":true}',
          })),
        },
        {
          path: UPSTREAM_PATH,
          bytes: encode(JSON.stringify(completedUpstream())),
        },
      ];
      const proof = await realVerify(toy, scratch, {
        capture: {
          ...makeCapture(),
          body: encode(triggerBody),
          upstream: completedUpstream(),
        },
        fixtureEntries: sanitizedEntries,
        bundleDigest: await computeReplayFixtureDigest(sanitizedEntries),
      });
      // The redaction-damaged fixture cannot reproduce the original failure:
      // the verifier returns no proof (the ordinary redacted limitation
      // stays at the consuming boundary).
      assert.equal(proof, null, "no proof when the fixture loses the trigger");
    } finally {
      await toy.cleanup();
      await Deno.remove(scratch, { recursive: true }).catch(() => {});
    }
  },
});

// ---------------------------------------------------------------------------
// GROUP F: real Linux bwrap boundary (injected LinuxReplayIsolation + Deno)
// ---------------------------------------------------------------------------
