import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type { GitHubCooldownGateV1 } from "../contracts/ports.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import {
  GIT_MAX_OUTPUT_BYTES,
  GIT_TIMEOUT_MS,
  LOCAL_BASE_BRANCH,
  LOCAL_REPOSITORY,
  REMOTE_URL,
  STATIC_GIT_BOUND,
  STATIC_GIT_FAILED,
  STATIC_INVALID_CONTROLLER,
} from "./local-policy.ts";
import type { LocalRepairHostOptionsV1 } from "./local-config.ts";
import { githubGitAuthEnv } from "./local-github-auth.ts";
import { joinPath, trustedGitPath } from "./local-io.ts";

/**
 * Exact commit-object presence in the trusted source mirror, proved through
 * the trusted git runtime only. A non-zero status (absent object, unreadable
 * or foreign repository) is a refusal, never a silent success.
 */
export async function commitObjectPresent(input: {
  sourcePath: string;
  sha: GitSha;
  scratch: string;
  trustedPath: string;
}): Promise<boolean> {
  try {
    const result = await runTrustedGitResult({
      args: ["-C", input.sourcePath, "cat-file", "-e", `${input.sha}^{commit}`],
      cwd: input.sourcePath,
      trustedPath: input.trustedPath,
      scratch: input.scratch,
    });
    return result.code === 0;
  } catch {
    // An unsettled or refused trusted child proves nothing about the object:
    // it counts as absent so the caller fails closed (or asks the host for
    // the exact fetch) instead of continuing against an unproved mirror.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Durable Git and filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Initialize the private bare state repository when it is absent or an empty
 * directory; an existing nonempty path is preserved and its existing later
 * validation still refuses it. Nothing is ever deleted or reset.
 */
export async function ensureBareStateRepository(
  stateGitPath: string,
  input: LocalRepairHostOptionsV1,
  scratch: string,
): Promise<void> {
  const existing = await durableGitPathState(stateGitPath);
  if (existing === "symlink") throw new Error(STATIC_GIT_FAILED);
  if (existing === "present") return;
  const result = await runTrustedGitResult({
    args: ["init", "--bare", stateGitPath],
    cwd: input.stateRoot,
    trustedPath: input.trustedPath,
    scratch,
  });
  if (result.code !== 0) throw new Error(STATIC_GIT_FAILED);
}

/**
 * Clone the trusted source object repository when it is absent or an empty
 * directory; no hardlinks, no creds. An existing nonempty path is preserved
 * and its existing later validation still refuses it.
 */
export async function prepareSourceRepository(
  sourcePath: string,
  input: LocalRepairHostOptionsV1,
  scratch: string,
  /** Authenticated remote to seed from; omitted means the local checkout. */
  remoteUrl?: string,
): Promise<void> {
  const existing = await durableGitPathState(sourcePath);
  if (existing === "symlink") throw new Error(STATIC_GIT_FAILED);
  if (existing === "present") return;
  // The sentinel self-mirror is seeded from this run's own checkout, which is
  // the exact runtime revision. A foreign target cannot be seeded that way:
  // its objects exist only on its own remote, so it is cloned from that
  // authenticated remote with no checkout.
  const result = await runTrustedGitResult({
    args: remoteUrl === undefined
      ? ["clone", "--no-hardlinks", input.sourceDir, sourcePath]
      : ["clone", "--no-hardlinks", "--no-checkout", remoteUrl, sourcePath],
    cwd: input.stateRoot,
    trustedPath: input.trustedPath,
    scratch,
    ...(remoteUrl === undefined
      ? {}
      : { extraEnv: githubGitAuthEnv(input.githubToken, remoteUrl) }),
  });
  if (result.code !== 0) throw new Error(STATIC_GIT_FAILED);
}

/**
 * Classify a durable Git path before initialization: an absent path and an
 * existing EMPTY directory are initialized in place, an existing nonempty
 * directory or plain file is preserved (its existing later validation still
 * refuses it), and a symlink is refused before any Git runs so initialization
 * can never follow it outside the private state root. Nothing is deleted.
 */
async function durableGitPathState(
  path: string,
): Promise<"absent" | "empty" | "present" | "symlink"> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "absent";
    throw error;
  }
  if (info.isSymlink) return "symlink";
  if (!info.isDirectory) return "present";
  for await (const _entry of Deno.readDir(path)) {
    return "present";
  }
  return "empty";
}

