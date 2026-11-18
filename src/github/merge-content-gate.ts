/**
 * The merge executors' own content gate (2026-11-17): no single caller is
 * the only barrier between a model-written change and a merge.
 * - Sentinel never merges a change it must not (`sentinelNeverMerges`: a
 *   credential path covered by a configured protected prefix on any target,
 *   any protected or `.github/` path of Sentinel's own repository, or a path
 *   no predicate can classify): `protection_required`.
 * - A change to a CI-executable path merges only when its GitHub Actions
 *   success names meet the expectation read from the base branch's merged
 *   pull requests (`ci-success-rule.ts`; unreadable: never): otherwise
 *   `checks_pending`.
 * The change set is the port's `readChangedPaths`: the local mirror's tree
 * diff when it holds both commits (always so for a head Sentinel published
 * from, or cloned into, this run's mirror: no API read), else one exact
 * comparison. Only a head neither can list whole is held (`checks_pending`,
 * the bounded `ci_pending` wait): it may change CI. Sentinel's own pull
 * requests change at most the publication bound of paths, far below the
 * comparison's limit.
 */
import type { GitSha } from "../contracts/brands.ts";
import type {
  GitHubChecksV1,
  GitHubCheckV1,
  MergedPullHeadsV1,
  PortResultV1,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { createLocalRepositoryConfig } from "../host/local-config.ts";
import { selectTrustedTargetPolicyV1 } from "../host/target-policy.ts";
import { decideCiGate } from "../repair/loop-checks.ts";
import {
  readCiExpectation,
  runtimeCiReferenceReads,
} from "../repair/ci-success-rule.ts";
import { sentinelNeverMerges } from "../repair/owner-landing.ts";
import { ciExecutablePath } from "../repair/workflow-trust.ts";

export interface MergeContentReadsV1 {
  readChangedPaths(
    base: GitSha,
    head: GitSha,
  ): Promise<PortResultV1<string[] | null>>;
  readChecks(head: GitSha): Promise<PortResultV1<GitHubChecksV1>>;
  readMergedPullHeads?(
    baseRef: string,
  ): Promise<PortResultV1<MergedPullHeadsV1>>;
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

/**
 * Null when the merge may proceed; otherwise its blocked reason. `baseRef`
 * is the pull request's base branch, whose merged pull requests are the CI
 * rule's reference.
 */
export async function mergeContentRefusal(
  reads: MergeContentReadsV1,
  repository: RepositoryIdentityV1,
  base: GitSha,
  head: GitSha,
  headChecks: GitHubCheckV1[],
  baseRef?: string,
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
  const expectation = await readCiExpectation(
    runtimeCiReferenceReads(reads, repository, baseRef),
    base,
  );
  return decideCiGate(headChecks, repository, {
      requireSuccess: true,
      expectation,
    }) === "proceed"
    ? null
    : "checks_pending";
}
