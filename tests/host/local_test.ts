import assert from "node:assert/strict";
import {
  createLocalRepositoryConfig,
  localCheckoutKey,
  renderLocalCodexConfig,
  tryAcquireLocalHostLock,
} from "../../src/host/local.ts";

Deno.test("local repository config parses with fixed local scope", () => {
  const config = createLocalRepositoryConfig();
  assert.equal(config.repository.owner, "ubiquity-sentinel");
  assert.equal(config.repository.name, "sentinel");
  assert.equal(config.repository.installationId, 0);
  assert.equal(config.adapter.kind, "github");
  assert.equal(config.baseBranch, "development");
  assert.deepEqual(config.commands, {
    replay: "replay_capture",
    test: "test_ci",
  });
  // Owner update, 2026-10-02: both rolling caps are explicitly null
  // (uncapped), never a fake huge number.
  assert.equal(config.liveStartLimits?.perHour, null);
  assert.equal(config.liveStartLimits?.perSevenDays, null);
  // 30 minutes: a larger target's session must be able to finish. The bound
  // matches this same template's own `test_ci` command allowance.
  assert.equal(config.sessionBound?.maxDurationMs, 1_800_000);
  assert.equal(config.sessionBound?.maxOutputChars, Number.MAX_SAFE_INTEGER);
  assert.equal(config.retention, null);
  assert.equal(config.stabilityPolicy, null);
  assert.equal(config.build.projectId, null);
  assert.equal(config.build.acceptance, null);
  assert.equal(config.secretRef, "secret://host/injected/sentinel-local-owner");
  assert.ok(config.protectedPaths.includes("src/host/local.ts"));
  assert.ok(config.protectedPaths.includes("src/contracts/local-release.ts"));
  assert.ok(config.protectedPaths.includes("src/host/local-release.ts"));
  assert.ok(config.protectedPaths.includes("src/host/local-supervisor.ts"));
  assert.ok(config.protectedPaths.includes("src/budget/"));
  assert.ok(!config.protectedPaths.includes("src/"));
  const specs = Object.values(config.commandRegistry.commands);
  assert.equal(specs.length, 2);
  const local = specs.find((spec) => spec.args.includes("test:local"));
  assert.ok(local !== undefined);
  assert.deepEqual(local.args, ["task", "test:local"]);
  const replay = specs.find((spec) => spec.args.includes("replay:capture"));
  assert.ok(replay !== undefined);
  assert.deepEqual(replay.args, ["task", "replay:capture"]);
});

/** Expected model shell PATH on this host: CommandLineTools Git when present. */
function expectedShellPath(fallback: string): string {
  const bin = "/Library/Developer/CommandLineTools/usr/bin";
  try {
    Deno.statSync(`${bin}/git`);
  } catch {
    return fallback;
  }
  return `${bin}:${fallback}`;
}

/**
 * The supervisor installs the target's pinned Bun as one real executable at
 * the platform path; the sandbox reads exactly that file, and Bun keeps every
 * cache out of the checkout (the model shell's HOME): its transpiler cache is
 * off and its install cache lives in the task's private temp directory.
 */
