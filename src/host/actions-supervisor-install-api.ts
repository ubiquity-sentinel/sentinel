/** Read-only installation evidence through the existing authenticated GitHub client. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { HOSTED_CONTROLLER_API_PATH } from "../contracts/hosted-controller-deployment.ts";
import { portError, portOk, type PortResultV1 } from "../contracts/ports.ts";
import { GitHubApiClient } from "../github/client.ts";
import { parseHostedCompare } from "../github/client-hosted-revision-wire.ts";
import { createDeadline } from "../github/http.ts";
import type { ChildRuntimeSummaryV1, RunJobSummaryV1 } from "./run-summary.ts";

const ROOT = HOSTED_CONTROLLER_API_PATH;
const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export class HostedSupervisorGitHubClient extends GitHubApiClient {
  /**
   * #178: every completed job of one run attempt with the summary `select`
   * reads from its bounded signed log (null when the log is unreadable or
   * has none). Read-only, self scope only, one bounded deadline; only the
   * selected summary is retained, never the log.
   */
  async readRunJobSummaries(
    runId: number,
    runAttempt: number,
    select: (log: string) => ChildRuntimeSummaryV1 | null,
    budgetMs = 90_000,
  ): Promise<PortResultV1<RunJobSummaryV1[]>> {
    if (
      !this.isHostedSelfScope() || !Number.isSafeInteger(runId) ||
      runId <= 0 || !Number.isSafeInteger(runAttempt) || runAttempt <= 0
    ) return portError("invalid", "run summary scope is invalid");
    const deadline = createDeadline(budgetMs);
    try {
      const jobs: { id: number; name: string; conclusion: string | null }[] =
        [];
      for (let page = 1; page <= 3; page++) {
        const response = await this.actionsReleaseGet(
          `${ROOT}/actions/runs/${runId}/attempts/${runAttempt}/jobs`,
          { per_page: "100", page: String(page) },
          deadline,
        );
        if (!response.ok) return response;
        const value = response.value;
        if (!record(value) || !Array.isArray(value.jobs)) {
          return portError("invalid", "run job list is malformed");
        }
        for (const job of value.jobs) {
          if (
            !record(job) || !Number.isSafeInteger(job.id) ||
            typeof job.name !== "string"
          ) return portError("invalid", "run job list is malformed");
          if (job.status !== "completed") continue;
          jobs.push({
            id: job.id as number,
            name: job.name.slice(0, 200),
            conclusion: typeof job.conclusion === "string"
              ? job.conclusion
              : null,
          });
        }
        if (value.jobs.length < 100) break;
      }
      const rows: RunJobSummaryV1[] = [];
      for (const job of jobs) {
        const log = await this.readHostedRuntimeLog(job.id, deadline);
        let summary: ChildRuntimeSummaryV1 | null = null;
        if (log.ok) {
          try {
            summary = select(log.value);
          } catch {
            summary = null;
          }
        }
        rows.push({ name: job.name, conclusion: job.conclusion, summary });
      }
      return portOk(rows);
    } catch {
      return portError("unavailable", "run job summaries are unavailable");
    } finally {
      deadline.dispose();
    }
  }
  async verifyAncestor(
    ancestor: GitSha,
    descendant: GitSha,
  ): Promise<PortResultV1<boolean>> {
    if (
      !this.isHostedSelfScope() || !isGitSha(ancestor) || !isGitSha(descendant)
    ) return portError("invalid", "launcher ancestry scope is invalid");
    const deadline = createDeadline(30_000);
    try {
      // Authenticate the exact descendant before interpreting a compare response.
      const commit = await this.actionsReleaseGet(
        `${ROOT}/commits/${descendant}`,
        {},
        deadline,
      );
      if (!commit.ok) return commit;
      if (!record(commit.value) || commit.value.sha !== descendant) {
        return portOk(false);
      }
      const compare = await this.actionsReleaseGet(
        `${ROOT}/compare/${ancestor}...${descendant}`,
        {},
        deadline,
      );
      if (!compare.ok) return compare;
      return portOk(parseHostedCompare(compare.value, ancestor));
    } catch {
      return portError(
        "unavailable",
        "launcher ancestry evidence is unavailable",
      );
    } finally {
      deadline.dispose();
    }
  }
  async verifyLauncherCi(
    revision: GitSha,
  ): Promise<PortResultV1<{ revision: GitSha; checkRunId: number } | null>> {
    if (!this.isHostedSelfScope() || !isGitSha(revision)) {
      return portError("invalid", "launcher CI scope is invalid");
    }
    const deadline = createDeadline(30_000);
    const rows: Record<string, unknown>[] = [];
    let total: number | null = null;
    try {
      for (let page = 1; page <= 20; page++) {
        const response = await this.actionsReleaseGet(
          `${ROOT}/commits/${revision}/check-runs`,
          { per_page: "100", page: String(page), filter: "latest" },
          deadline,
        );
        if (!response.ok) return response;
        const value = response.value;
        if (
          !record(value) || !Number.isSafeInteger(value.total_count) ||
          (value.total_count as number) < 0 ||
          !Array.isArray(value.check_runs) || value.check_runs.length > 100 ||
          total !== null && total !== value.total_count ||
          value.check_runs.some((r) =>
            !record(r) || !Number.isSafeInteger(r.id) || (r.id as number) <= 0
          )
        ) return portOk(null);
        total = value.total_count as number;
        rows.push(...value.check_runs as Record<string, unknown>[]);
        if (
          rows.length > total ||
          new Set(rows.map((r) => r.id)).size !== rows.length
        ) return portOk(null);
        if (rows.length === total) {
          const checks = rows.filter((r) =>
            r.name === "test-local" && r.head_sha === revision
          );
          // Ambiguous/failed latest checks cannot be hidden behind an older success.
          if (
            checks.length === 0 ||
            checks.some((r) =>
              r.status !== "completed" || r.conclusion !== "success" ||
              !record(r.app) || r.app.slug !== "github-actions"
            )
          ) return portOk(null);
          const ids = checks.map((r) => r.id as number).sort((a, b) => a - b);
          return portOk({ revision, checkRunId: ids[0] });
        }
        if (value.check_runs.length !== 100) return portOk(null);
      }
      return portOk(null);
    } catch {
      return portError("unavailable", "launcher CI evidence is unavailable");
    } finally {
      deadline.dispose();
    }
  }
}
