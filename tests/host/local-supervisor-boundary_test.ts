/**
 * The real inherited OS write boundary of the fixed local supervisor.
 *
 * This test invokes the exact production `defaultRunChild` once, on darwin
 * only, against a disposable absolute temp root beneath the test workspace. A
 * fake `repair:run` Deno task runs a credential-free child script (no model,
 * no GitHub, no live state) that attempts the exact authority writes the
 * boundary must deny and the exact private writes a real bounded local run
 * performs. The parent asserts structured probe results, surviving protected
 * bytes and the normal parent-side supervisor log.
 *
 * Issue #100: a third case gives the child a HOME that holds the owner's
 * opt-in and whose `.codex/bin/codex` resolves (through the standalone
 * installer's links) to a real Mach-O copy of `/bin/sh`. That exempted program
 * must be able to apply its own inner Seatbelt sandbox, and the inner rule
 * must hold, while a non-exempted copy still fails nested (`sandbox_apply`)
 * and the host's own writes stay denied.
 */

import assert from "node:assert/strict";

import type { GitSha } from "../../src/contracts/brands.ts";
import type { LocalSupervisorChildInputV1 } from "../../src/host/local-supervisor.ts";
import { defaultRunChild } from "../../src/host/local-supervisor.ts";
import {
  CODEX_OPT_IN_ACK,
  CODEX_OPT_IN_SEGMENTS,
  joinPath,
} from "../../src/host/local-supervisor-shared.ts";

const REVISION = "0123456789abcdef0123456789abcdef01234567" as GitSha;
const PROTECTED_TEXT = "protected supervisor authority\n";
const POINTER_TEXT = '{"version":"v1","kind":"local_active_runtime"}\n';
const LOCK_TEXT = "supervisor lock\n";
const DEADLINE_MS = 120_000;
/** The real timeout test: short, but ample for shell and sandbox startup. */
const TIMEOUT_DEADLINE_MS = 2_000;
const DESCENDANT_SLEEP_SECONDS = 30;

/** Every probe the sandboxed child runs, each expected to behave as stated. */
const PROBE_NAMES = [
  "status_write",
  "scratch_write",
  "checkouts_write",
  "tmp_host_write",
  "deno_dir_write",
  "pointer_overwrite",
  "pointer_remove",
  "pointer_rename",
  "receipts_remove",
  "receipts_rename",
  "supervisor_lock_overwrite",
  "supervisor_lock_remove",
  "runtimes_write",
  "runtimes_remove",
  "runtimes_rename",
  "outside_overwrite",
  "root_extra_write",
  "root_rename",
  "mutable_root_rename",
  "protected_hardlink",
  "protected_symlink_write",
  "mutable_hardlink",
  "shell_protected",
  "shell_mutable",
] as const;

/**
 * The child-program source. It derives every path from its own location, makes
 * one attempt per probe, records `true` only for the expected outcome, then
 * writes the structured results under its granted private temp directory.
 */
