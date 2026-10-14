import {
  EXPECTED_FAIL_LINE,
  EXPECTED_MARKER_LINE,
} from "./causal-verifier-helpers.ts";
import assert from "node:assert/strict";
import {
  CAUSAL_CONSUMER_COMMAND_ID,
  deriveExpectedFailureIdentity,
  GATEWAY_CAUSAL_VERIFIER_ID,
  gatewayCausalProofRef,
} from "../../src/replay/causal-proof.ts";
import { SENTINEL_REPLAY_INPUT_PATH } from "../../src/replay/causal-verifier.ts";
import {
  CAPTURE_ID,
  composedRequestBytes,
  composedUpstreamBytes,
  decode,
  encode,
  exitedResult,
  EXPECTED_FAILURE,
  expectedDispatchText,
  INCIDENT_ID,
  intendedFailResult,
  PRIVATE_MARKER,
  REQUEST_PATH,
  scratchEntries,
  scriptedContext,
  TEST_ID,
  TEST_ID_B,
  timedOutResult,
  UPSTREAM_PATH,
  verifierInput,
} from "./causal-verifier-helpers.ts";

Deno.test("causal verifier: proof carries exact observed evidence, private bytes stay in the original snapshot only, per-run homes/caches and verified cleanup", async () => {
  const ctx = await scriptedContext({
    consumer: () => intendedFailResult(),
  });
  try {
    const denoResolved = await Deno.realPath(Deno.execPath());
    const input = await verifierInput();
    const proof = await ctx.verify(input);
    assert.notEqual(proof, null, "a bound proof is expected");
    if (proof === null) return;

    assert.equal(proof.verifier, GATEWAY_CAUSAL_VERIFIER_ID);
    assert.equal(proof.consumerCommandId, CAUSAL_CONSUMER_COMMAND_ID);
    assert.equal(
      proof.proofRef,
      gatewayCausalProofRef(INCIDENT_ID, CAPTURE_ID, proof.bundleDigest),
    );
    assert.equal(
      proof.expectedFailureIdentity,
      await deriveExpectedFailureIdentity(EXPECTED_FAILURE),
    );
    // Observed evidence is separate from the expected-failure identity.
    for (
      const observation of [
        proof.originalObservation,
        proof.sanitizedObservation,
      ]
    ) {
      assert.equal(observation.intended, true);
      assert.equal(observation.exitCode, 1);
      assert.deepEqual(observation.observedTestIds, [TEST_ID]);
      assert.match(observation.outputDigest, /^[0-9a-f]{64}$/);
    }
    assert.notEqual(proof.originalObservation.outputDigest, "a1".repeat(32));
    assert.notEqual(
      proof.originalObservation.outputDigest,
      proof.expectedFailureIdentity,
    );
    // Private bytes never cross: no marker in the proof record.
    assert.ok(!JSON.stringify(proof).includes(PRIVATE_MARKER));

    // Two consumer executions with the fixed sandbox-exec protocol, each
    // confined to ITS OWN snapshot (cwd) and ITS OWN home/cache.
    const consumers = ctx.runtime.runs.filter((input) =>
      input.executable === Deno.execPath()
    );
    assert.equal(consumers.length, 2, "original + sanitized consumer runs");
    const [originalRun, sanitizedRun] = consumers;
    assert.notEqual(originalRun.cwd, sanitizedRun.cwd);
    assert.notEqual(originalRun.env.HOME, sanitizedRun.env.HOME);
    assert.notEqual(originalRun.env.DENO_DIR, sanitizedRun.env.DENO_DIR);
    assert.ok(sanitizedRun.env.HOME.includes("home-sanitized"));
    // The consumer path is the fixed bound script inside the snapshot.
    for (const [index, run] of consumers.entries()) {
      assert.equal(run.executable, Deno.execPath());
      assert.equal(run.args[0], "-p");
      assert.ok(
        run.args[1]!.startsWith("(version 1)"),
        "the fixed embedded deny-by-default seatbelt profile",
      );
      assert.equal(run.args[2], "-D");
      assert.ok(run.args[3]!.startsWith("DENO="));
      assert.equal(run.args[4], "-D");
      assert.ok(run.args[5]!.startsWith("SNAPSHOT="));
      assert.equal(run.args[6], "-D");
      assert.ok(run.args[7]!.startsWith("CACHE="));
      assert.equal(run.args[8], denoResolved, "the installed Deno binary");
      assert.equal(run.args[9], "run", "direct deno run, never deno task");
      assert.equal(
        run.args[run.args.length - 1],
        `${run.cwd}/scripts/replay.ts`,
      );
      assert.ok(run.args.includes("--no-config"));
      assert.ok(run.args.includes("--no-remote"));
      assert.ok(!run.args.includes("task"), "never deno task");
      assert.ok(!run.args.includes("--allow-net"));
      assert.ok(!run.args.includes("--allow-run"));
      const snapshotParam = paramValue(run.args, "SNAPSHOT");
      const cacheParam = paramValue(run.args, "CACHE");
      assert.ok(snapshotParam !== null && snapshotParam.startsWith("/"));
      assert.ok(cacheParam !== null && cacheParam.startsWith("/"));
      // Realpath-resolved substitution parameters: the OS boundary sees the
      // same resolved paths as the snapshot cwd and the run's own cache.
      // The realpaths are recorded by the recording wrapper WHILE the
      // snapshot existed (the verifier's verified cleanup removes the task
      // directory before the proof is returned).
      const record = ctx.runtime.consumerRecords[index]!;
      assert.equal(snapshotParam, record.realCwd);
      assert.equal(cacheParam, record.realDenoDir);
    }
    assert.notEqual(
      paramValue(originalRun.args, "SNAPSHOT"),
      paramValue(sanitizedRun.args, "SNAPSHOT"),
      "each run sees only its own snapshot at the OS boundary",
    );

    // Placement: the private original bytes are ONLY in the original
    // snapshot; the sanitized snapshot carries the exact composed bytes. Both
    // snapshots carry the exact canonical dispatch metadata (fixed paths,
    // ordered trusted ids, no private bytes).
    for (const record of ctx.runtime.consumerRecords) {
      const snapshot = record.snapshotText;
      assert.ok(snapshot[REQUEST_PATH] !== undefined);
      assert.ok(snapshot[UPSTREAM_PATH] !== undefined);
      assert.equal(
        snapshot[SENTINEL_REPLAY_INPUT_PATH],
        expectedDispatchText(),
        "both snapshots carry the exact canonical dispatch metadata",
      );
      assert.ok(
        !snapshot[SENTINEL_REPLAY_INPUT_PATH]!.includes(PRIVATE_MARKER),
        "dispatch metadata never carries private bytes",
      );
    }
    const originalSnapshot = ctx.runtime.consumerRecords[0]!.snapshotText;
    const sanitizedSnapshot = ctx.runtime.consumerRecords[1]!.snapshotText;
    assert.ok(originalSnapshot[REQUEST_PATH]!.includes(PRIVATE_MARKER));
    assert.ok(!originalSnapshot[UPSTREAM_PATH]!.includes(PRIVATE_MARKER));
    assert.ok(!sanitizedSnapshot[REQUEST_PATH]!.includes(PRIVATE_MARKER));
    assert.deepEqual(
      sanitizedSnapshot[REQUEST_PATH],
      decode(composedRequestBytes()),
    );
    assert.deepEqual(
      sanitizedSnapshot[UPSTREAM_PATH],
      decode(composedUpstreamBytes()),
    );

    // Normal cleanup was verified before the proof was returned.
    assert.deepEqual(await scratchEntries(ctx.scratchDir), []);
  } finally {
    await ctx.cleanup();
  }
});

