/**
 * Bounded backoff for a supervisor that keeps failing before its runtime.
 *
 * 2026-11-20 → 2026-11-22: one renamed target made every supervisor run fail
 * in its first job (the App token mint), and every failed run still chained
 * the next dispatcher run, so the failures looped about every 90 seconds until
 * the API quota was exhausted. This pass reads the newest completed runs of
 * the exact supervisor workflow on the protected ref once. When the newest
 * `BACKOFF_STREAK_THRESHOLD` or more all failed quickly (a `failure` or
 * `startup_failure` completed within `FAST_FAILURE_MS` of its start) at the
 * launcher SHA the follow step just read, the next supervisor dispatch is due
 * `backoffDelayMs(streak)` after the newest of them completed: 5, 10, 20, then
 * at most 30 minutes.
 *
 * Before it is due, the pass never ends the chain: it first dispatches the
 * dispatcher workflow itself (one POST, no parent id), so a pending successor
 * already exists, and only then holds for at most `BACKOFF_HOLD_MAX_MS` inside
 * the five-minute dispatcher job. The successor runs the follow step first, so
 * a CI-green fix is still installed within one hop, and a changed launcher SHA
 * or one success has no streak and dispatches at once.
 *
 * Fail open: an unreadable or malformed listing, a short streak, an elapsed
 * delay or a refused self-dispatch all return `dispatch`, exactly today's
 * behaviour. One text-free log line names the decision, a closed reason and
 * the streak count; nothing is persisted.
 */
import type { Clock } from "../contracts/ports.ts";
import {
  HOSTED_CONTROLLER_DEPLOYMENT,
  HOSTED_CONTROLLER_REPOSITORY,
} from "../contracts/hosted-controller-deployment.ts";
import { headerMap, type HttpTransportV1 } from "../github/http.ts";

/** Consecutive fast failures at one launcher SHA before any delay. */
export const BACKOFF_STREAK_THRESHOLD = 3;
/** Delay of the first backed-off dispatch; it doubles per further failure. */
export const BACKOFF_BASE_MS = 5 * 60_000;
/** Upper bound of the delay. */
export const BACKOFF_MAX_MS = 30 * 60_000;
/**
 * A failed run that completed within this of its start failed quickly. The
 * 2026-11-20 mint failures took 38-50 s and a green idle run can take about
 * nine minutes, so only a failure well under either counts.
 */
export const FAST_FAILURE_MS = 3 * 60_000;
/**
 * Longest hold of one dispatcher hop. With checkout, setup and the follow step
 * before it, the hop still ends inside the job's five-minute timeout; the
 * successor is already queued if it does not.
 */
export const BACKOFF_HOLD_MAX_MS = 150_000;
/** Newest completed runs read; enough to reach the delay cap. */
export const BACKOFF_LISTED_RUNS = 10;

const API_BASE = "https://api.github.com";
const FAST_CONCLUSIONS = new Set(["failure", "startup_failure"]);
const SUPERVISOR_RUNS_PATH =
  `/repos/${HOSTED_CONTROLLER_REPOSITORY}/actions/workflows/supervisor.yml/runs`;
const DISPATCHER_DISPATCH_PATH =
  `/repos/${HOSTED_CONTROLLER_REPOSITORY}/actions/workflows/supervisor-dispatch.yml/dispatches`;

export interface SupervisorBackoffDepsV1 {
  http: HttpTransportV1;
  token: string;
  clock: Clock;
  /** The launcher SHA the follow step read back in this same hop. */
  launcherSha: string;
  log: (line: Record<string, unknown>) => void;
  /** Injected in tests; production waits on a timer. */
  sleep?: (ms: number) => Promise<void>;
}

export type SupervisorBackoffDecisionV1 = "dispatch" | "held";

/** The delay owed after `streak` consecutive fast failures (0 below 3). */
export function backoffDelayMs(streak: number): number {
  if (!Number.isSafeInteger(streak) || streak < BACKOFF_STREAK_THRESHOLD) {
    return 0;
  }
  const doublings = Math.min(streak - BACKOFF_STREAK_THRESHOLD, 16);
  return Math.min(BACKOFF_BASE_MS * 2 ** doublings, BACKOFF_MAX_MS);
}

/**
 * Newest-first streak of fast failures at `launcherSha`, with the completion
 * time of the newest; null when any listed run is malformed.
 */
