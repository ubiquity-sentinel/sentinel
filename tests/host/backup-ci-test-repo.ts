/**
 * Synthetic, sanitized fixtures for the backup CI pipeline tests
 * (docs/backup-ci-spec.md §16 WP3): a temporary target "remote" reached
 * through a file URL (fetch by SHA allowed), commit helpers, and a
 * Passport-shaped workflow. Nothing here comes from a live repository.
 */
import type { GitSha } from "../../src/contracts/brands.ts";

const FIXTURE_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "@1761379200 +0000",
  GIT_COMMITTER_DATE: "@1761379200 +0000",
};

/** Runs fixture git (never the code under test's runner). */
export async function fixtureGit(
  cwd: string,
  args: string[],
): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      HOME: cwd,
      ...FIXTURE_ENV,
    },
  }).output();
  if (!out.success) {
    throw new Error(`git ${args[0]}: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/**
 * An absolute temporary directory inside the checkout: the named test
 * permissions read only `.`, and the code under test reads its own files.
 */
export async function testDir(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ dir: ".", prefix: `.${prefix}` });
  return `${Deno.cwd()}/${dir.replace(/^\.\//, "")}`;
}

/** `ln -s` (Deno.symlink needs unscoped read and write permissions). */
export async function fixtureSymlink(target: string, path: string) {
  const out = await new Deno.Command("ln", { args: ["-s", target, path] })
    .output();
  if (!out.success) throw new Error("ln -s failed");
}

export type FixtureFile = string | { text: string; mode: number } | {
  symlink: string;
};

export interface TargetRepoV1 {
  root: string;
  /** The bare remote's path (`file://` + it is the fetch URL). */
  remote: string;
  url: string;
  /** Replaces the work tree's files and commits them; returns the commit. */
  commit(
    files: Record<string, FixtureFile>,
    options?: { parent?: GitSha; remove?: string[] },
  ): Promise<GitSha>;
  close(): Promise<void>;
}

export async function targetRepo(prefix: string): Promise<TargetRepoV1> {
  const root = await testDir(prefix);
  const remote = `${root}/target.git`;
  await fixtureGit(root, ["init", "-q", "--bare", remote]);
  await fixtureGit(remote, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  const work = `${root}/work`;
  await fixtureGit(root, ["init", "-q", "-b", "main", work]);
  let n = 0;
  return {
    root,
    remote,
    url: `file://${remote}`,
    async commit(files, options = {}) {
      if (options.parent !== undefined) {
        await fixtureGit(work, ["checkout", "-q", "--detach", options.parent]);
      }
      for (const path of options.remove ?? []) {
        await fixtureGit(work, ["rm", "-q", "-r", "--", path]);
      }
      for (const [path, value] of Object.entries(files)) {
        const target = `${work}/${path}`;
        await Deno.mkdir(target.slice(0, target.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.remove(target).catch(() => undefined);
        if (typeof value === "string") {
          await Deno.writeTextFile(target, value);
        } else if ("symlink" in value) {
          await fixtureSymlink(value.symlink, target);
        } else {
          await Deno.writeTextFile(target, value.text);
          await Deno.chmod(target, value.mode);
        }
      }
      await fixtureGit(work, ["add", "-A"]);
      await fixtureGit(work, [
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        `fixture ${++n}`,
      ]);
      const sha = await fixtureGit(work, ["rev-parse", "HEAD"]) as GitSha;
      await fixtureGit(work, [
        "push",
        "-q",
        "-f",
        remote,
        `${sha}:refs/heads/c${n}`,
      ]);
      return sha;
    },
    close: () => Deno.remove(root, { recursive: true }),
  };
}

/** A synthetic workflow shaped like the Passport `deno` job. */
export const PASSPORT_WORKFLOW = `name: CI

on:
  push:
  pull_request:

permissions:
  contents: read

jobs:
  deno:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v6.0.3
        with:
          persist-credentials: false

      - uses: denoland/setup-deno@v2
        with:
          deno-version: 2.9.5

      - uses: actions/setup-node@v6
        with:
          node-version: 24.21.0

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.0

      - run: bun install --frozen-lockfile
      - name: Validate all retained and native runtimes
        run: bun --no-env-file run check
`;

export const WORKFLOW_PATH = ".github/workflows/ci.yml";
