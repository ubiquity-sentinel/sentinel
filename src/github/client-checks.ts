// Check reads and workflow-event enrichment.

import type { GitSha } from "../contracts/brands.ts";
import type {
  GitHubChecksReadOptionsV1,
  GitHubCheckSuitesV1,
  GitHubChecksV1,
  GitHubCheckV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { expectArray, expectRecord } from "../contracts/validation.ts";
import {
  applyBackupCiToChecks,
  type BackupCiClientReadsV1,
} from "./client-backup-ci.ts";
import { GitHubClientIssues } from "./client-issues.ts";
import { parseWith, repoPath } from "./client-response.ts";
import { neverStartedRunIndexes } from "./never-started-job.ts";
import {
  parseCheckRunWire,
  parseCheckSuiteMemberWire,
  parseCommitStatusWire,
} from "./wire.ts";

/**
 * The commit statuses an unfiltered head CI read reports (sentinel issue
 * #192). Each context is judged by its latest status: the newest
 * `created_at`, and on a tie the first listed (GitHub lists newest first),
 * the same recency as the gate's `latestChecks`. A context whose latest status
 * is `pending` is advisory once the head reports at least one check run,
 * every check run has completed, and the last one completed at least
 * `PENDING_STATUS_GRACE_MS` ago: all of its observations are then left out,
 * so a third-party status that never reports (a stale integration, a preview
 * deployment) cannot hold a head whose check runs are done, while a status
 * that resolves soon after the runs (one about to fail) is still waited for. Every other
 * context keeps its whole history exactly as before: a failed or errored
 * status still fails and a successful one still passes. A pending status
 * still waits while any check run runs, and when the head reports no check
 * run at all (its statuses are its only CI). Omitting a status adds no
 * observation, so it never turns a red check run green.
 */
export const PENDING_STATUS_GRACE_MS = 30 * 60_000;

/** Workflow-run event reads one observation may spend. */
export const MAX_WORKFLOW_EVENT_READS = 8;

/** Trusted workflow-event shape; an untrusted value is never carried. */
const WORKFLOW_EVENT_PATTERN = /^[a-z][a-z_]{0,39}$/;

/**
 * The exact Actions run/job identity of a check run, from its GitHub-owned
 * `details_url` (`.../{owner}/{name}/actions/runs/{run_id}/job/{job_id}`).
 * The check run id must be the URL's job id and the app must be GitHub
 * Actions: a third-party check run or a different job cannot lend a run's
 * event. Any other URL is unproven and leaves the event absent.
 */
function workflowRunId(
  input: unknown,
  owner: string,
  name: string,
): number | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return null;
  }
  const check = input as Record<string, unknown>;
  const app = check.app;
  if (
    typeof app !== "object" || app === null || Array.isArray(app) ||
    (app as Record<string, unknown>).slug !== "github-actions"
  ) return null;
  const jobId = check.id;
  const details = check.details_url;
  if (
    typeof jobId !== "number" || !Number.isSafeInteger(jobId) || jobId < 1 ||
    typeof details !== "string" || details.length > 2048
  ) return null;
  let url: URL;
  try {
    url = new URL(details);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" || url.hostname !== "github.com" ||
    url.port !== "" || url.username !== "" || url.password !== "" ||
    url.search !== "" || url.hash !== ""
  ) return null;
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  if (parts.length !== 7 || parts[2] !== "actions" || parts[3] !== "runs") {
    return null;
  }
  const same = (left: string, right: string) =>
    left.toLowerCase() === right.toLowerCase();
  const runId = Number(parts[4]);
  const urlJobId = Number(parts[6]);
  if (
    !same(parts[0], owner) || !same(parts[1], name) || parts[5] !== "job" ||
    !Number.isSafeInteger(runId) || runId < 1 ||
    !Number.isSafeInteger(urlJobId) || urlJobId !== jobId
  ) return null;
  return runId;
}