function paramValue(args: string[], name: string): string | null {
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === "-D" && args[index + 1]!.startsWith(`${name}=`)) {
      return args[index + 1]!.slice(name.length + 1);
    }
  }
  return null;
}

Deno.test("causal verifier: dispatch metadata binds the exact ordered trusted test ids in both snapshots", async () => {
  const ids = [TEST_ID, TEST_ID_B];
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}sentinel-replay-test:${TEST_ID_B}\n${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    const proof = await ctx.verify(await verifierInput({ testIds: ids }));
    assert.notEqual(proof, null, "the ordered trusted ids must be accepted");
    if (proof === null) return;
    assert.deepEqual(proof.originalObservation.observedTestIds, ids);
    assert.deepEqual(proof.sanitizedObservation.observedTestIds, ids);
    assert.equal(ctx.runtime.consumerRecords.length, 2);
    for (const record of ctx.runtime.consumerRecords) {
      assert.equal(
        record.snapshotText[SENTINEL_REPLAY_INPUT_PATH],
        expectedDispatchText(ids),
        "metadata carries the exact ordered trusted ids in both snapshots",
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: extra observed test identities are no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}sentinel-replay-test:${TEST_ID_B}\n${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a duplicated observed test identity is no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: reordered observed test identities are no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `sentinel-replay-test:${TEST_ID_B}\n${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    const input = await verifierInput({ testIds: [TEST_ID, TEST_ID_B] });
    assert.equal(await ctx.verify(input), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a missing observed test identity is no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
      ),
  });
  try {
    const input = await verifierInput({ testIds: [TEST_ID, TEST_ID_B] });
    assert.equal(await ctx.verify(input), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: an unrelated failure with the exact identity still carries no proof", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}unrelated failure: boom\n`,
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a private diagnostic line appended to the fixed protocol is no evidence (never hashed)", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}${PRIVATE_MARKER}\n`,
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: any stderr is no evidence even when stdout is the exact protocol", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(
        1,
        `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`,
        "unrelated failure: boom\n",
      ),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: an unsupported expected-failure matcher is rejected before any execution", async () => {
  const ctx = await scriptedContext();
  try {
    const differentText = await verifierInput({
      expectedFailure: {
        reason: "different reason",
        match: { kind: "contains", text: "different text" },
      },
    });
    assert.equal(await ctx.verify(differentText), null);
    const regex = await verifierInput({
      expectedFailure: {
        reason: "regex reason",
        match: { kind: "regex", source: "stream.*" },
      },
    });
    assert.equal(await ctx.verify(regex), null);
    assert.equal(ctx.runtime.runs.length, 0, "no command may run");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a zero-exit consumer is no evidence", async () => {
  const ctx = await scriptedContext({
    consumer: () =>
      exitedResult(0, `${EXPECTED_MARKER_LINE}${EXPECTED_FAIL_LINE}`),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: truncated output is no evidence and no sanitized run follows", async () => {
  const ctx = await scriptedContext({
    consumer: (_input, index) =>
      index === 0
        ? {
          outcome: "exited",
          exitCode: 1,
          stdout: encode(EXPECTED_MARKER_LINE),
          stderr: new Uint8Array(),
          truncated: true,
          settled: true,
          detail: "bounded output exhausted",
        }
        : intendedFailResult(),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      1,
      "truncation is a settled failure: no second execution",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a timed-out original aborts before the sanitized execution and cleans up", async () => {
  const ctx = await scriptedContext({
    consumer: () => timedOutResult(true),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      1,
      "no sanitized execution after a timed-out original",
    );
    assert.deepEqual(await scratchEntries(ctx.scratchDir), []);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: an unsettled original preserves the restricted scratch and never runs the sanitized execution", async () => {
  const ctx = await scriptedContext({
    consumer: () => timedOutResult(false),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      1,
      "unsettled original: the sanitized execution is never attempted",
    );
    // Restricted scratch is PRESERVED on uncertainty (with the private
    // request still inside the original snapshot).
    const leftovers = await scratchEntries(ctx.scratchDir);
    assert.equal(leftovers.length, 1, "scratch preserved on uncertainty");
    const taskDir = `${ctx.scratchDir}/${leftovers[0]}`;
    const privateRequest = await Deno.readTextFile(
      `${taskDir}/original/${REQUEST_PATH}`,
    );
    assert.ok(privateRequest.includes(PRIVATE_MARKER));
  } finally {
    await ctx.cleanup(); // removes the preserved scratch only in teardown
  }
});

Deno.test("causal verifier: an unsettled sanitized run also preserves the scratch and returns no proof", async () => {
  const ctx = await scriptedContext({
    consumer: (_input, index) =>
      index === 0 ? intendedFailResult() : timedOutResult(false),
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    const leftovers = await scratchEntries(ctx.scratchDir);
    assert.equal(leftovers.length, 1, "scratch preserved on uncertainty");
  } finally {
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GROUP D: ReplayPort consuming boundary (real subprocesses, real toy git)
// ---------------------------------------------------------------------------
