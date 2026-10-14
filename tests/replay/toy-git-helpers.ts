import type { GitSha } from "../../src/contracts/brands.ts";
import type { ToyApp } from "./helpers.ts";
import {
  APP_BUGGY,
  APP_FIXED,
  APP_UNRELATED,
  TOY_BUNDLE_FILES,
  TOY_DENO_JSON,
} from "./toy-app-fixtures.ts";

export function testGitEnv(home: string): Record<string, string> {
  return {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    HOME: home,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "sentinel-replay-test",
    GIT_AUTHOR_EMAIL: "sentinel-replay-test@localhost",
    GIT_COMMITTER_NAME: "sentinel-replay-test",
    GIT_COMMITTER_EMAIL: "sentinel-replay-test@localhost",
  };
}

export interface GitRunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export async function gitRun(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<GitRunResult> {
  const result = await new Deno.Command("git", {
    args,
    cwd,
    clearEnv: true,
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: result.success,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

export async function revParse(
  cwd: string,
  env: Record<string, string>,
): Promise<GitSha> {
  const result = await gitRun(cwd, ["rev-parse", "HEAD"], env);
  if (!result.ok) throw new Error(`rev-parse HEAD failed: ${result.stderr}`);
  return result.stdout.trim() as GitSha;
}

/**
 * Create the tiny toy repository: original bug, candidate fix, unrelated
 * breakage — three commits on a single main branch, all credential-free.
 */
export async function createToyApp(root: string): Promise<ToyApp> {
  await Deno.mkdir(root, { recursive: true });
  const env = testGitEnv(`${root}/home`);
  const init = await gitRun(root, ["init", "-q", "-b", "main"], env);
  if (!init.ok) throw new Error(`toy init failed: ${init.stderr}`);

  const write = async (path: string, text: string): Promise<void> => {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  };

  await write("deno.json", TOY_DENO_JSON);
  await write("src/app.ts", APP_BUGGY);
  await commitAll(root, env, "original: missing terminator produces 500");
  const originalSha = await revParse(root, env);

  // The candidate is the DELIVERED head: the fix plus the permanent
  // regression test + recorded upstream fixture, wired into the toy's
  // normal CI (`deno task test` picks up tests/). The trusted bundle must
  // replay original-intended-failure AND this exact candidate head even
  // though the candidate already contains the bundle bytes.
  await write("src/app.ts", APP_FIXED);
  for (const [path, text] of Object.entries(TOY_BUNDLE_FILES)) {
    await write(path, text);
  }
  await commitAll(
    root,
    env,
    "candidate: tolerate missing terminator; deliver permanent regression fixtures",
  );
  const candidateSha = await revParse(root, env);

  await write("src/app.ts", APP_UNRELATED);
  await commitAll(root, env, "unrelated: different breakage");
  const unrelatedSha = await revParse(root, env);

  return { root, env, originalSha, candidateSha, unrelatedSha };
}

export async function commitWith(
  root: string,
  env: Record<string, string>,
  files: Record<string, string>,
  message: string,
): Promise<GitSha> {
  for (const [path, text] of Object.entries(files)) {
    const full = `${root}/${path}`;
    await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(full, text);
  }
  await commitAll(root, env, message);
  return revParse(root, env);
}

async function commitAll(
  root: string,
  env: Record<string, string>,
  message: string,
): Promise<void> {
  const add = await gitRun(root, ["add", "-A"], env);
  if (!add.ok) throw new Error(`toy add failed: ${add.stderr}`);
  const commit = await gitRun(root, ["commit", "-q", "-m", message], env);
  if (!commit.ok) throw new Error(`toy commit failed: ${commit.stderr}`);
}

/**
 * Commit a symlink at `linkPath` whose blob text is `blobText`
 * (malicious-checkout fixture). Built with git plumbing so the test process
 * never needs symlink permissions: a gitlink entry (mode 120000) replaces
 * any existing index entry at `linkPath` (the delivered candidate contains
 * real files there, so the old entry is removed from the index first; the
 * worktree files remain untracked and never enter this commit).
 */
export async function commitSymlink(
  root: string,
  env: Record<string, string>,
  linkPath = "tests",
  blobText = "src",
): Promise<GitSha> {
  const remove = await gitRun(
    root,
    ["rm", "-r", "--cached", "--quiet", linkPath],
    env,
  );
  if (
    !remove.ok && !/did not match any files|pathspec .* did not match/.test(
      remove.stderr,
    )
  ) {
    throw new Error(`git rm --cached failed: ${remove.stderr}`);
  }
  const targetFile = `${root}/.link-target`;
  await Deno.writeTextFile(targetFile, blobText);
  try {
    const blob = await gitRun(
      root,
      ["hash-object", "-w", targetFile],
      env,
    );
    if (!blob.ok) throw new Error(`hash-object failed: ${blob.stderr}`);
    const blobSha = blob.stdout.trim();
    const index = await gitRun(
      root,
      ["update-index", "--add", "--cacheinfo", `120000,${blobSha},${linkPath}`],
      env,
    );
    if (!index.ok) throw new Error(`update-index failed: ${index.stderr}`);
  } finally {
    await Deno.remove(targetFile).catch(() => {});
  }
  const commit = await gitRun(
    root,
    ["commit", "-q", "-m", `symlink ${linkPath} -> ${blobText}`],
    env,
  );
  if (!commit.ok) throw new Error(`symlink commit failed: ${commit.stderr}`);
  return revParse(root, env);
}

/** Expected digest over a bundle entry set (independent of the port impl). */