function assertSandboxBun(text: string, tmpDir: string): void {
  const filesystem = text.slice(
    text.indexOf(".filesystem]"),
    text.indexOf('.filesystem.":workspace_roots"]'),
  );
  assert.match(filesystem, /^"\/usr\/local\/bin\/bun" = "read"$/m);
  assert.ok(!filesystem.includes('"/usr/local/bin" ='), "never the directory");
  const shell = text.slice(text.indexOf("[shell_environment_policy.set]"));
  assert.match(shell, /^BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0"$/m);
  assert.ok(
    shell.includes(`BUN_INSTALL_CACHE_DIR = ${JSON.stringify(tmpDir)}`),
    "Bun's install cache is the task's private temp directory",
  );
}

Deno.test("local Codex config isolates the model client", () => {
  const text = renderLocalCodexConfig({
    profile: "sentinel-local",
    tokenFile: "/private/clients/key/model.token",
    shellHome: "/private/checkouts/key",
    shellPath: "/usr/bin:/bin",
    shellTmpDir: "/private/tmp/key",
    shellDenoDir: "/private/deno/key",
    codexExecutable: "/home/.codex/bin/codex",
    codexDistributionDir: "/home/.codex/packages/standalone",
    denoExecutable: "/bin/deno",
    writeGrants: ["/private/tmp/key", "/private/deno/key"],
  });
  assert.match(text, /^approval_policy = "never"$/m);
  assert.match(text, /^allow_login_shell = false$/m);
  assert.match(text, /^default_permissions = "sentinel-local"$/m);
  assert.match(text, /base_url = "http:\/\/127\.0\.0\.1:8000\/v1"/);
  assert.match(text, /command = "\/bin\/cat"/);
  assert.match(text, /args = \["\/private\/clients\/key\/model\.token"\]/);
  assert.match(text, /^\[permissions\.sentinel-local\.filesystem\]$/m);
  assert.match(text, /^":minimal" = "read"$/m);
  assert.match(text, /^"\/home\/\.codex\/bin\/codex" = "read"$/m);
  assert.match(text, /^"\/home\/\.codex\/packages\/standalone" = "read"$/m);
  assert.match(text, /^"\/bin\/deno" = "read"$/m);
  assert.match(
    text,
    /^"\/Library\/Developer\/CommandLineTools\/usr\/share\/git-core" = "read"$/m,
  );
  assert.match(
    text,
    /^"\/Library\/Developer\/CommandLineTools\/usr\/bin" = "read"$/m,
  );
  assert.match(text, /^"\/private\/tmp\/key" = "write"$/m);
  assert.match(text, /^"\/private\/deno\/key" = "write"$/m);
  assertSandboxBun(text, "/private/tmp/key");
  assert.match(
    text,
    /^\[permissions\.sentinel-local\.filesystem\.":workspace_roots"\]$/m,
  );
  assert.match(text, /^"\." = "write"$/m);
  assert.match(text, /^"\.git" = "read"$/m);
  assert.match(text, /^"\.codex" = "read"$/m);
  assert.match(text, /^\[permissions\.sentinel-local\.network\]$/m);
  assert.match(text, /^enabled = false$/m);
  assert.match(text, /^inherit = "none"$/m);
  assert.match(text, /HOME = "\/private\/checkouts\/key"/);
  assert.ok(text.includes(`PATH = "${expectedShellPath("/usr/bin:/bin")}"`));
  // allow_login_shell is top level, never nested in the shell policy table.
  const shell = text.slice(text.indexOf("[shell_environment_policy]"));
  assert.ok(!shell.includes("allow_login_shell"));
  // The former invented read/write arrays and network boolean are gone.
  assert.ok(!text.includes("read = ["));
  assert.ok(!text.includes("write = ["));
  assert.ok(!text.includes("network = false"));
  // The token value is never written; only its file path is referenced.
  assert.ok(!text.includes("Bearer"));
  assert.ok(!text.includes("GITHUB_TOKEN"));
});

Deno.test("review Codex config is read-only", () => {
  const text = renderLocalCodexConfig({
    profile: "sentinel-review",
    tokenFile: "/private/clients/review/model.token",
    shellHome: "/private/review-checkout",
    shellPath: "/usr/bin:/bin",
    shellTmpDir: "/private/tmp/review",
    shellDenoDir: "/private/deno/review",
    codexExecutable: "/home/.codex/bin/codex",
    codexDistributionDir: "/home/.codex/packages/standalone",
    denoExecutable: "/bin/deno",
    writeGrants: [],
  });
  assert.match(text, /^default_permissions = "sentinel-review"$/m);
  assert.match(text, /^\[permissions\.sentinel-review\.filesystem\]$/m);
  assert.match(text, /^":minimal" = "read"$/m);
  assert.match(text, /^"\/bin\/deno" = "read"$/m);
  assert.match(
    text,
    /^"\/Library\/Developer\/CommandLineTools\/usr\/share\/git-core" = "read"$/m,
  );
  assert.match(
    text,
    /^"\/Library\/Developer\/CommandLineTools\/usr\/bin" = "read"$/m,
  );
  assert.match(
    text,
    /^\[permissions\.sentinel-review\.filesystem\.":workspace_roots"\]$/m,
  );
  assert.match(text, /^"\." = "read"$/m);
  assert.match(text, /^\[permissions\.sentinel-review\.network\]$/m);
  assert.match(text, /^enabled = false$/m);
  assert.ok(text.includes(`PATH = "${expectedShellPath("/usr/bin:/bin")}"`));
  assertSandboxBun(text, "/private/tmp/review");
  assert.ok(!text.includes('= "write"'));
  assert.ok(!text.includes("sentinel-local"));
});

Deno.test("task checkout keys are stable and distinct", async () => {
  const first = await localCheckoutKey("issue-42");
  const second = await localCheckoutKey("issue-42");
  const other = await localCheckoutKey("issue-43");
  assert.equal(first, second);
  assert.notEqual(first, other);
  assert.match(first, /^[0-9a-f]{64}$/);
});

Deno.test("state lock refuses a second overlapping writer", async () => {
  const root = await Deno.makeTempDir({ dir: ".", prefix: "sentinel-lock-" });
  try {
    const first = await tryAcquireLocalHostLock(root);
    assert.notEqual(first, null);
    assert.equal(await tryAcquireLocalHostLock(root), null);
    first!.close();
    const reacquired = await tryAcquireLocalHostLock(root);
    assert.notEqual(reacquired, null);
    reacquired!.close();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
