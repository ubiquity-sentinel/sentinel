/** Hosted hosted-runtime-main responsibility. */
import { SystemClock } from "../contracts/ports.ts";
import { DenoReplayRuntime } from "../replay/runtime.ts";
import { createReleaseStateStore, DenoGitRunner } from "../state/mod.ts";
import { githubGitAuthEnv, joinPath } from "./local.ts";
import {
  HOSTED_RUNTIME_STATIC_ENV,
  hostedRuntimeSentinelDir,
  isNonEmptyText,
  parseHostedEnvironment,
  readHostedIdentityEnv,
  REMOTE_URL,
  unavailableResult,
} from "./hosted-runtime-identity.ts";
import type {
  HostedModelDiagnosticV1,
  HostedRuntimeLauncherResultV1,
} from "./hosted-runtime-identity.ts";
import { readNativeMatrixStdin, runtimeJob } from "./hosted-runtime-matrix.ts";
import { runHostedRuntimeLauncher } from "./hosted-runtime-launcher.ts";

/**
 * Production entrypoint: fixed launcher cwd, fixed sibling runtime, the actual
 * Deno executable and the existing native token for a read-only release-state
 * read in the private ignored launcher scratch. The optional App token is read
 * only to forward it to the child for code-change writes. No test-only override
 * exists in this path.
 */
export async function runHostedRuntimeMain(): Promise<
  HostedRuntimeLauncherResultV1
> {
  try {
    // Only the named keys are read: the eight identity fields plus the four
    // existing process inputs. No unrestricted env access is required.
    const env: Record<string, string | undefined> = {
      ...readHostedIdentityEnv(),
      HOME: Deno.env.get("HOME"),
      PATH: Deno.env.get("PATH"),
      GITHUB_TOKEN: Deno.env.get("GITHUB_TOKEN"),
      SENTINEL_SUPERVISOR_TOKEN: Deno.env.get("SENTINEL_SUPERVISOR_TOKEN"),
      SENTINEL_MODEL_BASE_URL: Deno.env.get("SENTINEL_MODEL_BASE_URL"),
      SENTINEL_MODEL_ID: Deno.env.get("SENTINEL_MODEL_ID"),
      SENTINEL_MODEL_FALLBACK: Deno.env.get("SENTINEL_MODEL_FALLBACK"),
      SENTINEL_REVIEW_MODEL_ID: Deno.env.get("SENTINEL_REVIEW_MODEL_ID"),
      SENTINEL_DEEPSEEK_API_KEY: Deno.env.get("SENTINEL_DEEPSEEK_API_KEY"),
      SENTINEL_APP_INSTALLATION_ID: Deno.env.get(
        "SENTINEL_APP_INSTALLATION_ID",
      ),
      UOS_AI_TOKEN: Deno.env.get("UOS_AI_TOKEN"),
    };
    // Native identity is the first check: a malformed job identity fails
    // before any credential, checkout or state setup.
    const job = runtimeJob(env.GITHUB_JOB);
    parseHostedEnvironment(env, job);
    if (job === "matrix_plan") {
      env.GITHUB_OUTPUT = Deno.env.get("GITHUB_OUTPUT");
    }
    const stdin = job === "matrix_plan"
      ? undefined
      : await readNativeMatrixStdin();
    const launcherDir = Deno.cwd();
    const runtimeDir = joinPath(launcherDir, "..", "runtime");
    const token = env.GITHUB_TOKEN;
    if (!isNonEmptyText(token)) throw new Error(HOSTED_RUNTIME_STATIC_ENV);
    const sentinelDir = hostedRuntimeSentinelDir(launcherDir);
    const state = createReleaseStateStore({
      scratchDir: joinPath(sentinelDir, "state-scratch"),
      remoteUrl: REMOTE_URL,
      runner: new DenoGitRunner(
        joinPath(sentinelDir, "state-git-home"),
        githubGitAuthEnv(token),
      ),
    });
    const result = await runHostedRuntimeLauncher({
      state,
      clock: new SystemClock(),
      env,
      launcherDir,
      runtimeDir,
      denoExecutable: Deno.execPath(),
      process: new DenoReplayRuntime(Deno.execPath()),
      onDiagnostic: logHostedDiagnostic,
      ...(stdin === undefined ? {} : { stdin }),
    });
    return result;
  } catch {
    return unavailableResult();
  }
}

/**
 * Production advisory sink: one sanitized summary per streamed line, printed
 * as soon as its complete stdout line is retained instead of waiting for the
 * whole child run. It is explicitly advisory and never evidence of child
 * settlement, health or delivery.
 */
function logHostedDiagnostic(diagnostic: HostedModelDiagnosticV1): void {
  console.log(JSON.stringify(diagnostic));
}

export function emitHostedRuntimeCliResult(
  result: HostedRuntimeLauncherResultV1,
): 0 | 1 {
  if (result.matrixCarrier !== undefined) {
    console.log(JSON.stringify(result.matrixCarrier));
  }
  if (result.earlyFailure !== undefined) {
    console.log(JSON.stringify(result.earlyFailure));
  }
  if (result.terminal !== null) console.log(JSON.stringify(result.terminal));
  if (
    result.status === "unavailable" && result.launcherRejection !== undefined
  ) {
    console.log(JSON.stringify(result.launcherRejection));
  }
  if (result.status !== "healthy") {
    console.error(result.detail);
    return 1;
  }
  return 0;
}
