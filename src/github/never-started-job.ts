/**
 * A GitHub Actions job that never started is not CI evidence.
 *
 * When an account's Actions payments fail or its spending limit is reached,
 * GitHub still creates every job's check run and completes it about a second
 * later with conclusion `failure`, no step, runner id 0 and an annotation
 * ("The job was not started because recent account payments have failed or
 * your spending limit needs to be increased"). Nothing of the repository ran,
 * so the run says nothing about the commit: read as a real failure it held
 * every Passport repair behind a red base (`base_red`) and, once billing came
 * back and the base re-ran green, would have charged a CI fix for a head
 * whose own CI never ran.
 *
 * An Actions check run's id is its job's id (`GET /actions/jobs/{id}`). A run
 * is never started only when that exact job, on the exact commit, completed
 * `failure` with zero steps and no runner (`runner_id` 0 or null). Only failed
 * Actions check runs are read, the latest run of each name first and at most
 * `MAX_NEVER_STARTED_JOB_READS` per check read; a job that cannot be read or
 * does not match keeps its run exactly as GitHub reported it. The runtime
 * check read (`readChecks`) and the launcher's base-repair read
 * (`failedChecks`) share these rules; the launcher's CI resume pass judges a
 * workflow run's jobs with `completedJobNeverStarted`.
 */

/** GitHub's own Actions app on a check run. */
export const ACTIONS_APP_SLUG = "github-actions";

/** Job reads one check read may spend on failed Actions check runs. */
export const MAX_NEVER_STARTED_JOB_READS = 8;

/** Completed-job verdicts one cache keeps (a completed job never changes). */
const VERDICT_CACHE_MAX = 256;

/** One job read: the parsed body of `GET /actions/jobs/{id}`, or null. */
export type ActionsJobReadV1 = (jobId: number) => Promise<unknown>;

function row(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The job id of a GitHub Actions check run that completed `failure`, or null
 * for any other check run (another app, a run still going, any other
 * conclusion, or no usable id).
 */
export function failedActionsJobId(run: unknown): number | null {
  const check = row(run);
  if (check === null) return null;
  const app = row(check.app);
  if (app === null || app.slug !== ACTIONS_APP_SLUG) return null;
  if (check.status !== "completed" || check.conclusion !== "failure") {
    return null;
  }
  const id = check.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

/**
 * The verdict on one Actions job as GitHub reports it (the job read or a
 * run's job listing): null unless it is exactly job `jobId` on commit `head`
 * and completed; then true only when it completed `failure` without a single
 * step and without a runner (`runner_id` 0 or null).
 */
export function completedJobNeverStarted(
  job: unknown,
  jobId: number,
  head: string,
): boolean | null {
  const body = row(job);
  if (
    body === null || body.id !== jobId || body.head_sha !== head ||
    body.status !== "completed"
  ) return null;
  return body.conclusion === "failure" && Array.isArray(body.steps) &&
    body.steps.length === 0 &&
    (body.runner_id === 0 || body.runner_id === null);
}

/** A check run's recency, as the gates order runs (`latestChecks`). */
function runTime(run: Record<string, unknown> | null): number {
  for (const key of ["started_at", "completed_at"]) {
    const value = run?.[key];
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return -1;
}

/**
 * The index of the latest run of each name in `runs` (raw check runs), in the
 * order each name first appears; recency is the gates' own (`latestChecks`:
 * start time, else completion time, the first listed on a tie).
 */
export function latestRunIndexes(runs: readonly unknown[]): number[] {
  const latest = new Map<string, number>();
  runs.forEach((run, index) => {
    const name = row(run)?.name;
    if (typeof name !== "string") return;
    const previous = latest.get(name);
    if (
      previous === undefined || runTime(row(run)) > runTime(row(runs[previous]))
    ) latest.set(name, index);
  });
  return [...latest.values()];
}

/**
 * The indexes into `runs` (raw check runs, every one bound to `head`) of the
 * failed Actions runs whose job never started. Only the latest run of each
 * name is judged, at most `MAX_NEVER_STARTED_JOB_READS` jobs are read, and a
 * verdict found in `cache` (keyed by job and head) costs no read; an
 * unreadable or mismatched job is left out and is not cached.
 */
export async function neverStartedRunIndexes(
  runs: readonly unknown[],
  head: string,
  readJob: ActionsJobReadV1,
  cache?: Map<string, boolean>,
): Promise<Set<number>> {
  const marked = new Set<number>();
  let reads = 0;
  for (const index of latestRunIndexes(runs)) {
    const jobId = failedActionsJobId(runs[index]);
    if (jobId === null) continue;
    const key = `${jobId}:${head}`;
    let verdict = cache?.get(key) ?? null;
    if (verdict === null) {
      if (reads >= MAX_NEVER_STARTED_JOB_READS) continue;
      reads++;
      let body: unknown = null;
      try {
        body = await readJob(jobId);
      } catch {
        body = null;
      }
      verdict = completedJobNeverStarted(body, jobId, head);
      if (verdict === null) continue;
      if (cache !== undefined && cache.size < VERDICT_CACHE_MAX) {
        cache.set(key, verdict);
      }
    }
    if (verdict) marked.add(index);
  }
  return marked;
}
