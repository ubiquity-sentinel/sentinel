import assert from "node:assert/strict";
import { LinuxReplayIsolation } from "../../src/replay/isolation.ts";
import { validateReplayIsolationCapability } from "../../src/replay/port.ts";
import type { ReplayPortOptions } from "../../src/replay/port.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import {
  bundleDigest,
  commitSymlink,
  commitWith,
  createToyApp,
  FIXTURE_JSON,
  makePort,
  REGRESSION_TEST,
  REPLAY_SCRIPT,
  replayRequest,
  revParse,
  TOY_REPOSITORY,
  toyBundle,
  toyIsolation,
} from "./helpers.ts";
import {
  assertPortOk,
  configWithCommand,
  portWithBundle,
  text,
  withFixture,
} from "./port-helpers.ts";

Deno.test("repository mismatch is invalid; isolation is mandatory", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    const mismatch = await port.runReplay(
      await replayRequest(bundle, toy.originalSha, {
        repository: { ...TOY_REPOSITORY, owner: "other" },
      }),
    );
    assert.ok(!mismatch.ok);
    assert.match(
      mismatch.error.detail,
      /does not match the configured repository/,
    );

    assert.throws(
      () => makePort(toy.root, `${root}/scratch2`, { isolation: undefined }),
      TypeError,
      "missing isolation capability must refuse construction",
    );
    assert.throws(
      () =>
        makePort(toy.root, `${root}/scratch3`, {
          isolation: {
            // A real callable runner is present, so the ONLY fault under test
            // is the false `restrictedExecution` attestation.
            run: toyIsolation().run,
            attestation: {
              version: "v1",
              host: "not-restricted",
              restrictedExecution: false,
              boundary: "untrusted",
              attestationRef: "fixture://isolation/untrusted",
            },
          },
        }),
      TypeError,
      "unattested isolation must refuse construction",
    );
  });
});

Deno.test("isolation capability needs one captured callable run", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const valid = toyIsolation();
    const invalid: unknown[] = [
      { attestation: valid.attestation },
      { attestation: valid.attestation, run: null },
      { attestation: valid.attestation, run: "deno task test" },
      new Proxy({ attestation: valid.attestation }, {
        get(target, key) {
          if (key === "run") throw new Error("EXOTIC-RUN-READ");
          return Reflect.get(target, key);
        },
      }),
      // A revoked proxy can no longer answer any property read at all.
      (() => {
        const revocable = Proxy.revocable(
          { attestation: valid.attestation },
          {},
        );
        revocable.revoke();
        return revocable.proxy;
      })(),
    ];
    for (const isolation of invalid) {
      assert.throws(
        () =>
          makePort(toy.root, `${root}/scratch-bad`, {
            isolation,
          } as unknown as Partial<ReplayPortOptions>),
        TypeError,
        "a capability without a callable run must refuse construction",
      );
    }

    const input: ReplayCommandInputV1 = {
      executable: "deno",
      args: [],
      cwd: root,
      env: {},
      maxDurationMs: 1000,
      maxOutputBytes: 1024,
    };
    // runtime.ts declares `detail: string` (never null), so the conforming
    // bounded diagnostic is the empty string.
    const commandResult: ReplayCommandResultV1 = {
      outcome: "exited",
      exitCode: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      truncated: false,
      settled: true,
      detail: "",
    };

    // The run is read exactly once: a getter that would swap the function on
    // the second read can never replace the captured boundary.
    let runReads = 0;
    let firstCalls = 0;
    const first = (
      _input: ReplayCommandInputV1,
      _access: "read-only" | "read-write",
    ): Promise<ReplayCommandResultV1> => {
      firstCalls += 1;
      return Promise.resolve(commandResult);
    };
    const changing: { attestation: unknown } = {
      attestation: valid.attestation,
    };
    Object.defineProperty(changing, "run", {
      get() {
        runReads += 1;
        return runReads === 1 ? first : () => {
          throw new Error("SWAPPED-RUN");
        };
      },
    });
    const captured = validateReplayIsolationCapability(changing);
    assert.ok(captured !== null, "the first run read must validate");
    const capturedResult = await captured.run(input, "read-only");
    assert.equal(capturedResult.outcome, "exited");
    assert.equal(firstCalls, 1, "the first captured run is the one invoked");
    assert.equal(runReads, 1, "run is read exactly once");

    // A class method keeps its receiver through validation: `run` is captured
    // from the capability and bound to THAT capability object, so a class
    // instance carrying both the attestation and the method sees its own
    // fields. (An unbound method copied into a foreign wrapper would instead
    // see the wrapper — the documented receiver is the capability itself.)
    class FixtureCapability {
      calls = 0;
      readonly attestation = valid.attestation;
      run(
        _input: ReplayCommandInputV1,
        _access: "read-only" | "read-write",
      ): Promise<ReplayCommandResultV1> {
        this.calls += 1;
        return Promise.resolve(commandResult);
      }
    }
    const receiver = new FixtureCapability();
    const bound = validateReplayIsolationCapability(receiver);
    assert.ok(bound !== null);
    const result = await bound.run(input, "read-write");
    assert.equal(result.outcome, "exited");
    assert.equal(result.exitCode, 0);
    assert.equal(result.settled, true);
    assert.equal(receiver.calls, 1, "the captured run keeps its receiver");

    // Later mutation of the raw capability never reaches the snapshot.
    const mutable = { attestation: valid.attestation, run: valid.run };
    const snapshot = validateReplayIsolationCapability(mutable);
    assert.ok(snapshot !== null);
    const replacement = () => Promise.reject(new Error("MUTATED-RUN"));
    mutable.run = replacement;
    mutable.attestation = { ...valid.attestation, host: "mutated" };
    assert.notEqual(snapshot.run, replacement);
    assert.equal(snapshot.attestation.host, "toy-restricted-host");
  });
});

