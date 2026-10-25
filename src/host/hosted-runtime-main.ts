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
import { APP_TOKEN_MINTED_NOT_BEFORE_ENV } from "./hosted-app-token-window.ts";
import { HOSTED_APP_MINT_GRANT_ENV } from "./hosted-app-grant.ts";
import {
  reviewCommandItemRefusalLines,
  reviewTerminalAdvisoryLines,
} from "./hosted-runtime-status.ts";
import { runHostedRuntimeWithReviewCustody } from "./review-owner-host.ts";
import { fallbackHostedRuntimeSummary } from "./hosted-runtime-launcher.ts";
import type { HostedRuntimeSummaryV1 } from "../contracts/hosted-execution.ts";

/**
 * The exact process inputs the launcher reads besides the native identity.
 * Every key the child environment forwards for all jobs must be read here, or
 * a workflow setting is silently dropped before the child (the cooldown switch
 * once was); the job-scoped inputs (`readJobScopedLauncherEnv`) are read only
 * for the one job whose step grants them. Every hosted-runtime step must grant
 * each of these keys.
 */
export const HOSTED_RUNTIME_LAUNCHER_INPUT_KEYS = [
  "HOME",
  "PATH",
  "GITHUB_TOKEN",
  "SENTINEL_SUPERVISOR_TOKEN",
  "SENTINEL_SELF_TOKEN",
  "SENTINEL_SELF_TOKEN_MINT_GRANT",
  "SENTINEL_TARGET_INSTALLATION_ID",
  "SENTINEL_SELF_INSTALLATION_ID",
  "SENTINEL_MODEL_BASE_URL",
  "SENTINEL_MODEL_ID",
  "SENTINEL_MODEL_FALLBACK",
  "SENTINEL_REVIEW_MODEL_ID",
  "SENTINEL_DEEPSEEK_API_KEY",
  "SENTINEL_APP_INSTALLATION_ID",
  "SENTINEL_COOLDOWN_MODE",
  "SENTINEL_MERGE_QUEUE",
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
    Object.assign(
      env,
      readJobScopedLauncherEnv(job, (name) => Deno.env.get(name)),
    );
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
 * Job-scoped launcher inputs. Each name is read ONLY in the jobs whose
 * workflow steps grant it, so a cell never requests a name its
 * own `--allow-env` grant lacks (that read would refuse the whole launch).
 */
export function readJobScopedLauncherEnv(
  job: "repair" | "matrix_plan" | "matrix_cell",
  read: (name: string) => string | undefined,
): Record<string, string | undefined> {
  if (job === "repair" || job === "matrix_plan") {
    return {
      ...(job === "matrix_plan"
        ? { GITHUB_OUTPUT: read("GITHUB_OUTPUT") }
        : {}),
      [APP_TOKEN_MINTED_NOT_BEFORE_ENV]: read(APP_TOKEN_MINTED_NOT_BEFORE_ENV),
      [HOSTED_APP_MINT_GRANT_ENV]: read(HOSTED_APP_MINT_GRANT_ENV),
    };
  }
  return {};
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
  result: HostedRuntimeLauncherResultV1 & { summary?: HostedRuntimeSummaryV1 },
): 0 | 1 {
  for (const settlement of result.reviewOwnerSettlements ?? []) {
    console.log(JSON.stringify(settlement));
  }
  // Advisory step lines, in child order, before the carrier and terminal.
  for (const step of result.stepLines ?? []) console.log(JSON.stringify(step));
  if (result.matrixCarrier !== undefined) {
    console.log(JSON.stringify(result.matrixCarrier));
  }
  if (result.matrixPlanDiagnostic !== undefined) {
    console.log(JSON.stringify(result.matrixPlanDiagnostic));
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
  if (result.reviewTerminals !== undefined) {
    try {
      for (const line of reviewTerminalAdvisoryLines(result.reviewTerminals)) {
        console.log(line);
      }
    } catch {
      // Advisory printing cannot change the resolved child result or exit.
    }
  }
  // Exactly one advisory summary, after all child evidence; terminal readers are unchanged.
  console.log(
    JSON.stringify(result.summary ?? fallbackHostedRuntimeSummary(result)),
  );
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