const PROBE_SOURCE = String.raw`
const root = import.meta.dirname;
const stateRoot = root + "/state";
const protectedPath = root + "/outside/protected.txt";

const results = {};
async function attempt(name, expected, fn) {
  let ran = false;
  try {
    await fn();
    ran = true;
  } catch {
    ran = false;
  }
  results[name] = expected === "allowed" ? ran : !ran;
}
async function shellWrite(path, text) {
  const command = new Deno.Command("/bin/sh", {
    args: ["-c", 'printf "%s" "$2" > "$1"', "sh", path, text],
  });
  const status = await command.output();
  if (status.code !== 0) throw new Error("shell write did not succeed");
}

await attempt("status_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/status.json", "status\n");
});
await attempt("scratch_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/state-scratch/probe.txt", "scratch\n");
});
await attempt("checkouts_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/checkouts/probe.txt", "checkout\n");
});
await attempt("tmp_host_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/tmp/host/probe.txt", "tmp\n");
});
await attempt("deno_dir_write", "allowed", async () => {
  await Deno.writeTextFile(stateRoot + "/deno/host/probe.txt", "cache\n");
});
await attempt("pointer_overwrite", "denied", async () => {
  await Deno.writeTextFile(stateRoot + "/active-runtime.json", "hacked\n");
});
await attempt("pointer_remove", "denied", async () => {
  await Deno.remove(stateRoot + "/active-runtime.json");
});
await attempt("pointer_rename", "denied", async () => {
  await Deno.rename(
    stateRoot + "/active-runtime.json",
    stateRoot + "/tmp/host/pointer-moved.json",
  );
});
await attempt("receipts_remove", "denied", async () => {
  await Deno.remove(stateRoot + "/local-releases", { recursive: true });
});
await attempt("receipts_rename", "denied", async () => {
  await Deno.rename(
    stateRoot + "/local-releases",
    stateRoot + "/tmp/host/receipts-moved",
  );
});
await attempt("supervisor_lock_overwrite", "denied", async () => {
  await Deno.writeTextFile(stateRoot + "/supervisor.lock", "hacked\n");
});
await attempt("supervisor_lock_remove", "denied", async () => {
  await Deno.remove(stateRoot + "/supervisor.lock");
});
await attempt("runtimes_write", "denied", async () => {
  await Deno.writeTextFile(stateRoot + "/runtimes/probe.txt", "hacked\n");
});
await attempt("runtimes_remove", "denied", async () => {
  await Deno.remove(stateRoot + "/runtimes", { recursive: true });
});
await attempt("runtimes_rename", "denied", async () => {
  await Deno.rename(
    stateRoot + "/runtimes",
    stateRoot + "/tmp/host/runtimes-moved",
  );
});
await attempt("outside_overwrite", "denied", async () => {
  await Deno.writeTextFile(protectedPath, "hacked\n");
});
await attempt("root_extra_write", "denied", async () => {
  await Deno.writeTextFile(stateRoot + "/evil.txt", "hacked\n");
});
await attempt("root_rename", "denied", async () => {
  await Deno.rename(stateRoot, root + "/moved-state");
});
await attempt("mutable_root_rename", "denied", async () => {
  await Deno.rename(
    stateRoot + "/checkouts",
    stateRoot + "/tmp/host/moved-checkouts",
  );
});
await attempt("protected_hardlink", "denied", async () => {
  await Deno.link(protectedPath, stateRoot + "/tmp/host/protected-hardlink");
});
await attempt("protected_symlink_write", "denied", async () => {
  const link = stateRoot + "/tmp/host/protected-link";
  await Deno.symlink(protectedPath, link);
  await Deno.writeTextFile(link, "hacked\n");
});
await attempt("mutable_hardlink", "allowed", async () => {
  const source = stateRoot + "/checkouts/hardlink-source.txt";
  const dest = stateRoot + "/tmp/host/hardlink-dest.txt";
  await Deno.writeTextFile(source, "mutable\n");
  await Deno.link(source, dest);
  const text = await Deno.readTextFile(dest);
  if (text !== "mutable\n") throw new Error("unexpected hardlink content");
});
await attempt("shell_protected", "denied", async () => {
  await shellWrite(protectedPath, "hacked");
});
await attempt("shell_mutable", "allowed", async () => {
  const path = stateRoot + "/tmp/host/shell-ok.txt";
  await shellWrite(path, "shell");
  const text = await Deno.readTextFile(path);
  if (text !== "shell") throw new Error("unexpected shell content");
});

await Deno.writeTextFile(
  stateRoot + "/tmp/host/boundary-results.json",
  JSON.stringify(results) + "\n",
);
console.log(JSON.stringify({ probes: Object.keys(results).length }));
`;

/**
 * A fake `deno` executable for the timeout test: it ignores the `task` argv,
 * forks a shell `sleep` descendant that inherits (and therefore holds open)
 * the captured pipes, persists that descendant's pid under the granted private
 * TMPDIR, and then hangs so only the deadline can end the run.
 */
