// client reads.

import type {
  GitHubBranchProtectionsV1,
  GitHubChecksV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  GitHubReviewDecisionV1,
  PortResultV1,
} from "../contracts/ports.ts";
import {
  expectArray,
  expectBoolean,
  expectRecord,
  fail,
} from "../contracts/validation.ts";
import type { RepositoryMergeSettingsV1 } from "../contracts/target-delivery.ts";
import {
  parseBranchRuleWire,
  parseCheckRunWire,
  parseProtectionWire,
  parsePullReviewDecisionWire,
  parsePullWire,
  parseRefWire,
  parseReviewCommentWire,
  parseReviewWire,
  parseRuleSetWire,
  unprotectedProtection,
} from "./wire.ts";
import { portError, portOk } from "../contracts/ports.ts";
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import type {
  GitHubBranchRuleWireV1,
  GitHubReviewCommentWireV1,
  GitHubReviewWireV1,
  GitHubRuleSetWireV1,
} from "./wire.ts";
import { GitHubClientChecks } from "./client-checks.ts";
import { parseWire, parseWith, repoPath } from "./client-response.ts";
import { REVIEW_DECISION_QUERY } from "./client-issue-wire.ts";
import { readPassportBaseReviewChecks } from "./base-review-ci.ts";
export {
  MAX_WORKFLOW_EVENT_READS,
  PENDING_STATUS_GRACE_MS,
} from "./client-checks.ts";

/** Parents one commit may list (a merge has two; octopus merges more). */
const COMMIT_PARENTS_MAX = 64;

