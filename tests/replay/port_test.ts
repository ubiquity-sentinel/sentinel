import assert from "node:assert/strict";
import type { ReplayRunRequestV1 } from "../../src/contracts/ports.ts";
import {
  bundleDigest,
  createToyApp,
  FIXTURE_JSON,
  gitRun,
  makePort,
  REGRESSION_TEST,
  REPLAY_SCRIPT,
  replayRequest,
  revParse,
  sha256HexText,
  TOY_BUNDLE_FILES,
  toyBundle,
  toyPolicy,
} from "./helpers.ts";
import {
  assertPortOk,
  configWithCommand,
  portWithBundle,
  text,
  withFixture,
} from "./port-helpers.ts";

Deno.test("fail-before/pass-after on exact heads with matching digest", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();

    const originalReq = await replayRequest(bundle, toy.originalSha);
    const original = assertPortOk(await port.runReplay(originalReq));
    assert.equal(original.outcome, "failed", "original must fail");
    assert.equal(original.exitCode, 1);
    assert.equal(original.failure?.intended, true, "failure must be intended");
    assert.equal(
      original.failure?.reason,
      "missing completion terminator produces 500",
    );
    assert.ok(original.output !== null, "failed run keeps bounded output");
    assert.ok(
      original.output.stdoutDigest !== null,
      "failed run records stdout digest",
    );
    assert.deepEqual(original.limitations, []);

    // The candidate is the DELIVERED head: it already contains the permanent
    // regression test + fixture bytes, so ReplayPort must accept the
    // byte-identical existing files (no rewrite) and pass. This is the
    // required actual-candidate route, not a raw CI subprocess.
    const candidateReq = await replayRequest(bundle, toy.candidateSha);
    const candidate = assertPortOk(await port.runReplay(candidateReq));
    assert.equal(candidate.outcome, "passed", "candidate must pass");
    assert.equal(candidate.exitCode, 0);
    assert.equal(candidate.failure, null);
    assert.ok(candidate.output?.stdoutDigest !== null);
    assert.deepEqual(candidate.limitations, []);

    // Independent exact-head verification with a real second clone.
    const verifyDir = `${root}/verify`;
    await Deno.mkdir(verifyDir);
    const clone = await gitRun(
      root,
      ["clone", "-q", "--no-local", toy.root, verifyDir],
      toy.env,
    );
    assert.ok(clone.ok, `verify clone failed: ${clone.stderr}`);
    for (const sha of [toy.originalSha, toy.candidateSha]) {
      const check = await gitRun(
        verifyDir,
        ["rev-parse", "--verify", `${sha}^{commit}`],
        toy.env,
      );
      assert.ok(check.ok, `revision ${sha} must exist`);
      assert.equal(check.stdout.trim(), sha);
    }
    // The candidate's tree really contains the permanent bundle bytes.
    const onCandidate = await gitRun(
      verifyDir,
      ["ls-tree", "-r", "--name-only", toy.candidateSha],
      toy.env,
    );
    assert.ok(onCandidate.ok);
    for (const path of Object.keys(TOY_BUNDLE_FILES)) {
      assert.ok(
        onCandidate.stdout.split("\n").includes(path),
        `candidate must contain delivered bundle file ${path}`,
      );
    }

    // Matching fixture digest recomputed independently from the same bytes.
    const expectedDigest = await bundleDigest({
      "tests/regression_test.ts": REGRESSION_TEST,
      "tests/fixtures/upstream.json": FIXTURE_JSON,
      "scripts/replay.ts": REPLAY_SCRIPT,
    });
    assert.equal(originalReq.fixtureDigest, expectedDigest);
    assert.equal(candidateReq.fixtureDigest, expectedDigest);

    // The shared source working directory is untouched by replay runs.
    const status = await gitRun(toy.root, ["status", "--porcelain"], toy.env);
    assert.equal(status.stdout.trim(), "");
    assert.equal(await revParse(toy.root, toy.env), toy.unrelatedSha);

    // No disposable task scratch leftovers.
    const leftovers = [];
    for await (const entry of Deno.readDir(`${root}/scratch`)) {
      leftovers.push(entry.name);
    }
    assert.deepEqual(leftovers, []);

    // Independent raw confirmation that the delivered head's permanent
    // regression is wired into the toy's normal CI command: a fresh
    // checkout of the candidate head passes `deno task test`.
    const ciDir = `${root}/ci`;
    await Deno.mkdir(ciDir);
    const ciClone = await gitRun(
      root,
      ["clone", "-q", "--no-local", toy.root, ciDir],
      toy.env,
    );
    assert.ok(ciClone.ok);
    await gitRun(ciDir, ["checkout", "-q", toy.candidateSha], toy.env);
    const ci = await new Deno.Command("deno", {
      args: ["task", "test"],
      cwd: ciDir,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: `${root}/ci-home`,
        DENO_DIR: `${root}/ci-home/.cache/deno`,
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const ciOutput = new TextDecoder().decode(ci.stdout) +
      new TextDecoder().decode(ci.stderr);
    assert.equal(
      ci.success,
      true,
      `wired CI command must pass on delivered head: ${ciOutput}`,
    );
  });
});

