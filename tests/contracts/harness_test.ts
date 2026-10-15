// Hermetic-harness regression: the harness must wait for removal of its
// task-created temp home on BOTH success and failure before exiting. The
// regression under test is the failure path: the previous harness called
// `Deno.exit(1)` from inside the try block, which terminates the process
// without running the finally cleanup, and its cleanup call was not awaited.
//
// This test runs the actual test-local.ts harness from a disposable cwd whose
// deliberately unformatted file makes `deno fmt --check` (the first step)
// fail, then asserts the harness exited non-zero and left no
// `sentinel-test-local-*` directory behind. No new flags or environment
// switches are introduced: the harness is invoked exactly like
// `deno task test:local` from the disposable cwd.
import assert from "node:assert/strict";

// Repository root, derived without any remote package: the harness lives at
// <root>/tests/contracts/harness_test.ts.
const here = new URL(import.meta.url);
if (here.protocol !== "file:") throw new Error("expected a file: test module");
const rootDir = decodeURIComponent(here.pathname).replace(
  /\/tests\/contracts\/harness_test\.ts$/,
  "",
);

Deno.test("test:local failure path removes its temp home before exiting", async () => {
  // The workspace root is always writable in the harness context, so the
  // disposable cwd lives there (gitignored via /sentinel-harness-failure-*/).
  const disposable = await Deno.makeTempDir({
    prefix: "sentinel-harness-failure-",
    dir: rootDir,
  });
  try {
    // Deliberately unformatted file: `deno fmt --check` fails on it.
    // Deliberately unformatted file: `deno fmt --check` fails on it. The
    // disposable cwd also carries a minimal local deno.json so the harness
    // (run from that cwd) does not inherit this repository's fmt include
    // list via config discovery from a parent directory.
    await Deno.writeTextFile(`${disposable}/bad-format.ts`, "const x=1;  \n");
    await Deno.writeTextFile(
      `${disposable}/deno.json`,
      JSON.stringify({ fmt: { include: ["bad-format.ts"] } }),
    );
    const result = await new Deno.Command("deno", {
      args: [
        "run",
        "--allow-env=PATH",
        "--allow-run=deno",
        "--allow-write",
        `${rootDir}/test-local.ts`,
      ],
      cwd: disposable,
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: `${disposable}/home`,
        DENO_DIR: `${disposable}/deno-cache`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assert.equal(result.success, false, `harness should fail, got: ${output}`);
    assert.match(output, /test:local failed at step: deno fmt --check/);
    // The harness must have awaited the removal of its temp home before
    // exiting; no sentinel-test-local-* directory may remain.
    const leftovers = [];
    for await (const entry of Deno.readDir(disposable)) {
      if (entry.name.startsWith("sentinel-test-local-")) {
        leftovers.push(entry.name);
      }
    }
    assert.deepEqual(leftovers, []);
  } finally {
    await Deno.remove(disposable, { recursive: true }).catch(() => {});
  }
});

Deno.test("test:local multi-root discovery keeps dependency cache in its isolated step", async () => {
  const disposable = await Deno.makeTempDir({
    prefix: "sentinel-harness-failure-discovery-",
    dir: rootDir,
  });
  try {
    const directories = [
      "contracts",
      "state",
      "budget",
      "github",
      "host",
      "adapters/gateway",
      "replay",
      "repair",
      "release",
      "integration",
    ];
    for (const directory of directories) {
      await Deno.mkdir(`${disposable}/tests/${directory}`, { recursive: true });
    }
    await Deno.writeTextFile(`${disposable}/deno.json`, "{}");
    await Deno.writeTextFile(
      `${disposable}/tests/contracts/main_test.ts`,
      `Deno.test("main permission boundary", async () => {
  const access = await Deno.permissions.query({ name: "read", path: "/tmp" });
  if (access.state === "granted") throw new Error("main gained temp access");
});\n`,
    );
    await Deno.writeTextFile(
      `${disposable}/tests/replay/dependency-cache_test.ts`,
      `Deno.test("isolated cache permission boundary", async () => {
  const temp = await Deno.permissions.query({ name: "read", path: "/tmp" });
  const workspace = await Deno.permissions.query({ name: "write", path: "." });
  const network = await Deno.permissions.query({ name: "net" });
  const credential = await Deno.permissions.query({ name: "env", variable: "GITHUB_TOKEN" });
  if (temp.state !== "granted") throw new Error("cache entered main step");
  if (workspace.state === "granted" || network.state === "granted" || credential.state === "granted") {
    throw new Error("isolated cache boundary widened");
  }
});\n`,
    );
    // Skip unrelated toolchain checks, but execute both actual test commands.
    // Recording argv also proves the isolated step keeps its narrow grants.
    const commandsPath = `${disposable}/commands.jsonl`;
    const shimPath = `${disposable}/shim.ts`;
    await Deno.writeTextFile(
      shimPath,
      `await Deno.writeTextFile(${
        JSON.stringify(commandsPath)
      }, JSON.stringify(Deno.args) + "\\n", { append: true });
const child = new Deno.Command(${JSON.stringify(Deno.execPath())}, {
  args: Deno.args, stdout: "inherit", stderr: "inherit",
}).spawn();
Deno.exit((await child.status).code);\n`,
    );
    const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const bin = `${disposable}/bin`;
    await Deno.mkdir(bin);
    await Deno.writeTextFile(
      `${bin}/deno`,
      `#!/bin/sh
if [ "$1" != test ]; then exit 0; fi
exec ${shellQuote(Deno.execPath())} run --no-config --allow-write=${
        shellQuote(disposable)
      } --allow-run=${shellQuote(Deno.execPath())} ${shellQuote(shimPath)} "$@"
`,
    );
    await Deno.chmod(`${bin}/deno`, 0o700);
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-env=PATH",
        "--allow-run=deno",
        "--allow-write",
        `${rootDir}/test-local.ts`,
      ],
      cwd: disposable,
      clearEnv: true,
      env: {
        PATH: `${bin}:${Deno.env.get("PATH") ?? "/usr/bin:/bin"}`,
        HOME: `${disposable}/home`,
        DENO_DIR: `${disposable}/deno-cache`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const output = new TextDecoder().decode(result.stdout) +
      new TextDecoder().decode(result.stderr);
    assert.equal(result.code, 0, output);
    const commands: string[][] = (await Deno.readTextFile(commandsPath)).trim()
      .split("\n").map((line) => JSON.parse(line));
    assert.equal(commands.length, 2, output);
    assert.equal(
      commands[0].find((arg) => arg.startsWith("--allow-read=")),
      `--allow-read=.,/usr,/bin,${Deno.execPath()}`,
    );
    assert.deepEqual(commands[1], [
      "test",
      `--allow-read=.,/usr,/bin,${Deno.execPath()},/opt/node-lts/bin/node,/tmp`,
      "--allow-run",
      "--allow-write=/tmp",
      "--allow-env=PATH,NODE_V8_COVERAGE",
      "tests/replay/dependency-cache_test.ts",
    ]);
    assert.equal(
      (output.match(/main permission boundary \.\.\./g) ?? []).length,
      1,
    );
    assert.equal(
      (output.match(/isolated cache permission boundary \.\.\./g) ?? []).length,
      1,
    );
  } finally {
    await Deno.remove(disposable, { recursive: true });
  }
});

Deno.test("test:integration grants what its own integration cases require", async () => {
  // Integration cases spawn real Deno children (Deno.execPath()) and the real
  // replay runtime, whose node child-process layer reads NODE_V8_COVERAGE, so
  // the task carries the same grants the aggregate test task already has.
  const manifest = JSON.parse(
    await Deno.readTextFile(new URL("../../deno.json", import.meta.url)),
  ) as { tasks: Record<string, string> };
  const task = manifest.tasks["test:integration"];
  assert.ok(/--allow-run(\s|$)/.test(task), "bare --allow-run");
  assert.ok(
    task.includes("$(deno eval 'console.log(Deno.execPath())')"),
    "read access to the running Deno executable",
  );
  assert.ok(
    /--allow-env=\S*NODE_V8_COVERAGE/.test(task),
    "the replay runtime may read NODE_V8_COVERAGE",
  );
  assert.ok(task.endsWith("tests/integration/"));
});
