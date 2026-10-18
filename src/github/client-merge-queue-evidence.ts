/** Canonical merge-group Actions evidence, separate from queue membership. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitHubApiClientOptionsV1 } from "./client-contracts.ts";
import { GitHubMergeQueueClient } from "./client-merge-queue.ts";
import { nextLinkUrl, repoPath } from "./client-response.ts";
import { createDeadline, type DeadlineV1 } from "./http.ts";
import type {
  MergeQueueSurface,
  QueueCheck,
  QueueEvidence,
  QueueGroupRun,
  QueuePullIdentity,
  QueueRead,
} from "./merge-queue-types.ts";
import {
  decodeQueueWire,
  invalidQueueWire,
  queueInteger,
  queueObject,
  queueSha,
  queueString,
  sameQueuePull,
} from "./merge-queue-wire.ts";

function status(value: unknown): QueueGroupRun["status"] {
  if (value === "queued" || value === "in_progress" || value === "completed") {
    return value;
  }
  if (value === "requested" || value === "waiting" || value === "pending") {
    return "queued";
  }
  return invalidQueueWire("malformed");
}
function conclusion(value: unknown): string | null {
  return value === null ? null : queueString(value, 100);
}

/** The reviewed workflow ID is mandatory; the base client needs no queue permission. */
export class GitHubMergeQueueEvidenceClient extends GitHubMergeQueueClient
  implements MergeQueueSurface {
  constructor(
    options: GitHubApiClientOptionsV1,
    private readonly queueWorkflowId: number | null,
  ) {
    super(options);
  }
  private run(value: unknown, revision: GitSha): QueueGroupRun {
    const row = queueObject(value);
    const repo = queueObject(row.repository);
    if (
      repo.name !== this.repository.name ||
      queueObject(repo.owner).login !== this.repository.owner ||
      row.head_sha !== revision || row.event !== "merge_group" ||
      row.workflow_id !== this.queueWorkflowId ||
      row.path !== ".github/workflows/deno-deploy.yml"
    ) return invalidQueueWire("identity_mismatch");
    return {
      id: queueInteger(row.id),
      attempt: queueInteger(row.run_attempt),
      head: queueSha(row.head_sha),
      event: "merge_group",
      workflowId: queueInteger(row.workflow_id),
      workflowPath: ".github/workflows/deno-deploy.yml",
      suiteId: queueInteger(row.check_suite_id),
      status: status(row.status),
      conclusion: conclusion(row.conclusion),
      checks: [],
    };
  }
  private check(value: unknown, run: QueueGroupRun): QueueCheck {
    const row = queueObject(value);
    if (
      row.head_sha !== run.head ||
      queueObject(row.check_suite).id !== run.suiteId
    ) return invalidQueueWire("identity_mismatch");
    return {
      id: queueInteger(row.id),
      suiteId: run.suiteId,
      head: queueSha(row.head_sha),
      name: queueString(row.name, 256),
      appId: queueInteger(queueObject(row.app).id),
      status: status(row.status),
      conclusion: conclusion(row.conclusion),
    };
  }

  /** Reject redirects to a different endpoint/filter even on the same API host. */
  private nextPage(next: string, original: URL, page: number): boolean {
    try {
      const url = new URL(next);
      if (
        url.origin !== original.origin || url.pathname !== original.pathname ||
        url.username !== "" || url.password !== "" || url.hash !== "" ||
        url.searchParams.get("page") !== String(page)
      ) return false;
      const expected = new URLSearchParams(original.search);
      expected.set("page", String(page));
      const entries = [...url.searchParams.entries()];
      return entries.length === [...expected.entries()].length &&
        entries.every(([key, value]) => expected.get(key) === value);
    } catch {
      return false;
    }
  }
  private async pages(
    path: string,
    query: Record<string, string>,
    key: string,
    deadline: DeadlineV1,
  ): Promise<QueueRead<readonly unknown[]>> {
    const original = new URL(`${this.apiBaseUrl}${path}`);
    original.search = new URLSearchParams({
      ...query,
      per_page: "100",
      page: "1",
    }).toString();
    let url = original.toString();
    const items: unknown[] = [];
    let total: number | null = null;
    for (let page = 1; page <= this.maxPages; page++) {
      const raw = await this.sendCore("GET", url, null, undefined, deadline);
      if (raw.status !== "response") {
        const reason =
          raw.status === "error" && raw.error.kind === "rate_limited"
            ? "rate_limited"
            : raw.status === "error" && raw.error.kind === "auth_failed"
            ? "auth"
            : "transport";
        return { status: "unavailable", reason };
      }
      if (raw.response.status !== 200) {
        return {
          status: "unavailable",
          reason: raw.response.status === 403
            ? "permission"
            : raw.response.status === 404
            ? "not_found"
            : "http",
        };
      }
      const parsed = decodeQueueWire(() => {
        const body = queueObject(JSON.parse(raw.response.bodyText));
        const count = queueInteger(body.total_count, 0);
        if (!Array.isArray(body[key]) || body[key].length > 100) {
          return invalidQueueWire("malformed");
        }
        return { count, rows: body[key] as unknown[] };
      });
      if (parsed.status !== "complete") return parsed;
      if (total !== null && total !== parsed.value.count) {
        return { status: "unavailable", reason: "drift" };
      }
      total = parsed.value.count;
      // Actions filtered workflow-run listings have a documented 1,000-result ceiling.
      if (total > this.maxItems || (key === "workflow_runs" && total >= 1000)) {
        return { status: "unavailable", reason: "resource_bound" };
      }
      items.push(...parsed.value.rows);
      if (items.length > this.maxItems || items.length > total) {
        return { status: "unavailable", reason: "resource_bound" };
      }
      const next = nextLinkUrl(raw.response.headers);
      if (next === null) {
        return items.length === total
          ? { status: "complete", value: items }
          : { status: "unavailable", reason: "incomplete" };
      }
      if (
        parsed.value.rows.length === 0 ||
        !this.nextPage(next, original, page + 1)
      ) return { status: "invalid", reason: "cursor" };
      url = next;
    }
    return { status: "unavailable", reason: "resource_bound" };
  }
  private async runs(
    revision: GitSha,
    deadline: DeadlineV1,
  ): Promise<QueueRead<readonly QueueGroupRun[]>> {
    const read = await this.pages(
      `/repos/${
        repoPath(this.repository)
      }/actions/workflows/${this.queueWorkflowId}/runs`,
      { event: "merge_group", head_sha: revision },
      "workflow_runs",
      deadline,
    );
    if (read.status !== "complete") return read;
    return decodeQueueWire(() => {
      const parsed = read.value.map((value) => this.run(value, revision));
      if (new Set(parsed.map((run) => run.id)).size !== parsed.length) {
        return invalidQueueWire("duplicate");
      }
      return parsed.sort((a, b) => a.id - b.id);
    });
  }
  private async checks(
    run: QueueGroupRun,
    deadline: DeadlineV1,
  ): Promise<QueueRead<readonly QueueCheck[]>> {
    const read = await this.pages(
      `/repos/${
        repoPath(this.repository)
      }/check-suites/${run.suiteId}/check-runs`,
      { filter: "latest" },
      "check_runs",
      deadline,
    );
    if (read.status !== "complete") return read;
    return decodeQueueWire(() => {
      const parsed = read.value.map((value) => this.check(value, run));
      if (new Set(parsed.map((check) => check.id)).size !== parsed.length) {
        return invalidQueueWire("duplicate");
      }
      return parsed.sort((a, b) => a.id - b.id);
    });
  }

  async readMergeGroupRuns(
    revision: GitSha,
  ): Promise<QueueRead<readonly QueueGroupRun[]>> {
    if (this.queueWorkflowId === null) {
      return { status: "unavailable", reason: "unsupported" };
    }
    if (
      !isGitSha(revision) || !Number.isSafeInteger(this.queueWorkflowId) ||
      this.queueWorkflowId < 1
    ) return { status: "invalid", reason: "identity_mismatch" };
    const deadline = createDeadline(this.requestDeadlineMs);
    try {
      const first = await this.runs(revision, deadline);
      if (first.status !== "complete") return first;
      const collected: QueueGroupRun[] = [];
      for (const run of first.value) {
        const before = await this.checks(run, deadline);
        if (before.status !== "complete") return before;
        const after = await this.checks(run, deadline);
        if (after.status !== "complete") return after;
        if (
          canonicalStringify(before.value) !== canonicalStringify(after.value)
        ) return { status: "unavailable", reason: "drift" };
        collected.push({ ...run, checks: after.value });
      }
      const second = await this.runs(revision, deadline);
      if (second.status !== "complete") return second;
      if (
        canonicalStringify(first.value) !== canonicalStringify(second.value)
      ) return { status: "unavailable", reason: "drift" };
      return { status: "complete", value: collected };
    } finally {
      deadline.dispose();
    }
  }

  /** Full delivery evidence is queried only after an exact merged revision exists. */
  async readPullEvidence(
    pull: QueuePullIdentity,
  ): Promise<QueueRead<QueueEvidence>> {
    const member = await this.readPullMembership(pull);
    if (member.status !== "complete") return member;
    if (!sameQueuePull(member.value.pull, pull)) {
      return { status: "unavailable", reason: "drift" };
    }
    if (member.value.mergedRevision === null) {
      return { status: "unavailable", reason: "incomplete" };
    }
    const events = await this.readPullQueueEvents(pull);
    if (events.status !== "complete") return events;
    const runs = await this.readMergeGroupRuns(member.value.mergedRevision);
    if (runs.status !== "complete") return runs;
    const after = await this.readPullMembership(pull);
    if (after.status !== "complete") return after;
    if (canonicalStringify(member.value) !== canonicalStringify(after.value)) {
      return { status: "unavailable", reason: "drift" };
    }
    return {
      status: "complete",
      value: {
        ...events.value,
        entry: member.value.entry,
        mergeGroupRuns: runs.value,
      },
    };
  }
}
