/**
 * The launcher's Actions job reads over one repository's token: a job that
 * never started (a billing or spending-limit stop) is no CI evidence
 * (`src/github/never-started-job.ts`).
 *
 * - `failedCheckNames`: the base-repair read. Of a complete, head-bound
 *   check-run listing, the latest run of each name that completed with one
 *   of the caller's `conclusions` (the runtime's own sets: a tip's
 *   `RED_BASE_CONCLUSIONS`, a held head's `CANDIDATE_CONCLUSIONS`), without
 *   the failed Actions runs whose job never started (bounded job reads; an
 *   unreadable job keeps its run as a failure).
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
import {
  ciMinuteDigest,
  ciTerminalEstimateDigest,
} from "../src/contracts/ci-minute-budget.ts";
import type { CiMinuteJobProofV1 } from "../src/contracts/ci-minute-budget.ts";
import type {
  CiMinutePolicyV1,
  CiMinuteReadCursorV1,
} from "../src/contracts/ci-minute-budget.ts";
import { ciMonth } from "../src/contracts/ci-minute-budget.ts";
import { parseBoundedYaml } from "./backup-ci-workflow-map.ts";
import type { PreparedWorkflowBlobV1 } from "../src/github/review-snapshot.ts";
import { MAX_FILE_BYTES } from "../src/github/snapshot-policy.ts";
import type {
  CiEffectFactsV1,
  CiEffectV1,
} from "../src/contracts/ci-minute-budget.ts";

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
      conclusions: readonly string[],
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
        conclusions.includes(String(runs[index]["conclusion"]))
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

/** Private continuation: never serialized to the public accounting ledger or logs. */
export type { CiMinuteReadCursorV1 } from "../src/contracts/ci-minute-budget.ts";

export type CiMinuteReadWindowV1 = {
  complete: boolean;
  cursor: CiMinuteReadCursorV1 | null;
  jobs: CiMinuteJobProofV1[];
  reason: string | null;
  completedAttempts: string[];
};

/**
 * One existing-turn slice: at most four run pages and eight attempt/job pages.
 * The trusted caller retains the private cursor and accumulated opaque proofs;
 * incomplete or density-limited history is never a completed observation.
 */
