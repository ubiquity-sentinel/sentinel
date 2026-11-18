/**
 * The target's own native CI history that automatic calibration samples
 * (review MUST 2/MUST 4, 2026-11-17): completed runs of ONE workflow file
 * and event, a page at a time, and the jobs of one run. Every value is
 * re-checked client-side (event, branch, workflow path, same-repository
 * head) and only closed values leave this module.
 */
import type { GitSha } from "../src/contracts/brands.ts";

type Obj = Record<string, unknown>;
const row = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : null;
const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
const sha40 = (v: unknown): v is GitSha =>
  typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
const time = (v: unknown): number | null =>
  typeof v === "string" && Number.isFinite(Date.parse(v))
    ? Date.parse(v)
    : null;

/** One completed native workflow run, as the sampler uses it. */
export interface BackupCiNativeRunV1 {
  id: number;
  headSha: GitSha;
  event: "push" | "pull_request";
  headBranch: string;
  /** `.github/workflows/<file>` without any `@ref` suffix. */
  path: string;
  /** The head repository's `owner/name` (a fork answers another). */
  headRepository: string;
  conclusion: string;
  startedAt: number | null;
  updatedAt: number | null;
}

/** The runs of one listing page, malformed rows dropped. */
export function parseBackupCiNativeRuns(body: unknown): BackupCiNativeRunV1[] {
  const runs = row(body)?.workflow_runs;
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((value) => {
    const run = row(value);
    const id = posInt(run?.id);
    const event = run?.event;
    const path = typeof run?.path === "string" ? run.path.split("@")[0] : "";
    const head = row(run?.head_repository)?.full_name;
    if (
      run === null || id === null || !sha40(run.head_sha) ||
      (event !== "push" && event !== "pull_request") ||
      typeof run.head_branch !== "string" || typeof head !== "string" ||
      typeof run.conclusion !== "string" || path === ""
    ) return [];
    return [{
      id,
      headSha: run.head_sha,
      event,
      headBranch: run.head_branch,
      path,
      headRepository: head,
      conclusion: run.conclusion,
      startedAt: time(run.run_started_at),
      updatedAt: time(run.updated_at),
    }];
  });
}

/** The listing path of one workflow file's completed runs of `event`. */
export function backupCiNativeRunsPath(
  repo: string,
  workflowPath: string,
  event: "push" | "pull_request",
  branch: string | null,
  page: number,
  perPage: number,
): string | null {
  const file = /^\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)$/.exec(
    workflowPath,
  )?.[1];
  if (file === undefined) return null;
  const query = [
    `event=${event}`,
    "status=completed",
    ...(branch === null ? [] : [`branch=${encodeURIComponent(branch)}`]),
    `per_page=${perPage}`,
    `page=${page}`,
  ].join("&");
  return `/repos/${repo}/actions/workflows/${file}/runs?${query}`;
}

/** The jobs of one run (one page; at most 100 jobs per run are read). */
export function parseBackupCiRunJobs(body: unknown): Obj[] | null {
  const jobs = row(body)?.jobs;
  if (!Array.isArray(jobs)) return null;
  return jobs.flatMap((j) => {
    const job = row(j);
    return job === null ? [] : [job];
  });
}
