/**
 * Runs the exact upstream ai.ubq.fi 6c3afe42 deploy lock, join file storage,
 * journal runner and command runner in a child Deno that holds only the
 * recorded release bridge driver grants (ubiquity-sentinel/sentinel#162), so a
 * missing grant fails here instead of refusing every VPS release at release
 * time. No journalctl or driver command is executed: the journal child gets a
 * missing working directory, and the only command run is `deno --version`.
 */
import assert from "node:assert/strict";
import {
  VPS_RELEASE_BRIDGE_DRIVER_GRANTS,
  vpsReleaseBridgeDriverDenoFlags,
} from "../../src/host/release-bridge-grants.ts";
import {
  DENO_DRIVER_SHA,
  upstreamSource,
} from "../release/vps-driver-fixture.ts";

/** Test-owned probe; every module it imports is the exact upstream source. */
const PROBE = `import { realpath } from "node:fs/promises";
import { acquireDeployLock } from "./ops/deploy-lock.ts";
import { command } from "./ops/io.ts";
import { runVpsJournalCommand } from "./ops/vps-journal-reader.ts";
import { createVpsJoinFileStorage } from "./ops/vps-metrics-storage.ts";

const { target, deno } = JSON.parse(Deno.args[0]);
const refuse = () => Promise.reject(new Error("no cipher use expected"));
const retention = { evidenceMaxAgeMs: 172800000, evidenceMaxBytes: 16777216 };
const steps = {
  lock: async () => {
    (await acquireDeployLock(target + "/.data/deploy.lock"))();
    return "ok";
  },
  storage: async () => {
    const storage = createVpsJoinFileStorage(target, retention, { seal: refuse, open: refuse }, (scope) => Promise.resolve(scope));
    return (await storage.load({ operationId: "a".repeat(64) })) === null ? "ok" : "unexpected";
  },
  journal: async () => {
    const args = ["--unit=ai-ubq-fi.service", "--since=@1", "--until=@2", "--output=json", "--all", "--no-pager"];
    await runVpsJournalCommand(args, { deadline: Date.now() + 5000, maxBytes: 1024, maxEntries: 8 }, target + "/.data/absent");
    return "ran";
  },
  command: async () => {
    await command(deno, ["--version"], { cwd: target });
    return "ok";
  },
  sparse: async () => {
    await command(deno, ["--version"], { cwd: target + "/.data", sparse: true });
    return "ok";
  },
  root: async () => ((await realpath(target)) === target ? "ok" : "unexpected"),
};
const result = {};
for (const [name, step] of Object.entries(steps)) {
  try {
    result[name] = await step();
  } catch (error) {
    result[name] = (error?.name === "NotCapable" ? "NotCapable: " : "error: ") + error?.message;
  }
}
console.log(JSON.stringify(result));
`;
const MODULES = [
  "deploy-lock.ts",
  "io.ts",
  "vps-journal-reader.ts",
  "vps-metrics-types.ts",
  "vps-metrics-storage.ts",
  "vps-metrics-join.ts",
  "vps-release-journal.ts",
  "vps-release-contract.ts",
] as const;
type ProbeResult = Record<
  "lock" | "storage" | "journal" | "command" | "sparse" | "root",
  string
>;

async function probeTree() {
  const repository = decodeURIComponent(
    new URL("../../", import.meta.url).pathname,
  ).replace(/\/$/, "");
  const tmp = await Deno.realPath(
    await Deno.makeTempDir({
      dir: repository,
      prefix: "sentinel-release-test-bridge-grants-",
    }),
  );
  const driver = `${tmp}/driver`, target = `${tmp}/target`;
  await Deno.mkdir(`${driver}/ops`, { recursive: true });
  await Deno.mkdir(`${target}/.data`, { recursive: true, mode: 0o700 });
  for (const file of MODULES) {
    await Deno.writeTextFile(
      `${driver}/ops/${file}`,
      await upstreamSource(DENO_DRIVER_SHA, file),
    );
  }
  await Deno.writeTextFile(`${driver}/probe.ts`, PROBE);
  return {
    tmp,
    driver,
    target,
    cleanup: () => Deno.remove(tmp, { recursive: true }).catch(() => {}),
  };
}

async function probe(
  tree: Awaited<ReturnType<typeof probeTree>>,
  flags: readonly string[],
): Promise<ProbeResult> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-prompt",
      "--no-config",
      "--no-lock",
      "--no-remote",
      "--no-npm",
      ...flags,
      `${tree.driver}/probe.ts`,
      JSON.stringify({ target: tree.target, deno: Deno.execPath() }),
    ],
    cwd: tree.tmp,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(output.stderr);
  assert.equal(output.code, 0, stderr);
  return JSON.parse(new TextDecoder().decode(output.stdout));
}