Deno.test({
  name: "Linux isolation executes the configured replay and test commands",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    await withFixture(async (root) => {
      const toy = await createToyApp(`${root}/toy`);
      const scratch = `${root}/scratch`;
      await Deno.mkdir(scratch);
      const isolation = new LinuxReplayIsolation(scratch);
      const port = makePort(toy.root, scratch, { isolation });
      const bundle = toyBundle();

      // Original head: the intended regression failure under the real
      // bubblewrap boundary, with no partial-execution limitations.
      const original = assertPortOk(
        await port.runReplay(
          await replayRequest(bundle, toy.originalSha, {
            commandId: "replay",
          }),
        ),
      );
      assert.equal(original.outcome, "failed");
      assert.equal(original.exitCode, 1);
      assert.equal(original.failure?.intended, true);
      assert.deepEqual(original.limitations, []);

      // Candidate head through the configured replay command.
      const candidate = assertPortOk(
        await port.runReplay(
          await replayRequest(bundle, toy.candidateSha, {
            commandId: "replay",
          }),
        ),
      );
      assert.equal(candidate.outcome, "passed");
      assert.equal(candidate.exitCode, 0);
      assert.equal(candidate.failure, null);
      assert.deepEqual(candidate.limitations, []);

      // Candidate head through the configured test command.
      const candidateTest = assertPortOk(
        await port.runReplay(await replayRequest(bundle, toy.candidateSha)),
      );
      assert.equal(candidateTest.outcome, "passed");
      assert.equal(candidateTest.exitCode, 0);
      assert.equal(candidateTest.failure, null);
      assert.deepEqual(candidateTest.limitations, []);

      // Read-write proof: the trusted configured argv first writes inside its
      // disposable checkout, then runs the toy's real target tests there.
      const writePort = makePort(toy.root, scratch, {
        isolation,
        config: configWithCommand("test", {
          executable: "deno",
          args: [
            "eval",
            "await Deno.writeTextFile('sandbox-write.txt','public'); const s=await new Deno.Command('deno',{args:['task','test'],stdout:'inherit',stderr:'inherit'}).output(); Deno.exit(s.code);",
          ],
          maxDurationMs: 15000,
          maxOutputBytes: 262144,
        }),
      });
      const wrote = assertPortOk(
        await writePort.runReplay(
          await replayRequest(bundle, toy.candidateSha),
        ),
      );
      assert.equal(wrote.outcome, "passed");
      assert.equal(wrote.exitCode, 0);
      assert.equal(wrote.failure, null);
      assert.deepEqual(wrote.limitations, []);

      // Every disposable checkout was removed: the isolation scratch is empty.
      const remaining: string[] = [];
      for await (const entry of Deno.readDir(scratch)) {
        remaining.push(entry.name);
      }
      assert.deepEqual(remaining, []);
    });
  },
});

Deno.test("checked-out symlink ancestors are rejected at materialization", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const symlinkSha = await commitSymlink(toy.root, toy.env);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    const run = await port.runReplay(
      await replayRequest(bundle, symlinkSha),
    );
    assert.ok(!run.ok, "symlink ancestor must fail closed");
    assert.equal(run.error.kind, "invalid");
    assert.match(run.error.detail, /resolves through a symlink/);
  });
});

