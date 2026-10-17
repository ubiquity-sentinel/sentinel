// client writes.

import type {
  GitHubIssueV1,
  GitHubPullRequestV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  parseIssueWire,
  parseMergeResponseWire,
  parsePullWire,
} from "./wire.ts";
import type { GitSha } from "../contracts/brands.ts";
import { GitHubClientReads } from "./client-reads.ts";
import type { CreatePullWireV1, MergePutWireV1 } from "./client-contracts.ts";
import { parseWire, repoPath } from "./client-response.ts";

export abstract class GitHubClientWrites extends GitHubClientReads {
  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  async createPull(create: {
    title: string;
    headRef: string;
    baseRef: string;
    body: string;
  }): Promise<PortResultV1<CreatePullWireV1>> {
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/repos/${repoPath(this.repository)}/pulls`,
      {
        title: create.title,
        head: `${this.repository.owner}:${create.headRef}`,
        base: create.baseRef,
        body: create.body,
      },
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      // The response was lost; the pull may have been created. The port
      // reconciles through exact discovery before concluding anything.
      return portOk({ status: "exists" });
    }
    const response = raw.response;
    if (response.status === 201) {
      const parsed = parseWire(
        response,
        (v) => parsePullWire(v, "$"),
      );
      if (!parsed.ok) return parsed;
      return portOk({ status: "created", pr: parsed.value });
    }
    if (response.status === 422 || response.status === 409) {
      return portOk({ status: "exists" });
    }
    return portError(...this.mapError(response));
  }

  async mergePull(
    number: number,
    sha: GitSha,
  ): Promise<PortResultV1<MergePutWireV1>> {
    const raw = await this.sendCore(
      "PUT",
      `${this.apiBaseUrl}/repos/${
        repoPath(this.repository)
      }/pulls/${number}/merge`,
      { sha },
    );
    if (raw.status === "error") {
      return portError(raw.error.kind, raw.error.detail, raw.error.rateLimit);
    }
    if (raw.status === "lost") {
      // The response was lost; the merge may have been applied. The port
      // re-observes the exact PR before reporting.
      return portOk({ status: "ambiguous" });
    }
    const response = raw.response;
    if (response.status === 200) {
      const parsed = parseWire(
        response,
        (v) => parseMergeResponseWire(v, "$"),
      );
      if (!parsed.ok) return parsed;
      return portOk({ status: "merged", mergeSha: parsed.value.mergeSha });
    }
    if (
      response.status === 405 || response.status === 409 ||
      response.status === 422
    ) {
      // Known non-merge states: the port re-observes the exact PR to
      // determine the blocked reason rather than guessing from the status.
      return portOk({ status: "rejected" });
    }
    return portError(...this.mapError(response));
  }

  /**
   * Assign one exact login to an issue. Idempotent: GitHub answers a created
   * response whether or not the login was already assigned, so the caller's
   * post-condition is "the identity is assigned". No other issue field is
   * touched.
   */
  async assignIssue(
    issueNumber: number,
    login: string,
  ): Promise<PortResultV1<void>> {
    const response = await this.send(
      "POST",
      `/repos/${repoPath(this.repository)}/issues/${issueNumber}/assignees`,
      {},
      { assignees: [login] },
    );
    if (!response.ok) return response;
    if (response.value.status === 200 || response.value.status === 201) {
      return portOk(undefined);
    }
    return portError(...this.mapError(response.value));
  }

  async closeIssue(issueNumber: number): Promise<PortResultV1<GitHubIssueV1>> {
    const response = await this.send(
      "PATCH",
      `/repos/${repoPath(this.repository)}/issues/${issueNumber}`,
      {},
      { state: "closed" },
    );
    if (!response.ok) return response;
    if (response.value.status === 200) {
      const parsed = parseWire(response.value, (v) => parseIssueWire(v, "$"));
      if (!parsed.ok) return parsed;
      if (parsed.value.kind === "pull_request") {
        return portError("invalid", "GitHub API response is malformed");
      }
      return portOk(parsed.value.issue);
    }
    return portError(...this.mapError(response.value));
  }

  async closePullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1>> {
    const response = await this.send(
      "PATCH",
      `/repos/${repoPath(this.repository)}/pulls/${number}`,
      {},
      { state: "closed" },
    );
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    return parseWire(response.value, (value) => parsePullWire(value, "$"));
  }
}
