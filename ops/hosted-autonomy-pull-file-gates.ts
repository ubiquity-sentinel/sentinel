/**
 * The launcher merge gates that read what a pull request changes (issue #158
 * item 2 and the owner directive of 2026-11-17, "give sentinel full access"):
 *
 * - a change Sentinel never merges on its own (`sentinelNeverMerges`: a
 *   credential path on any target, or a protected path of Sentinel's own
 *   repository) refuses `protected_path`;
 * - a change to a CI-executable path (`ciExecutablePath`: anything under
 *   `.github/`) is judged by its own modified workflow, whose jobs may all be
 *   skipped or neutral and still read as green, so it merges only when its
 *   exact head carries a job its own CI ran to `success`
 *   (`hasTargetCiSuccess`; a backup-CI stand-in never counts, since it runs
 *   the same modified workflow from the merge tree), else
 *   `ci_success_required`;
 * - a delivery train never carries such a change (`train_ci_executable`): the
 *   member keeps the per-record path, which applies the rule above.
 *
 * An unreadable listing or success read refuses; a fixture surface without
 * the file listing skips these gates.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { createLocalRepositoryConfig } from "../src/host/local-config.ts";
import { selectTrustedTargetPolicyV1 } from "../src/host/target-policy.ts";
import { sentinelNeverMerges } from "../src/repair/owner-landing.ts";
import { ciExecutablePath } from "../src/repair/workflow-trust.ts";
import type { HostedTreeChangeV1 } from "./hosted-autonomy-github-trees.ts";
import type { HostedAutonomyGitHubV1 } from "./hosted-autonomy-types.ts";

/** A launcher merge never lands a change Sentinel never merges itself. */
export function touchesTargetProtected(
  repository: RepositoryIdentityV1,
  changes: readonly Pick<HostedTreeChangeV1, "path">[],
): boolean {
  try {
    const policy = selectTrustedTargetPolicyV1(
      createLocalRepositoryConfig(),
      repository,
    );
    return sentinelNeverMerges(
      policy,
      repository,
      changes.map((change) => change.path),
    );
  } catch {
    return true;
  }
}

/**
 * `ci_success_required` unless the exact head carries a job its own CI ran
 * to success, when `paths` change a CI-executable path; null otherwise.
 */
export async function ciSuccessRefusal(
  surface: HostedAutonomyGitHubV1,
  head: string,
  paths: readonly string[],
): Promise<"ci_success_required" | null> {
  if (!paths.some(ciExecutablePath)) return null;
  let success: boolean | null = null;
  try {
    success = await surface.hasTargetCiSuccess?.(head) ?? null;
  } catch {
    success = null;
  }
  return success === true ? null : "ci_success_required";
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
  gate: { readonly head?: string; readonly train?: boolean } = {},
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
  return gate.head === undefined
    ? null
    : await ciSuccessRefusal(surface, gate.head, paths);
}
