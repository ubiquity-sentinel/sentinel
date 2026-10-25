/**
 * The launcher's Actions job reads over one repository's token: a job that
 * never started (a billing or spending-limit stop) is no CI evidence
 * (`src/github/never-started-job.ts`).
 *
 * - `failedCheckNames`: the base-repair read. Of a complete, head-bound
 *   check-run listing, the latest run of each name that completed
 *   `failure`, `timed_out` or `startup_failure`, without the failed Actions
 *   runs whose job never started (bounded job reads; an unreadable job keeps
 *   its run as a failure).
 * - `runNeverStarted`: whether one completed workflow run's latest attempt
 *   failed only through jobs that never started (the CI resume pass); null
 *   when its job listing cannot be read completely and bound to the run.
 */
import {
  completedJobNeverStarted,
  latestRunIndexes,
  neverStartedRunIndexes,
} from "../src/github/never-started-job.ts";
import type { createHostedAutonomyRequest } from "./hosted-autonomy-github-listing.ts";

/** Conclusions that make a completed check run a failure on its commit. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out", "startup_failure"]);

/** Jobs one run's latest attempt may list in the one page that is read. */
const RUN_JOBS_PAGE = 100;

export function createHostedActionsJobReads(
  request: ReturnType<typeof createHostedAutonomyRequest>,
  scope: string,
) {
  return {
    async failedCheckNames(
      head: string,
      runs: readonly Record<string, unknown>[],
    ): Promise<string[]> {
      const latest = latestRunIndexes(runs);
      const notStarted = await neverStartedRunIndexes(
        latest.map((index) => runs[index]),
        head,
        (jobId) => request("GET", `/repos/${scope}/actions/jobs/${jobId}`),
      );
      return latest.filter((index, position) =>
        !notStarted.has(position) &&
        runs[index]["status"] === "completed" &&
        FAILED_CONCLUSIONS.has(String(runs[index]["conclusion"]))
      ).map((index) => String(runs[index]["name"]));
    },
    async runNeverStarted(id: number, head: string): Promise<boolean | null> {
      if (!Number.isSafeInteger(id) || id <= 0) return null;
      const body = await request(
        "GET",
        `/repos/${scope}/actions/runs/${id}/jobs?filter=latest&per_page=${RUN_JOBS_PAGE}`,
      );
      if (body === null || typeof body !== "object") return null;
      const listing = body as Record<string, unknown>;
      const jobs = listing["jobs"];
      if (
        !Array.isArray(jobs) || listing["total_count"] !== jobs.length ||
        jobs.length > RUN_JOBS_PAGE
      ) return null;
      let failed = 0;
      for (const job of jobs) {
        if (job === null || typeof job !== "object") return null;
        const row = job as Record<string, unknown>;
        if (row["run_id"] !== id || row["head_sha"] !== head) return null;
        if (row["conclusion"] !== "failure") continue;
        failed++;
        const jobId = row["id"];
        if (
          typeof jobId !== "number" ||
          completedJobNeverStarted(row, jobId, head) !== true
        ) return false;
      }
      return failed > 0;
    },
  };
}
