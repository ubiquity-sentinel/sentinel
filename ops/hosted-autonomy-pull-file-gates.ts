/**
 * The launcher merge gates that read what a pull request changes (issue #158
 * item 2 and the owner directive of 2026-11-17, "give sentinel full access"):
 *
 * - a change Sentinel never merges on its own (`sentinelNeverMerges`: a
 *   credential path on any target, or a protected path of Sentinel's own
 *   repository) refuses `protected_path`;
 * - a change to a CI-executable path (`ciExecutablePath`: anything under
 *   `.github/`, and any path it cannot classify) is judged by its own
 *   modified workflow, whose jobs may all be skipped or neutral and still
 *   read as green, or which may drop the real tests for a trivial job, so it
 *   merges only when every job name GitHub Actions ran to `success` on the
 *   base also ran to `success` on the exact head (at least one job when the
 *   base has none; `targetCiSuccessNames`: never a status, a backup-CI
 *   stand-in or another app's check), else `ci_success_required`. This gate
 *   alone holds such a head: it survives a runtime rollback;
 * - a delivery train never carries such a change (`train_ci_executable`): the
 *   member keeps the per-record path, which applies the rule above.
 *
 * An unreadable listing or success read refuses; a fixture surface without
 * the file listing skips these gates.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { neverMergedChange } from "../src/github/merge-content-gate.ts";
import {
  GITHUB_ACTIONS_APP_SLUG,
  isCiEvidenceSource,
} from "../src/repair/merge-gate-checks.ts";
import { ciExecutablePath } from "../src/repair/workflow-trust.ts";
import { SENTINEL_BACKUP_FIELD } from "./hosted-autonomy-backup-ci-read.ts";
import type { HostedTreeChangeV1 } from "./hosted-autonomy-github-trees.ts";
import type { HostedAutonomyGitHubV1 } from "./hosted-autonomy-types.ts";

/** A launcher merge never lands a change Sentinel never merges itself. */
export function touchesTargetProtected(
  repository: RepositoryIdentityV1,
  changes: readonly Pick<HostedTreeChangeV1, "path">[],
): boolean {
  return neverMergedChange(repository, changes.map((change) => change.path));
}

/**
 * The job names GitHub Actions ran to `success` among one commit's complete
 * gating check runs (`targetCiSuccessNames`), exactly as the runtime reads
 * them (`ci-success-rule.ts`): the latest run of each name (by start, else
 * completion, time; the first listed on a tie), counted only when it is a
 * GitHub Actions run completed `success`, never a backup-CI stand-in, a
 * commit status, a review bot or another app's check; sorted. The adapter
 * only lists the runs; this verdict lives with the gate that reads it.
 */
export function actionsSuccessNames(
  runs: readonly Record<string, unknown>[],
): string[] {
  const time = (run: Record<string, unknown>) => {
    const at = Date.parse(String(run["started_at"] ?? run["completed_at"]));
    return Number.isFinite(at) ? at : -1;
  };
  const latest = new Map<string, Record<string, unknown>>();
  for (const run of runs) {
    const name = String(run["name"]);
    const prior = latest.get(name);
    if (prior === undefined || time(run) > time(prior)) latest.set(name, run);
  }
  return [...latest.values()].filter((run) => {
    const app = run["app"];
    const slug = app !== null && typeof app === "object" && !Array.isArray(app)
      ? (app as Record<string, unknown>)["slug"]
      : undefined;
    return slug === GITHUB_ACTIONS_APP_SLUG &&
      run[SENTINEL_BACKUP_FIELD] === undefined &&
      isCiEvidenceSource(slug, String(run["name"])) &&
      run["status"] === "completed" && run["conclusion"] === "success";
  }).map((run) => String(run["name"])).sort();
}

/**
 * `ci_success_required` unless every job name GitHub Actions ran to success
 * on `base` also ran to success on `head` (at least one when `base` has
 * none), when `paths` change a CI-executable path; null otherwise. An
 * unreadable listing, or no base to compare with, refuses.
 */
export async function ciSuccessRefusal(
  surface: HostedAutonomyGitHubV1,
  base: string | null,
  head: string,
  paths: readonly string[],
): Promise<"ci_success_required" | null> {
  if (!paths.some(ciExecutablePath)) return null;
  if (base === null) return "ci_success_required";
  let passed: readonly string[] | null = null;
  let expected: readonly string[] | null = null;
  try {
    passed = await surface.targetCiSuccessNames?.(head) ?? null;
    expected = passed === null
      ? null
      : await surface.targetCiSuccessNames?.(base) ?? null;
  } catch {
    passed = null;
  }
  if (passed === null || expected === null) return "ci_success_required";
  const satisfied = expected.length === 0
    ? passed.length > 0
    : expected.every((name) => passed!.includes(name));
  return satisfied ? null : "ci_success_required";
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
  return gate.head === undefined
    ? null
    : await ciSuccessRefusal(surface, gate.base ?? null, gate.head, paths);
}