Deno.test("injected runtime boundary faults surface as unavailable", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const realRuntime = new DenoReplayRuntime(
      Deno.env.get("PATH") ?? "/usr/bin:/bin",
    );
    class ThrowingRuntime implements ReplayRuntimeV1 {
      constructor(private readonly inner: ReplayRuntimeV1) {}
      run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
        if (input.executable === "deno") {
          return Promise.reject(
            new Error("synthetic transport failure at the runtime border"),
          );
        }
        return this.inner.run(input);
      }
    }
    const port = makePort(toy.root, `${root}/scratch`, {
      runtime: new ThrowingRuntime(realRuntime),
    });
    const bundle = toyBundle();
    const run = await port.runReplay(
      await replayRequest(bundle, toy.originalSha),
    );
    assert.ok(!run.ok);
    assert.equal(run.error.kind, "unavailable");
    assert.match(run.error.detail, /synthetic transport failure/);
  });
});

Deno.test("request commands resolve only against the trusted registry", async () => {
  await withFixture(async (root) => {
    const toy = await createToyApp(`${root}/toy`);
    const port = makePort(toy.root, `${root}/scratch`);
    const bundle = toyBundle();
    // Malformed ids are rejected by the shape guard; a valid-format unknown
    // id and — critically — an inherited Object.prototype member name
    // ("constructor") must be rejected by the own-property registry lookup.
    for (
      const commandId of [
        "not in registry",
        "toString",
        "nope",
        "constructor",
      ]
    ) {
      const result = await port.runReplay(
        await replayRequest(bundle, toy.originalSha, { commandId }),
      );
      assert.ok(!result.ok, `command ${commandId} must not resolve`);
      assert.equal(result.error.kind, "invalid");
      if (commandId === "nope" || commandId === "constructor") {
        assert.match(
          result.error.detail,
          /not in the trusted command registry/,
        );
      }
    }
  });
});

Deno.test(
  "byte-identical bundle targets are accepted; different bytes, directories and symlink targets are rejected",
  async () => {
    await withFixture(async (root) => {
      const toy = await createToyApp(`${root}/toy`);
      const bundle = toyBundle();

      // The delivered candidate head ALREADY contains the permanent bundle
      // bytes: ReplayPort must accept them without rewriting and pass.
      const delivered = assertPortOk(
        await portWithBundle(
          toy.root,
          `${root}/scratch`,
          bundle,
        ).runReplay(await replayRequest(bundle, toy.candidateSha)),
      );
      assert.equal(delivered.outcome, "passed");
      assert.equal(delivered.exitCode, 0);

      // Different bytes at a bundle target are rejected, never rewritten.
      const tamperedSha = await commitWith(
        toy.root,
        toy.env,
        { "tests/regression_test.ts": "// DIFFERENT bytes and no marker\n" },
        "tamper: different regression bytes",
      );
      const tampered = await portWithBundle(
        toy.root,
        `${root}/scratch`,
        bundle,
      ).runReplay(await replayRequest(bundle, tamperedSha));
      assert.ok(!tampered.ok, "different bytes must fail closed");
      assert.equal(tampered.error.kind, "invalid");
      assert.match(tampered.error.detail, /different bytes/);

      // A directory where a bundle file must live is rejected. The file
      // committed by the candidate is replaced by a directory holding one
      // file (git cannot track empty directories).
      await Deno.remove(`${toy.root}/tests/fixtures/upstream.json`);
      const dirSha = await commitWith(
        toy.root,
        toy.env,
        { "tests/fixtures/upstream.json/deeper.txt": "x" },
        "tamper: bundle target is a directory",
      );
      const asDir = await portWithBundle(
        toy.root,
        `${root}/scratch`,
        bundle,
      ).runReplay(await replayRequest(bundle, dirSha));
      assert.ok(!asDir.ok, "directory target must fail closed");
      assert.equal(asDir.error.kind, "invalid");
      assert.match(asDir.error.detail, /is a directory/);

      // A symlink AT the bundle target is rejected (in addition to the
      // symlink-ancestor case below).
      const symlinkSha = await commitSymlink(
        toy.root,
        toy.env,
        "tests/fixtures/upstream.json",
        "../src/app.ts",
      );
      const asLink = await portWithBundle(
        toy.root,
        `${root}/scratch`,
        bundle,
      ).runReplay(await replayRequest(bundle, symlinkSha));
      assert.ok(!asLink.ok, "symlink target must fail closed");
      assert.equal(asLink.error.kind, "invalid");
      assert.match(asLink.error.detail, /resolves through a symlink/);

      // Both exact rebuilt heads stay immutable and the digest is unchanged.
      assert.equal(await revParse(toy.root, toy.env), symlinkSha);
      assert.equal(
        (await replayRequest(bundle, toy.candidateSha)).fixtureDigest,
        await bundleDigest({
          "tests/regression_test.ts": REGRESSION_TEST,
          "tests/fixtures/upstream.json": FIXTURE_JSON,
          "scripts/replay.ts": REPLAY_SCRIPT,
        }),
      );
    });
  },
);