const UNAVAILABLE = "error: VPS journal command unavailable";
const OK: ProbeResult = {
  lock: "ok",
  storage: "ok",
  journal: UNAVAILABLE,
  command: "ok",
  sparse: "ok",
  root: "ok",
};

Deno.test("VPS bridge grants: the recorded constant denotes exactly these flags and this Deno offers the lock", () => {
  assert.deepEqual(VPS_RELEASE_BRIDGE_DRIVER_GRANTS, {
    sys: ["uid"],
    run: "unscoped",
    read: ["<root>"],
    write: ["<root>/.data"],
    env: ["NODE_V8_COVERAGE"],
    sparsePreparationEnv: ["PATH"],
    denoApis: ["FsFile.prototype.tryLockSync"],
    verifiedDeno: "2.9.7",
  });
  const root = "/home/codex/repos/ubiquity/ai.ubq.fi";
  assert.deepEqual(
    vpsReleaseBridgeDriverDenoFlags(root, { sparsePreparation: false }),
    [
      "--allow-sys=uid",
      "--allow-run",
      `--allow-read=${root}`,
      `--allow-write=${root}/.data`,
      "--allow-env=NODE_V8_COVERAGE",
    ],
  );
  assert.equal(
    vpsReleaseBridgeDriverDenoFlags(root, { sparsePreparation: true }).at(-1),
    "--allow-env=NODE_V8_COVERAGE,PATH",
  );
  for (const invalid of ["relative", "/a,b"]) {
    assert.throws(
      () =>
        vpsReleaseBridgeDriverDenoFlags(invalid, { sparsePreparation: false }),
      TypeError,
    );
  }
  assert.equal(typeof Deno.FsFile.prototype.tryLockSync, "function");
});

Deno.test("VPS bridge grants: the 6c3afe42 lock, checkpoint storage, journal and command runners run under exactly the recorded grants", async (t) => {
  const tree = await probeTree();
  try {
    const flags = vpsReleaseBridgeDriverDenoFlags(tree.target, {
      sparsePreparation: true,
    });
    await t.step("all recorded grants", async () => {
      assert.deepEqual(await probe(tree, flags), OK);
    });
    await t.step("no sparse preparation: PATH is not readable", async () => {
      const result = await probe(
        tree,
        vpsReleaseBridgeDriverDenoFlags(tree.target, {
          sparsePreparation: false,
        }),
      );
      assert.match(result.sparse, /^NotCapable: Requires env access to "PATH"/);
      assert.deepEqual({ ...result, sparse: "ok" }, OK);
    });
    const without = (prefix: string) =>
      probe(tree, flags.filter((flag) => !flag.startsWith(prefix)));
    await t.step("without --allow-sys=uid", async () => {
      const result = await without("--allow-sys");
      for (const step of ["lock", "storage"] as const) {
        assert.match(result[step], /^NotCapable: Requires sys access to "uid"/);
      }
      assert.deepEqual({ ...result, lock: "ok", storage: "ok" }, OK);
    });
    await t.step("without --allow-env=NODE_V8_COVERAGE", async () => {
      const result = await without("--allow-env");
      assert.match(
        result.journal,
        /^NotCapable: Requires env access to "NODE_V8_COVERAGE"/,
      );
      assert.match(result.sparse, /^NotCapable: Requires env access/);
      assert.deepEqual({ ...result, journal: UNAVAILABLE, sparse: "ok" }, OK);
    });
    await t.step("without --allow-run", async () => {
      const result = await without("--allow-run");
      for (const step of ["command", "sparse"] as const) {
        assert.match(result[step], /^NotCapable: Requires run access/);
      }
      assert.deepEqual({ ...result, command: "ok", sparse: "ok" }, OK);
    });
    await t.step("without write on <root>/.data", async () => {
      const result = await without("--allow-write");
      for (const step of ["lock", "storage", "sparse"] as const) {
        assert.match(result[step], /^NotCapable: Requires write access/);
      }
    });
    await t.step("without read on <root>", async () => {
      const result = await without("--allow-read");
      for (const step of ["lock", "storage", "root"] as const) {
        assert.match(result[step], /^NotCapable: Requires read access/);
      }
    });
  } finally {
    await tree.cleanup();
  }
});
