// client hosted revisions.

import { createDeadline, type DeadlineV1 } from "./http.ts";
import { isHostedControllerRepository } from "../contracts/hosted-controller-deployment.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import { isGitSha } from "../contracts/brands.ts";
import {
  expectGitSha,
  expectRecord,
  fail,
  tryParse,
} from "../contracts/validation.ts";
import type { ReleaseRequestV1 } from "../contracts/release.ts";
import { parseReleaseRequestV1 } from "../contracts/release.ts";
import { GitHubClientCi } from "./client-ci.ts";
import {
  ACTIONS_RELEASE_BRANCH,
  HOSTED_EXECUTION_READ_DEADLINE_MS,
  HOSTED_EXECUTION_SCOPE,
  HOSTED_EXECUTION_UNAVAILABLE,
} from "./client-hosted-policy.ts";
import { parseWire, parseWith, repoPath } from "./client-response.ts";
import {
  hostedSelfRequest,
  parseActionsReleaseCommit,
  parseActionsReleasePull,
  parseHostedCompare,
  parseMatrixTreeEntry,
} from "./client-hosted-revision-wire.ts";

export abstract class GitHubClientHostedRevisions extends GitHubClientCi {
  /** Authenticated JSON GET used by the hosted supervisor evidence reads. */

  protected async actionsReleaseGet(
    path: string,
    query: Record<string, string> = {},
    parent?: DeadlineV1,
  ): Promise<PortResultV1<unknown>> {
    const response = await this.request("GET", path, query, parent);
    if (!response.ok) return response;
    if (response.value.status !== 200) {
      return portError(...this.mapError(response.value));
    }
    try {
      return portOk(JSON.parse(response.value.bodyText));
    } catch {
      return portError("invalid", "GitHub API response is malformed");
    }
  }

  // -------------------------------------------------------------------------
  // Hosted supervisor execution evidence (read-only, scope-0 self only)
  // -------------------------------------------------------------------------

  protected isHostedSelfScope(): boolean {
    return isHostedControllerRepository(this.repository);
  }

  protected hostedExecutionTimeout(): PortResultV1<never> {
    return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
  }

  /**
   * Ancestry check for one exact revision against the moving development ref:
   * the ref is never selected as an execution. Only an ahead/identical compare
   * whose base and merge base are the requested SHA is accepted.
   */
  async verifyHostedRevision(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>> {
    if (!this.isHostedSelfScope() || !isGitSha(revision)) {
      return portError("invalid", HOSTED_EXECUTION_SCOPE);
    }
    const deadline = createDeadline(HOSTED_EXECUTION_READ_DEADLINE_MS);
    try {
      const response = await this.request(
        "GET",
        `/repos/${
          repoPath(this.repository)
        }/compare/${revision}...${ACTIONS_RELEASE_BRANCH}`,
        {},
        deadline,
      );
      if (!response.ok) return response;
      if (response.value.status !== 200) {
        return portError(...this.mapError(response.value));
      }
      return parseWire(
        response.value,
        (value) => parseHostedCompare(value, revision),
      );
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Ordinary-only capability proof for the exact admitted commit. Complete,
   * authenticated Git trees prove absence; unknown identity or transport never does.
   */
  async verifyMatrixOrdinaryRevision(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>> {
    if (!this.isHostedSelfScope() || !isGitSha(revision)) {
      return portError("invalid", HOSTED_EXECUTION_SCOPE);
    }
    const deadline = createDeadline(HOSTED_EXECUTION_READ_DEADLINE_MS);
    try {
      const repo = repoPath(this.repository);
      const commit = await this.actionsReleaseGet(
        `/repos/${repo}/git/commits/${revision}`,
        {},
        deadline,
      );
      if (!commit.ok) return commit;
      const parsed = parseWith(commit.value, (value) => {
        const obj = expectRecord(value, "$");
        if (expectGitSha(obj.sha, "$.sha") !== revision) {
          fail(
            "$.sha",
            "invalid_value",
            "commit does not bind admitted revision",
          );
        }
        const tree = expectRecord(obj.tree, "$.tree");
        return expectGitSha(tree.sha, "$.tree.sha");
      });
      if (!parsed.ok) return parsed;
      let treeSha = parsed.value;
      const path = ["src", "host", "matrix-actions.ts"];
      for (const [index, name] of path.entries()) {
        if (deadline.fired()) return this.hostedExecutionTimeout();
        const tree = await this.actionsReleaseGet(
          `/repos/${repo}/git/trees/${treeSha}`,
          {},
          deadline,
        );
        if (!tree.ok) return tree;
        const entry = parseWith(
          tree.value,
          (value) => parseMatrixTreeEntry(value, treeSha, name, this.maxItems),
        );
        if (!entry.ok) return entry;
        if (entry.value === null) return portOk(false);
        const last = index === path.length - 1;
        if (
          last
            ? entry.value.type !== "blob" ||
              (entry.value.mode !== "100644" && entry.value.mode !== "100755")
            : entry.value.type !== "tree" || entry.value.mode !== "040000"
        ) {
          return portError(
            "invalid",
            "ordinary matrix entrypoint is not a normal source file",
          );
        }
        treeSha = entry.value.sha;
      }
      return portOk(true);
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Exact self production open request: the merged PR and its two-parent merge
   * commit are revalidated, then the requested revision must be an ancestor of
   * the current development ref within the SAME deadline. No workflow listing
   * and no authority-tree comparison.
   */
  async verifyHostedReleaseRequest(
    request: ReleaseRequestV1,
  ): Promise<PortResultV1<boolean>> {
    if (!this.isHostedSelfScope()) {
      return portError("invalid", HOSTED_EXECUTION_SCOPE);
    }
    const parsed = tryParse(parseReleaseRequestV1, request);
    if (!parsed.ok || !hostedSelfRequest(parsed.value)) return portOk(false);
    const frozen = parsed.value;
    const deadline = createDeadline(HOSTED_EXECUTION_READ_DEADLINE_MS);
    try {
      const repo = repoPath(this.repository);
      const pull = await this.actionsReleaseGet(
        `/repos/${repo}/pulls/${frozen.source.pullRequest}`,
        {},
        deadline,
      );
      if (!pull.ok) return pull;
      const parsedPull = tryParse(
        (value) => parseActionsReleasePull(value, frozen),
        pull.value,
      );
      if (!parsedPull.ok) return portOk(false);
      if (deadline.fired()) return this.hostedExecutionTimeout();
      const commit = await this.actionsReleaseGet(
        `/repos/${repo}/commits/${frozen.revision}`,
        {},
        deadline,
      );
      if (!commit.ok) return commit;
      const parsedCommit = tryParse(
        (value) => parseActionsReleaseCommit(value, frozen),
        commit.value,
      );
      if (!parsedCommit.ok) return portOk(false);
      if (deadline.fired()) return this.hostedExecutionTimeout();
      const compare = await this.request(
        "GET",
        `/repos/${repo}/compare/${frozen.revision}...${ACTIONS_RELEASE_BRANCH}`,
        {},
        deadline,
      );
      if (!compare.ok) return compare;
      if (compare.value.status !== 200) {
        return portError(...this.mapError(compare.value));
      }
      return parseWire(
        compare.value,
        (value) => parseHostedCompare(value, frozen.revision),
      );
    } catch {
      return portError("unavailable", HOSTED_EXECUTION_UNAVAILABLE);
    } finally {
      deadline.dispose();
    }
  }
}
