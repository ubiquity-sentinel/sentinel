import assert from "node:assert/strict";
import {
  exceedsCeiling,
  formatInventory,
  inventoryCode,
  isTestCode,
  measureCode,
  physicalLines,
} from "../../ops/code-size.ts";

const encoder = new TextEncoder();
const script = new URL("../../ops/code-size.ts", import.meta.url);
const harness = new URL("../../test-local.ts", import.meta.url);

function measure(path: string, text: string) {
  return measureCode(path, encoder.encode(text));
}

Deno.test("code size counts blanks, comments and unterminated physical lines", () => {
  for (
    const [text, count] of [
      ["", 0],
      ["export {};", 1],
      ["export {};\n", 1],
      ["\n", 1],
      ["// comment\n\nexport {};\n", 3],
      ["a\r\nb\r\n", 2],
      ["a\rb\r", 2],
      ["a\u2028b\u2029", 2],
      ["a\n\n", 2],
      ["a\r\n\r\nb", 3],
    ] as const
  ) assert.equal(physicalLines(text), count, JSON.stringify(text));
  assert.equal(measure("src/unicode.ts", "// café\n").bytes, 9);
});

Deno.test("code size recognizes test directories and dot/underscore test names", () => {
  for (
    const path of [
      "tests/contracts/helper.ts",
      "test/example.ts",
      "src/__tests__/helper.tsx",
      "src/parser.test.ts",
      "ops/run_test.ts",
      "src/parser.spec.mts",
      "ops/run_spec.js",
    ]
  ) assert.equal(isTestCode(path), true, path);
  for (
    const path of ["src/testing.ts", "src/test-util.ts", "ops/test-local.ts"]
  ) {
    assert.equal(isTestCode(path), false, path);
  }
});

Deno.test("code size enforces exact source/test ceilings; review triggers only report", () => {
  for (
    const [path, ceiling, review] of [
      ["ops/tool.ts", 1000, 500],
      ["tests/contracts/tool_test.ts", 1500, 800],
    ] as const
  ) {
    const atLimit = measure(path, "// comment\n".repeat(ceiling));
    assert.equal(atLimit.lines, ceiling);
    assert.equal(atLimit.ceiling, ceiling);
    assert.equal(atLimit.review, review);
    assert.equal(exceedsCeiling(atLimit), false);
    assert.equal(exceedsCeiling(measure(path, "\n".repeat(ceiling + 1))), true);
    assert.equal(
      exceedsCeiling(measure(path, "x\n".repeat(ceiling) + "x")),
      true,
    );
    const reviewOnly = measure(path, "\n".repeat(review + 1));
    assert.equal(exceedsCeiling(reviewOnly), false);
    assert.match(
      formatInventory({ files: [reviewOnly], deleted: [] }),
      /\treview\t/,
    );
    assert.match(
      formatInventory({ files: [atLimit], deleted: [] }),
      /0 over ceiling/,
    );
  }
});