Deno.test("configured replay command id resolves and runs", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();

    const original = assertPortOk(
      await port.runReplay(
        await replayRequest(bundle, toy.originalSha, { commandId: "replay" }),
      ),
    );
    assert.equal(original.outcome, "failed");
    assert.equal(original.failure?.intended, true);

    const candidate = assertPortOk(
      await port.runReplay(
        await replayRequest(bundle, toy.candidateSha, { commandId: "replay" }),
      ),
    );
    assert.equal(candidate.outcome, "passed");
    assert.equal(candidate.exitCode, 0);
  });
});

Deno.test("wrong revision is unavailable, never an original regression", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    const wrongSha = "0".repeat(40) as ReplayRunRequestV1["revision"];

    const run = assertPortOk(
      await port.runReplay(await replayRequest(bundle, wrongSha)),
    );
    assert.equal(run.outcome, "unavailable");
    assert.equal(run.exitCode, null);
    assert.equal(run.output, null);
    assert.equal(run.failure, null);
    assert.match(port.lastUnavailableDetail(), /not present in the source/);
  });
});

Deno.test("fixture digest mismatch is rejected before any command", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    const result = await port.runReplay(
      await replayRequest(bundle, toy.originalSha, {
        fixtureDigest: "0".repeat(64),
      }),
    );
    assert.ok(!result.ok, "digest mismatch must fail closed");
    assert.equal(result.error.kind, "invalid");
    assert.match(result.error.detail, /digest mismatch/);
  });
});

Deno.test("malicious fixture entry paths are rejected", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    for (
      const path of [
        "/etc/passwd",
        "../escape.txt",
        "tests\\evil.txt",
        "tests//x.ts",
        "tests/./x.ts",
        "a/b/c/../../x.ts",
      ]
    ) {
      const bundle = toyBundle({
        entries: [{ path, bytes: text.encode("x") }],
      });
      const port = portWithBundle(toy.root, `${root}/scratch`, bundle);
      const result = await port.runReplay(
        await replayRequest(bundle, toy.originalSha),
      );
      assert.ok(!result.ok, `path must be rejected: ${path}`);
      assert.equal(result.error.kind, "invalid");
      assert.match(result.error.detail, /unsafe fixture entry path/);
    }
  });
});

Deno.test("secret-bearing fixture content is rejected", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const secrets = [
      "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
      "Authorization: Bearer ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij\n",
      "AKIAIOSFODNN7EXAMPLE\n",
      "cli_token=sk-abcdefghijklmnopqrstuvwxyz123456\n",
    ];
    for (const secret of secrets) {
      const bundle = toyBundle({
        entries: [{
          path: "tests/fixtures/leak.txt",
          bytes: text.encode(secret),
        }],
      });
      const port = portWithBundle(toy.root, `${root}/scratch`, bundle);
      const result = await port.runReplay(
        await replayRequest(bundle, toy.originalSha),
      );
      assert.ok(!result.ok, "secret-shaped content must be rejected");
      assert.equal(result.error.kind, "invalid");
      assert.match(result.error.detail, /secret-shaped text/);
    }
  });
});

Deno.test("bundle outside trusted scope or targeting protected paths is rejected", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);

    const outOfScope = toyBundle({
      entries: [{ path: "etc/passwd.txt", bytes: text.encode("x") }],
    });
    const outOfScopePort = portWithBundle(
      toy.root,
      `${root}/scratch`,
      outOfScope,
    );
    const outOfScopeResult = await outOfScopePort.runReplay(
      await replayRequest(outOfScope, toy.originalSha),
    );
    assert.ok(!outOfScopeResult.ok);
    assert.match(outOfScopeResult.error.detail, /outside trusted bundle scope/);

    // A scope that overlaps protectedPaths is caught by the protected-path
    // check even though the path shape itself is safe.
    const policy = toyPolicy();
    const protectedBundle = toyBundle({
      entries: [{ path: "src/app.ts", bytes: text.encode("x") }],
    });
    const protectedPort = portWithBundle(
      toy.root,
      `${root}/scratch`,
      protectedBundle,
      {
        policy: { ...policy, bundleScopes: ["tests/", "scripts/", "src/"] },
      },
    );
    const protectedResult = await protectedPort.runReplay(
      await replayRequest(protectedBundle, toy.originalSha),
    );
    assert.ok(!protectedResult.ok);
    assert.match(protectedResult.error.detail, /protected path/);
  });
});

