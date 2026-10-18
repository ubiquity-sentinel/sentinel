/**
 * Advisory classification and optional structured hints for one failing
 * check. The label tells the model whether a repository command failed
 * ("candidate") or the failure sits in runner setup, checkout, caching,
 * artifacts, a lost runner or a cancellation ("likely infrastructure"), so it
 * does not chase infrastructure. It never changes correction, round or merge
 * policy. A log segment alone cannot relabel a run-step failure: candidate
 * output can print fake group lines, so a setup label also needs the job's
 * own failing step (from the API) to be a setup step when it is known.
 *
 * Hints summarize formatter, linter, compiler and test failures on top of
 * the raw excerpt; an unrecognized failure has no hints and loses nothing.
 */
import type {
  CiRetainedStepV1,
  CiScannedLogV1,
} from "./ci-evidence-excerpt.ts";
import {
  type CiCheckClassificationV1,
  type CiFailingStepV1,
  MAX_CI_HINT_CHARS,
  MAX_CI_HINTS,
} from "./ci-evidence-types.ts";
import { capChars } from "./ci-evidence-sanitize.ts";

export const CI_REASON_RUN_STEP = "a repository command failed in a run step";
export const CI_REASON_HANG =
  "a run step timed out (a possible hang in the candidate)";
export const CI_REASON_ACTION = "a repository action or composite step failed";
export const CI_REASON_STEP = "a job step failed";
export const CI_REASON_NO_DETAIL =
  "no step-level detail is available; treated as the candidate's";
export const CI_REASON_EXTERNAL = "an external check reported a failure";
export const CI_REASON_SETUP =
  "the failing step is a setup, checkout, cache or artifact step";
export const CI_REASON_SETUP_TIMEOUT = "the job timed out outside any run step";
export const CI_REASON_STARTUP =
  "the job failed before any step ran (startup failure)";
export const CI_REASON_RUNNER = "the runner was lost or shut down";
export const CI_REASON_CANCELLED =
  "the job was cancelled without a failing step";
export const CI_REASON_EXTERNAL_STALE =
  "the external check was cancelled or went stale";

/** `owner/repo[/path]@ref` of a step that uses an action. */
const ACTION_REF = /^(?:Run )?[\w.-]+\/([\w.-]+)(?:\/[\w./-]+)?@\S+$/i;
const INFRA_ACTION =
  /^(?:checkout|cache|upload-artifact|download-artifact|setup-[\w.-]+)$/i;

function infraAction(text: string): boolean {
  const match = ACTION_REF.exec(text.trim());
  return match !== null && INFRA_ACTION.test(match[1]);
}

/** A job step name GitHub or a workflow gives to runner/setup work. */
export function infraStepName(name: string): boolean {
  const trimmed = name.trim();
  return /^(?:set up job|complete job)$/i.test(trimmed) ||
    /^post\b/i.test(trimmed) || /\bcheckout\b/i.test(trimmed) ||
    infraAction(trimmed);
}

export interface CiClassifyInputV1 {
  /** Check-run (job) conclusion. */
  conclusion: string;
  /** Not a GitHub Actions job (another app's check run or a commit status). */
  external: boolean;
  /** The job's failing steps from the API; null when they could not be read. */
  failingSteps: readonly CiFailingStepV1[] | null;
  log: CiScannedLogV1 | null;
}

