/** Hosted hosted-runtime-child responsibility. */
import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import {
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY,
} from "../contracts/hosted-supervisor.ts";
import type { ReplayRuntimeV1 } from "../replay/runtime.ts";
import { joinPath } from "./local.ts";
import {
  GIT_EXECUTABLE,
  GIT_MAX_OUTPUT_BYTES,
  GIT_TIMEOUT_MS,
  HOSTED_RUNTIME_STATIC_ENV,
  HOSTED_RUNTIME_STATIC_SOURCE,
  HOSTED_RUNTIME_WORKFLOW_REF,
  isNonEmptyText,
  parentDirectory,
} from "./hosted-runtime-identity.ts";
import type { HostedRuntimeIdentityV1 } from "./hosted-runtime-identity.ts";
import { LEGACY_REVIEW_CUTOFF_ENV } from "./legacy-review-cutoff-env.ts";
import {
  HOSTED_APP_GRANT_MAX_BYTES,
  HOSTED_APP_MINT_GRANT_ENV,
} from "./hosted-app-grant.ts";
import {
  APP_TOKEN_MINTED_NOT_BEFORE_ENV,
  APP_TOKEN_NOT_AFTER_ENV,
  deriveAppTokenNotAfterV1,
} from "./hosted-app-token-window.ts";

export function buildChildEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  identity: HostedRuntimeIdentityV1,
  dirs: { home: string; tmp: string; denoDir: string },
  now: number,
  /**
   * The legacy review class's cutoff the launcher pinned for exactly the
   * executed revision (`legacyReviewCutoffForExecution`); never read from the
   * launcher's own environment. Null: the key is not set.
   */
  legacyReviewCutoff: number | null = null,
): Record<string, string> {
  const path = env.PATH;
  const githubToken = env.GITHUB_TOKEN;
  const appToken = env.SENTINEL_SUPERVISOR_TOKEN;
  const selfToken = env.SENTINEL_SELF_TOKEN;
  const selfGrant = env.SENTINEL_SELF_TOKEN_MINT_GRANT;
  const modelToken = env.UOS_AI_TOKEN;
  if (
    !isNonEmptyText(path) || !isNonEmptyText(githubToken) ||
    !isNonEmptyText(modelToken)
  ) {
    throw new Error(HOSTED_RUNTIME_STATIC_ENV);
  }
  // Complete-only child environment: the two required credentials, the
  // optional App token when it is non-empty text, the validated standard
  // identity, plus private HOME/cache/temp. No Actions output/env/path file and
  // no host variable crosses over.
  // Optional route inputs: forwarded only when non-empty so an unset route
  // keeps the primary gateway behavior exactly as before. The child's own
  // trusted resolver decides the route; the launcher never selects one.
  const routeKeys = [
    "SENTINEL_MODEL_BASE_URL",
    "SENTINEL_MODEL_ID",
    "SENTINEL_MODEL_FALLBACK",
    "SENTINEL_REVIEW_MODEL_ID",
    "SENTINEL_DEEPSEEK_API_KEY",
    "SENTINEL_COOLDOWN_MODE",
  ] as const;
  const routeEnv: Record<string, string> = {};
  for (const key of routeKeys) {
    const value = env[key];
    if (isNonEmptyText(value)) routeEnv[key] = value;
  }
  const child: Record<string, string> = {
    HOME: dirs.home,
    PATH: path,
    GITHUB_TOKEN: githubToken,
    ...(isNonEmptyText(appToken)
      ? {
        SENTINEL_SUPERVISOR_TOKEN: appToken,
        ...(isNonEmptyText(selfToken)
          ? {
            SENTINEL_SELF_TOKEN: selfToken,
            ...(selfGrant === undefined
              ? {}
              : { SENTINEL_SELF_TOKEN_MINT_GRANT: selfGrant }),
          }
          : {}),
      }
      : {}),
    ...routeEnv,
    UOS_AI_TOKEN: modelToken,
    GITHUB_RUN_ID: String(identity.runId),
    GITHUB_RUN_ATTEMPT: String(identity.runAttempt),
    GITHUB_REPOSITORY: HOSTED_SUPERVISOR_REPOSITORY,
    GITHUB_REF: HOSTED_SUPERVISOR_REF,
    GITHUB_SHA: identity.launcherSha,
    GITHUB_WORKFLOW_SHA: identity.launcherSha,
    GITHUB_WORKFLOW_REF: HOSTED_RUNTIME_WORKFLOW_REF,
    GITHUB_JOB: identity.job,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
    DENO_DIR: dirs.denoDir,
  };
  if (isNonEmptyText(appToken)) {
    child.SENTINEL_SUPERVISOR_TOKEN = appToken;
    if (isNonEmptyText(selfToken)) {
      child.SENTINEL_SELF_TOKEN = selfToken;
      if (selfGrant !== undefined) {
        child.SENTINEL_SELF_TOKEN_MINT_GRANT = selfGrant;
      }
    }
  }
  // Optional model-route inputs, forwarded only when non-empty so an unset
  // route keeps the primary gateway behaviour exactly as before. The child's
  // own trusted resolver decides the route; the launcher never selects one and
  // the DeepSeek key is only ever a forwarded value, never logged.
  for (
    const key of [
      "SENTINEL_MODEL_BASE_URL",
      "SENTINEL_MODEL_ID",
      "SENTINEL_MODEL_FALLBACK",
      "SENTINEL_DEEPSEEK_API_KEY",
      "SENTINEL_APP_INSTALLATION_ID",
      "SENTINEL_TARGET_INSTALLATION_ID",
      "SENTINEL_SELF_INSTALLATION_ID",
      "SENTINEL_COOLDOWN_MODE",
    ] as const
  ) {
    const value = env[key];
    if (isNonEmptyText(value)) child[key] = value;
  }
  // Admission selector belongs to the trusted runtime host, never a model client.
  // Preserve invalid nonempty values so the child's lower-only resolver disables.
  if (typeof env.SENTINEL_MERGE_QUEUE === "string") {
    child.SENTINEL_MERGE_QUEUE = env.SENTINEL_MERGE_QUEUE;
  }
  // Backup CI's lower-only mode (spec §11.8): forwarded as given, so the
  // child's exact parse reads anything but `on` and `shadow` as `off`.
  if (typeof env.SENTINEL_BACKUP_CI === "string") {
    child.SENTINEL_BACKUP_CI = env.SENTINEL_BACKUP_CI;
  }
  if (legacyReviewCutoff !== null) {
    child[LEGACY_REVIEW_CUTOFF_ENV] = String(legacyReviewCutoff);
  }
  if (identity.job === "matrix_plan") {
    const output = env.GITHUB_OUTPUT;
    if (!isNonEmptyText(output)) throw new Error(HOSTED_RUNTIME_STATIC_ENV);
    child.GITHUB_OUTPUT = output;
  }
  // Repair and planner share the same conservative App lifetime. Without an
  // App token every write uses the
  // job-lifetime native token, so there is nothing to bound. A malformed or
  // future mint bound refuses here, before any child exists.
  if (identity.job !== "matrix_cell" && isNonEmptyText(appToken)) {
    let notAfter: number | undefined;
    try {
      notAfter = deriveAppTokenNotAfterV1(
        env[APP_TOKEN_MINTED_NOT_BEFORE_ENV],
        now,
      );
    } catch {
      throw new Error(HOSTED_RUNTIME_STATIC_ENV);
    }
    if (notAfter !== undefined) {
      child[APP_TOKEN_NOT_AFTER_ENV] = String(notAfter);
    }
    // Inert metadata follows only its own App token into trusted host children.
    // The private principal factory repeats source/native/scope checks. It
    // refuses missing or malformed metadata without disabling ordinary work.
    const grant = env[HOSTED_APP_MINT_GRANT_ENV];
    if (
      notAfter !== undefined && typeof grant === "string" && grant.length > 0 &&
      grant.length <= HOSTED_APP_GRANT_MAX_BYTES &&
      new TextEncoder().encode(grant).length <= HOSTED_APP_GRANT_MAX_BYTES
    ) {
      child[HOSTED_APP_MINT_GRANT_ENV] = grant;
    }
  }
  return child;
}