Deno.test("unattested sanitization is refused, attested redaction is limited", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);

    const unattested = toyBundle({
      provenance: { ...toyBundle().provenance, sanitized: false },
    });
    const unattestedPort = portWithBundle(
      toy.root,
      `${root}/scratch`,
      unattested,
    );
    const refused = await unattestedPort.runReplay(
      await replayRequest(unattested, toy.originalSha),
    );
    assert.ok(!refused.ok);
    assert.match(refused.error.detail, /sanitization attestation/);

    const redacted = toyBundle({
      provenance: { ...toyBundle().provenance, redacted: true },
    });
    const redactedPort = portWithBundle(
      toy.root,
      `${root}/scratch`,
      redacted,
    );
    const original = assertPortOk(
      await redactedPort.runReplay(
        await replayRequest(redacted, toy.originalSha),
      ),
    );
    assert.equal(original.outcome, "failed");
    assert.equal(original.failure?.intended, true);
    assert.deepEqual(original.limitations, ["fixture_redacted"]);
    const candidate = assertPortOk(
      await redactedPort.runReplay(
        await replayRequest(redacted, toy.candidateSha),
      ),
    );
    assert.equal(candidate.outcome, "passed");
    assert.deepEqual(candidate.limitations, ["fixture_redacted"]);
  });
});

Deno.test("missing executable and unrelated non-zero are unavailable/failed", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const bundle = toyBundle();

    const missingPort = makePort(toy.root, `${root}/scratch`, {
      config: configWithCommand("test", {
        executable: "sentinel-no-such-executable-xyz",
        args: ["task", "test"],
        maxDurationMs: 15000,
        maxOutputBytes: 262144,
      }),
    });
    const missing = assertPortOk(
      await missingPort.runReplay(
        await replayRequest(bundle, toy.originalSha),
      ),
    );
    assert.equal(missing.outcome, "unavailable");
    assert.match(missingPort.lastUnavailableDetail(), /could not spawn/);

    // Unrelated breakage: same bundle, different failure reason.
    const port = makePort(toy.root, `${root}/scratch`);
    const unrelated = assertPortOk(
      await port.runReplay(await replayRequest(bundle, toy.unrelatedSha)),
    );
    assert.equal(unrelated.outcome, "failed");
    assert.equal(
      unrelated.failure?.intended,
      false,
      "unrelated failure is not intended",
    );
  });
});

Deno.test("bounded child timeout is killed, reaped and unavailable", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const bundle = toyBundle();
    const port = makePort(toy.root, `${root}/scratch`, {
      config: configWithCommand("test", {
        executable: "deno",
        args: ["eval", "setTimeout(() => {}, 10000)"],
        maxDurationMs: 150,
        maxOutputBytes: 262144,
      }),
    });
    const started = Date.now();
    const run = assertPortOk(
      await port.runReplay(await replayRequest(bundle, toy.originalSha)),
    );
    const elapsed = Date.now() - started;
    assert.equal(run.outcome, "unavailable", "timeout must be unavailable");
    assert.equal(run.exitCode, null);
    assert.ok(elapsed < 8000, `timeout must fire promptly, took ${elapsed}ms`);
    assert.match(port.lastUnavailableDetail(), /exceeded maxDurationMs/);
  });
});

Deno.test("output cap preserves bounded hashes and truncation limitation", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const bundle = toyBundle();
    const port = makePort(toy.root, `${root}/scratch`, {
      config: configWithCommand("test", {
        executable: "deno",
        args: ["eval", "console.log('x'.repeat(4000)); Deno.exit(1)"],
        maxDurationMs: 15000,
        maxOutputBytes: 128,
      }),
    });
    const run = assertPortOk(
      await port.runReplay(await replayRequest(bundle, toy.originalSha)),
    );
    assert.equal(run.outcome, "failed");
    assert.equal(
      run.failure?.intended,
      false,
      "truncated output cannot be intended",
    );
    assert.equal(run.output?.truncated, true);
    assert.ok(run.limitations.includes("output_truncated"));
    assert.equal(
      run.output?.stdoutDigest,
      await sha256HexText("x".repeat(128)),
    );
  });
});

Deno.test("a no-op exit-0 command is never a passing regression", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const bundle = toyBundle();
    const port = makePort(toy.root, `${root}/scratch`, {
      config: configWithCommand("test", {
        executable: "deno",
        args: ["eval", "console.log('no tests ran')"],
        maxDurationMs: 15000,
        maxOutputBytes: 262144,
      }),
    });
    const run = assertPortOk(
      await port.runReplay(await replayRequest(bundle, toy.candidateSha)),
    );
    assert.equal(run.outcome, "unavailable", "no-op must not pass");
    assert.equal(run.exitCode, null);
    assert.equal(run.failure, null);
  });
});
