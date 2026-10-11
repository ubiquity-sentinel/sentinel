import assert from "node:assert/strict";
import type { FixtureDigest } from "../../src/contracts/brands.ts";
import {
  CAUSAL_CONSUMER_PATH,
  GatewayLocalCausalVerifier,
  SENTINEL_REPLAY_INPUT_PATH,
} from "../../src/replay/causal-verifier.ts";
import type { GatewayLocalCausalVerifierOptionsV1 } from "../../src/replay/causal-verifier.ts";
import {
  composedEntries,
  consumerFiles,
  encode,
  expectedDispatchText,
  FIXTURE_DIR,
  intendedFailResult,
  makeCapture,
  materialize,
  PRIVATE_MARKER,
  REQUEST_PATH,
  scratchEntries,
  scriptedContext,
  ScriptedRuntime,
  UPSTREAM_PATH,
  verifierInput,
} from "./causal-verifier-helpers.ts";

Deno.test("causal verifier: the consumer path is bound to the fixed trusted consumer command identity", () => {
  const base: GatewayLocalCausalVerifierOptionsV1 = {
    sourcePath: "/tmp",
    scratchDir: "/tmp",
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: "/tmp",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
  };
  // The fixed path is accepted.
  assert.ok(
    new GatewayLocalCausalVerifier(base) instanceof
      GatewayLocalCausalVerifier,
  );
  // An interchangeable arbitrary consumerPath is rejected.
  for (
    const consumerPath of [
      "scripts/causal-consumer.ts",
      "scripts/other-consumer.ts",
      "scripts/replay.js",
    ]
  ) {
    assert.throws(
      () => new GatewayLocalCausalVerifier({ ...base, consumerPath }),
      /fixed trusted consumer path/,
      consumerPath,
    );
  }
  // A dot-segment consumer path is rejected by the exact safe-path
  // validation itself (never normalized into the fixed path): the actual
  // path-safety error is what must surface, without weakening the rejection.
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerPath: "scripts/../scripts/replay.ts",
      }),
    /fixed safe root-relative paths/,
  );
});

Deno.test("causal verifier: consumer/request/upstream paths must be three distinct fixed safe paths", () => {
  const base: GatewayLocalCausalVerifierOptionsV1 = {
    sourcePath: "/tmp",
    scratchDir: "/tmp",
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: "/tmp",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
  };
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerRequestPath: UPSTREAM_PATH,
      }),
    /must differ/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerRequestPath: "scripts/replay.ts",
      }),
    /must differ/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerUpstreamPath: "scripts/replay.ts",
      }),
    /must differ/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerRequestPath: REQUEST_PATH + "/../upstream.json",
      }),
    /fixed safe root-relative paths/,
  );
});

Deno.test("causal verifier: neither input path may be the fixed dispatch metadata path", () => {
  const base: GatewayLocalCausalVerifierOptionsV1 = {
    sourcePath: "/tmp",
    scratchDir: "/tmp",
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: "/tmp",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
  };
  for (
    const key of ["consumerRequestPath", "consumerUpstreamPath"] as const
  ) {
    assert.throws(
      () =>
        new GatewayLocalCausalVerifier({
          ...base,
          [key]: SENTINEL_REPLAY_INPUT_PATH,
        }),
      /dispatch metadata path/,
      key,
    );
  }
});

Deno.test("causal verifier: ancestor/descendant fixed path overlap is rejected", () => {
  const base: GatewayLocalCausalVerifierOptionsV1 = {
    sourcePath: "/tmp",
    scratchDir: "/tmp",
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: "/tmp",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
  };
  // An input path that is an ancestor of the other input destination.
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerRequestPath: "tests",
      }),
    /must not overlap/,
  );
  // An input path nested below the other input destination.
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerUpstreamPath: `${REQUEST_PATH}/nested.json`,
      }),
    /must not overlap/,
  );
  // The bound consumer itself is protected from an ancestor input path.
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        consumerRequestPath: "scripts",
      }),
    /must not overlap/,
  );
});

