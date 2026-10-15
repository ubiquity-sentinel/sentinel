// client issues.

import type {
  GitHubIssueRelationsV1,
  GitHubIssueV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { expectArray } from "../contracts/validation.ts";
import { parseIssueWire } from "./wire.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { GitHubClientHttp } from "./client-http.ts";
import { parseWire, parseWith, repoPath } from "./client-response.ts";
import {
  ISSUE_RELATIONS_QUERY,
  parseIssueRelations,
} from "./client-issue-wire.ts";

export abstract class GitHubClientIssues extends GitHubClientHttp {
  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/issues`,
      { state: "open", per_page: String(this.perPage) },
      // GitHub's REST `/issues` endpoint returns a top-level array. The
      // object envelope used by search is a different API shape and must not
      // be accepted here because it would hide a provider contract drift.
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const issues: GitHubIssueV1[] = [];
    let enrich = this.includeIssueRelations;
    for (const item of collected.value) {
      // Issue-vs-PR distinction: `/issues` lists pull requests too and GitHub
      // marks them with a `pull_request` key; a PR is never an issue here.
      const parsed = parseWith(item, (v) => parseIssueWire(v, "$"));
      if (!parsed.ok) return parsed;
      if (parsed.value.kind === "issue") {
        if (!enrich) {
          issues.push(parsed.value.issue);
          continue;
        }
        // Trusted enrichment of an actual REST issue record. If relations
        // cannot be fetched for an issue, include it WITHOUT relations —
        // the intake admits it and the matrix cell's pre-start verification
        // does the final blocker check. Skipping the issue here would starve
        // intake when GraphQL is unavailable.
        const relations = await this.readIssueRelations(
          parsed.value.issue.number,
        );
        if (!relations.ok) {
          // A rate limit applies to every later read of this listing: the
          // remaining issues are listed without relations instead of each
          // spending one more refused request.
          if (relations.error.kind === "rate_limited") enrich = false;
          issues.push(parsed.value.issue);
          continue;
        }
        issues.push({ ...parsed.value.issue, relations: relations.value });
      }
    }
    return portOk(issues);
  }

  async readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/issues/${issueNumber}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    const parsed = parseWire(response.value, (v) => parseIssueWire(v, "$"));
    if (!parsed.ok) return parsed;
    if (parsed.value.kind === "pull_request") {
      // A pull request is not an issue; the caller's issue does not exist as
      // one. Distinct from a transport failure, never a fabricated issue.
      return portOk(null);
    }
    if (!this.includeIssueRelations) return portOk(parsed.value.issue);
    const relations = await this.readIssueRelations(parsed.value.issue.number);
    if (!relations.ok) return relations;
    return portOk({ ...parsed.value.issue, relations: relations.value });
  }

  /**
   * Native dependency relations for one actual issue. Same authenticated
   * GraphQL transport, whole-operation deadline, cooldown gate and typed
   * error mapping as `readPullRequestReviewDecision`; there is no retry loop
   * and no separate credential path. Every malformed, mismatched or
   * truncated answer is a typed failure — never an empty success.
   */
  protected async readIssueRelations(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueRelationsV1>> {
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/graphql`,
      {
        query: ISSUE_RELATIONS_QUERY,
        variables: {
          owner: this.repository.owner,
          name: this.repository.name,
          number: issueNumber,
        },
      },
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      return portError("unavailable", "GitHub API request failed");
    }
    if (raw.response.status !== 200) {
      return portError(...this.mapError(raw.response));
    }
    return parseWire(
      raw.response,
      (value) => parseIssueRelations(value, issueNumber),
    );
  }
}