Deno.test(
  "descendant retaining captured output after parent exit times out as unavailable",
  async () => {
    await withFixture(async (root) => {
      const toy = await createToyApp(`${root}/toy`);
      const bundle = toyBundle();
      const port = makePort(toy.root, `${root}/scratch`, {
        config: configWithCommand("test", {
          executable: "/bin/sh",
          // The direct parent exits 0 immediately while a descendant keeps
          // the captured stdout pipe open and keeps running: parent exit is
          // NOT completion and the deadline must fire promptly.
          args: ["-c", "(sleep 0.2) & exit 0"],
          maxDurationMs: 50,
          maxOutputBytes: 262144,
        }),
      });
      const started = Date.now();
      const run = assertPortOk(
        await port.runReplay(await replayRequest(bundle, toy.originalSha)),
      );
      const elapsed = Date.now() - started;
      assert.equal(run.outcome, "unavailable", "run must time out");
      assert.equal(run.exitCode, null);
      assert.equal(run.failure, null);
      assert.equal(run.output, null);
      assert.ok(
        elapsed < 2000,
        `timeout must fire promptly, took ${elapsed}ms`,
      );
      assert.match(port.lastUnavailableDetail(), /exceeded maxDurationMs/);
    });
  },
);

Deno.test(
  "an unsettled runtime result is unavailable and preserves the scratch",
  async () => {
    await withFixture(async (root) => {
      const toy = await createToyApp(`${root}/toy`);
      const realRuntime = new DenoReplayRuntime(
        Deno.env.get("PATH") ?? "/usr/bin:/bin",
      );
      class UnsettledRuntime implements ReplayRuntimeV1 {
        constructor(private readonly inner: ReplayRuntimeV1) {}
        run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
          if (input.executable === "deno") {
            // Exit 0 WITH the expected test marker would normally pass — but
            // settlement is not proven, so the port must treat the run as
            // unavailable and KEEP the scratch for inspection.
            return Promise.resolve({
              outcome: "exited",
              exitCode: 0,
              stdout: text.encode(
                "sentinel-replay-test:gateway:stream-termination\n",
              ),
              stderr: new Uint8Array(),
              truncated: false,
              settled: false,
              detail: "synthetic: owned descendant could not be proved settled",
            });
          }
          return this.inner.run(input);
        }
      }
      const port = makePort(toy.root, `${root}/scratch`, {
        runtime: new UnsettledRuntime(realRuntime),
      });
      const bundle = toyBundle();
      const run = assertPortOk(
        await port.runReplay(await replayRequest(bundle, toy.candidateSha)),
      );
      assert.equal(run.outcome, "unavailable", "unsettled must be unavailable");
      assert.equal(run.exitCode, null);
      assert.equal(run.failure, null);
      assert.match(
        port.lastUnavailableDetail(),
        /settlement could not be proven/,
      );
      assert.match(port.lastUnavailableDetail(), /scratch preserved/);

      // The preserved scratch still exists and contains the checkout.
      const preserved = [];
      for await (const entry of Deno.readDir(`${root}/scratch`)) {
        preserved.push(entry.name);
      }
      assert.equal(preserved.length, 1, "scratch must be preserved");
      const taskDir = `${root}/scratch/${preserved[0]}`;
      const entries = [];
      for await (const entry of Deno.readDir(taskDir)) {
        entries.push(entry.name);
      }
      assert.ok(entries.includes("checkout"), "checkout must survive");
      await Deno.remove(taskDir, { recursive: true }).catch(() => {});
    });
  },
);

// ---------------------------------------------------------------------------
// Gateway dispatch metadata (candidate ReplayPort path)
//
// A valid frozen gateway fixture reference selects the dispatch protocol: the
// candidate checkout receives the fixed root `.sentinel-replay-input.json`
// record — exact canonical {version,requestPath,upstreamPath,testIds} bound to
// the resolved incident/capture paths and to the trusted resolved test ids —
// materialized OUTSIDE the digested two-entry bundle. The committed toy
// consumer and regression test below read ONLY that record, so a missing
// dispatcher cannot pass by hardcoded fixture reads. Non-gateway references
// are unchanged. This toy proves dispatch/selection wiring, not the target
// gateway converter (tested separately in its own repository).
// ---------------------------------------------------------------------------
