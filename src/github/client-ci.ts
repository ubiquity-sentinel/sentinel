// client ci.

import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  expectArray,
  expectCount,
  expectRecord,
  fail,
} from "../contracts/validation.ts";
import { GitHubClientWrites } from "./client-writes.ts";
import type {
  ApproveExactCiRunInputV1,
  CiApprovalOutcomeV1,
} from "./client-contracts.ts";
import {
  CI_APPROVAL_AMBIGUOUS,
  CI_APPROVAL_BOUND,
  CI_APPROVAL_MAX_RUNS,
  CI_APPROVAL_RECONCILE,
  CI_APPROVAL_SCOPE,
  CI_WORKFLOW_FILE,
  type ExactCiPullIdentityV1,
  type ExactCiRunIdentityV1,
  parseExactCiPull,
  parseExactCiRun,
  validateCiApprovalInput,
} from "./client-ci-wire.ts";
import { nextLinkUrl, parseWire, repoPath } from "./client-response.ts";

export abstract class GitHubClientCi extends GitHubClientWrites {
  // -------------------------------------------------------------------------
  // Exact self-target CI approval
  // -------------------------------------------------------------------------

  /**
   * Approve the ONE exact `action_required` CI run for a durable self-target
   * pull request candidate. Read-only until a single POST: the actual PR is
   * read raw (head repository identity included) and the workflow run list is
   * bound to one page. Immediately before the POST the exact run and PR are
   * re-read and every identity is revalidated; an ambiguous or mismatched
   * candidate never submits. A lost response is reconciled by re-reading the
   * same run — this method never issues a second POST. A 201 reports the
   * approval as submitted, never that CI passed.
   */
  async approveExactCiRun(
    input: ApproveExactCiRunInputV1,
  ): Promise<PortResultV1<CiApprovalOutcomeV1>> {
    if (
      this.repository.owner !== "ubiquity-sentinel" ||
      this.repository.name !== "sentinel" ||
      this.repository.installationId !== 0
    ) {
      return portError("invalid", CI_APPROVAL_SCOPE);
    }
    const invalid = validateCiApprovalInput(input);
    if (invalid !== null) return invalid;
    const repo = repoPath(this.repository);
    const pullPath = `/repos/${repo}/pulls/${input.number}`;

    const firstPull = await this.readExactCiPull(pullPath, input);
    if (!firstPull.ok) return firstPull;
    const repositoryId = firstPull.value.repositoryId;

    const listed = await this.listExactCiRuns(repo, input, repositoryId);
    if (!listed.ok) return listed;
    if (listed.value.length === 0) return portOk({ status: "pending" });
    if (listed.value.length > 1) {
      return portError("unavailable", CI_APPROVAL_AMBIGUOUS);
    }
    const target = listed.value[0]!;
    const runPath = `/repos/${repo}/actions/runs/${target.id}`;

    // Re-read the exact run and PR immediately before the single POST: both
    // must still match the passed identity — including the selected run id and
    // attempt — and the run must still be awaiting approval. A transitioned or
    // changed run is observed, never re-approved here.
    const current = await this.readExactCiRun(
      runPath,
      input,
      target,
      repositoryId,
    );
    if (!current.ok) return current;
    if (!current.value.actionRequired) return portOk({ status: "pending" });
    const currentPull = await this.readExactCiPull(pullPath, input);
    if (!currentPull.ok) return currentPull;

    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}${runPath}/approve`,
      null,
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      // The approval may have applied. Reconcile against the SAME run id and
      // attempt; no second POST is ever submitted by this invocation.
      const observed = await this.readExactCiRun(
        runPath,
        input,
        target,
        repositoryId,
      );
      if (observed.ok && !observed.value.actionRequired) {
        return portOk({ status: "approved", runId: target.id });
      }
      return portError("unavailable", CI_APPROVAL_RECONCILE);
    }
    if (raw.response.status === 201) {
      return portOk({ status: "approved", runId: target.id });
    }
    return portError(...this.mapError(raw.response));
  }

  protected async readExactCiPull(
    path: string,
    input: ApproveExactCiRunInputV1,
  ): Promise<PortResultV1<ExactCiPullIdentityV1>> {
    const response = await this.request("GET", path);
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    return parseWire(response.value, (value) => parseExactCiPull(value, input));
  }

  protected async readExactCiRun(
    path: string,
    input: ApproveExactCiRunInputV1,
    expected: ExactCiRunIdentityV1,
    repositoryId: number,
  ): Promise<PortResultV1<{ actionRequired: boolean }>> {
    const response = await this.request("GET", path);
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    return parseWire(response.value, (value) => {
      const run = parseExactCiRun(value, input, repositoryId);
      // Every exact-run read (including lost-response reconciliation) must be
      // the selected run and attempt: a wrong id or changed attempt is never
      // approved and never reported as an approval.
      if (run.id !== expected.id || run.attempt !== expected.attempt) {
        fail("$.id", "invalid_value", "CI run identity mismatch");
      }
      return { actionRequired: run.actionRequired };
    });
  }

  protected async listExactCiRuns(
    repo: string,
    input: ApproveExactCiRunInputV1,
    repositoryId: number,
  ): Promise<PortResultV1<ExactCiRunIdentityV1[]>> {
    const response = await this.request(
      "GET",
      `/repos/${repo}/actions/workflows/${CI_WORKFLOW_FILE}/runs`,
      {
        event: "pull_request",
        head_sha: input.head,
        status: "action_required",
        per_page: String(CI_APPROVAL_MAX_RUNS),
      },
    );
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    // A next-page link is a hard truncation signal: the approval never
    // continues pagination toward a write.
    if (nextLinkUrl(response.value.headers) !== null) {
      return portError("unavailable", CI_APPROVAL_BOUND);
    }
    return parseWire(response.value, (value) => {
      const obj = expectRecord(value, "$");
      const total = expectCount(obj.total_count, "$.total_count");
      const page = expectArray(
        obj.workflow_runs,
        "$.workflow_runs",
        CI_APPROVAL_MAX_RUNS,
        (item) => item,
      );
      if (total > CI_APPROVAL_MAX_RUNS || page.length !== total) {
        fail(
          "$.total_count",
          "bound_exceeded",
          "CI run list is not a complete bounded page",
        );
      }
      const runs: ExactCiRunIdentityV1[] = [];
      for (const item of page) {
        // Identity mismatches anywhere in the page fail the whole read via
        // the strict parser; only a still-awaiting run is a candidate, and its
        // exact id and attempt are retained for the later exact reads.
        const run = parseExactCiRun(item, input, repositoryId);
        if (run.actionRequired) {
          runs.push({ id: run.id, attempt: run.attempt });
        }
      }
      return runs;
    });
  }
}
