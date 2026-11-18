/**
 * GitHub reads of the trusted backup CI pass (docs/backup-ci-spec.md §9):
 * one bounded REST helper over one token, complete listings, and the target
 * reads the planner and the ingest's native comparison need. Every read is
 * fail-closed: an error, a non-2xx answer, an over-bound body or an
 * incomplete listing is null, and a null read plans nothing.
 *
 * Observations: a check run is never started only when it is a failed
 * GitHub Actions run whose own job (`GET /actions/jobs/{id}`) completed
 * `failure` with zero steps and no runner (WP0's `completedJobNeverStarted`);
 * an unreadable job is unknown (null), which reads as started.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  completedJobNeverStarted,
  failedActionsJobId,
} from "../src/github/never-started-job.ts";
import { trustedActionsLogUrl } from "../src/github/client-hosted-log-wire.ts";
import {
  backupCiNativeRunsPath,
  type BackupCiNativeRunV1,
  parseBackupCiNativeRuns,
  parseBackupCiRunJobs,
} from "./backup-ci-history-reads.ts";
import { readBoundedBody } from "./backup-ci-materialize.ts";
import type {
  BackupCiPlanObservationV1,
  BackupCiPlanSuiteV1,
} from "./backup-ci-plan.ts";

export const BACKUP_CI_API = "https://api.github.com";
const TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 4 * 2 ** 20;
const PAGE = 100;
const MAX_PAGES = 10;
/** Job reads one commit's observation read may spend. */
export const BACKUP_CI_MAX_JOB_READS = 32;

type Obj = Record<string, unknown>;
const row = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : null;
const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;

/** One token's bounded REST surface. */
export interface BackupCiApiV1 {
  get(path: string, maxBytes?: number): Promise<unknown | null>;
  /** POST/PATCH/DELETE: the status (null on a network error) and body. */
  send(
    method: "POST" | "PATCH",
    path: string,
    body?: Obj,
  ): Promise<{ status: number; body: unknown | null } | null>;
  /**
   * A GET GitHub answers with a redirect to a trusted Actions storage host
   * (job logs, artifact zips): the bytes of that URL fetched WITHOUT the
   * token, `unserved` for a 404, null for anything else.
   */
  redirected(
    path: string,
    maxBytes: number,
  ): Promise<Uint8Array | "unserved" | null>;
  /** As `redirected`, but the first `maxBytes` bytes of a longer body. */
  redirectedPrefix?(
    path: string,
    maxBytes: number,
  ): Promise<Uint8Array | "unserved" | null>;
}

/**
 * The target read token is an installation token of the same App the
 * supervisor uses, so they share one rate limit (review MUST 3: a throttled
 * supervisor goes red). Every client stops for the rest of the pass once
 * GitHub throttles it (403/429 with no remaining quota or a
 * `retry-after`): each later call answers null at once. The target client
 * also stops while the remaining quota is under this floor, leaving it to
 * the supervisor. (The workflow token's whole budget is 1000 an hour, so
 * the floor is never applied to the Sentinel-side clients.)
 */
export const BACKUP_CI_RATE_FLOOR = 1_000;

export interface BackupCiApiOptionsV1 {
  /** Stop while `x-ratelimit-remaining` is below this (target token). */
  floor?: number;
  onCooldown?: (reason: "throttled" | "floor") => void;
}