export async function readCiMinuteWindow(input: {
  request(path: string): Promise<unknown>;
  repositoryId: number;
  scope: string;
  from: number;
  through: number;
  cursor?: CiMinuteReadCursorV1;
  knownAttempts?: ReadonlySet<string>;
  knownProofs?: readonly CiMinuteJobProofV1[];
  /** Authenticated metadata from the durable known-run slice, not a new listing. */
  run?: Record<string, unknown>;
  /** Accepted conservative scheduling estimate; absence retains strict meter-only reads. */
  estimateMinutes?: number;
  effectDigestFor?(
    run: Record<string, unknown>,
    attempt: number,
  ): string | null;
  deadline: number;
  now(): number;
}): Promise<CiMinuteReadWindowV1> {
  const jobs: CiMinuteJobProofV1[] = [];
  const completedAttempts: string[] = [];
  const queryDigest = ciMinuteDigest({
    repositoryId: input.repositoryId,
    scope: input.scope,
    from: input.from,
    through: input.through,
    ...(input.run === undefined ? {} : { runId: input.run.id }),
  });
  let cursor = input.cursor === undefined
    ? {
      queryDigest,
      runPage: 1,
      runOffset: 0,
      attempt: 1,
      jobPage: 1,
      jobsSeen: 0,
      runDigest: null,
      pageDigest: null,
    }
    : structuredClone(input.cursor);
  const incomplete = (reason: string): CiMinuteReadWindowV1 => ({
    complete: false,
    cursor,
    jobs,
    reason,
    completedAttempts,
  });
  if (
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(input.scope) ||
    !Number.isSafeInteger(input.repositoryId) || input.repositoryId < 1 ||
    !Number.isSafeInteger(input.from) || !Number.isSafeInteger(input.through) ||
    input.from < 0 || input.through < input.from ||
    cursor.queryDigest !== queryDigest ||
    ![
      cursor.runPage,
      cursor.runOffset,
      cursor.attempt,
      cursor.jobPage,
      cursor.jobsSeen,
    ]
      .every((n) => Number.isSafeInteger(n) && n >= 0) ||
    cursor.runPage < 1 ||
    cursor.runPage > 10 || cursor.runOffset > 100 || cursor.attempt < 1 ||
    cursor.attempt > 101 ||
    cursor.jobPage < 1 || cursor.jobPage > 10 ||
    cursor.jobsSeen !== (cursor.jobPage - 1) * 100 ||
    (cursor.runDigest !== null && !/^[0-9a-f]{64}$/.test(cursor.runDigest))
  ) return incomplete("cursor_binding");
  let runReads = 0, jobReads = 0;
  const cache = new Map<number, Record<string, unknown>>();
  const timings = new Map<number, Map<number, number>>();
  try {
    while (input.now() < input.deadline) {
      let listing = cache.get(cursor.runPage);
      if (listing === undefined) {
        if (++runReads > 4) return incomplete("read_bound");
        const range = encodeURIComponent(
          `${new Date(input.from).toISOString()}..${
            new Date(input.through).toISOString()
          }`,
        );
        const raw = input.run === undefined
          ? await input.request(
            `/repos/${input.scope}/actions/runs?created=${range}&per_page=100&page=${cursor.runPage}`,
          )
          : { total_count: 1, workflow_runs: [input.run] };
        if (raw === null || typeof raw !== "object") {
          return incomplete("run_listing");
        }
        listing = raw as Record<string, unknown>;
        cache.set(cursor.runPage, listing);
      }
      const total = listing.total_count, runs = listing.workflow_runs;
      if (
        !Number.isSafeInteger(total) || Number(total) < 0 ||
        Number(total) >= 1000 || !Array.isArray(runs) ||
        runs.length !==
          Math.min(100, Math.max(0, Number(total) - (cursor.runPage - 1) * 100))
      ) {
        return incomplete("run_coverage");
      }
      if (cursor.runOffset > runs.length) return incomplete("cursor_binding");
      const pageDigest = ciMinuteDigest({
        total,
        runs: runs.map((run) => {
          const r = run as Record<string, unknown>;
          return [r.id, r.head_sha, r.run_attempt];
        }),
      });
      if (
        cursor.pageDigest !== undefined && cursor.pageDigest !== null &&
        cursor.pageDigest !== pageDigest
      ) {
        return incomplete("run_page_changed");
      }
      cursor.pageDigest = pageDigest;
      if (cursor.runOffset === runs.length) {
        if (cursor.runPage * 100 >= Number(total)) {
          return {
            complete: true,
            cursor: null,
            jobs,
            reason: null,
            completedAttempts,
          };
        }
        cursor = {
          ...cursor,
          runPage: cursor.runPage + 1,
          runOffset: 0,
          pageDigest: null,
        };
        continue;
      }
      const run = runs[cursor.runOffset] as Record<string, unknown>;
      if (
        run === null || typeof run !== "object" ||
        !Number.isSafeInteger(run.id) || Number(run.id) < 1 ||
        !/^[0-9a-f]{40}$/.test(String(run.head_sha)) ||
        !Number.isSafeInteger(run.run_attempt) ||
        Number(run.run_attempt) < 1 || Number(run.run_attempt) > 100
      ) return incomplete("run_binding");
      if (run.status !== "completed") return incomplete("run_pending");
      const repository = run.repository as Record<string, unknown> | undefined;
      if (repository?.id !== input.repositoryId) {
        return incomplete("repository_binding");
      }
      const runDigest = ciMinuteDigest({
        repositoryId: input.repositoryId,
        runId: run.id,
        head: run.head_sha,
      });
      if (cursor.runDigest !== null && cursor.runDigest !== runDigest) {
        return incomplete("run_cursor_changed");
      }
      cursor.runDigest = runDigest;
      if (cursor.attempt > Number(run.run_attempt)) {
        const timing = timings.get(Number(run.id));
        if (timing !== undefined && input.estimateMinutes === undefined) {
          const ids = new Set(
            [...(input.knownProofs ?? []), ...jobs].filter((j) =>
              j.identity?.repositoryId === input.repositoryId &&
              j.identity.runId === run.id
            ).map((j) => j.identity!.jobId),
          );
          if ([...timing.keys()].some((id) => !ids.has(id))) {
            return incomplete("timing_coverage");
          }
        }
        cursor = {
          ...cursor,
          runOffset: cursor.runOffset + 1,
          attempt: 1,
          jobPage: 1,
          jobsSeen: 0,
          runDigest: null,
        };
        continue;
      }
      const attemptDigest = ciMinuteDigest({
        repositoryId: input.repositoryId,
        runId: run.id,
        attempt: cursor.attempt,
        head: run.head_sha,
      });
      if (input.knownAttempts?.has(attemptDigest)) {
        cursor = {
          ...cursor,
          attempt: cursor.attempt + 1,
          jobPage: 1,
          jobsSeen: 0,
        };
        continue;
      }
      let billed = timings.get(Number(run.id));
      if (billed === undefined) {
        if (++jobReads > 8) return incomplete("read_bound");
        const timing = await input.request(
          `/repos/${input.scope}/actions/runs/${run.id}/timing`,
        );
        const parsed = ciMinuteBillable(timing);
        if (parsed === null && input.estimateMinutes === undefined) {
          return incomplete("billing_timing_unavailable");
        }
        billed = parsed ?? new Map();
        timings.set(Number(run.id), billed);
      }
      if (++jobReads > 8) return incomplete("read_bound");
      const raw = await input.request(
        `/repos/${input.scope}/actions/runs/${run.id}/attempts/${cursor.attempt}/jobs?per_page=100&page=${cursor.jobPage}`,
      );
      if (raw === null || typeof raw !== "object") {
        return incomplete("job_listing");
      }
      const result = raw as Record<string, unknown>;
      const count = result.total_count, rows = result.jobs;
      if (
        !Number.isSafeInteger(count) || Number(count) < 0 ||
        Number(count) > 1000 || !Array.isArray(rows) ||
        rows.length !==
          Math.min(100, Math.max(0, Number(count) - (cursor.jobPage - 1) * 100))
      ) return incomplete("job_coverage");
      for (const rawJob of rows) {
        if (rawJob === null || typeof rawJob !== "object") {
          return incomplete("job_binding");
        }
        const job = rawJob as Record<string, unknown>;
        if (
          !Number.isSafeInteger(job.id) || Number(job.id) < 1 ||
          job.run_id !== run.id || job.head_sha !== run.head_sha ||
          (job.run_attempt !== undefined &&
            job.run_attempt !== cursor.attempt) ||
          job.status !== "completed"
        ) {
          return incomplete("job_binding");
        }
        const neverStarted = completedJobNeverStarted(
          job,
          Number(job.id),
          String(run.head_sha),
        );
        let startedAt: number | null = null, completedAt: number | null = null;
        if (neverStarted !== true) {
          if (
            !Number.isSafeInteger(job.runner_id) || Number(job.runner_id) < 1 ||
            !Array.isArray(job.labels) || job.labels.includes("self-hosted") ||
            !job.labels.some((l) =>
              ["ubuntu-latest", "ubuntu-24.04", "ubuntu-22.04"].includes(
                String(l),
              )
            )
          ) {
            return incomplete("runner_profile");
          }
          startedAt = ciMinuteTimestamp(job.started_at);
          completedAt = ciMinuteTimestamp(job.completed_at);
          if (
            startedAt === null || completedAt === null ||
            completedAt < startedAt || completedAt > input.now()
          ) {
            return incomplete("job_timing");
          }
        }
        const effectDigest = input.effectDigestFor?.(run, cursor.attempt) ??
          null;
        if (effectDigest !== null && !/^[0-9a-f]{64}$/.test(effectDigest)) {
          return incomplete("effect_binding");
        }
        const billedDurationMs = billed.get(Number(job.id)) ?? null;
        if (
          input.estimateMinutes === undefined &&
          (billedDurationMs === null ||
            (neverStarted !== true && billedDurationMs <= 0))
        ) {
          return incomplete("billing_job_binding");
        }
        const proof: CiMinuteJobProofV1 = {
          digest: ciMinuteDigest({
            repositoryId: input.repositoryId,
            runId: run.id,
            attempt: cursor.attempt,
            jobId: job.id,
          }),
          effectDigest,
          startedAt,
          completedAt,
          neverStarted: neverStarted === true,
          terminal: true,
          conclusion: (job.conclusion ?? null) as string | null,
          billedDurationMs: neverStarted === true && billedDurationMs === null
            ? 0
            : billedDurationMs,
          identity: {
            repositoryId: input.repositoryId,
            runId: Number(run.id),
            attempt: cursor.attempt,
            jobId: Number(job.id),
          },
        };
        if (neverStarted !== true && input.estimateMinutes !== undefined) {
          if (
            !Number.isSafeInteger(input.estimateMinutes) ||
            input.estimateMinutes <= 0
          ) {
            return incomplete("estimate_binding");
          }
          // Timestamp arithmetic can increase conservative exposure, never refund it
          // or masquerade as an authenticated billing quantity.
          proof.estimate = {
            kind: "retained_estimate",
            minutes: Math.max(
              input.estimateMinutes,
              Math.ceil((completedAt! - startedAt!) / 60_000),
              Math.ceil((billedDurationMs ?? 0) / 60_000),
            ),
            executionMonth:
              ciMonth(startedAt!).month === ciMonth(completedAt!).month
                ? ciMonth(startedAt!).month
                : null,
            terminalProofDigest: ciTerminalEstimateDigest(proof),
          };
        }
        jobs.push(proof);
      }
      cursor.jobsSeen += rows.length;
      if (cursor.jobsSeen === count) {
        // The catalog reader can attach a later authenticated effect binding to
        // the retained job proof without repeating this completed attempt.
        completedAttempts.push(attemptDigest);
        cursor = {
          ...cursor,
          attempt: cursor.attempt + 1,
          jobPage: 1,
          jobsSeen: 0,
        };
      } else if (cursor.jobsSeen < Number(count)) cursor.jobPage++;
      else return incomplete("job_coverage");
    }
    return incomplete("deadline");
  } catch {
    return incomplete("observation_unavailable");
  }
}

