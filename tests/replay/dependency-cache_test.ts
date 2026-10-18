import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { preparePublicDependencyCache } from "../../src/replay/dependency-cache.ts";
import type { ReplayDependencyCacheV1 } from "../../src/replay/dependency-cache.ts";
import { LinuxReplayIsolation } from "../../src/replay/isolation.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";

const SOURCE_SHA = "1".repeat(40);
const INPUTS: Record<string, string> = {
  "deno.json": JSON.stringify({ imports: {}, nodeModulesDir: "none" }),
  "deno.lock": JSON.stringify({
    version: "5",
    specifiers: {},
    jsr: {},
    npm: {},
  }),
  "tools/lint/package.json": JSON.stringify({
    name: "public-fixture",
    version: "1.0.0",
    private: true,
  }),
  "tools/lint/bun.lock": JSON.stringify({
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: { "": { name: "public-fixture" } },
    packages: {},
  }),
  "scripts/verify.sh": "#!/bin/sh\nexit 0\n",
  "scripts/_bootstrap.sh": "# public fixture bootstrap\n",
  "entry.ts": "export const value = 1;\n",
};

async function fixture() {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-dependency-test-",
  });
  const checkout = `${root}/checkout`;
  for (const [path, text] of Object.entries(INPUTS)) {
    const target = `${checkout}/${path}`;
    await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
      recursive: true,
    });
    await Deno.writeTextFile(target, text);
  }
  const cache = await preparePublicDependencyCache({
    sourceDir: checkout,
    sourceSha: SOURCE_SHA,
    root: `${root}/seed`,
    entrypoints: ["entry.ts"],
    runtime: {
      run: async (input) => {
        assert.equal(input.env.HOME, `${root}/seed/preparation-home`);
        if (input.args[0] === "install") {
          assert.ok(input.args.includes("--frozen-lockfile"));
          assert.ok(input.args.includes("--ignore-scripts"));
          await Deno.writeTextFile(
            `${root}/seed/tools/node_modules/public-tool`,
            "public fixture tool",
          );
        } else {
          assert.ok(input.args.includes("--frozen"));
          await Deno.writeTextFile(
            `${root}/seed/deno/public-module`,
            "public fixture module",
          );
        }
        return {
          outcome: "exited",
          exitCode: 0,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          truncated: false,
          settled: true,
          detail: "scripted public downloader",
        };
      },
    },
  }).catch(async (error) => {
    await Deno.remove(root, { recursive: true });
    throw error;
  });
  return { root, checkout, cache };
}

