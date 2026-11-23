/**
 * EXPERIMENTAL manual agent-job lane: trusted host Git helpers shared by the
 * cell and publish steps. Tokens travel only in the environment of one Git
 * command (`GIT_CONFIG_*`); they are never written to a checkout's config.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

const HOST_GIT_CONFIG = [
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "user.name=ubiquity-sentinel[bot]",
  "-c",
  "user.email=ubiquity-sentinel[bot]@users.noreply.github.com",
  "-c",
  "protocol.file.allow=always",
];

/** Environment that authenticates exactly one Git command against GitHub. */
export function gitAuthEnv(token: string | null): Record<string, string> {
  if (token === null || token.length === 0) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${
      btoa(`x-access-token:${token}`)
    }`,
  };
}

/** Run trusted host Git with a cleared environment. */
export async function git(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<CommandResult> {
  const output = await new Deno.Command("git", {
    args: [...HOST_GIT_CONFIG, ...args],
    cwd: options.cwd,
    clearEnv: true,
    env: {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      GIT_TERMINAL_PROMPT: "0",
      ...options.env,
    },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim(),
  };
}

/** Git that must succeed; the error never includes the environment. */
export async function gitOk(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<string> {
  const result = await git(args, options);
  if (result.code !== 0) {
    throw new Error(
      `git ${args[0]} failed (${result.code}): ${result.stderr.slice(-400)}`,
    );
  }
  return result.stdout;
}

/** Remote URL of a repository; tests substitute local bare repositories. */
export type RemoteUrl = (repository: string) => string;

export const githubRemoteUrl: RemoteUrl = (repository) =>
  `https://github.com/${repository}.git`;

/**
 * Clone one branch (the default branch when `base` is null) without tags.
 * Returns the resolved branch name and its commit.
 */
export async function cloneBranch(input: {
  url: string;
  base: string | null;
  directory: string;
  token: string | null;
}): Promise<{ branch: string; sha: string }> {
  await gitOk([
    "clone",
    "--quiet",
    "--no-tags",
    "--single-branch",
    ...(input.base === null ? [] : ["--branch", input.base]),
    input.url,
    input.directory,
  ], { env: gitAuthEnv(input.token) });
  return {
    branch: await gitOk(["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: input.directory,
    }),
    sha: await gitOk(["rev-parse", "HEAD"], { cwd: input.directory }),
  };
}
