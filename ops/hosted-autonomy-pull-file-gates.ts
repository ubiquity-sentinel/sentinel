/**
 * The launcher merge gates that read what a pull request changes (issue #158
 * item 2 and the owner directive of 2026-11-17, "give sentinel full access"):
 *
 * - a change Sentinel never merges on its own (`sentinelNeverMerges`: a
 *   credential path on any target, or a protected path of Sentinel's own
 *   repository) refuses `protected_path`;
 * - a change to a CI-executable path (`ciExecutablePath`: anything under
 *   `.github/` in any letter case, and any path it cannot classify) is judged
 *   by its own modified workflow, whose jobs may all be skipped or neutral and
 *   still read as green, or which may drop the real tests for a trivial job,
 *   so it merges only when its GitHub Actions success names meet the
 *   expectation read from the base branch's merged pull requests
 *   (`src/repair/ci-success-rule.ts`, shared with the runtime: every job the
 *   last merged pull request with an Actions success passed, else the base's,
 *   else at least one; never a status, a backup-CI stand-in or another app's
 *   check), else `ci_success_required`. This gate alone holds such a head: it
 *   survives a runtime rollback;
 * - a delivery train never carries such a change (`train_ci_executable`): the
 *   member keeps the per-record path, which applies the rule above.
 *
 * - every launcher merge (delivery, spent and carried delivery, a train
 *   member) refuses unless the record's source issue was opened by the owner
 *   account (login and id) or the App (`sourceAdmissionRefusal`), read live:
 *   the launcher runs before the runtime each cycle, so the runtime's own
 *   admission parks cannot stand in for it.
 *
 * An unreadable listing or success read refuses; a fixture surface without
 * the file listing skips the file gates (never the admission gate).
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { neverMergedChange } from "../src/github/merge-content-gate.ts";
import type { GitHubCheckV1 } from "../src/contracts/ports.ts";
import {
  actionsSuccessNames as checkSuccessNames,
  ciExpectationSatisfied,
  readCiExpectation,
} from "../src/repair/ci-success-rule.ts";
import { ciExecutablePath } from "../src/repair/workflow-trust.ts";
import { SENTINEL_BACKUP_FIELD } from "./hosted-autonomy-backup-ci-read.ts";
import type { HostedTreeChangeV1 } from "./hosted-autonomy-github-trees.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyRecordV1,
} from "./hosted-autonomy-types.ts";
import { issueAuthorAdmitted } from "../src/repair/issue-admission.ts";

/** A launcher merge never lands a change Sentinel never merges itself. */
export function touchesTargetProtected(
  repository: RepositoryIdentityV1,
  changes: readonly Pick<HostedTreeChangeV1, "path">[],
): boolean {
  return neverMergedChange(repository, changes.map((change) => change.path));
}

/**
 * The job names GitHub Actions ran to `success` among one commit's complete
 * gating check runs (`targetCiSuccessNames`): each raw run read as the
 * runtime's check shape and reduced by the runtime's own function
 * (`ci-success-rule.ts`: the latest run of each name by start, else
 * completion, time, the first listed on a tie; only a GitHub Actions run
 * completed `success`, never a backup-CI stand-in, a commit status, a review
 * bot or another app's check); sorted.
 */
export function actionsSuccessNames(
  runs: readonly Record<string, unknown>[],
): string[] {
  const time = (value: unknown) => {
    const at = Date.parse(String(value));
    return Number.isFinite(at) ? at : null;
  };
  return checkSuccessNames(runs.map((run) => {
    const app = run["app"];
    const slug = app !== null && typeof app === "object" && !Array.isArray(app)
      ? (app as Record<string, unknown>)["slug"]
      : undefined;
    return {
      name: String(run["name"]),
      status: run["status"],
      conclusion: run["conclusion"],
      head: run["head_sha"],
      startedAt: time(run["started_at"]),
      completedAt: time(run["completed_at"]),
      ...(typeof slug === "string" ? { app: slug } : {}),
      ...(run[SENTINEL_BACKUP_FIELD] === undefined ? {} : { backup: {} }),
    } as unknown as GitHubCheckV1;
  }));
}

