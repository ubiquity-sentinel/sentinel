// review snapshot helpers.

import assert from "node:assert/strict";
import { asGitSha, type GitSha } from "../../src/contracts/brands.ts";
import { GitReviewSnapshot } from "../../src/github/review-snapshot.ts";
import type {
  ReplayCommandOutcomeV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";

export const here = new URL(import.meta.url);

if (here.protocol !== "file:") throw new Error("expected a file: test module");

export const testsDir = decodeURIComponent(here.pathname).replace(
  /\/review-snapshot-helpers\.ts$/,
  "",
);

export const PATH = Deno.env.get("PATH") ?? "/usr/bin:/bin";

export const ZERO_SHA = "0".repeat(40);

export const ZERO_MODE = "000000";

export function contains(text: string, needle: string, message?: string): void {
  assert.ok(text.includes(needle), message ?? `expected ${needle} in text`);
}

export async function runGit(
  cwd: string,
  args: string[],
): Promise<Deno.CommandOutput> {
  return await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      // Test-side probes stay honest: a missing promisor object is observed as
      // missing, never silently materialized by a lazy fetch.
      GIT_NO_LAZY_FETCH: "1",
      GIT_AUTHOR_NAME: "Sentinel Test",
      GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
      GIT_COMMITTER_NAME: "Sentinel Test",
      GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
}

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** True when the command exits 0; used to prove an object stays missing. */
export async function gitSucceeds(
  cwd: string,
  args: string[],
): Promise<boolean> {
  return (await runGit(cwd, args)).success;
}

/**
 * Run one tiny Git fixture command with piped stdin. Used only to build the
 * explicit empty-tree fixture through `git mktree`, which reads stdin.
 */
export async function gitWithInput(
  cwd: string,
  args: string[],
  input: string,
): Promise<string> {
  const child = new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env: {
      PATH,
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_NO_LAZY_FETCH: "1",
      GIT_AUTHOR_NAME: "Sentinel Test",
      GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
      GIT_COMMITTER_NAME: "Sentinel Test",
      GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
    },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(input));
  await writer.close();
  const result = await child.output();
  if (!result.success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}

/** Exact blob identity of one repository-relative path at one commit. */
export async function blobAt(
  repo: string,
  commit: GitSha,
  path: string,
): Promise<string> {
  return (await git(repo, ["rev-parse", `${commit}:${path}`])).trim();
}

export async function withRepo<T>(
  fn: (repo: string) => Promise<T>,
): Promise<T> {
  const repo = await Deno.makeTempDir({
    prefix: ".review-snapshot-",
    dir: testsDir,
  });
  try {
    await git(repo, ["init", "-q"]);
    await git(repo, ["config", "user.email", "sentinel-test@example.invalid"]);
    await git(repo, ["config", "user.name", "Sentinel Test"]);
    await git(repo, ["config", "commit.gpgsign", "false"]);
    return await fn(repo);
  } finally {
    await Deno.remove(repo, { recursive: true }).catch(() => {});
  }
}

/** Stage the whole worktree and commit it. */
export async function commitAll(
  repo: string,
  message: string,
): Promise<GitSha> {
  await git(repo, ["add", "-A"]);
  await git(repo, ["commit", "-q", "-m", message]);
  return asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
}

/** Commit exactly the prepared index (used for gitlink fixtures). */
export async function commitIndex(
  repo: string,
  message: string,
): Promise<GitSha> {
  await git(repo, ["commit", "-q", "-m", message]);
  return asGitSha((await git(repo, ["rev-parse", "HEAD"])).trim());
}

export function producer(
  repo: string,
  overrides: Partial<ConstructorParameters<typeof GitReviewSnapshot>[0]> = {},
): GitReviewSnapshot {
  return new GitReviewSnapshot({
    trustedPath: PATH,
    repositoryDir: repo,
    ...overrides,
  });
}

/** Deterministic injected runtime for process/deadline failure paths. */
export function fakeRuntime(
  result: Partial<ReplayCommandResultV1> & { outcome: ReplayCommandOutcomeV1 },
): ReplayRuntimeV1 {
  return {
    run: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: new Uint8Array(),
        stderr: new Uint8Array(),
        truncated: false,
        settled: true,
        detail: "",
        ...result,
      }),
  };
}

export async function seedTwoCommitRepo(
  repo: string,
): Promise<{ base: GitSha; head: GitSha }> {
  await Deno.writeTextFile(
    `${repo}/account.ts`,
    "export function deposit(balance: number, amount: number) {\n" +
      "  return balance + amount;\n" +
      "}\n",
  );
  await Deno.writeTextFile(`${repo}/README.md`, "synthetic specification\n");
  const base = await commitAll(repo, "base");
  await Deno.writeTextFile(
    `${repo}/account.ts`,
    "export function deposit(balance: number, amount: number) {\n" +
      '  if (amount < 0) throw new Error("negative");\n' +
      "  return balance + amount;\n" +
      "}\n",
  );
  await Deno.writeTextFile(`${repo}/new.ts`, "export const added = true;\n");
  await Deno.remove(`${repo}/README.md`);
  const head = await commitAll(repo, "head");
  return { base, head };
}

// ---------------------------------------------------------------------------
// M14: bounded validation before candidate preservation
// ---------------------------------------------------------------------------

/** Exact publication validation input; protected paths default to none. */
export function publicationInput(
  base: GitSha,
  head: GitSha,
  overrides: {
    publishedHead?: GitSha | null;
    protectedPaths?: readonly string[];
  } = {},
): {
  base: GitSha;
  head: GitSha;
  publishedHead: GitSha | null;
  protectedPaths: readonly string[];
} {
  return {
    base,
    head,
    publishedHead: overrides.publishedHead ?? null,
    protectedPaths: overrides.protectedPaths ?? [],
  };
}

/** Base commit with one protected subtree and one public file. */
export async function seedProtectedRepo(repo: string): Promise<GitSha> {
  await Deno.mkdir(`${repo}/protected`, { recursive: true });
  await Deno.writeTextFile(`${repo}/protected/keep.txt`, "keep v1\n");
  await Deno.writeTextFile(`${repo}/protected/sibling.txt`, "sibling v1\n");
  await Deno.writeTextFile(`${repo}/public.txt`, "public v1\n");
  return await commitAll(repo, "base");
}