export abstract class GitHubClientReads extends GitHubClientChecks {
  /** Host-authored base-review jobs; unrelated supervisor jobs are not task CI. */
  async readBaseReviewChecks(
    sha: GitSha,
    names: readonly string[],
  ): Promise<PortResultV1<GitHubChecksV1>> {
    const collected = await this.collectCheckRuns(sha);
    if (!collected.ok) return collected;
    const checks = [];
    const raws = [];
    for (const item of collected.value) {
      if (
        typeof item !== "object" || item === null ||
        !names.includes(String((item as Record<string, unknown>).name))
      ) continue;
      const app = (item as Record<string, unknown>).app as
        | Record<string, unknown>
        | undefined;
      if (app?.id !== 15368 || app.slug !== "github-actions") {
        return portError("unavailable", "base CI producer mismatch");
      }
      const parsed = parseWith(item, (v) => parseCheckRunWire(v, "$"));
      if (!parsed.ok) return parsed;
      if (parsed.value.head !== sha) {
        return portError("unavailable", "base CI head mismatch");
      }
      checks.push(parsed.value);
      raws.push(item);
    }
    if (
      this.repository.owner === "ubiquity" &&
      this.repository.name === "passport.ubq.fi"
    ) {
      return readPassportBaseReviewChecks({
        sha,
        names,
        raws,
        checks,
        backup: this.backupCiReads(),
        read: async (path, query) => {
          const response = await this.request(
            "GET",
            `/repos/${repoPath(this.repository)}${path}`,
            query,
          );
          return response.ok
            ? parseWire(response.value, (value) => value)
            : response;
        },
        pages: (path, query, key) =>
          this.collectPages(
            `/repos/${repoPath(this.repository)}${path}`,
            { ...query, per_page: String(this.perPage) },
            (body) =>
              expectArray(
                key === null ? body : expectRecord(body, "$")[key],
                "$",
                this.maxItems,
                (value) => value,
              ) as unknown[],
          ),
      });
    }
    return portOk({ head: sha, checks });
  }
  /** Raw open/closed PR list for a head ref (discovery; exact match later). */
  async listPullRequestsByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/pulls`,
      {
        head: `${this.repository.owner}:${headRef}`,
        state: "all",
        per_page: String(this.perPage),
      },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const pulls: GitHubPullRequestV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parsePullWire(v, "$"));
      if (!parsed.ok) return parsed;
      if (parsed.value.headRef === headRef) pulls.push(parsed.value);
    }
    return portOk(pulls);
  }

  async readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/pulls/${number}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    const parsed = parseWire(response.value, (v) => parsePullWire(v, "$"));
    if (!parsed.ok) return parsed;
    return portOk(parsed.value);
  }

  /** Read approval from GitHub's authoritative GraphQL field. */
  async readPullRequestReviewDecision(
    number: number,
  ): Promise<PortResultV1<GitHubReviewDecisionV1>> {
    const raw = await this.sendCore(
      "POST",
      `${this.apiBaseUrl}/graphql`,
      {
        query: REVIEW_DECISION_QUERY,
        variables: {
          owner: this.repository.owner,
          name: this.repository.name,
          number,
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
      (value) => parsePullReviewDecisionWire(value, "$"),
    );
  }

  async readProtections(
    branch: string,
  ): Promise<PortResultV1<GitHubBranchProtectionsV1>> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/branches/${
        encodeURIComponent(branch)
      }/protection`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) {
      // Unprotected branch (or absent branch): a real observed value, never
      // an error and never "protected".
      return portOk(unprotectedProtection(branch));
    }
    const parsed = parseWire(
      response.value,
      (v) => parseProtectionWire(v, branch),
    );
    if (!parsed.ok) return parsed;
    return portOk(parsed.value);
  }

  async readRef(inputRef: string): Promise<PortResultV1<GitHubRefV1 | null>> {
    const ref = inputRef.startsWith("refs/")
      ? inputRef.slice("refs/".length)
      : inputRef;
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/git/ref/${ref}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    const parsed = parseWire(response.value, (v) => parseRefWire(v, "$"));
    if (!parsed.ok) return parsed;
    if (parsed.value.ref !== `refs/${ref}`) {
      return portError("invalid", "GitHub API response is malformed");
    }
    return portOk(parsed.value);
  }

  /** The exact parents of one commit, in order; null when it does not exist. */
  async readCommitParents(
    sha: GitSha,
  ): Promise<PortResultV1<GitSha[] | null>> {
    if (!isGitSha(sha)) return portError("invalid", "commit SHA is invalid");
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/git/commits/${sha}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    return parseWire(response.value, (value) => {
      const commit = expectRecord(value, "$");
      if (commit.sha !== sha) {
        fail("$.sha", "invalid_value", "commit does not match the request");
      }
      return expectArray(
        commit.parents,
        "$.parents",
        COMMIT_PARENTS_MAX,
        (item, path) => {
          const parent = expectRecord(item, path).sha;
          if (!isGitSha(parent)) {
            fail(`${path}.sha`, "invalid_sha", "expected a full commit SHA");
          }
          return parent;
        },
      );
    });
  }

  /**
   * The exact tree of one commit; null when it does not exist. A squash merge
   * is proven by its tree equal to the reviewed head's tree (#331).
   */
  async readCommitTree(sha: GitSha): Promise<PortResultV1<GitSha | null>> {
    if (!isGitSha(sha)) return portError("invalid", "commit SHA is invalid");
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/git/commits/${sha}`,
    );
    if (!response.ok) return response;
    if (response.value.status === 404) return portOk(null);
    return parseWire(response.value, (value) => {
      const commit = expectRecord(value, "$");
      if (commit.sha !== sha) {
        fail("$.sha", "invalid_value", "commit does not match the request");
      }
      const tree = expectRecord(commit.tree, "$.tree").sha;
      if (!isGitSha(tree)) {
        fail("$.tree.sha", "invalid_sha", "expected a full tree SHA");
      }
      return tree;
    });
  }

  /** The repository's merge settings (`allow_squash_merge`, #331). */
  async readRepositoryMergeSettings(): Promise<
    PortResultV1<RepositoryMergeSettingsV1>
  > {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}`,
    );
    if (!response.ok) return response;
    return parseWire(response.value, (value) => {
      const repo = expectRecord(value, "$");
      return {
        allowSquashMerge: expectBoolean(
          repo.allow_squash_merge,
          "$.allow_squash_merge",
        ),
        allowMergeCommit: expectBoolean(
          repo.allow_merge_commit,
          "$.allow_merge_commit",
        ),
      };
    });
  }

  async readReviews(
    number: number,
  ): Promise<PortResultV1<GitHubReviewWireV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/pulls/${number}/reviews`,
      { per_page: String(this.perPage) },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const reviews: GitHubReviewWireV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseReviewWire(v, "$"));
      if (!parsed.ok) return parsed;
      reviews.push(parsed.value);
    }
    return portOk(reviews);
  }

  async readReviewComments(
    number: number,
  ): Promise<PortResultV1<GitHubReviewCommentWireV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/pulls/${number}/comments`,
      { per_page: String(this.perPage) },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const comments: GitHubReviewCommentWireV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseReviewCommentWire(v, "$"));
      if (!parsed.ok) return parsed;
      comments.push(parsed.value);
    }
    return portOk(comments);
  }

  /**
   * All active rules that apply to the branch (repository + organization
   * level), exhausted with the same bounds as every other paged read.
   */
  async readBranchRules(
    branch: string,
  ): Promise<PortResultV1<GitHubBranchRuleWireV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/rules/branches/${
        encodeURIComponent(branch)
      }`,
      { per_page: String(this.perPage) },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const rules: GitHubBranchRuleWireV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseBranchRuleWire(v, "$"));
      if (!parsed.ok) return parsed;
      rules.push(parsed.value);
    }
    return portOk(rules);
  }

  /** Repository rulesets including parent (organization) rulesets that apply. */
  async readRepositoryRuleSets(): Promise<PortResultV1<GitHubRuleSetWireV1[]>> {
    const collected = await this.collectPages(
      `/repos/${repoPath(this.repository)}/rulesets`,
      {
        includes_parents: "true",
        per_page: String(this.perPage),
      },
      (body) => expectArray(body, "$", this.maxItems, (v) => v) as unknown[],
    );
    if (!collected.ok) return collected;
    const rulesets: GitHubRuleSetWireV1[] = [];
    for (const item of collected.value) {
      const parsed = parseWith(item, (v) => parseRuleSetWire(v, "$"));
      if (!parsed.ok) return parsed;
      rulesets.push(parsed.value);
    }
    return portOk(rulesets);
  }

  /** Exact ruleset details (rules and bypass policy for one ruleset). */
  async readRepositoryRuleSet(
    ruleSetId: number,
  ): Promise<PortResultV1<GitHubRuleSetWireV1>> {
    const response = await this.request(
      "GET",
      `/repos/${repoPath(this.repository)}/rulesets/${ruleSetId}`,
    );
    if (!response.ok) return response;
    const parsed = parseWire(response.value, (v) => parseRuleSetWire(v, "$"));
    if (!parsed.ok) return parsed;
    return portOk(parsed.value);
  }
}