export function classifyCheck(
  input: CiClassifyInputV1,
): { classification: CiCheckClassificationV1; reason: string } {
  const candidate = (reason: string) => ({
    classification: "candidate" as const,
    reason,
  });
  const infra = (reason: string) => ({
    classification: "likely_infrastructure" as const,
    reason,
  });
  if (input.external) {
    return ["cancelled", "stale", "startup_failure"].includes(input.conclusion)
      ? infra(CI_REASON_EXTERNAL_STALE)
      : candidate(CI_REASON_EXTERNAL);
  }
  if (input.conclusion === "startup_failure") return infra(CI_REASON_STARTUP);
  if (input.log?.runnerLost === true) return infra(CI_REASON_RUNNER);
  const steps = input.failingSteps;
  const known = steps !== null && steps.length > 0;
  const apiInfra = known && steps.every((step) => infraStepName(step.name));
  if (input.conclusion === "cancelled") {
    const failed = (steps ?? []).filter((step) =>
      step.conclusion === "failure"
    );
    return failed.length > 0 &&
        !failed.every((step) => infraStepName(step.name))
      ? candidate(CI_REASON_STEP)
      : infra(CI_REASON_CANCELLED);
  }
  const timedOut = input.conclusion === "timed_out";
  const failing = input.log?.steps.find((step) => step.hasError) ?? null;
  if (failing !== null) {
    if (failing.hasShell) {
      return candidate(timedOut ? CI_REASON_HANG : CI_REASON_RUN_STEP);
    }
    const setup = failing.header === "Set up job" ||
      failing.header === "Post job cleanup" || infraAction(failing.header);
    if (setup && (!known || apiInfra)) {
      return infra(timedOut ? CI_REASON_SETUP_TIMEOUT : CI_REASON_SETUP);
    }
    return candidate(CI_REASON_ACTION);
  }
  if (apiInfra) {
    return infra(timedOut ? CI_REASON_SETUP_TIMEOUT : CI_REASON_SETUP);
  }
  if (timedOut && !known) return infra(CI_REASON_SETUP_TIMEOUT);
  return candidate(known ? CI_REASON_STEP : CI_REASON_NO_DETAIL);
}

const PRETTIER = /^\[warn\] (\S+)$/;
const BARE_PATH = /^(\S+\.[A-Za-z0-9]{1,8})$/;
const TSC = /^(\S+?)\((\d+),(\d+)\): error (TS\d+):/;
const RUSTC = /^error\[(E\d+)\]/;
const RUSTC_AT = /^\s*--> (\S+:\d+:\d+)$/;
const TEST_FAIL = [
  /^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/,
  /^--- FAIL: (\S+)/,
  /^FAILED (\S+::\S+)/,
  /^not ok \d+ - (.+)$/,
];

/** Bounded structured summaries of the failing steps' retained lines. */
export function extractHints(steps: readonly CiRetainedStepV1[]): string[] {
  const hints: string[] = [];
  const add = (hint: string) => {
    const capped = capChars(hint, MAX_CI_HINT_CHARS);
    if (hints.length < MAX_CI_HINTS && !hints.includes(capped)) {
      hints.push(capped);
    }
  };
  for (const step of steps) {
    let file: string | null = null;
    let rustCode: string | null = null;
    const indices = [...step.lines.keys()].sort((a, b) => a - b);
    for (const index of indices) {
      const line = step.lines.get(index)!;
      const prettier = PRETTIER.exec(line);
      if (prettier !== null && /[./]/.test(prettier[1])) {
        add(`prettier: ${prettier[1]}`);
      }
      if (BARE_PATH.test(line)) file = line;
      const parts = line.split(/\s{2,}/);
      if (
        file !== null && parts.length >= 4 && parts[0] === "" &&
        /^\d+:\d+$/.test(parts[1] ?? "") && parts[2] === "error"
      ) {
        add(`eslint: ${file}:${parts[1]} error ${parts[parts.length - 1]}`);
      }
      const tsc = TSC.exec(line);
      if (tsc !== null) add(`tsc: ${tsc[1]}(${tsc[2]},${tsc[3]}) ${tsc[4]}`);
      const rust = RUSTC.exec(line);
      if (rust !== null) rustCode = rust[1];
      const at = RUSTC_AT.exec(line);
      if (at !== null && rustCode !== null) {
        add(`rustc: ${at[1]} ${rustCode}`);
        rustCode = null;
      }
      for (const pattern of TEST_FAIL) {
        const test = pattern.exec(line);
        if (test !== null) add(`test: ${test[1]}`);
      }
    }
  }
  return hints;
}
