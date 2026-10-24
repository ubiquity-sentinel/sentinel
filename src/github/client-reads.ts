// client reads.

import type {
  GitHubBranchProtectionsV1,
  GitHubCheckSuitesV1,
  GitHubChecksV1,
  GitHubCheckV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  GitHubReviewDecisionV1,
  PortResultV1,
} from "../contracts/ports.ts";
import { expectArray, expectRecord } from "../contracts/validation.ts";
import {
  parseBranchRuleWire,
  parseCheckRunWire,
  parseCheckSuiteMemberWire,
  parseCommitStatusWire,
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
import type { GitSha } from "../contracts/brands.ts";
import type {
  GitHubBranchRuleWireV1,
  GitHubReviewCommentWireV1,
  GitHubReviewWireV1,
  GitHubRuleSetWireV1,
} from "./wire.ts";
import { GitHubClientIssues } from "./client-issues.ts";
import { parseWire, parseWith, repoPath } from "./client-response.ts";
import { REVIEW_DECISION_QUERY } from "./client-issue-wire.ts";

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

export abstract class GitHubClientReads extends GitHubClientIssues {
  /** Host-authored base-review jobs; unrelated supervisor jobs are not task CI. */
  async readBaseReviewChecks(
    sha: GitSha,
    names: readonly string[],
  ): Promise<PortResultV1<GitHubChecksV1>> {
    const collected = await this.collectCheckRuns(sha);
    if (!collected.ok) return collected;
    const checks = [];
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

  /** Every check-run page of exactly one commit, raw, item bound applied. */
  private collectCheckRuns(sha: GitSha): Promise<PortResultV1<unknown[]>> {
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
    const checks = [];
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
    }
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