Deno.test("causal verifier: constructor requires absolute, bounded trusted host inputs", () => {
  const base: GatewayLocalCausalVerifierOptionsV1 = {
    sourcePath: "/tmp",
    scratchDir: "/tmp",
    consumerPath: CAUSAL_CONSUMER_PATH,
    consumerRequestPath: REQUEST_PATH,
    consumerUpstreamPath: UPSTREAM_PATH,
    denoPath: "/tmp",
    maxDurationMs: 15_000,
    maxOutputBytes: 262_144,
  };
  assert.throws(
    () => new GatewayLocalCausalVerifier({ ...base, sourcePath: "relative" }),
    /absolute local source path/,
  );
  assert.throws(
    () => new GatewayLocalCausalVerifier({ ...base, scratchDir: "relative" }),
    /absolute scratch root/,
  );
  assert.throws(
    () => new GatewayLocalCausalVerifier({ ...base, denoPath: "deno" }),
    /absolute installed Deno binary/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        maxDurationMs: 0,
      }),
    /bounded execution deadline/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        maxOutputBytes: 0,
      }),
    /bounded output retention/,
  );
  assert.throws(
    () =>
      new GatewayLocalCausalVerifier({
        ...base,
        sandboxExecPath: "sandbox-exec",
      }),
    /absolute sandbox-exec path/,
  );
});