const FAKE_DENO_SOURCE = String.raw`#!/bin/sh
sleep ${DESCENDANT_SLEEP_SECONDS} &
echo $! > "$TMPDIR/descendant.pid"
sleep ${DESCENDANT_SLEEP_SECONDS}
`;

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test({
  name:
    "local supervisor boundary: the real sandboxed child cannot write supervisor authority",
  ignore: Deno.build.os !== "darwin",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const root =
      `${Deno.cwd()}/.local-supervisor-boundary-${crypto.randomUUID()}`;
    const stateRoot = `${root}/state`;
    const runtimeDir = `${root}/runtime`;
    const outsideDir = `${root}/outside`;
    const homeDir = `${root}/home`;
    const protectedPath = `${outsideDir}/protected.txt`;
    const resultsPath = `${stateRoot}/tmp/host/boundary-results.json`;
    try {
      for (const dir of [root, runtimeDir, outsideDir, homeDir, stateRoot]) {
        await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
      }
      await Deno.writeTextFile(protectedPath, PROTECTED_TEXT);
      await Deno.writeTextFile(
        `${stateRoot}/active-runtime.json`,
        POINTER_TEXT,
      );
      await Deno.writeTextFile(`${stateRoot}/supervisor.lock`, LOCK_TEXT);
      await Deno.mkdir(`${stateRoot}/local-releases`, { mode: 0o700 });
      await Deno.mkdir(`${stateRoot}/runtimes`, { mode: 0o700 });
      await Deno.writeTextFile(`${root}/probe.ts`, PROBE_SOURCE);
      await Deno.writeTextFile(
        `${runtimeDir}/deno.json`,
        JSON.stringify({
          tasks: {
            "repair:run":
              `${Deno.execPath()} run -A --no-config --no-lock ${root}/probe.ts`,
          },
        }),
      );

      const input: LocalSupervisorChildInputV1 = {
        stateRoot,
        runtimeDir,
        revision: REVISION,
        taskName: "repair:run",
        env: {
          HOME: homeDir,
          PATH: Deno.env.get("PATH") ?? "",
          GITHUB_TOKEN: "",
          UOS_AI_TOKEN: "",
        },
        denoExecutable: Deno.execPath(),
        deadlineMs: DEADLINE_MS,
        logPath: `${stateRoot}/supervisor-logs/unused.log`,
      };
      const result = await defaultRunChild(input);
      assert.equal(
        result.settled,
        true,
        "the sandboxed real child must settle",
      );
      assert.equal(result.exitCode, 0, "the sandboxed real child must exit 0");

      const results = JSON.parse(
        await Deno.readTextFile(resultsPath),
      ) as Record<string, boolean>;
      assert.deepEqual(
        Object.keys(results).sort(),
        [...PROBE_NAMES].sort(),
        "every boundary probe must report a structured result",
      );
      for (const name of PROBE_NAMES) {
        assert.equal(results[name], true, `boundary probe ${name} failed`);
      }

      assert.equal(
        await Deno.readTextFile(protectedPath),
        PROTECTED_TEXT,
        "the protected outside file must keep its original bytes",
      );
      assert.equal(
        await Deno.readTextFile(`${stateRoot}/active-runtime.json`),
        POINTER_TEXT,
        "the active runtime pointer must keep its original bytes",
      );
      assert.equal(
        await Deno.readTextFile(`${stateRoot}/supervisor.lock`),
        LOCK_TEXT,
        "the supervisor lock must keep its original bytes",
      );
      assert.equal(
        await exists(`${stateRoot}/evil.txt`),
        false,
        "no unlisted state root entry may appear",
      );
      assert.equal(
        await exists(`${root}/moved-state`),
        false,
        "the state root may never be replaced",
      );
      assert.ok(
        (await Deno.lstat(`${stateRoot}/checkouts`)).isDirectory,
        "a mutable top-level directory may never be replaced",
      );
      assert.ok(
        (await Deno.lstat(`${stateRoot}/local-releases`)).isDirectory,
        "the receipt directory may never be replaced",
      );
      assert.ok(
        (await Deno.lstat(`${stateRoot}/runtimes`)).isDirectory,
        "the runtime directory may never be replaced",
      );
      assert.equal(
        await Deno.readTextFile(`${stateRoot}/status.json`),
        "status\n",
        "the child writes its own bounded status receipt",
      );

      const logDir = `${stateRoot}/supervisor-logs`;
      const logs: string[] = [];
      for await (const entry of Deno.readDir(logDir)) logs.push(entry.name);
      assert.equal(
        logs.length,
        1,
        "the parent writes exactly one child log outside the sandbox",
      );
      const logText = await Deno.readTextFile(`${logDir}/${logs[0]}`);
      assert.ok(
        logText.includes("stdout:") && logText.includes('"probes"'),
        "the parent-side child log captures the real child stdout",
      );
      assert.ok(
        logText.startsWith("codex-exemption: absent:not_opted_in\n"),
        "without the owner's opt-in the child keeps today's exact profile",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "local supervisor boundary: a child deadline ends the whole sandboxed group",
  ignore: Deno.build.os !== "darwin",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const root =
      `${Deno.cwd()}/.local-supervisor-timeout-${crypto.randomUUID()}`;
    const stateRoot = `${root}/state`;
    const runtimeDir = `${root}/runtime`;
    const fakeDeno = `${root}/fake-deno`;
    const descendantPidPath = `${stateRoot}/tmp/host/descendant.pid`;
    try {
      await Deno.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
      await Deno.mkdir(stateRoot, { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(fakeDeno, FAKE_DENO_SOURCE);
      await Deno.chmod(fakeDeno, 0o755);
      const input: LocalSupervisorChildInputV1 = {
        stateRoot,
        runtimeDir,
        revision: REVISION,
        taskName: "repair:run",
        env: {
          HOME: `${root}/home`,
          PATH: Deno.env.get("PATH") ?? "",
          GITHUB_TOKEN: "",
          UOS_AI_TOKEN: "",
        },
        denoExecutable: fakeDeno,
        deadlineMs: TIMEOUT_DEADLINE_MS,
        logPath: `${stateRoot}/supervisor-logs/unused.log`,
      };

      const startedAt = Date.now();
      const result = await defaultRunChild(input);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(result.settled, true, "the timed-out run must still settle");
      assert.equal(result.exitCode, null, "a timeout is never a success");
      assert.ok(
        elapsedMs < TIMEOUT_DEADLINE_MS + 15_000,
        `the bounded run returned after ${elapsedMs}ms`,
      );

      // The descendant's own pid was persisted inside the granted private temp
      // directory; it must not exist after the deadline settlement.
      const descendantPid = Number(
        (await Deno.readTextFile(descendantPidPath)).trim(),
      );
      assert.ok(
        Number.isSafeInteger(descendantPid) && descendantPid > 0,
        "the descendant pid must be persisted",
      );
      const probe = await new Deno.Command("/bin/kill", {
        args: ["-0", String(descendantPid)],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
      assert.notEqual(
        probe.code,
        0,
        "the owned descendant must be gone after the bounded return",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});

/**
 * The issue #100 child program. `$HOME/.codex/bin/codex` and the sibling are
 * copies of `/bin/sh`; each runs a nested `/usr/bin/sandbox-exec` with an inner
 * profile that denies one directory, exactly as Codex confines its tools.
 */
const NESTING_SOURCE = String.raw`
const root = import.meta.dirname;
const stateRoot = root + "/state";
const outside = root + "/outside";
const innerDenied = outside + "/inner-denied";
const codex = Deno.env.get("HOME") + "/.codex/bin/codex";
const sibling = root + "/sibling/codex";
const inner = '(version 1)\n(allow default)\n(deny file-write* (subpath "' +
  innerDenied + '"))';
const nested = 'exec /usr/bin/sandbox-exec -p "$1" /bin/sh -c ' +
  "'printf %s ok > \"$1\"' inner \"$2\"";
async function launch(launcher, target) {
  const out = await new Deno.Command(launcher, {
    args: ["-c", nested, "outer", inner, target],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { code: out.code, stderr: new TextDecoder().decode(out.stderr) };
}
async function exists(path) {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}
async function readOrNull(path) {
  try {
    return await Deno.readTextFile(path);
  } catch {
    return null;
  }
}
const results = {};
const applied = await launch(codex, outside + "/exempt.txt");
results.exempt_nested_apply = applied.code === 0 &&
  (await readOrNull(outside + "/exempt.txt")) === "ok";
results.exempt_stderr = applied.stderr;
await launch(codex, innerDenied + "/denied.txt");
results.inner_rule_holds = !(await exists(innerDenied + "/denied.txt"));
const confined = await launch(sibling, outside + "/sibling.txt");
results.sibling_fails_nested = confined.code !== 0 &&
  confined.stderr.includes("sandbox_apply") &&
  !(await exists(outside + "/sibling.txt"));
results.sibling_stderr = confined.stderr;
try {
  await Deno.writeTextFile(outside + "/host.txt", "hacked\n");
  results.host_write_denied = false;
} catch {
  results.host_write_denied = true;
}
try {
  await Deno.writeTextFile(stateRoot + "/active-runtime.json", "hacked\n");
  results.host_pointer_denied = false;
} catch {
  results.host_pointer_denied = true;
}
await Deno.writeTextFile(
  stateRoot + "/tmp/host/nesting-results.json",
  JSON.stringify(results) + "\n",
);
`;

/** `ln -s`: Deno.symlink needs unscoped grants the test harness lacks. */
async function symlink(target: string, path: string): Promise<void> {
  const linked = await new Deno.Command("ln", {
    args: ["-s", target, path],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).output();
  if (!linked.success) throw new Error(`ln -s ${target} ${path} failed`);
}

Deno.test({
  name:
    "local supervisor boundary: only the exempted Codex applies its own nested sandbox (issue #100)",
  ignore: Deno.build.os !== "darwin",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const root = await Deno.realPath(
      await Deno.makeTempDir({
        prefix: ".local-supervisor-nesting-",
        dir: Deno.cwd(),
      }),
    );
    const stateRoot = `${root}/state`;
    const runtimeDir = `${root}/runtime`;
    const homeDir = `${root}/home`;
    const standalone = `${homeDir}/.codex/packages/standalone`;
    const release = `${standalone}/releases/0.0.0-test`;
    try {
      for (
        const dir of [
          stateRoot,
          runtimeDir,
          `${root}/outside/inner-denied`,
          `${root}/sibling`,
          `${release}/bin`,
          `${homeDir}/.codex/bin`,
        ]
      ) {
        await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
      }
      await Deno.copyFile("/bin/sh", `${release}/bin/codex`);
      await Deno.chmod(`${release}/bin/codex`, 0o755);
      await Deno.copyFile("/bin/sh", `${root}/sibling/codex`);
      await Deno.chmod(`${root}/sibling/codex`, 0o755);
      await symlink(release, `${standalone}/current`);
      await symlink(
        `${standalone}/current/bin/codex`,
        `${homeDir}/.codex/bin/codex`,
      );
      await Deno.mkdir(`${homeDir}/.config/sentinel-local`, {
        recursive: true,
        mode: 0o700,
      });
      await Deno.writeTextFile(
        joinPath(homeDir, ...CODEX_OPT_IN_SEGMENTS),
        `${CODEX_OPT_IN_ACK}\n`,
      );
      await Deno.chmod(joinPath(homeDir, ...CODEX_OPT_IN_SEGMENTS), 0o644);
      await Deno.writeTextFile(
        `${stateRoot}/active-runtime.json`,
        POINTER_TEXT,
      );
      await Deno.writeTextFile(`${root}/nesting.ts`, NESTING_SOURCE);
      await Deno.writeTextFile(
        `${runtimeDir}/deno.json`,
        JSON.stringify({
          tasks: {
            "repair:run":
              `${Deno.execPath()} run -A --no-config --no-lock ${root}/nesting.ts`,
          },
        }),
      );
      const result = await defaultRunChild({
        stateRoot,
        runtimeDir,
        revision: REVISION,
        taskName: "repair:run",
        env: {
          HOME: homeDir,
          PATH: Deno.env.get("PATH") ?? "",
          GITHUB_TOKEN: "",
          UOS_AI_TOKEN: "",
        },
        denoExecutable: Deno.execPath(),
        deadlineMs: DEADLINE_MS,
        logPath: `${stateRoot}/supervisor-logs/unused.log`,
      });
      const logDir = `${stateRoot}/supervisor-logs`;
      const logs: string[] = [];
      for await (const entry of Deno.readDir(logDir)) logs.push(entry.name);
      assert.equal(logs.length, 1, "exactly one parent-side child log");
      const logText = await Deno.readTextFile(`${logDir}/${logs[0]}`);
      assert.ok(
        logText.startsWith("codex-exemption: applied\n"),
        `the exemption must apply: ${logText.slice(0, 2000)}`,
      );
      assert.equal(result.settled, true, "the sandboxed child must settle");
      assert.equal(result.exitCode, 0, logText.slice(0, 2000));
      const results = JSON.parse(
        await Deno.readTextFile(`${stateRoot}/tmp/host/nesting-results.json`),
      ) as Record<string, unknown>;
      for (
        const name of [
          "exempt_nested_apply",
          "inner_rule_holds",
          "sibling_fails_nested",
          "host_write_denied",
          "host_pointer_denied",
        ]
      ) {
        assert.equal(
          results[name],
          true,
          `${name} failed: ${JSON.stringify(results)}`,
        );
      }
      assert.equal(
        await Deno.readTextFile(`${stateRoot}/active-runtime.json`),
        POINTER_TEXT,
        "the active runtime pointer must keep its original bytes",
      );
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => {});
    }
  },
});