async function git(root: string, ...args: string[]) {
  const result = await new Deno.Command("git", {
    args,
    cwd: root,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(result.success, true, new TextDecoder().decode(result.stderr));
}

async function withRepository(run: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "sentinel-code-size-" });
  try {
    await git(root, "init", "--quiet");
    await Deno.writeTextFile(
      `${root}/.gitignore`,
      "ignored/\nignored.ts\ntracked-ignored.ts\n/.deno-cache/\n/home/\n/sentinel-test-local-*/\n",
    );
    await run(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function write(root: string, path: string, text: string) {
  const parent = path.lastIndexOf("/");
  if (parent !== -1) {
    await Deno.mkdir(`${root}/${path.slice(0, parent)}`, { recursive: true });
  }
  await Deno.writeTextFile(`${root}/${path}`, text);
}

Deno.test("code size inventory includes tracked, new, ops and shebang code without ignore gaps", async () => {
  await withRepository(async (root) => {
    await write(root, "src/tracked.ts", "export {};\n");
    await write(root, "tracked-ignored.ts", "// tracked despite ignore\n");
    await write(root, "src/deleted.ts", "export {};\n");
    await git(root, "add", "src/tracked.ts", "src/deleted.ts");
    await git(root, "add", "--force", "tracked-ignored.ts");
    await Deno.remove(`${root}/src/deleted.ts`);
    await write(root, "ops/new.ts", "\n".repeat(1001));
    await write(root, ".github/new.ts", "// outside fmt/lint include\n");
    await write(root, "ops/space and\nnewline.ts", "// nul-separated path\n");
    await write(root, "tests/helpers/fixture.ts", "// test helper\n");
    await write(root, "src/view.tsx", "export {};\n");
    await write(root, "bin/tool", "#!/bin/sh\nexit 0\n");
    await write(root, "ignored.ts", "\n".repeat(1001));
    await write(root, "ignored/huge.ts", "\n".repeat(1001));
    await write(root, "data.json", "{}\n");
    const inventory = await inventoryCode(root);
    assert.deepEqual(inventory.files.map((entry) => entry.path), [
      ".github/new.ts",
      "bin/tool",
      "ops/new.ts",
      "ops/space and\nnewline.ts",
      "src/tracked.ts",
      "src/view.tsx",
      "tests/helpers/fixture.ts",
      "tracked-ignored.ts",
    ]);
    assert.deepEqual(inventory.deleted, ["src/deleted.ts"]);
    assert.deepEqual(
      inventory.files.filter(exceedsCeiling).map((entry) => entry.path),
      ["ops/new.ts"],
    );
    assert.equal(
      inventory.files.find((entry) => entry.path === "tests/helpers/fixture.ts")
        ?.ceiling,
      1500,
    );
    assert.match(
      formatInventory(inventory),
      /1 over ceiling; 1 deleted tracked paths/,
    );
    assert.match(formatInventory(inventory), /space and\\nnewline\.ts/);
    await assert.rejects(() => inventoryCode(`${root}/src`), /worktree root/);
  });
});

Deno.test("code size refuses symlinks instead of silently skipping their code", async () => {
  await withRepository(async (root) => {
    await write(root, "src/real.ts", "export {};\n");
    await Deno.symlink("real.ts", `${root}/src/link.ts`);
    await assert.rejects(
      () => inventoryCode(root),
      /regular file.*src\/link\.ts/,
    );
  });
});

function childEnvironment(root: string) {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: `${root}/home`,
    DENO_DIR: `${root}/.deno-cache`,
  };
}

function output(result: Deno.CommandOutput): string {
  return new TextDecoder().decode(result.stdout) +
    new TextDecoder().decode(result.stderr);
}

async function cli(root: string, mode: string) {
  return await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-lock",
      `--allow-read=${root}`,
      "--allow-run=git",
      script.pathname,
      mode,
    ],
    cwd: root,
    clearEnv: true,
    env: childEnvironment(root),
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("code size CLI reports violations, fails enforcement, then passes repaired input", async () => {
  await withRepository(async (root) => {
    await write(root, "ops/new.ts", "// comment\n".repeat(1001));
    const report = await cli(root, "report");
    assert.equal(report.code, 0, output(report));
    assert.match(output(report), /OVER CEILING.*ops\/new\.ts/);
    const failed = await cli(root, "check");
    assert.equal(failed.code, 1, output(failed));
    await write(root, "ops/new.ts", "// comment\n".repeat(1000));
    const passed = await cli(root, "check");
    assert.equal(passed.code, 0, output(passed));
    assert.match(output(passed), /0 over ceiling/);
  });
});

Deno.test("test:local size gate stops before later stages and cleans its owned temp home", async () => {
  await withRepository(async (root) => {
    await write(root, "src/okay.ts", "export {};\n");
    await write(root, "ops/code-size.ts", await Deno.readTextFile(script));
    await write(root, "ops/too-large.sh", "# comment\n".repeat(1001));
    await write(
      root,
      "deno.json",
      JSON.stringify({
        fmt: { include: ["src/okay.ts"] },
        lint: { include: ["src/okay.ts"] },
      }),
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--no-lock",
        "--allow-env=PATH",
        "--allow-run=deno",
        "--allow-write",
        harness.pathname,
      ],
      cwd: root,
      clearEnv: true,
      env: childEnvironment(root),
      stdout: "piped",
      stderr: "piped",
    }).output();
    assert.equal(result.code, 1, output(result));
    assert.match(output(result), /OVER CEILING.*ops\/too-large\.sh/);
    assert.match(
      output(result),
      /test:local failed at step: deno run .*ops\/code-size\.ts check/,
    );
    assert.doesNotMatch(output(result), /src\/contracts\/mod\.ts/);
    const leftovers = [];
    for await (const entry of Deno.readDir(root)) {
      if (entry.name.startsWith("sentinel-test-local-")) {
        leftovers.push(entry.name);
      }
    }
    assert.deepEqual(leftovers, []);
  });
});
