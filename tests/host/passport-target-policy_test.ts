import assert from "node:assert/strict";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import {
  createDefaultBranchResolver,
  createTargetConfigV1,
  loadTargetConfigsV1,
} from "../../src/host/targets.ts";
import { ReplayPortImpl } from "../../src/replay/port.ts";
import type { ReplayCommandInputV1 } from "../../src/replay/runtime.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  createPassportDependencyPreparer,
  PASSPORT_DEPENDENCY_REFUSAL,
} from "../../src/host/passport-dependencies.ts";
import { LocalCheckoutModelPort } from "../../src/host/local-model.ts";
import { localCheckoutKey } from "../../src/host/local-checkout.ts";
import {
  DependencyTracker,
  fixtureSymlink,
} from "./self-dependency-fixtures.ts";
import { modelRequest } from "./local-test-helpers.ts";
import { FakeClock } from "../repair/helpers.ts";
import { T0 } from "../state/helpers.ts";
import {
  createToyApp,
  gitRun,
  replayRequest,
  testGitEnv,
  toyBundle,
  ToyFixtureResolver,
  toyIsolation,
  toyOptions,
} from "../replay/helpers.ts";

const TARGET = {
  slug: "ubiquity/passport.ubq.fi",
  owner: "ubiquity",
  name: "passport.ubq.fi",
};
const template = createLocalRepositoryConfig();

Deno.test("Passport policy: actual target loading resolves main and replaces Sentinel commands", async () => {
  const result = await loadTargetConfigsV1({
    template,
    readFile: () => Promise.resolve(JSON.stringify([TARGET.slug])),
    resolveDefaultBranch: createDefaultBranchResolver({
      token: "synthetic-token",
      http: (request) => {
        assert.equal(
          request.url,
          `https://api.github.com/repos/${TARGET.slug}`,
        );
        return Promise.resolve({
          status: 200,
          headers: new Headers(),
          bodyText: '{"default_branch":"main"}',
        });
      },
    }),
  });
  assert.equal(result.configs.length, 1);
  const config = result.configs[0];
  assert.equal(config.baseBranch, "main");
  assert.equal(config.adapter.kind, "github");
  assert.equal(config.commands.test, "passport_verify");
  assert.equal(config.commands.replay, config.commands.test);
  assert.deepEqual(config.commandRegistry.commands[config.commands.test].args, [
    "--no-env-file",
    "run",
    "check",
  ]);
  assert.equal(
    config.commandRegistry.commands[config.commands.test].executable,
    "bun",
  );
  for (
    const path of [
      "package.json",
      "bun.lock",
      "scripts/",
      "kv-service/",
      "wrangler.jsonc",
    ]
  ) {
    assert(config.protectedPaths.includes(path), path);
  }
  for (const path of template.protectedPaths) {
    assert(config.protectedPaths.includes(path), path);
  }
});

Deno.test("Passport policy: exact identity defeats slug and template command spoofing", () => {
  const hostile = structuredClone(template);
  hostile.commandRegistry.commands[hostile.commands.test].args = [
    "task",
    "deploy",
  ];
  const selected = createTargetConfigV1(hostile, TARGET, "trunk");
  assert.deepEqual(
    selected.commandRegistry.commands[selected.commands.test].args,
    [
      "--no-env-file",
      "run",
      "check",
    ],
  );
  assert.equal(selected.baseBranch, "trunk");
  const foreign = createTargetConfigV1(template, {
    ...TARGET,
    owner: "foreign",
  }, "main");
  assert.deepEqual(foreign.commandRegistry, template.commandRegistry);
});