async function hash(bytes: Uint8Array): Promise<string> {
  const result = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return [...new Uint8Array(result)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

async function symlink(target: string, path: string): Promise<void> {
  const result = await new Deno.Command("/bin/ln", {
    args: ["-s", target, path],
    clearEnv: true,
    env: { PATH: "/usr/bin:/bin" },
  }).output();
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
}

async function rewriteManifest(
  cache: ReplayDependencyCacheV1,
  change: (manifest: Record<string, unknown>) => void,
) {
  const path = `${cache.root}/manifest.json`;
  const manifest = JSON.parse(await Deno.readTextFile(path));
  change(manifest);
  const text = canonicalStringify(manifest);
  await Deno.writeTextFile(path, text);
  return {
    ...cache,
    manifestDigest: await hash(new TextEncoder().encode(text)),
  };
}

Deno.test("trusted dependency cache: scripted public preparation and real isolated consumption keep seed immutable and network/credentials denied", async () => {
  const { root, checkout, cache } = await fixture();
  const manifestBefore = await Deno.readTextFile(`${cache.root}/manifest.json`);
  try {
    await Deno.writeTextFile(`${root}/host-only`, "not mounted");
    const isolation = new LinuxReplayIsolation(root, {
      dependencyCache: cache,
    });
    const program = `
const result = {};
try { await Deno.writeTextFile(${
      JSON.stringify(`${checkout}/tools/lint/node_modules/tamper`)
    }, "changed"); result.toolsReadOnly = false; }
catch (error) { result.toolsReadOnly = /[Rr]ead-only file ?system|EROFS/.test(String(error)); }
await Deno.writeTextFile("/tmp/deno/private-write", "private");
result.privateCacheWritable = true;
try { await Deno.readTextFile(${
      JSON.stringify(`${root}/host-only`)
    }); result.hostSiblingDenied = false; }
catch { result.hostSiblingDenied = true; }
result.hostCredential = Deno.env.get("SENTINEL_CACHE_CANARY") ?? null;
try { const connection = await Deno.connect({ hostname: "1.1.1.1", port: 80 }); connection.close(); result.networkDenied = false; }
catch { result.networkDenied = true; }
const node = await new Deno.Command("/tmp/public-tools/node", { args: ["--version"] }).output();
result.pinnedNodeWorks = node.code === 0;
console.log(JSON.stringify(result));
`;
    await Deno.writeTextFile(`${checkout}/consumer.ts`, program);
    const result = await isolation.run({
      executable: "deno",
      args: [
        "run",
        "--no-config",
        "--no-prompt",
        "--allow-read",
        "--allow-write",
        "--allow-net",
        "--allow-env",
        "--allow-run",
        "consumer.ts",
      ],
      cwd: checkout,
      env: { SENTINEL_CACHE_CANARY: "synthetic-private-canary" },
      maxDurationMs: 10_000,
      maxOutputBytes: 65_536,
    }, "read-write");
    assert.equal(result.outcome, "exited");
    assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
    assert.equal(result.settled, true);
    assert.deepEqual(JSON.parse(new TextDecoder().decode(result.stdout)), {
      toolsReadOnly: true,
      privateCacheWritable: true,
      hostSiblingDenied: true,
      hostCredential: null,
      networkDenied: true,
      pinnedNodeWorks: true,
    });
    assert.equal(
      await Deno.readTextFile(`${cache.root}/manifest.json`),
      manifestBefore,
    );
    await assert.rejects(
      Deno.stat(`${cache.root}/deno/private-write`),
      Deno.errors.NotFound,
    );
    const leftovers = [];
    for await (const entry of Deno.readDir(root)) {
      if (entry.name.startsWith("sentinel-dependency-run-")) {
        leftovers.push(entry.name);
      }
    }
    assert.deepEqual(leftovers, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("trusted dependency cache: source lock runtime platform tamper symlink and private configuration refuse before target execution", async (test) => {
  const { root, checkout, cache } = await fixture();
  const manifestPath = `${cache.root}/manifest.json`;
  const originalManifest = await Deno.readTextFile(manifestPath);
  const runtime = new DenoReplayRuntime("/usr/local/bin:/usr/bin:/bin");
  let invocations = 0;
  const runner = {
    run: (input: Parameters<DenoReplayRuntime["run"]>[0]) => {
      invocations++;
      return runtime.run(input);
    },
  };
  async function refuses(descriptor = cache) {
    const before = invocations;
    const result = await new LinuxReplayIsolation(root, {
      dependencyCache: descriptor,
      runtime: runner,
    }).run({
      executable: "deno",
      args: ["eval", "throw new Error('must never run')"],
      cwd: checkout,
      env: {},
      maxDurationMs: 1000,
      maxOutputBytes: 1024,
    }, "read-write");
    assert.equal(result.outcome, "spawn_failed");
    assert.equal(result.settled, true);
    assert.equal(invocations, before);
  }
  try {
    await test.step("seed root symlink", async () => {
      const alias = `${root}/seed-alias`;
      await symlink(cache.root, alias);
      try {
        await refuses({ ...cache, root: alias });
      } finally {
        await Deno.remove(alias);
      }
    });
    await test.step("run scratch symlink", async () => {
      const alias = `${root}/scratch-alias`;
      await symlink(root, alias);
      try {
        await refuses({ ...cache, runScratchDir: alias });
      } finally {
        await Deno.remove(alias);
      }
    });
    await test.step("preparation requires canonical paths and a real parent", async () => {
      let downloads = 0;
      const prepare = (seed: string) =>
        preparePublicDependencyCache({
          sourceDir: checkout,
          sourceSha: SOURCE_SHA,
          root: seed,
          entrypoints: ["entry.ts"],
          runtime: {
            run: () => {
              downloads++;
              throw new Error("unsafe preparation must never run");
            },
          },
        });
      for (
        const path of ["relative", "/", `${root}/../seed`, `${root}//seed`]
      ) {
        await assert.rejects(prepare(path), /task-owned absolute path/);
      }
      const alias = `${root}/parent-alias`;
      await symlink(checkout, alias);
      try {
        await assert.rejects(prepare(`${alias}/seed`), /must not be a symlink/);
        await assert.rejects(
          Deno.stat(`${checkout}/seed`),
          Deno.errors.NotFound,
        );
      } finally {
        await Deno.remove(alias);
      }
      await assert.rejects(prepare(cache.root), Deno.errors.AlreadyExists);
      assert.equal(downloads, 0);
      assert.equal(await Deno.readTextFile(manifestPath), originalManifest);
    });
    await test.step("source identity mismatch", () =>
      refuses({ ...cache, sourceSha: "2".repeat(40) }));
    await test.step("lock mismatch", async () => {
      await Deno.writeTextFile(`${checkout}/deno.lock`, "{}");
      try {
        await refuses();
      } finally {
        await Deno.writeTextFile(`${checkout}/deno.lock`, INPUTS["deno.lock"]);
      }
    });
    for (const field of ["denoVersion", "platform"]) {
      await test.step(`${field} mismatch with a correctly hashed manifest`, async () => {
        const altered = await rewriteManifest(cache, (manifest) => {
          (manifest.runtime as Record<string, unknown>)[field] = "different";
        });
        try {
          await refuses(altered);
        } finally {
          await Deno.writeTextFile(manifestPath, originalManifest);
        }
      });
    }
    await test.step("manifest tamper", async () => {
      await Deno.writeTextFile(manifestPath, originalManifest + " ");
      try {
        await refuses();
      } finally {
        await Deno.writeTextFile(manifestPath, originalManifest);
      }
    });
    await test.step("public dependency byte tamper", async () => {
      const path = `${cache.root}/deno/unrecorded`;
      await Deno.writeTextFile(path, "changed");
      try {
        await refuses();
      } finally {
        await Deno.remove(path);
      }
    });
    await test.step("escaping seed symlink to an existing public file", async () => {
      const outside = `${root}/outside-public`;
      const link = `${cache.root}/tools/node_modules/escape`;
      await Deno.writeTextFile(outside, "outside");
      await symlink(outside, link);
      try {
        await refuses();
      } finally {
        await Deno.remove(link);
      }
    });
    await test.step("protected source input symlink", async () => {
      const path = `${checkout}/deno.lock`;
      await Deno.rename(path, `${path}.real`);
      await symlink(`${path}.real`, path);
      try {
        await refuses();
      } finally {
        await Deno.remove(path);
        await Deno.rename(`${path}.real`, path);
      }
    });
    await test.step("private package configuration", async () => {
      const path = `${checkout}/.npmrc`;
      await Deno.writeTextFile(path, "synthetic-private-config");
      try {
        await refuses();
      } finally {
        await Deno.remove(path);
      }
    });
    await test.step("candidate symlink cannot redirect the authoritative tool bind", async () => {
      const destination = `${checkout}/tools/lint/node_modules`;
      await Deno.mkdir(destination, { recursive: true });
      await Deno.remove(destination);
      await symlink(`${root}/outside-public`, destination);
      try {
        await refuses();
      } finally {
        await Deno.remove(destination);
      }
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
