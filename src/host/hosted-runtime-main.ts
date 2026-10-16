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
import { reviewCommandItemRefusalLines } from "./hosted-runtime-status.ts";
import { runHostedRuntimeWithReviewCustody } from "./review-owner-host.ts";

/**
 * The exact process inputs the launcher reads besides the native identity.
 * Every key the child environment forwards for all jobs must be read here, or
 * a workflow setting is silently dropped before the child (the cooldown switch
 * once was); the matrix_plan-only GITHUB_OUTPUT is read conditionally below.
 * Every hosted-runtime step must grant each of these keys.
 */
export const HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS = [
  "HOME",
  "PATH",
  "GITHUB_TOKEN",
  "SENTINEL_SUPERVISOR_TOKEN",
  "SENTINEL_MODEL_BASE_URL",
  "SENTINEL_MODEL_ID",
  "SENTINEL_MODEL_FALLBACK",
  "SENTINEL_REVIEW_MODEL_ID",
  "SENTINEL_DEEPSEEK_API_KEY",
  "SENTINEL_APP_INSTALLATION_ID",
  "SENTINEL_COOLDOWN_MODE",
  "UOS_AI_TOKEN",
] as const;

/** Named reads of exactly the launcher inputs; the reader is a test seam. */
export function readHostedLauncherInputs(
  read: (key: string) => string | undefined = (key) => Deno.env.get(key),
): Record<string, string | undefined> {
  const inputs: Record<string, string | undefined> = {};
  for (const key of HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS) inputs[key] = read(key);
  return inputs;
}

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
    // Only the named keys are read: the eight identity fields plus the fixed
    // launcher inputs. No unrestricted env access is required.
    const env: Record<string, string | undefined> = {
      ...readHostedIdentityEnv(),
      ...readHostedLauncherInputs(),
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
    const result = await runHostedRuntimeWithReviewCustody({
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
  for (const settlement of result.reviewOwnerSettlements ?? []) {
    console.log(JSON.stringify(settlement));
  }
  if (result.matrixCarrier !== undefined) {
    console.log(JSON.stringify(result.matrixCarrier));
  }
  if (result.earlyFailure !== undefined) {
    console.log(JSON.stringify(result.earlyFailure));
  }
  if (result.terminal !== null) console.log(JSON.stringify(result.terminal));
  if (result.mergeEvents !== undefined) {
    for (const mergeEvent of result.mergeEvents) {
      console.log(JSON.stringify(mergeEvent));
    }
  }
  if (result.childFailure !== undefined) {
    console.log(JSON.stringify(result.childFailure));
  }
  if (
    result.status === "unavailable" && result.launcherRejection !== undefined
  ) {
    console.log(JSON.stringify(result.launcherRejection));
  }
  printReviewCommandRefusals(result);
  if (result.status !== "healthy") {
    console.error(result.detail);
    return 1;
  }
  return 0;
}

/**
 * Advisory only, printed after every evidence line: the refused reviewer
 * command predicates the child reported, re-validated and capped. A failure to
 * print is swallowed, so it can never change the exit status.
 */
function printReviewCommandRefusals(
  result: HostedRuntimeLauncherResultV1,
): void {
  if (result.reviewCommandRefusals === undefined) return;
  try {
    for (
      const line of reviewCommandItemRefusalLines(result.reviewCommandRefusals)
    ) {
      console.log(line);
    }
  } catch {
    // Advisory only.
  }
}