Deno.test("causal verifier: malformed UTF-8 request bytes are rejected before any execution", async () => {
  const ctx = await scriptedContext();
  try {
    const malformed = await verifierInput();
    malformed.capture = makeCapture(
      JSON.stringify({ model: "synthetic", input: "\u0000\u00ff" }),
    );
    // Replace with real malformed bytes (invalid UTF-8 sequence).
    malformed.capture = {
      ...malformed.capture,
      body: new Uint8Array([
        0x7b,
        0x22,
        0x61,
        0x22,
        0x3a,
        0x22,
        0xff,
        0x22,
        0x7d,
      ]),
    };
    assert.equal(await ctx.verify(malformed), null);
    assert.equal(ctx.runtime.runs.length, 0, "no command may run");
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: bundle identity and entry shape are exact before any execution", async () => {
  const ctx = await scriptedContext();
  try {
    const wrongDigest = await verifierInput({
      bundleDigest: "d".repeat(64) as FixtureDigest,
    });
    assert.equal(await ctx.verify(wrongDigest), null);

    const missingEntry = await verifierInput({
      fixtureEntries: [composedEntries()[0]!],
    });
    assert.equal(await ctx.verify(missingEntry), null);

    const extraEntry = await verifierInput();
    (extraEntry.fixtureEntries as { path: string; bytes: Uint8Array }[]).push({
      path: "tests/fixtures/extra.json",
      bytes: encode("{}"),
    });
    assert.equal(await ctx.verify(extraEntry), null);

    // Unknown test identities are rejected before execution too.
    const badIds = await verifierInput({ testIds: [] });
    assert.equal(await ctx.verify(badIds), null);

    assert.equal(ctx.runtime.runs.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: non-macOS and a missing sandbox-exec are NO proof (no fallback)", async () => {
  // Non-macOS host: the narrow macOS slice does not exist anywhere else.
  const linuxCtx = await scriptedContext({
    verifierOptions: {},
  });
  // Rebuild with osName override.
  await linuxCtx.cleanup();
  const root = await Deno.makeTempDir({
    prefix: "causal-verifier-os-",
    dir: Deno.cwd(),
  });
  try {
    const linuxRuntime = new ScriptedRuntime();
    const linuxVerifier = new GatewayLocalCausalVerifier({
      sourcePath: root,
      scratchDir: `${root}/scratch`,
      consumerPath: CAUSAL_CONSUMER_PATH,
      consumerRequestPath: REQUEST_PATH,
      consumerUpstreamPath: UPSTREAM_PATH,
      denoPath: Deno.execPath(),
      osName: "linux",
      maxDurationMs: 15_000,
      maxOutputBytes: 262_144,
      runtime: linuxRuntime,
    });
    const linuxInput = await verifierInput({
      capture: {
        ...makeCapture(),
        body: encode(
          `{"model":"synthetic-model","input":"${PRIVATE_MARKER}"}`,
        ),
      },
    });
    assert.equal(await linuxVerifier.verify(linuxInput), null);
    assert.equal(linuxRuntime.runs.length, 0);
    assert.deepEqual(await scratchEntries(`${root}/scratch`), []);

    // Missing installed sandbox-exec: no proof before any execution.
    const missingSandboxRuntime = new ScriptedRuntime();
    const missingSandboxVerifier = new GatewayLocalCausalVerifier({
      sourcePath: root,
      scratchDir: `${root}/scratch-missing-sandbox`,
      consumerPath: CAUSAL_CONSUMER_PATH,
      consumerRequestPath: REQUEST_PATH,
      consumerUpstreamPath: UPSTREAM_PATH,
      denoPath: Deno.execPath(),
      sandboxExecPath: `${root}/missing-sandbox-exec`,
      osName: "darwin",
      maxDurationMs: 15_000,
      maxOutputBytes: 262_144,
      runtime: missingSandboxRuntime,
    });
    assert.equal(
      await missingSandboxVerifier.verify(await verifierInput()),
      null,
    );
    assert.equal(missingSandboxRuntime.runs.length, 0);
    assert.deepEqual(
      await scratchEntries(`${root}/scratch-missing-sandbox`),
      [],
    );
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// GROUP B: placement boundaries (scripted checkouts, no consumer execution)
// ---------------------------------------------------------------------------

Deno.test("causal verifier: a missing trusted consumer at the original SHA is no proof", async () => {
  const ctx = await scriptedContext({
    files: { "scripts/other.ts": "// not the bound consumer" },
  });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
      "no consumer may run without the bound script",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a symlink ancestor in the FIRST input path is rejected before private writes", async () => {
  const ctx = await scriptedContext({
    files: consumerFiles(),
  });
  // Replace the request path's chain: `tests` becomes a symlink.
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    try {
      await Deno.remove(`${dest}/tests`, { recursive: true });
    } catch {
      // does not exist yet
    }
    await Deno.symlink("fixtures", `${dest}/tests`);
  };
  const symlinkCtx = await scriptedContext({ onClone });
  try {
    assert.equal(await symlinkCtx.verify(await verifierInput()), null);
    assert.equal(
      symlinkCtx.runtime.runs.filter((input) => input.executable !== "git")
        .length,
      0,
    );
  } finally {
    await symlinkCtx.cleanup();
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a symlink ancestor in the SECOND input path is rejected before private writes", async () => {
  // The request path is perfectly placeable; the upstream path's `fixtures`
  // ancestor is a symlink. Every component of BOTH paths is validated — the
  // clean first path must not short-circuit the second.
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    const fixtures = `${dest}/tests/fixtures`;
    const gateway = `${dest}/tests/gateway-replay`;
    await Deno.mkdir(gateway, { recursive: true });
    await Deno.rename(fixtures, `${dest}/tests/fixtures-real`);
    await Deno.symlink("fixtures-real", fixtures);
  };
  const ctx = await scriptedContext({ onClone });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
      "no consumer may run when the second path has a symlink ancestor",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a symlink or non-regular final input component is rejected", async () => {
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    const dir = `${dest}/${FIXTURE_DIR}`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.symlink("request.json", `${dir}/upstream.json`);
    await Deno.mkdir(`${dir}/request.json`, { recursive: true });
  };
  const ctx = await scriptedContext({ onClone });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: foreign dispatch metadata bytes are rejected before any execution", async () => {
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    await Deno.writeTextFile(
      `${dest}/${SENTINEL_REPLAY_INPUT_PATH}`,
      '{"version":"v1","requestPath":"tests/elsewhere/request.json",' +
        '"upstreamPath":"tests/elsewhere/upstream.json","testIds":["other"]}',
    );
  };
  const ctx = await scriptedContext({ onClone });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
      "foreign dispatch metadata must reject before any consumer run",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a symlinked dispatch metadata target is rejected before any execution", async () => {
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    await Deno.symlink(
      "scripts/replay.ts",
      `${dest}/${SENTINEL_REPLAY_INPUT_PATH}`,
    );
  };
  const ctx = await scriptedContext({ onClone });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
      "symlinked dispatch metadata must reject before any consumer run",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: a directory at the dispatch metadata target is rejected before any execution", async () => {
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    await Deno.mkdir(`${dest}/${SENTINEL_REPLAY_INPUT_PATH}`, {
      recursive: true,
    });
  };
  const ctx = await scriptedContext({ onClone });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
      "directory dispatch metadata must reject before any consumer run",
    );
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: byte-identical existing dispatch metadata is accepted untouched in both snapshots", async () => {
  const exact = encode(expectedDispatchText());
  const seen: string[] = [];
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    await Deno.writeFile(`${dest}/${SENTINEL_REPLAY_INPUT_PATH}`, exact);
    seen.push(await Deno.readTextFile(`${dest}/${SENTINEL_REPLAY_INPUT_PATH}`));
  };
  const ctx = await scriptedContext({
    onClone,
    consumer: () => intendedFailResult(),
  });
  try {
    const proof = await ctx.verify(await verifierInput());
    assert.notEqual(
      proof,
      null,
      "identical existing metadata must be accepted",
    );
    assert.equal(seen.length, 2, "both snapshots carried existing metadata");
    for (const text of seen) {
      assert.equal(text, expectedDispatchText());
    }
    for (const record of ctx.runtime.consumerRecords) {
      assert.equal(
        record.snapshotText[SENTINEL_REPLAY_INPUT_PATH],
        expectedDispatchText(),
        "the identical record is never rewritten",
      );
    }
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("causal verifier: whole-snapshot preflight rejects a foreign dispatch metadata target before any private write", async () => {
  // The sanitized snapshot's dispatch metadata target already holds FOREIGN
  // bytes. The whole-snapshot preflight must reject BEFORE any write — no
  // metadata and no private original bytes may be placed anywhere. The task
  // directory is made execute-only after both snapshots are materialized so
  // the verifier's best-effort cleanup cannot enumerate or remove the
  // evidence; the test restores permissions and removes it in teardown.
  const canaryPath = "public-canary.txt";
  const canaryBytes = "synthetic-public-canary-v1\n";
  let taskDir: string | null = null;
  const onClone = async (dest: string) => {
    await materialize(dest, consumerFiles());
    if (dest.endsWith("/original")) {
      // Public synthetic canary: cleanup must not erase original evidence.
      await Deno.writeTextFile(`${dest}/${canaryPath}`, canaryBytes);
      return;
    }
    if (!dest.endsWith("/sanitized")) return;
    await Deno.writeTextFile(
      `${dest}/${SENTINEL_REPLAY_INPUT_PATH}`,
      '{"version":"v1","foreign":true}',
    );
    taskDir = dest.slice(0, dest.lastIndexOf("/"));
    // Execute-only: preflight can reach known child paths, but recursive
    // cleanup cannot enumerate (and thus cannot delete) snapshot contents.
    await Deno.chmod(taskDir, 0o100);
  };
  const ctx = await scriptedContext({ onClone });
  try {
    assert.equal(await ctx.verify(await verifierInput()), null);
    assert.equal(
      ctx.runtime.runs.filter((input) => input.executable !== "git").length,
      0,
      "no consumer may run after a preflight rejection",
    );
    assert.notEqual(taskDir, null, "both snapshots must have been cloned");
    const root = taskDir!;
    // Execute-only taskDir blocks recursive cleanup enumeration, so this
    // canary proves original evidence survived verify: the absence checks
    // below cannot be cleanup artifacts.
    assert.equal(
      await Deno.readTextFile(`${root}/original/${canaryPath}`),
      canaryBytes,
      "original snapshot canary must survive verify cleanup",
    );
    // The original snapshot received NOTHING (no metadata, no private bytes).
    for (
      const path of [SENTINEL_REPLAY_INPUT_PATH, REQUEST_PATH, UPSTREAM_PATH]
    ) {
      let exists = true;
      try {
        await Deno.lstat(`${root}/original/${path}`);
      } catch {
        exists = false;
      }
      assert.equal(
        exists,
        false,
        `original/${path} must not be written before the whole preflight passes`,
      );
    }
    // The sanitized snapshot's input destinations are untouched too.
    for (const path of [REQUEST_PATH, UPSTREAM_PATH]) {
      let exists = true;
      try {
        await Deno.lstat(`${root}/sanitized/${path}`);
      } catch {
        exists = false;
      }
      assert.equal(
        exists,
        false,
        `sanitized/${path} must not be written before the whole preflight passes`,
      );
    }
    // The foreign bytes are untouched (never rewritten, never removed).
    assert.equal(
      await Deno.readTextFile(
        `${root}/sanitized/${SENTINEL_REPLAY_INPUT_PATH}`,
      ),
      '{"version":"v1","foreign":true}',
    );
  } finally {
    if (taskDir !== null) {
      await Deno.chmod(taskDir, 0o700).catch(() => {});
    }
    await ctx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GROUP C: execution semantics (scripted consumer runs)
// ---------------------------------------------------------------------------