Deno.test("Passport policy: real verification consumer executes only the named native check", async () => {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: ".", prefix: ".passport-policy-" }),
  );
  try {
    const app = await createToyApp(`${root}/source`);
    const config = createTargetConfigV1(template, TARGET, "main");
    const calls: ReplayCommandInputV1[] = [];
    const isolation = toyIsolation({
      run: (input) => {
        calls.push(input);
        return Promise.resolve({
          outcome: "exited",
          exitCode: 0,
          settled: true,
          truncated: false,
          stdout: new TextEncoder().encode(
            "sentinel-replay-test:gateway:stream-termination\n",
          ),
          stderr: new Uint8Array(),
          detail: "synthetic native verification",
        });
      },
    });
    const bundle = toyBundle();
    bundle.entries = bundle.entries.filter((entry) =>
      entry.path.startsWith("tests/")
    );
    const port = new ReplayPortImpl(
      toyOptions(app.root, `${root}/scratch`, {
        config,
        isolation,
        fixtures: new ToyFixtureResolver(bundle),
      }),
    );
    const result = await port.runReplay(
      await replayRequest(bundle, app.candidateSha, {
        repository: config.repository,
        commandId: config.commands.test,
      }),
    );
    assert(result.ok, JSON.stringify(result));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "bun");
    assert.deepEqual(calls[0].args, ["--no-env-file", "run", "check"]);
    assert(!JSON.stringify(calls).includes("synthetic-token"));
    assert(!JSON.stringify(calls).includes("replay:capture"));
    const forged = await port.runReplay(
      await replayRequest(bundle, app.candidateSha, {
        repository: config.repository,
        commandId: "gateway_replay",
      }),
    );
    assert(!forged.ok);
    assert.equal(
      calls.length,
      1,
      "unregistered commands never reach the executor",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function dependencyRig() {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ dir: ".", prefix: ".passport-deps-" }),
  );
  const source = `${root}/source`;
  const scratch = `${root}/scratch`;
  await Deno.mkdir(source);
  await Deno.mkdir(scratch);
  const env = testGitEnv(scratch);
  const git = async (args: string[], cwd = source) => {
    const result = await gitRun(cwd, args, env);
    assert(result.ok, result.stderr);
    return result.stdout.trim();
  };
  await git(["init", "-qb", "main"]);
  await Deno.writeTextFile(
    `${source}/package.json`,
    JSON.stringify({
      name: "synthetic-native-target",
      packageManager: "bun@1.4.0",
      engines: { bun: "1.4.0" },
      scripts: { postinstall: "must-never-execute", check: "synthetic-check" },
    }),
  );
  await Deno.writeTextFile(
    `${source}/bun.lock`,
    "synthetic frozen dependency identity\n",
  );
  await Deno.writeTextFile(`${source}/.gitignore`, "node_modules/\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "synthetic pinned target"]);
  const base = await git(["rev-parse", "HEAD"]) as GitSha;
  const checkout = `${root}/checkout`;
  await git(["clone", "-q", "--no-hardlinks", source, checkout]);
  const request = {
    repository: { owner: TARGET.owner, name: TARGET.name, installationId: 123 },
    checkout,
    sourcePath: source,
    base,
  };
  const calls: ReplayCommandInputV1[] = [];
  const runtime = {
    run: async (input: ReplayCommandInputV1) => {
      calls.push(input);
      assert.equal(input.executable, "/usr/local/bin/bun");
      assert(!JSON.stringify(input.env).includes("credential"));
      assert.equal(input.env.HOME, input.cwd.replace(/\/graph$/, "/home"));
      if (input.args[0] !== "--version") {
        assert.deepEqual(input.args, [
          "--no-env-file",
          "install",
          "--frozen-lockfile",
          "--ignore-scripts",
          "--backend=copyfile",
        ]);
        await Deno.mkdir(`${input.cwd}/node_modules/synthetic`, {
          recursive: true,
        });
        await Deno.mkdir(`${input.cwd}/node_modules/.bin`);
        await Deno.writeTextFile(
          `${input.cwd}/node_modules/synthetic/cli.js`,
          "synthetic executable dependency\n",
          { mode: 0o700 },
        );
        await fixtureSymlink(
          "../synthetic/cli.js",
          `${input.cwd}/node_modules/.bin/synthetic`,
        );
      }
      return {
        outcome: "exited" as const,
        exitCode: 0,
        stdout: new TextEncoder().encode(
          input.args[0] === "--version" ? "1.4.0\n" : "",
        ),
        stderr: new Uint8Array(),
        truncated: false,
        settled: true,
        detail: "synthetic installer",
      };
    },
  };
  const options = { scratch, trustedPath: env.PATH, runtime };
  return {
    root,
    source,
    checkout,
    scratch,
    base,
    calls,
    options,
    request,
    git,
    cleanup: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test("Passport dependencies: exact base installs frozen without hooks or credentials and preserves binary links", async () => {
  const rig = await dependencyRig();
  try {
    const prepare = createPassportDependencyPreparer(rig.options);
    assert.deepEqual(await prepare(rig.request), {
      ok: true,
      value: undefined,
    });
    assert.equal(rig.calls.length, 2);
    assert.equal(
      await Deno.readLink(`${rig.checkout}/node_modules/.bin/synthetic`),
      "../synthetic/cli.js",
    );
    assert.equal(await rig.git(["status", "--porcelain"], rig.checkout), "");
    assert.deepEqual(Object.keys(rig.calls[1].env).sort(), [
      "BUN_INSTALL_CACHE_DIR",
      "BUN_RUNTIME_TRANSPILER_CACHE_PATH",
      "HOME",
      "NODE_V8_COVERAGE",
      "PATH",
      "TMPDIR",
    ]);
    const entries = [];
    for await (const entry of Deno.readDir(rig.scratch)) {
      entries.push(entry.name);
    }
    assert.deepEqual(entries, []);
    assert.deepEqual(await prepare(rig.request), {
      ok: true,
      value: undefined,
    });
  } finally {
    await rig.cleanup();
  }
});

Deno.test("Passport dependencies: changed lock and private configuration refuse before any execution", async (t) => {
  for (
    const mode of ["lock", "package", "dotenv", "config", "symlink"] as const
  ) {
    await t.step(mode, async () => {
      const rig = await dependencyRig();
      try {
        if (mode === "lock") {
          await Deno.writeTextFile(`${rig.checkout}/bun.lock`, "changed");
        }
        if (mode === "package") {
          await Deno.writeTextFile(`${rig.checkout}/package.json`, "{}");
        }
        if (mode === "dotenv") {
          await Deno.writeTextFile(
            `${rig.checkout}/.env`,
            "synthetic-credential-marker",
          );
        }
        if (mode === "config") {
          await Deno.writeTextFile(
            `${rig.checkout}/.npmrc`,
            "synthetic-credential-marker",
          );
        }
        if (mode === "symlink") {
          await Deno.remove(`${rig.checkout}/bun.lock`);
          await fixtureSymlink(
            `${rig.source}/bun.lock`,
            `${rig.checkout}/bun.lock`,
          );
        }
        const result = await createPassportDependencyPreparer(rig.options)(
          rig.request,
        );
        assert(!result.ok);
        if (!result.ok) {
          assert.equal(result.error.detail, PASSPORT_DEPENDENCY_REFUSAL);
        }
        assert.equal(rig.calls.length, 0);
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("Passport dependencies: hostile graphs and unsuccessful installs never reach a model checkout", async (t) => {
  for (
    const mode of [
      "version",
      "exit",
      "truncated",
      "lock-change",
      "escape",
      "existing-link",
    ] as const
  ) {
    await t.step(mode, async () => {
      const rig = await dependencyRig();
      try {
        const original = rig.options.runtime.run;
        rig.options.runtime.run = async (input) => {
          const result = await original(input);
          if (mode === "version") {
            result.stdout = new TextEncoder().encode("1.3.0\n");
          }
          if (mode === "exit") result.exitCode = 1;
          if (mode === "truncated") result.truncated = true;
          if (input.args[0] !== "--version") {
            if (mode === "lock-change") {
              await Deno.writeTextFile(
                `${rig.checkout}/bun.lock`,
                "changed during installation",
              );
            }
            if (mode === "escape") {
              await Deno.remove(`${input.cwd}/node_modules/.bin/synthetic`);
              await fixtureSymlink(
                `${rig.source}/package.json`,
                `${input.cwd}/node_modules/.bin/synthetic`,
              );
            }
          }
          return result;
        };
        if (mode === "existing-link") {
          await fixtureSymlink(rig.source, `${rig.checkout}/node_modules`);
        }
        const result = await createPassportDependencyPreparer(rig.options)(
          rig.request,
        );
        assert(!result.ok);
        if (mode === "existing-link") assert.equal(rig.calls.length, 0);
        else {await assert.rejects(() =>
            Deno.lstat(`${rig.checkout}/node_modules`), Deno.errors.NotFound);}
      } finally {
        await rig.cleanup();
      }
    });
  }
});

Deno.test("Passport dependencies: unrelated target preparations remain untouched", async () => {
  let calls = 0;
  const prepare = createPassportDependencyPreparer({
    scratch: "/nonexistent",
    trustedPath: "/usr/bin:/bin",
    runtime: {
      run: () => {
        calls++;
        throw new Error("must not execute");
      },
    },
  });
  for (const name of ["sentinel", "ai.ubq.fi", "other"]) {
    assert.deepEqual(
      await prepare({
        repository: { owner: "ubiquity", name, installationId: 1 },
        checkout: "/nonexistent",
        sourcePath: "/nonexistent",
        base: "a".repeat(40) as GitSha,
      }),
      { ok: true, value: undefined },
    );
  }
  assert.equal(calls, 0);
});

Deno.test("Passport dependencies: host preparation precedes the actual model client and missing preparation refuses", async () => {
  const rig = await dependencyRig();
  try {
    const stateRoot = `${rig.root}/state`;
    const request = {
      ...modelRequest(),
      repository: rig.request.repository,
      base: rig.base,
    };
    const checkout = `${stateRoot}/checkouts/${await localCheckoutKey(
      request.taskId,
    )}`;
    const tracker = new DependencyTracker(async () => {
      assert.equal(rig.calls.length, 2);
      assert(
        (await Deno.lstat(`${checkout}/node_modules/synthetic/cli.js`)).isFile,
      );
    });
    const input = {
      stateRoot,
      sourcePath: rig.source,
      scratch: rig.scratch,
      trustedPath: rig.options.trustedPath,
      codexExecutable: "/nonexistent/synthetic-codex",
      denoExecutable: Deno.execPath(),
      modelToken: "synthetic-token",
      clock: new FakeClock(T0),
      tracker,
    };
    const missing = await new LocalCheckoutModelPort(input).runModel(request);
    assert(!missing.ok);
    assert.equal(tracker.starts, 0);
    const client = `${stateRoot}/clients/${await localCheckoutKey(
      request.taskId,
    )}`;
    await assert.rejects(() => Deno.lstat(client), Deno.errors.NotFound);
    await new LocalCheckoutModelPort({
      ...input,
      preparePassportDependencies: createPassportDependencyPreparer(
        rig.options,
      ),
    }).runModel(request);
    assert.equal(tracker.starts, 1);
    assert(await tracker.settleAll());
  } finally {
    await rig.cleanup();
  }
});