function ciMinuteTimestamp(value: unknown): number | null {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)
  ) return null;
  const n = Date.parse(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function ciMinuteBillable(value: unknown): Map<number, number> | null {
  if (value === null || typeof value !== "object") return null;
  const billable = (value as Record<string, unknown>).billable;
  if (
    billable === null || typeof billable !== "object" || Array.isArray(billable)
  ) return null;
  const skus = billable as Record<string, unknown>;
  if (Object.keys(skus).some((key) => key !== "UBUNTU")) return null;
  const linux = skus.UBUNTU;
  if (linux === null || typeof linux !== "object") return null;
  const data = linux as Record<string, unknown>;
  if (
    !Number.isSafeInteger(data.jobs) || Number(data.jobs) < 0 ||
    Number(data.jobs) > 1000 ||
    !Number.isSafeInteger(data.total_ms) || Number(data.total_ms) < 0 ||
    !Array.isArray(data.job_runs) ||
    data.job_runs.length !== data.jobs
  ) return null;
  const result = new Map<number, number>();
  let total = 0;
  for (const row of data.job_runs) {
    if (
      row === null || typeof row !== "object" ||
      !Number.isSafeInteger(row.job_id) || row.job_id < 1 ||
      !Number.isSafeInteger(row.duration_ms) || row.duration_ms < 0 ||
      result.has(row.job_id)
    ) return null;
    result.set(row.job_id, row.duration_ms);
    total += row.duration_ms;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total === data.total_ms ? result : null;
}

/** Authenticated exact-blob profile and effect observation; never executes target code. */
export function createPrivateCiEffectResolver(
  input: {
    policy: CiMinutePolicyV1;
    request(path: string, deadline: number): Promise<unknown | null>;
    readPreparedWorkflow?(
      effect: CiEffectV1,
      deadline: number,
    ): Promise<PreparedWorkflowBlobV1 | null>;
  },
) {
  return async (
    effect: CiEffectV1,
    deadline: number,
  ): Promise<CiEffectFactsV1 | null> => {
    try {
      const target = input.policy.targets.find((t) =>
        t.owner === effect.repository.owner && t.name === effect.repository.name
      );
      if (!target || effect.head === null) return null;
      const scope = target.owner + "/" + target.name;
      const repository = await input.request("/repos/" + scope, deadline) as
        | Record<string, unknown>
        | null;
      if (
        repository?.id !== target.repositoryId || repository.private !== true ||
        typeof repository.default_branch !== "string"
      ) return null;
      let rerun: Record<string, unknown> | null = null;
      if (effect.kind === "rerun") {
        if (
          !Number.isSafeInteger(effect.runId) || Number(effect.runId) < 1 ||
          !Number.isSafeInteger(effect.attempt) || Number(effect.attempt) < 2
        ) return null;
        rerun = await input.request(
          `/repos/${scope}/actions/runs/${effect.runId}`,
          deadline,
        ) as Record<string, unknown> | null;
        if (
          !rerun || rerun.id !== effect.runId ||
          rerun.head_sha !== effect.head ||
          (rerun.repository as Record<string, unknown> | undefined)?.id !==
            target.repositoryId ||
          rerun.path !== ".github/workflows/ci.yml" ||
          !Number.isSafeInteger(rerun.workflow_id) ||
          Number(rerun.workflow_id) < 1 ||
          !Number.isSafeInteger(rerun.run_attempt) ||
          ![effect.attempt, Number(effect.attempt) - 1].includes(
            Number(rerun.run_attempt),
          ) ||
          (rerun.run_attempt !== effect.attempt && rerun.status !== "completed")
        ) return null;
        const workflow = await input.request(
          `/repos/${scope}/actions/workflows/${rerun.workflow_id}`,
          deadline,
        ) as Record<string, unknown> | null;
        if (
          !workflow || workflow.id !== rerun.workflow_id ||
          workflow.path !== ".github/workflows/ci.yml"
        ) return null;
      }
      let decoded: Uint8Array, workflowBlob: string;
      if (
        ["head_push", "base_refresh", "train_push", "train_dispatch"].includes(
          effect.kind,
        )
      ) {
        const evidence = await input.readPreparedWorkflow?.(effect, deadline);
        if (
          !evidence || evidence.head !== effect.head ||
          evidence.path !== ".github/workflows/ci.yml" ||
          !/^[0-9a-f]{40}$/.test(evidence.workflowBlob) ||
          !(evidence.bytes instanceof Uint8Array) ||
          evidence.bytes.length < 1 || evidence.bytes.length > MAX_FILE_BYTES
        ) return null;
        decoded = evidence.bytes;
        workflowBlob = evidence.workflowBlob;
      } else {
        const raw = await input.request(
          `/repos/${scope}/contents/.github/workflows/ci.yml?ref=${
            rerun?.head_sha ?? effect.head
          }`,
          deadline,
        ) as Record<string, unknown> | null;
        if (
          raw?.type !== "file" || raw.encoding !== "base64" ||
          typeof raw.content !== "string" ||
          typeof raw.sha !== "string" || !/^[0-9a-f]{40}$/.test(raw.sha)
        ) return null;
        decoded = Uint8Array.from(
          atob(raw.content.replace(/\s/g, "")),
          (c) => c.charCodeAt(0),
        );
        if (decoded.length < 1 || decoded.length > MAX_FILE_BYTES) return null;
        workflowBlob = raw.sha;
      }
      const workflow = parseBoundedYaml(decoded) as
        | Record<string, unknown>
        | null;
      const jobs = workflow?.jobs;
      if (
        jobs === null || typeof jobs !== "object" || Array.isArray(jobs) ||
        Object.keys(jobs).length !== 1
      ) return null;
      const jobKey = Object.keys(jobs)[0];
      const job = (jobs as Record<string, unknown>)[jobKey] as Record<
        string,
        unknown
      >;
      if (
        !job || typeof job !== "object" || job.strategy !== undefined ||
        typeof job["runs-on"] !== "string" ||
        !Number.isSafeInteger(job["timeout-minutes"])
      ) return null;
      const events = workflow?.on;
      const event = (name: string) =>
        typeof events === "string"
          ? events === name ? {} : undefined
          : Array.isArray(events)
          ? events.includes(name) ? {} : undefined
          : events && typeof events === "object"
          ? (events as Record<string, unknown>)[name]
          : undefined;
      const matches = (name: string, branch: string) => {
        const config = event(name);
        if (config === undefined) return false;
        if (config === null) return true;
        if (typeof config !== "object" || Array.isArray(config)) {
          throw new Error("unqualified trigger");
        }
        const c = config as Record<string, unknown>;
        if (
          c.paths !== undefined || c["paths-ignore"] !== undefined ||
          c["branches-ignore"] !== undefined || c.tags !== undefined
        ) throw new Error("unqualified trigger");
        if (c.branches === undefined) return true;
        if (
          !Array.isArray(c.branches) ||
          c.branches.some((v) => typeof v !== "string" || /[*!?\[\]{}]/.test(v))
        ) throw new Error("unqualified trigger");
        return c.branches.includes(branch);
      };
      const branch = effect.ref.replace(/^refs\/heads\//, "");
      let count = 0;
      if (effect.kind === "merge" || effect.kind === "train_push") {
        count = matches("push", branch) ? 1 : 0;
      } else if (effect.kind === "train_dispatch") {
        count = event("workflow_dispatch") === undefined ? 0 : 1;
      } else if (effect.kind === "rerun") count = 1;
      else if (effect.kind === "pr_open") {
        count = matches("pull_request", repository.default_branch as string)
          ? 1
          : 0;
      } else {count = (matches("push", branch) ? 1 : 0) +
          (effect.pr !== null &&
              matches("pull_request", repository.default_branch as string)
            ? 1
            : 0);}
      let effectState: CiEffectFactsV1["effectState"] = "unknown";
      if (["head_push", "base_refresh", "train_push"].includes(effect.kind)) {
        const ref = await input.request(
          "/repos/" + scope + "/git/ref/" + effect.ref.replace(/^refs\//, ""),
          deadline,
        ) as Record<string, unknown> | null | undefined;
        if (ref === undefined) effectState = "not_applied";
        else if (ref && typeof ref.object === "object") {
          effectState =
            (ref.object as Record<string, unknown>).sha === effect.head
              ? "applied"
              : "not_applied";
        }
      } else if (effect.kind === "merge" && effect.pr !== null) {
        const pull = await input.request(
          "/repos/" + scope + "/pulls/" + effect.pr,
          deadline,
        ) as Record<string, unknown> | null;
        if (
          pull &&
          (pull.head as Record<string, unknown> | undefined)?.sha ===
            effect.head
        ) {
          effectState = pull.merged === true
            ? "applied"
            : pull.state === "open"
            ? "not_applied"
            : "unknown";
        }
      } else if (effect.kind === "pr_open") {
        const pulls = await input.request(
          "/repos/" + scope + "/pulls?state=open&per_page=100&head=" +
            encodeURIComponent(target.owner + ":" + branch),
          deadline,
        );
        if (Array.isArray(pulls) && pulls.length < 100) {
          const matching = pulls.filter((p) =>
            (p.head as Record<string, unknown> | undefined)?.sha === effect.head
          );
          effectState = matching.length === 0
            ? "not_applied"
            : matching.length === 1
            ? "applied"
            : "unknown";
        }
      } else if (effect.kind === "rerun" && rerun !== null) {
        effectState = rerun.run_attempt === effect.attempt
          ? "applied"
          : "not_applied";
      } else if (effect.kind === "train_dispatch") {
        const listing = await input.request(
          "/repos/" + scope +
            "/actions/runs?event=workflow_dispatch&per_page=100&head_sha=" +
            effect.head + "&branch=" + encodeURIComponent(branch),
          deadline,
        ) as Record<string, unknown> | null;
        if (
          listing && Array.isArray(listing.workflow_runs) &&
          listing.total_count === listing.workflow_runs.length &&
          listing.workflow_runs.length < 100
        ) {
          effectState = listing.workflow_runs.length === 0
            ? "not_applied"
            : listing.workflow_runs.length === 1
            ? "applied"
            : "unknown";
        }
      }
      return {
        repositoryId: target.repositoryId,
        workflowBlob,
        job: jobKey,
        jobs: count,
        runner: String(job["runs-on"]),
        timeoutMinutes: Number(job["timeout-minutes"]),
        ceilingMinutes: target.ceilingMinutes,
        qualificationDigest: input.policy.ceilingQualification ?? "",
        triggered: count > 0,
        effectState,
      };
    } catch {
      return null;
    }
  };
}
