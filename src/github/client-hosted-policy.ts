// client hosted policy.
import { HOSTED_CONTROLLER_DEPLOYMENT } from "../contracts/hosted-controller-deployment.ts";
import { portError } from "../contracts/ports.ts";
import type { PortErrorV1, PortResultV1 } from "../contracts/ports.ts";

/** Development ref compared by the hosted supervisor evidence reads. */
export const ACTIONS_RELEASE_BRANCH = HOSTED_CONTROLLER_DEPLOYMENT.sourceBranch;

/** Bounded signed job-log read for the hosted runtime terminal. */
export const ACTIONS_RELEASE_LOG_MAX_BYTES = 8 * 1024 * 1024;

/** Hosted supervisor execution reader: one bounded whole-operation window. */
export const HOSTED_EXECUTION_READ_DEADLINE_MS = 120_000;

/**
 * GitHub can expose a completed workflow run before it attaches the repair
 * job's runtime step and terminal metadata. Re-read that exact jobs page for
 * a bounded window; the whole reader still fits its own deadline.
 */
export const HOSTED_EXECUTION_METADATA_REREAD_BUDGET_MS = 100_000;

export const HOSTED_EXECUTION_METADATA_REREAD_DELAY_MS = 10_000;

export const HOSTED_EXECUTION_METADATA_REREAD_MAX =
  HOSTED_EXECUTION_METADATA_REREAD_BUDGET_MS /
  HOSTED_EXECUTION_METADATA_REREAD_DELAY_MS;

// Native protected workflow: at most 256 matrix cells plus five fixed jobs.
export const HOSTED_EXECUTION_MAX_JOBS = 256 + 5;

export const HOSTED_EXECUTION_JOBS_PAGE_SIZE = 100;

export const HOSTED_EXECUTION_MAX_JOB_STEPS = 100;

export const HOSTED_EXECUTION_BRANCH =
  HOSTED_CONTROLLER_DEPLOYMENT.supervisorBranch;

export const HOSTED_EXECUTION_UNAVAILABLE =
  "hosted execution evidence is unavailable";

export const HOSTED_EXECUTION_SCOPE =
  "hosted execution evidence is restricted to the scope-0 self repository";

export const HOSTED_EXECUTION_REDIRECT =
  "hosted execution log redirect is not trusted";

export const HOSTED_EXECUTION_METADATA = "hosted execution metadata is invalid";

/**
 * Structured fact attached only when the reader actually spent its bounded
 * metadata re-read window (or ran out of the shared operation deadline) and
 * still could not observe complete runtime metadata. The host uses this fact,
 * never the detail text, to decide whether repeating the whole reader could
 * change the result.
 */
export interface HostedExecutionMetadataErrorV1 extends PortErrorV1 {
  metadataWindow: "exhausted";
}

export function hostedExecutionMetadataWindowExhausted(
  error: PortErrorV1,
): boolean {
  return (error as Partial<HostedExecutionMetadataErrorV1>).metadataWindow ===
    "exhausted";
}

/**
 * One metadata refusal. The marked variant is reserved for a reader that
 * already exhausted its own re-read budget; an incomplete listing seen before
 * that window is unmarked so the host still retries it.
 */
export function hostedExecutionMetadataError(
  windowExhausted = false,
): PortResultV1<never> {
  const failure = portError("unavailable", HOSTED_EXECUTION_METADATA);
  if (failure.ok || !windowExhausted) return failure;
  const exhausted: HostedExecutionMetadataErrorV1 = {
    ...failure.error,
    metadataWindow: "exhausted",
  };
  return { ok: false, error: exhausted };
}