export function createBackupCiApi(
  token: string,
  fetcher: typeof fetch = fetch,
  options: BackupCiApiOptionsV1 = {},
): BackupCiApiV1 {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "sentinel-backup-ci",
  };
  let cooled = false;
  const observe = (response: Response) => {
    if (cooled) return;
    const left = response.headers.get("x-ratelimit-remaining");
    const throttled = (response.status === 403 || response.status === 429) &&
      (response.headers.get("retry-after") !== null || left === "0");
    const floor = options.floor !== undefined && left !== null &&
      Number.isFinite(Number(left)) && Number(left) < options.floor;
    if (throttled || floor) {
      cooled = true;
      options.onCooldown?.(throttled ? "throttled" : "floor");
    }
  };
  const timed = async <T>(run: (signal: AbortSignal) => Promise<T>) => {
    if (cooled) throw new Error("backup CI API cooling down");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  };
  const fetchObserved: typeof fetch = async (input, init) => {
    const response = await fetcher(input, init);
    observe(response);
    return response;
  };
  const redirect = (path: string, maxBytes: number, prefix: boolean) =>
    timed(async (signal) => {
      const first = await fetchObserved(`${BACKUP_CI_API}${path}`, {
        headers,
        redirect: "manual",
        signal,
      });
      await first.body?.cancel();
      if (first.status === 404) return "unserved" as const;
      if (first.status !== 302 && first.status !== 301) return null;
      const location = trustedActionsLogUrl(
        first.headers.get("location") ?? "",
      );
      if (location === null) return null;
      const second = await fetcher(location, { redirect: "error", signal });
      if (second.status === 404) {
        await second.body?.cancel();
        return "unserved" as const;
      }
      if (second.status !== 200) {
        await second.body?.cancel();
        return null;
      }
      return prefix
        ? await readBodyPrefix(second, maxBytes)
        : await readBoundedBody(second, maxBytes);
    }).catch(() => null);
  return {
    redirectedPrefix: (path, maxBytes) => redirect(path, maxBytes, true),
    get: (path, maxBytes = MAX_JSON_BYTES) =>
      timed(async (signal) => {
        const response = await fetchObserved(`${BACKUP_CI_API}${path}`, {
          headers,
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel();
          return null;
        }
        const bytes = await readBoundedBody(response, maxBytes);
        return bytes === null
          ? null
          : JSON.parse(new TextDecoder().decode(bytes));
      }).catch(() => null),
    send: (method, path, body) =>
      timed(async (signal) => {
        const response = await fetchObserved(`${BACKUP_CI_API}${path}`, {
          method,
          headers: {
            ...headers,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal,
        });
        const bytes = await readBoundedBody(response, MAX_JSON_BYTES);
        let parsed: unknown = null;
        try {
          parsed = bytes === null || bytes.length === 0
            ? null
            : JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          parsed = null;
        }
        return { status: response.status, body: parsed };
      }).catch(() => null),
    redirected: (path, maxBytes) => redirect(path, maxBytes, false),
  };
}

/** The first `max` bytes of a body (the rest is cancelled, not read). */
async function readBodyPrefix(
  response: Response,
  max: number,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array(0);
  const out = new Uint8Array(max);
  let total = 0;
  while (total < max) {
    const step = await reader.read();
    if (step.done) break;
    const take = Math.min(step.value.byteLength, max - total);
    out.set(step.value.subarray(0, take), total);
    total += take;
  }
  await reader.cancel().catch(() => undefined);
  return out.slice(0, total);
}

/**
 * Every item of one paged list endpoint, or null unless the listing is
 * provably complete (stable `total_count`, unique positive ids, covered).
 */
export async function backupCiCompleteListing(
  api: BackupCiApiV1,
  pagePath: (page: number) => string,
  key: string,
  maxPages: number = MAX_PAGES,
): Promise<Obj[] | null> {
  const items: Obj[] = [];
  const seen = new Set<number>();
  let total: number | null = null;
  for (let page = 1; page <= maxPages; page++) {
    const body = row(await api.get(pagePath(page)));
    if (body === null) return null;
    const count = body.total_count;
    if (
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
    ) {
      return null;
    }
    if (total === null) {
      total = count;
      if (total > maxPages * PAGE) return null;
    } else if (total !== count) return null;
    const list = body[key];
    if (!Array.isArray(list)) return null;
    for (const entry of list) {
      const item = row(entry);
      const id = posInt(item?.id);
      if (item === null || id === null || seen.has(id)) return null;
      seen.add(id);
      items.push(item);
    }
    if (items.length >= total) return items.length === total ? items : null;
    if (list.length === 0) return null;
  }
  return null;
}

export interface BackupCiPullV1 {
  number: number;
  state: string;
  draft: boolean;
  user: string;
  /** The author's numeric id (a login can be renamed), when answered. */
  userId?: number | null;
  /** Whether the pull request was merged (`merged_at` set). */
  merged?: boolean;
  head: {
    sha: string;
    ref: string;
    repo: { full_name: string; name: string; owner: { login: string } };
  };
  base: {
    sha: string;
    ref: string;
    repo: { full_name: string; name: string; owner: { login: string } };
  };
}

function pullSide(value: unknown): BackupCiPullV1["head"] | null {
  const side = row(value);
  const repo = row(side?.repo);
  const owner = row(repo?.owner);
  if (
    side === null || repo === null || owner === null ||
    typeof side.sha !== "string" || typeof side.ref !== "string" ||
    typeof repo.full_name !== "string" || typeof repo.name !== "string" ||
    typeof owner.login !== "string"
  ) return null;
  return {
    sha: side.sha,
    ref: side.ref,
    repo: {
      full_name: repo.full_name,
      name: repo.name,
      owner: { login: owner.login },
    },
  };
}

/** The reads of one target repository (target read token). */
export interface BackupCiTargetReadsV1 {
  /** `fullName` is the answered `owner/name` (a rename answers another). */
  repository(): Promise<
    {
      id: number;
      defaultBranch: string;
      private: boolean;
      fullName?: string;
    } | null
  >;
  branchTip(branch: string): Promise<GitSha | null>;
  checkRuns(sha: GitSha, filter: "latest" | "all"): Promise<Obj[] | null>;
  suites(sha: GitSha): Promise<BackupCiPlanSuiteV1[] | null>;
  statusContexts(sha: GitSha): Promise<Set<string> | null>;
  job(id: number): Promise<unknown | null>;
  annotations(checkRunId: number): Promise<string[] | null>;
  pull(number: number): Promise<BackupCiPullV1 | null>;
  compare(
    base: GitSha,
    head: GitSha,
  ): Promise<{ status: string; behindBy: number } | null>;
  /** GitHub's `refs/pull/N/merge` commit: parents and tree, or absent. */
  pullMerge(
    number: number,
  ): Promise<{ parents: string[]; tree: string } | "absent" | null>;
  /**
   * One page of completed native runs of one workflow file and event (on
   * `branch` when given): the history automatic calibration samples.
   */
  workflowRuns?(
    workflowPath: string,
    event: "push" | "pull_request",
    branch: string | null,
    page: number,
  ): Promise<BackupCiNativeRunV1[] | null>;
  /** The jobs of one native run (raw objects), or null. */
  runJobs?(runId: number): Promise<Obj[] | null>;
  /**
   * The first `BACKUP_CI_NATIVE_LOG_PREFIX_BYTES` of a native job's log
   * (UNTRUSTED text: only `backupCiNativeMergeParents` reads it), or null.
   */
  jobLogPrefix?(jobId: number): Promise<string | null>;
}

/** Enough for a job's set-up and first (checkout) step sections. */
export const BACKUP_CI_NATIVE_LOG_PREFIX_BYTES = 256 * 1024;

export function createBackupCiTargetReads(
  api: BackupCiApiV1,
  owner: string,
  name: string,
): BackupCiTargetReadsV1 {
  const repo = `/repos/${owner}/${name}`;
  const sha40 = (v: unknown) =>
    typeof v === "string" && /^[0-9a-f]{40}$/.test(v);
  return {
    async repository() {
      const body = row(await api.get(repo));
      const id = posInt(body?.id);
      if (
        body === null || id === null ||
        typeof body.default_branch !== "string" ||
        typeof body.private !== "boolean" ||
        typeof body.full_name !== "string"
      ) return null;
      return {
        id,
        defaultBranch: body.default_branch,
        private: body.private,
        fullName: body.full_name,
      };
    },
    async branchTip(branch) {
      const body = row(
        await api.get(`${repo}/git/ref/heads/${encodeURIComponent(branch)}`),
      );
      const sha = row(body?.object)?.sha;
      return sha40(sha) ? sha as GitSha : null;
    },
    async jobLogPrefix(jobId) {
      if (api.redirectedPrefix === undefined) return null;
      const bytes = await api.redirectedPrefix(
        `${repo}/actions/jobs/${jobId}/logs`,
        BACKUP_CI_NATIVE_LOG_PREFIX_BYTES,
      );
      return bytes === null || bytes === "unserved"
        ? null
        : new TextDecoder().decode(bytes);
    },
    async workflowRuns(workflowPath, event, branch, page) {
      const path = backupCiNativeRunsPath(
        `${owner}/${name}`,
        workflowPath,
        event,
        branch,
        page,
        50,
      );
      if (path === null) return null;
      const body = await api.get(path);
      return body === null ? null : parseBackupCiNativeRuns(body);
    },
    async runJobs(runId) {
      const body = await api.get(
        `${repo}/actions/runs/${runId}/jobs?filter=latest&per_page=100`,
      );
      return body === null ? null : parseBackupCiRunJobs(body);
    },
    async checkRuns(sha, filter) {
      const runs = await backupCiCompleteListing(
        api,
        (page) =>
          `${repo}/commits/${sha}/check-runs?filter=${filter}&per_page=${PAGE}&page=${page}`,
        "check_runs",
      );
      return runs !== null && runs.every((r) => r.head_sha === sha)
        ? runs
        : null;
    },
    async suites(sha) {
      const runs = await backupCiCompleteListing(
        api,
        (page) =>
          `${repo}/actions/runs?head_sha=${sha}&per_page=${PAGE}&page=${page}`,
        "workflow_runs",
      );
      if (runs === null) return null;
      const suites: BackupCiPlanSuiteV1[] = [];
      for (const run of runs) {
        const suiteId = posInt(run.check_suite_id);
        const runId = posInt(run.id);
        if (
          suiteId === null || runId === null || run.head_sha !== sha ||
          typeof run.path !== "string" || typeof run.event !== "string"
        ) return null;
        suites.push({
          suiteId,
          runId,
          workflowPath: run.path.split("@")[0],
          event: run.event,
        });
      }
      return suites;
    },
    async statusContexts(sha) {
      const body = row(
        await api.get(`${repo}/commits/${sha}/status?per_page=100`),
      );
      const statuses = body?.statuses;
      if (
        body === null || !Array.isArray(statuses) ||
        typeof body.total_count !== "number" ||
        body.total_count > statuses.length
      ) return null;
      const contexts = new Set<string>();
      for (const status of statuses) {
        const context = row(status)?.context;
        if (typeof context !== "string") return null;
        contexts.add(context);
      }
      return contexts;
    },
    job: (id) => api.get(`${repo}/actions/jobs/${id}`),
    async annotations(checkRunId) {
      const body = await api.get(
        `${repo}/check-runs/${checkRunId}/annotations?per_page=50`,
      );
      if (!Array.isArray(body)) return null;
      return body.map((a) => String(row(a)?.message ?? ""));
    },
    async pull(number) {
      const body = row(await api.get(`${repo}/pulls/${number}`));
      const head = pullSide(body?.head);
      const base = pullSide(body?.base);
      const user = row(body?.user)?.login;
      if (
        body === null || head === null || base === null ||
        body.number !== number || typeof body.state !== "string" ||
        typeof user !== "string"
      ) return null;
      return {
        number,
        state: body.state,
        draft: body.draft === true,
        user,
        userId: posInt(row(body.user)?.id),
        merged: typeof body.merged_at === "string" && body.merged_at !== "",
        head,
        base,
      };
    },
    async compare(base, head) {
      const body = row(
        await api.get(
          `${repo}/compare/${base}...${head}?per_page=1`,
          8 * 2 ** 20,
        ),
      );
      if (
        body === null || typeof body.status !== "string" ||
        typeof body.behind_by !== "number"
      ) return null;
      return { status: body.status, behindBy: body.behind_by };
    },
    async pullMerge(number) {
      const body = row(await api.get(`${repo}/git/ref/pull/${number}/merge`));
      if (body === null) return "absent";
      const sha = row(body.object)?.sha;
      if (!sha40(sha)) return null;
      const commit = row(await api.get(`${repo}/git/commits/${sha}`));
      const tree = row(commit?.tree)?.sha;
      const parents = commit?.parents;
      if (commit === null || !sha40(tree) || !Array.isArray(parents)) {
        return null;
      }
      return {
        parents: parents.map((p) => String(row(p)?.sha ?? "")),
        tree: tree as string,
      };
    },
  };
}

/**
 * One commit's observations: the default and `filter=all` listings with each
 * failed Actions run's never-started verdict (at most 32 job reads; beyond
 * that, unknown), the suites and the commit status contexts; null when any
 * read is incomplete.
 */
export async function readBackupCiObservations(
  reads: BackupCiTargetReadsV1,
  sha: GitSha,
): Promise<
  {
    latest: BackupCiPlanObservationV1[];
    all: BackupCiPlanObservationV1[];
    suites: BackupCiPlanSuiteV1[];
    statusContexts: Set<string>;
  } | null
> {
  const [latest, all, suites, statusContexts] = await Promise.all([
    reads.checkRuns(sha, "latest"),
    reads.checkRuns(sha, "all"),
    reads.suites(sha),
    reads.statusContexts(sha),
  ]);
  if (
    latest === null || all === null || suites === null ||
    statusContexts === null
  ) {
    return null;
  }
  const verdicts = new Map<number, boolean | null>();
  let jobReads = 0;
  const observe = async (
    run: Obj,
  ): Promise<BackupCiPlanObservationV1 | null> => {
    const id = posInt(run.id);
    if (
      id === null || typeof run.name !== "string" ||
      typeof run.status !== "string"
    ) {
      return null;
    }
    let notStarted: boolean | null = false;
    const jobId = failedActionsJobId(run);
    if (jobId !== null) {
      if (verdicts.has(jobId)) notStarted = verdicts.get(jobId)!;
      else if (jobReads >= BACKUP_CI_MAX_JOB_READS) notStarted = null;
      else {
        jobReads++;
        notStarted = completedJobNeverStarted(
          await reads.job(jobId),
          jobId,
          sha,
        );
        verdicts.set(jobId, notStarted);
      }
    }
    const app = row(run.app)?.slug;
    return {
      checkRunId: id,
      name: run.name,
      app: typeof app === "string" ? app : null,
      suiteId: posInt(row(run.check_suite)?.id),
      status: run.status,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      notStarted,
    };
  };
  const mapped = async (runs: Obj[]) => {
    const out: BackupCiPlanObservationV1[] = [];
    for (const run of runs) {
      const o = await observe(run);
      if (o === null) return null;
      out.push(o);
    }
    return out;
  };
  const allObs = await mapped(all);
  const latestObs = await mapped(latest);
  if (allObs === null || latestObs === null) return null;
  return { latest: latestObs, all: allObs, suites, statusContexts };
}