/** Canonical real directories: the runtime is the launcher's fixed sibling. */
export async function resolveRuntimeDirectories(
  launcherDir: string,
  runtimeDir: string,
): Promise<{ launcher: string; runtime: string }> {
  const launcher = await realDirectory(launcherDir);
  const runtime = await realDirectory(runtimeDir);
  if (runtime !== joinPath(parentDirectory(launcher), "runtime")) {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  if (runtime === launcher) throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  return { launcher, runtime };
}

async function realDirectory(path: string): Promise<string> {
  let real: string;
  try {
    real = await Deno.realPath(path);
  } catch {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(real);
  } catch {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  if (!info.isDirectory) throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  return real;
}

/** Exact commit of a clean worktree, read with fixed credential-free git. */
export async function readCleanGitHead(
  process: ReplayRuntimeV1,
  dir: string,
): Promise<GitSha> {
  const head = await runBoundedGit(process, dir, ["rev-parse", "HEAD"]);
  if (head === null || !isGitSha(head)) {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  const status = await runBoundedGit(process, dir, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (status === null || status !== "") {
    throw new Error(HOSTED_RUNTIME_STATIC_SOURCE);
  }
  return head;
}

async function runBoundedGit(
  process: ReplayRuntimeV1,
  dir: string,
  args: readonly string[],
): Promise<string | null> {
  try {
    const result = await process.run({
      executable: GIT_EXECUTABLE,
      args: ["-c", "core.hooksPath=/dev/null", "-C", dir, ...args],
      cwd: dir,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: dir,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      maxDurationMs: GIT_TIMEOUT_MS,
      maxOutputBytes: GIT_MAX_OUTPUT_BYTES,
    });
    if (
      result.outcome !== "exited" || !result.settled || result.truncated ||
      result.exitCode !== 0
    ) {
      return null;
    }
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return null;
  }
}