/** Refresh the exact remote development ref through trusted authenticated git. */
export async function refreshDevelopment(
  sourcePath: string,
  /**
   * Narrowed to the exact trusted inputs this refresh reads, so an existing
   * composed host can reuse it without carrying unrelated host options. Every
   * existing caller passes a full `LocalRepairHostOptionsV1`, which remains
   * assignable and keeps identical behavior.
   */
  input: Pick<
    LocalRepairHostOptionsV1,
    "stateRoot" | "trustedPath" | "githubToken"
  >,
  scratch: string,
  gate: GitHubCooldownGateV1,
  installationId: number = LOCAL_REPOSITORY.installationId,
  /** Exact target remote and its own base branch; omitted means sentinel. */
  target: { remoteUrl: string; baseBranch: string } = {
    remoteUrl: REMOTE_URL,
    baseBranch: LOCAL_BASE_BRANCH,
  },
): Promise<string> {
  // Durable admission is the FIRST operation: a refused or faulted gate stops
  // here, before any Git command or external fetch runs. There is no
  // success-empty fallback.
  const admission = await gate.beforeRequest(installationId);
  if (!admission.ok) throw new Error(STATIC_GIT_FAILED);
  const fetched = await runTrustedGitResult({
    args: [
      "-C",
      sourcePath,
      "fetch",
      "--no-tags",
      target.remoteUrl,
      `+refs/heads/${target.baseBranch}:refs/remotes/origin/${target.baseBranch}`,
    ],
    cwd: input.stateRoot,
    trustedPath: input.trustedPath,
    scratch,
    extraEnv: githubGitAuthEnv(input.githubToken, target.remoteUrl),
  });
  if (fetched.code !== 0) throw new Error(STATIC_GIT_FAILED);
  const head = await runTrustedGitResult({
    args: [
      "-C",
      sourcePath,
      "rev-parse",
      `refs/remotes/origin/${target.baseBranch}`,
    ],
    cwd: input.stateRoot,
    trustedPath: input.trustedPath,
    scratch,
  });
  if (head.code !== 0 || !isGitSha(head.stdout.trim())) {
    throw new Error(STATIC_GIT_FAILED);
  }
  return head.stdout.trim();
}

/** Exact controller SHA through trusted git in the source worktree. */
export async function readControllerSha(
  sourceDir: string,
  trustedPath: string,
  scratch: string,
): Promise<GitSha> {
  const result = await runTrustedGitResult({
    args: ["-C", sourceDir, "rev-parse", "HEAD"],
    cwd: sourceDir,
    trustedPath,
    scratch,
  });
  const sha = result.code === 0 ? result.stdout.trim() : "";
  if (!isGitSha(sha)) throw new Error(STATIC_INVALID_CONTROLLER);
  return sha;
}

interface LocalGitInputV1 {
  args: string[];
  cwd: string;
  trustedPath: string;
  scratch?: string;
  extraEnv?: Record<string, string>;
}

/** Bounded trusted git result through the shared owned-group runtime. */
export async function runTrustedGitResult(
  input: LocalGitInputV1,
): Promise<{ code: number; stdout: string }> {
  const scratch = input.scratch ??
    joinPath(input.cwd, ".sentinel-git-home");
  const result = await new DenoReplayRuntime(Deno.execPath()).run({
    executable: trustedGitPath(input.trustedPath),
    args: ["-c", "core.hooksPath=/dev/null", ...input.args],
    cwd: input.cwd,
    env: {
      PATH: input.trustedPath,
      HOME: scratch,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      ...(input.extraEnv ?? {}),
    },
    maxDurationMs: GIT_TIMEOUT_MS,
    maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
  });
  // Only a normal, fully settled, untruncated exit yields a usable result;
  // every other outcome fails closed with a sanitized static fault.
  if (result.outcome !== "exited" || !result.settled) {
    throw new Error(STATIC_GIT_FAILED);
  }
  if (result.truncated) throw new Error(STATIC_GIT_BOUND);
  return {
    code: result.exitCode ?? 1,
    stdout: new TextDecoder().decode(result.stdout),
  };
}