function headStatuses(
  runs: readonly GitHubCheckV1[],
  statuses: readonly GitHubCheckV1[],
  now: number,
): GitHubCheckV1[] {
  if (
    runs.length === 0 ||
    runs.some((run) => run.status !== "completed" || run.completedAt === null)
  ) {
    return [...statuses];
  }
  const lastCompleted = Math.max(...runs.map((run) => run.completedAt!));
  if (now - lastCompleted < PENDING_STATUS_GRACE_MS) return [...statuses];
  const latest = new Map<string, GitHubCheckV1>();
  const time = (status: GitHubCheckV1) => status.startedAt ?? -1;
  for (const status of statuses) {
    const previous = latest.get(status.name);
    if (previous === undefined || time(status) > time(previous)) {
      latest.set(status.name, status);
    }
  }
  return statuses.filter((status) =>
    latest.get(status.name)?.status === "completed"
  );
}

export abstract class GitHubClientChecks extends GitHubClientIssues {
  /** Never-started verdicts of completed Actions jobs (`never-started-job.ts`). */
  private readonly jobVerdicts = new Map<string, boolean>();

  /** One Actions job's parsed body, or null for any unreadable answer. */
  private async readActionsJob(jobId: number): Promise<unknown> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/actions/jobs/${jobId}`,
    );
    if (!response.ok || response.value.status !== 200) return null;
    try {
      return JSON.parse(response.value.bodyText);
    } catch {
      return null;
    }
  }

  /** One workflow run's exact event, or undefined when it cannot be proven. */
  private async readWorkflowEvent(
    runId: number,
    sha: GitSha,
  ): Promise<string | undefined> {
    try {
      const response = await this.request(
        "GET",
        `/repos/${repoPath(this.repository)}/actions/runs/${runId}`,
      );
      if (!response.ok || response.value.status !== 200) return undefined;
      const value: unknown = JSON.parse(response.value.bodyText);
      if (
        typeof value !== "object" || value === null || Array.isArray(value)
      ) return undefined;
      const run = value as Record<string, unknown>;
      if (run.id !== runId || run.head_sha !== sha) return undefined;
      return typeof run.event === "string" &&
          WORKFLOW_EVENT_PATTERN.test(run.event)
        ? run.event
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Attach each Actions run's proven event, once per distinct run. */
  private async enrichCheckEvents(
    sha: GitSha,
    items: readonly unknown[],
    checks: readonly GitHubCheckV1[],
    options: GitHubChecksReadOptionsV1 | undefined,
  ): Promise<GitHubCheckV1[]> {
    if (options?.events !== true) return [...checks];
    const cache = new Map<number, Promise<string | undefined>>();
    const enriched = [...checks];
    let reads = 0;
    const eventOf = (runId: number): Promise<string | undefined> => {
      const previous = cache.get(runId);
      if (previous !== undefined) return previous;
      if (reads >= MAX_WORKFLOW_EVENT_READS) {
        return Promise.resolve(undefined);
      }
      reads++;
      const read = this.readWorkflowEvent(runId, sha);
      cache.set(runId, read);
      return read;
    };
    for (let index = 0; index < items.length; index++) {
      const runId = workflowRunId(
        items[index],
        this.repository.owner,
        this.repository.name,
      );
      if (runId === null) continue;
      const event = await eventOf(runId);
      if (event !== undefined) enriched[index] = { ...checks[index], event };
    }
    return enriched;
  }

  /** The backup CI consumer's reads over this client, or null (§11.2). */
  protected backupCiReads(): BackupCiClientReadsV1 | null {
    const backupCi = this.options.backupCi;
    if (backupCi === undefined) return null;
    return {
      ...backupCi,
      repository: this.repository,
      pages: (path, query, key) =>
        this.collectPages(
          `/repos/${repoPath(this.repository)}${path}`,
          { ...query, per_page: String(this.perPage) },
          (body) =>
            expectArray(
              key === null ? body : expectRecord(body, "$")[key],
              "$",
              this.maxItems,
              (v) => v,
            ) as unknown[],
        ),
      readJob: (jobId) => this.readActionsJob(jobId),
      verdicts: this.jobVerdicts,
    };
  }

  /** Every check-run page of exactly one commit, raw, item bound applied. */
  protected collectCheckRuns(sha: GitSha): Promise<PortResultV1<unknown[]>> {
    return this.collectPages(
      `/repos/${repoPath(this.repository)}/commits/${sha}/check-runs`,
      { per_page: String(this.perPage) },
      (body) => {
        const obj = expectRecord(body, "$");
        return expectArray(
          obj.check_runs,
          "$.check_runs",
          this.maxItems,
          (v) => v,
        ) as unknown[];
      },
    );
  }

  async readChecks(
    sha: GitSha,
    names?: ReadonlySet<string>,
    options?: GitHubChecksReadOptionsV1,
  ): Promise<PortResultV1<GitHubChecksV1>> {
    const collected = await this.collectCheckRuns(sha);
    if (!collected.ok) return collected;
    // A name filter skips unrelated entries before the strict parse; an entry
    // whose raw name is not a requested string is never read (`readChecks`
    // in ports-github.ts).
    const wanted = (item: unknown, key: "name" | "context") => {
      if (names === undefined) return true;
      const raw = typeof item === "object" && item !== null
        ? (item as Record<string, unknown>)[key]
        : undefined;
      return typeof raw === "string" && names.has(raw);
    };
    const checks: GitHubCheckV1[] = [];
    const items: unknown[] = [];
    for (const item of collected.value) {
      if (!wanted(item, "name")) continue;
      const parsed = parseWith(item, (v) => parseCheckRunWire(v, "$"));
      if (!parsed.ok) return parsed;
      // Every run must be bound to the exact requested head: a run recorded
      // for a different commit is not evidence for this head, and accepting
      // it would let a stale run satisfy a required check.
      if (parsed.value.head !== sha) {
        return portError(
          "unavailable",
          "checks collection does not match the requested head",
        );
      }
      checks.push(parsed.value);
      items.push(item);
    }
    // A failed Actions run whose job never started is marked (bounded job
    // reads; an unreadable job keeps the run as reported).
    const neverStarted = await neverStartedRunIndexes(
      items,
      sha,
      (jobId) => this.readActionsJob(jobId),
      this.jobVerdicts,
    );
    for (const index of neverStarted) {
      checks[index] = { ...checks[index], neverStarted: true };
    }
    checks.splice(
      0,
      checks.length,
      ...await this.enrichCheckEvents(sha, items, checks, options),
    );
    const statusesCollected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/commits/${sha}/statuses`,
      { per_page: String(this.perPage) },
      (body) => {
        return expectArray(
          body,
          "$",
          this.maxItems,
          (v) => v,
        ) as unknown[];
      },
    );
    if (!statusesCollected.ok) return statusesCollected;
    const statuses: GitHubCheckV1[] = [];
    for (const item of statusesCollected.value) {
      if (!wanted(item, "context")) continue;
      const parsed = parseWith(item, (v) => parseCommitStatusWire(v, "$", sha));
      if (!parsed.ok) return parsed;
      statuses.push(parsed.value);
    }
    // The bound counts every observation read, advisory statuses included.
    if (checks.length + statuses.length > this.maxItems) {
      return portError(
        "unavailable",
        "GitHub API checks collection size bound exceeded",
      );
    }
    // Verified backup CI stand-ins for never-started runs, and peers, before
    // the statuses are folded in (docs/backup-ci-spec.md §11.2).
    checks.splice(
      0,
      checks.length,
      ...await applyBackupCiToChecks(
        this.backupCiReads(),
        sha,
        items,
        checks,
        statuses,
        names !== undefined,
      ),
    );
    // A name-filtered read (the base attribution of given head failures)
    // judges no other check run of the commit: its statuses are as recorded.
    checks.push(
      ...(names === undefined
        ? headStatuses(checks, statuses, this.options.clock.now())
        : statuses),
    );
    return portOk({ head: sha, checks });
  }

  /**
   * The coverage rule's base read (`GitHubPort.readCheckSuites`): the same
   * complete, item-bounded check-run listing as `readChecks`, every run bound
   * to `sha`, reduced to name and suite with no label bound on the name.
   */
  async readCheckSuites(
    sha: GitSha,
  ): Promise<PortResultV1<GitHubCheckSuitesV1>> {
    const collected = await this.collectCheckRuns(sha);
    if (!collected.ok) return collected;
    const checks: GitHubCheckSuitesV1["checks"] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseCheckSuiteMemberWire(v, "$"));
      if (!parsed.ok) return parsed;
      if (parsed.value.head !== sha) {
        return portError(
          "unavailable",
          "checks collection does not match the requested head",
        );
      }
      checks.push({ name: parsed.value.name, suite: parsed.value.suite });
    }
    return portOk({ head: sha, checks });
  }
}