export function fastFailureStreak(
  runs: readonly unknown[],
  launcherSha: string,
): { streak: number; newestCompletedMs: number | null } | null {
  let streak = 0;
  let newestCompletedMs: number | null = null;
  let previousCreatedMs = Number.POSITIVE_INFINITY;
  for (const raw of runs) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return null;
    }
    const run = raw as Record<string, unknown>;
    const createdMs = timestamp(run.created_at);
    const startedMs = run.run_started_at === undefined
      ? createdMs
      : timestamp(run.run_started_at);
    const completedMs = timestamp(run.updated_at);
    if (
      run.status !== "completed" ||
      run.path !== HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowPath ||
      run.head_branch !== HOSTED_CONTROLLER_DEPLOYMENT.supervisorBranch ||
      typeof run.head_sha !== "string" ||
      createdMs === null || startedMs === null || completedMs === null ||
      createdMs > previousCreatedMs
    ) return null;
    previousCreatedMs = createdMs;
    const fast = typeof run.conclusion === "string" &&
      FAST_CONCLUSIONS.has(run.conclusion) &&
      completedMs >= startedMs && completedMs - startedMs <= FAST_FAILURE_MS;
    if (!fast || run.head_sha !== launcherSha) break;
    if (streak === 0) newestCompletedMs = completedMs;
    streak += 1;
  }
  return { streak, newestCompletedMs };
}

/**
 * Decide whether this hop dispatches the supervisor now (`dispatch`) or has
 * chained its successor and held (`held`). Never throws.
 */
export async function supervisorDispatchBackoff(
  deps: SupervisorBackoffDepsV1,
): Promise<SupervisorBackoffDecisionV1> {
  const line = (decision: string, reason: string, extra = {}) =>
    deps.log({ event: "dispatch_backoff", decision, reason, ...extra });
  let streak: ReturnType<typeof fastFailureStreak>;
  try {
    streak = await readStreak(deps);
  } catch {
    streak = null;
  }
  if (streak === null) {
    line("dispatch", "listing_unavailable");
    return "dispatch";
  }
  const delayMs = backoffDelayMs(streak.streak);
  if (delayMs === 0 || streak.newestCompletedMs === null) return "dispatch";
  const dueMs = streak.newestCompletedMs + delayMs;
  const nowMs = deps.clock.now();
  const counts = { streak: streak.streak, delayMs };
  if (nowMs >= dueMs) {
    line("dispatch", "backoff_elapsed", counts);
    return "dispatch";
  }
  // Chain first: a hold the job timeout cuts short can never end the chain.
  let chained = false;
  try {
    chained = await dispatchSuccessor(deps);
  } catch {
    chained = false;
  }
  if (!chained) {
    line("dispatch", "successor_unavailable", counts);
    return "dispatch";
  }
  const holdMs = Math.min(dueMs - nowMs, BACKOFF_HOLD_MAX_MS);
  line("held", "fast_failure_streak", {
    ...counts,
    dueAt: new Date(dueMs).toISOString(),
    holdMs,
  });
  try {
    await (deps.sleep ?? timerSleep)(holdMs);
  } catch {
    // The successor is already queued; the hold is only pacing.
  }
  return "held";
}

async function readStreak(
  deps: SupervisorBackoffDepsV1,
): Promise<ReturnType<typeof fastFailureStreak>> {
  const url = new URL(`${API_BASE}${SUPERVISOR_RUNS_PATH}`);
  url.searchParams.set("branch", HOSTED_CONTROLLER_DEPLOYMENT.supervisorBranch);
  url.searchParams.set("status", "completed");
  url.searchParams.set("per_page", String(BACKOFF_LISTED_RUNS));
  const response = await deps.http(request(deps.token, "GET", url, null));
  if (response.status !== 200) return null;
  const body = JSON.parse(response.bodyText) as unknown;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return null;
  }
  const runs = (body as Record<string, unknown>).workflow_runs;
  if (!Array.isArray(runs) || runs.length > BACKOFF_LISTED_RUNS) return null;
  return fastFailureStreak(runs, deps.launcherSha);
}

async function dispatchSuccessor(
  deps: SupervisorBackoffDepsV1,
): Promise<boolean> {
  const response = await deps.http(request(
    deps.token,
    "POST",
    new URL(`${API_BASE}${DISPATCHER_DISPATCH_PATH}`),
    JSON.stringify({ ref: HOSTED_CONTROLLER_DEPLOYMENT.sourceBranch }),
  ));
  return response.status >= 200 && response.status < 300;
}

function request(
  token: string,
  method: "GET" | "POST",
  url: URL,
  body: string | null,
) {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "sentinel-supervisor-dispatch",
    "x-github-api-version": "2022-11-28",
  };
  if (body !== null) headers["content-type"] = "application/json";
  return { method, url: url.toString(), headers: headerMap(headers), body };
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timerSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
