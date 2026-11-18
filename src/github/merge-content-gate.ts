/**
 * The merge executors' own content gate (2026-11-17): no single caller is
 * the only barrier between a model-written change and a merge.
 * - Sentinel never merges a change it must not (`sentinelNeverMerges`: a
 *   credential path covered by a configured protected prefix on any target,
 *   any protected or `.github/` path of Sentinel's own repository, or a path
 *   no predicate can classify): `protection_required`.
 * - A change to a CI-executable path merges only when every job name GitHub
 *   Actions ran to `success` on the base also ran to `success` on the exact
 *   head (at least one when the base has none; `decideCiGate` with
 *   `requireSuccess`): otherwise `checks_pending`.
 * The change set is one exact `base...head` comparison read at merge time;
 * an unreadable or possibly truncated one refuses `checks_pending` (the
 * merge retries, never lands unproven). Sentinel's own pull requests change
 * at most the publication bound of paths, far below the comparison's limit.
 */
import type { GitSha } from "../contracts/brands.ts";
import type {
  GitHubChecksV1,
  GitHubCheckV1,
  PortResultV1,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { createLocalRepositoryConfig } from "../host/local-config.ts";
import { selectTrustedTargetPolicyV1 } from "../host/target-policy.ts";
import { decideCiGate } from "../repair/loop-checks.ts";
import { sentinelNeverMerges } from "../repair/owner-landing.ts";
import { ciExecutablePath } from "../repair/workflow-trust.ts";

export interface MergeContentReadsV1 {
  readChangedPaths(
    base: GitSha,
    head: GitSha,
  ): Promise<PortResultV1<string[] | null>>;
  readChecks(head: GitSha): Promise<PortResultV1<GitHubChecksV1>>;
}

/**
 * Whether Sentinel must never merge this change set on `repository`
 * (`sentinelNeverMerges` under the repository's trusted policy); a policy
 * that cannot be selected refuses.
 */
export function neverMergedChange(
  repository: RepositoryIdentityV1,
  paths: readonly string[],
): boolean {
  try {
    return sentinelNeverMerges(
      selectTrustedTargetPolicyV1(createLocalRepositoryConfig(), repository),
      repository,
      paths,
    );
  } catch {
    return true;
  }
}

/** Null when the merge may proceed; otherwise its blocked reason. */
export async function mergeContentRefusal(
  reads: MergeContentReadsV1,
  repository: RepositoryIdentityV1,
  base: GitSha,
  head: GitSha,
  headChecks: GitHubCheckV1[],
): Promise<"protection_required" | "checks_pending" | null> {
  let paths: string[] | null = null;
  try {
    const read = await reads.readChangedPaths(base, head);
    paths = read.ok ? read.value : null;
  } catch {
    paths = null;
  }
  if (paths === null) return "checks_pending";
  if (neverMergedChange(repository, paths)) return "protection_required";
  if (!paths.some(ciExecutablePath)) return null;
  const baseChecks = await reads.readChecks(base);
  if (!baseChecks.ok || baseChecks.value.head !== base) return "checks_pending";
  return decideCiGate(headChecks, repository, {
      requireSuccess: true,
      baseChecks: baseChecks.value.checks,
    }) === "proceed"
    ? null
    : "checks_pending";
}