/**
 * `ci_success_required` unless `head`'s Actions success names meet the
 * expectation read from `baseBranch`'s merged pull requests (the default
 * branch when absent; `readCiExpectation`, shared with the runtime), when
 * `paths` change a CI-executable path; null otherwise. An unreadable read, or
 * no base, refuses.
 */
export async function ciSuccessRefusal(
  surface: HostedAutonomyGitHubV1,
  base: string | null,
  head: string,
  paths: readonly string[],
  baseBranch?: string | null,
): Promise<"ci_success_required" | null> {
  if (!paths.some(ciExecutablePath)) return null;
  if (base === null) return "ci_success_required";
  const names = async (sha: string) =>
    await surface.targetCiSuccessNames?.(sha) ?? null;
  try {
    const passed = await names(head);
    if (passed === null) return "ci_success_required";
    const expectation = await readCiExpectation({
      mergedPullHeads: async () =>
        await surface.mergedPullHeads?.(baseBranch ?? undefined) ?? null,
      successNames: names,
    }, base);
    return ciExpectationSatisfied(expectation, passed)
      ? null
      : "ci_success_required";
  } catch {
    return "ci_success_required";
  }
}

export type PullFileRefusalV1 =
  | "protected_path"
  | "protected_path_unverified"
  | "ci_success_required"
  | "train_ci_executable";

/**
 * The pull request's changed paths (a rename's previous path included),
 * listed once: the protected-path refusal, then, for a merge of `head`, the
 * success rule, or for a train admission (`train`), a CI-executable change.
 */
export async function protectedPathRefusal(
  surface: HostedAutonomyGitHubV1,
  repository: RepositoryIdentityV1,
  pull: number,
  gate: {
    readonly head?: string;
    readonly base?: string;
    readonly baseBranch?: string | null;
    readonly train?: boolean;
  } = {},
): Promise<PullFileRefusalV1 | null> {
  if (surface.listPullFiles === undefined) return null;
  let paths: readonly string[] | null = null;
  try {
    paths = await surface.listPullFiles(pull);
  } catch {
    paths = null;
  }
  if (paths === null) return "protected_path_unverified";
  if (touchesTargetProtected(repository, paths.map((path) => ({ path })))) {
    return "protected_path";
  }
  if (gate.train === true && paths.some(ciExecutablePath)) {
    return "train_ci_executable";
  }
  // A head without its base cannot be compared: a CI change refuses.
  return gate.head === undefined ? null : await ciSuccessRefusal(
    surface,
    gate.base ?? null,
    gate.head,
    paths,
    gate.baseBranch,
  );
}

/** The launcher admission gate's closed refusals. */
export type SourceAdmissionRefusalV1 =
  | "issue_not_admitted"
  | "issue_author_unverified";

/**
 * Owner directive 2026-11-17 (`src/repair/issue-admission.ts`): Sentinel
 * merges an issue's work only when the issue's author is the owner account
 * (login and numeric id) or the Sentinel App. Read live with the
 * author-carrying read (`readIssueFacts`); a surface without it, an
 * unreadable or different issue refuses `issue_author_unverified` (no merge,
 * the record waits), another author `issue_not_admitted`. A record without a
 * source issue (an incident) is no issue's work and passes.
 */
export async function sourceAdmissionRefusal(
  surface: HostedAutonomyGitHubV1 | null,
  record: Pick<HostedAutonomyRecordV1, "related">,
): Promise<SourceAdmissionRefusalV1 | null> {
  const number = record.related.issueNumber;
  if (number === null) return null;
  const read = surface?.readIssueFacts;
  if (surface === null || read === undefined) return "issue_author_unverified";
  try {
    const issue = await read.call(surface, number);
    if (issue === null || issue.number !== number) {
      return "issue_author_unverified";
    }
    return issueAuthorAdmitted(issue) ? null : "issue_not_admitted";
  } catch {
    return "issue_author_unverified";
  }
}
