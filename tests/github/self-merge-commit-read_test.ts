/**
 * Issue #196: the self-merge commit reader reports a path git says is absent
 * as null, and any failed git child (a killed, timed-out or otherwise failing
 * `rev-parse`) as `unavailable`. A transient failure must never read as a
 * changed trusted CI pipeline, which the repair loop parks for the owner.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";

async function git(args: string[]): Promise<string> {
  const r = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=Self merge read fixture",
      "-c",
      "user.email=read@example.test",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    clearEnv: true,
    env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert.equal(r.code, 0, new TextDecoder().decode(r.stderr));
  return new TextDecoder().decode(r.stdout).trim();
}

async function fixture(withLock: boolean) {
  const temp = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-self-merge-read-",
  });
  const work = `${temp}/work`;
  await git(["init", "-q", "-b", "development", work]);
  await Deno.mkdir(`${work}/.github/workflows`, { recursive: true });
  await Deno.mkdir(`${work}/ops`);
  const files = [
    ".github/workflows/ci.yml",
    "test-local.ts",
    "ops/native-ci-proof.ts",
    "deno.json",
    ...(withLock ? ["deno.lock"] : []),
  ];
  for (const path of files) {
    await Deno.writeTextFile(`${work}/${path}`, `fixture ${path}\n`);
  }
  await git(["-C", work, "add", "."]);
  await git(["-C", work, "commit", "-q", "-m", "base"]);
  const sha = await git(["-C", work, "rev-parse", "HEAD"]) as GitSha;
  return { temp, work, sha };
}

/**
 * A git wrapper that forwards every call to the real git, except the trusted
 * `<sha>:ops` path read, which exits with `status` like a killed child.
 */
async function failingGit(temp: string, status: number): Promise<string> {
  const path = `${temp}/fake-git.sh`;
  await Deno.writeTextFile(
    path,
    [
      "#!/bin/sh",
      'for arg in "$@"; do',
      '  case "$arg" in',
      `    *:ops) exit ${status} ;;`,
      "  esac",
      "done",
      'exec git "$@"',
      "",
    ].join("\n"),
  );
  await Deno.chmod(path, 0o755);
  return path;
}

Deno.test("self merge read: present paths resolve and an absent path is null", async () => {
  const present = await fixture(true);
  const absent = await fixture(false);
  try {
    const full = await new DenoGitExecutor({
      localDir: present.work,
      remoteUrl: present.work,
    }).readSelfMergeCommit!(present.sha);
    assert.ok(full.ok, JSON.stringify(full));
    if (!full.ok) return;
    for (const value of Object.values(full.value.pipeline)) {
      assert.match(String(value), /^[0-9a-f]{40}$/);
    }
    for (const value of Object.values(full.value.sources)) {
      assert.match(String(value), /^[0-9a-f]{40}$/);
    }
    const partial = await new DenoGitExecutor({
      localDir: absent.work,
      remoteUrl: absent.work,
    }).readSelfMergeCommit!(absent.sha);
    assert.ok(partial.ok, JSON.stringify(partial));
    if (!partial.ok) return;
    assert.equal(partial.value.pipeline.lock, null);
    assert.match(String(partial.value.pipeline.operations), /^[0-9a-f]{40}$/);
  } finally {
    await Deno.remove(present.temp, { recursive: true });
    await Deno.remove(absent.temp, { recursive: true });
  }
});

Deno.test("self merge read: a failed git child is unavailable, never an absent path", async () => {
  for (const status of [2, 128, 137]) {
    const f = await fixture(true);
    try {
      const result = await new DenoGitExecutor({
        localDir: f.work,
        remoteUrl: f.work,
        gitPath: await failingGit(f.temp, status),
      }).readSelfMergeCommit!(f.sha);
      assert.equal(result.ok, false, `status ${status}`);
      if (result.ok) return;
      assert.equal(result.error.kind, "unavailable", `status ${status}`);
    } finally {
      await Deno.remove(f.temp, { recursive: true });
    }
  }
});
