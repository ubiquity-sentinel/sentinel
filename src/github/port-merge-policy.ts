// port merge policy.

import type { GitHubRuleSetWireV1 } from "./wire.ts";
import type {
  GitHubCheckV1,
  MergeOutcomeV1,
  PortResultV1,
} from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  effectiveMergeMethodV1,
  type RepositoryMergeSettingsV1,
  squashCommitMessageV1,
  targetDeliveryPolicyV1,
} from "../contracts/target-delivery.ts";
import type { MergePullShapeV1 } from "./client-contracts.ts";
import type { GitHubEffectiveProtectionsV1 } from "./port-contracts.ts";
import { isGreenConclusion } from "../repair/ci-rejection.ts";

/**
 * Effective strict server-enforced protections required for a merge, from
 * the active branch rules: a pull_request rule and a strict
 * required_status_checks rule with a non-empty check list must be active,
 * no unsupported/merge-queue rule may be active, the pull_request rule must
 * not require something we cannot verify (thread resolution), and the
 * per-ruleset bypass policy must explicitly report `never` for the merging
 * credential with no bypass actors applied. Unprotected, unreadable,
 * unsupported, incomplete or bypassable policy blocks.
 */
export function evaluateEffectiveProtections(
  protections: GitHubEffectiveProtectionsV1,
): { ok: true } | { ok: false; reason: string } {
  if (protections.unsupportedRuleTypes.length > 0) {
    return {
      ok: false,
      reason: `unsupported active rules: ${
        protections.unsupportedRuleTypes.join(", ")
      }`,
    };
  }
  if (protections.mergeQueueActive) {
    return { ok: false, reason: "merge queue rules are active" };
  }
  if (!protections.strictRequiredChecks) {
    return { ok: false, reason: "strict up-to-date checks are not enforced" };
  }
  if (protections.requiredCheckNames.length === 0) {
    return { ok: false, reason: "no required status checks are bound" };
  }
  if (!protections.activeRuleTypes.includes("pull_request")) {
    return { ok: false, reason: "pull_request rule is not active" };
  }
  if (protections.pullRequestThreadResolutionRequired) {
    return {
      ok: false,
      reason: "required review thread resolution cannot be verified",
    };
  }
  if (protections.bypassUnknown) {
    return { ok: false, reason: "bypass policy is unknown" };
  }
  if (protections.bypassActors.length > 0) {
    return { ok: false, reason: "bypass actors are configured" };
  }
  return { ok: true };
}

/**
 * The protections record of a branch with no enforceable rules: what the
 * merge path uses when the target has none, or when they cannot be read.
 * Owner directive 2026-10-24: branch rules are not a merge requirement.
 */
export function noEffectiveProtections(
  branch: string,
): GitHubEffectiveProtectionsV1 {
  return {
    branch,
    activeRuleTypes: [],
    unsupportedRuleTypes: [],
    mergeQueueActive: false,
    requiredCheckNames: [],
    strictRequiredChecks: false,
    requiredApprovingReviewCount: 0,
    pullRequestThreadResolutionRequired: false,
    bypassUnknown: false,
    bypassActors: [],
  };
}

export function uniqueSorted(names: string[]): string[] {
  return [...new Set(names)].sort();
}

/**
 * Exact ruleset evidence match: the evidence must be the requested ruleset
 * (id) with the same source binding as the contributing rule (`source_type`
 * + `source`). Anything else is contradictory evidence, never proof of
 * active non-bypassable policy.
 */
export function ruleSetEvidenceMatches(
  evidence: GitHubRuleSetWireV1,
  ruleSetId: number,
  sourceType: "Repository" | "Organization",
  source: string,
): boolean {
  return evidence.id === ruleSetId &&
    evidence.sourceType === sourceType &&
    evidence.source === source;
}

export type RequiredChecksState = "pass" | "pending" | "failed";

/**
 * Exact-name required checks on the exact head: commit-status contexts and
 * check runs share the same required name space. A missing or not-completed
 * observation is pending; a completed non-green conclusion (failure,
 * timed_out, cancelled, action_required, stale) is failed; completed `success`,
 * `skipped` and `neutral` observations pass (owner directive 2026-10-24). GitHub returns historical observations for a
 * context, so only the newest observation (by its completion/start time) is
 * evaluated; an older pending or failed status must not override a newer pass.
 */
export function requiredChecksState(
  requiredNames: string[],
  checks: GitHubCheckV1[],
): RequiredChecksState {
  const latest = latestChecksByName(checks);
  let pending = false;
  for (const name of requiredNames) {
    const run = latest.get(name);
    if (run === undefined) {
      pending = true;
      continue;
    }
    if (run.status !== "completed" || run.conclusion === null) {
      pending = true;
      continue;
    }
    if (!isGreenConclusion(run.conclusion)) return "failed";
  }
  return pending ? "pending" : "pass";
}

/**
 * Collapse historical check observations to one current value per context.
 * Commit statuses are returned newest-first, while check runs expose explicit
 * timestamps; the timestamp provides the same rule across both APIs. Equal
 * timestamps keep the first observation, preserving GitHub's newest-first
 * ordering without inventing a tie-breaker.
 */
export function latestChecksByName(
  checks: GitHubCheckV1[],
): Map<string, GitHubCheckV1> {
  const latest = new Map<string, GitHubCheckV1>();
  for (const check of checks) {
    const previous = latest.get(check.name);
    if (
      previous === undefined ||
      checkObservationTime(check) > checkObservationTime(previous)
    ) {
      latest.set(check.name, check);
    }
  }
  return latest;
}

export function checkObservationTime(check: GitHubCheckV1): number {
  return check.completedAt ?? check.startedAt ?? -1;
}

/**
 * The exact published closing link of one pull request body: the single line
 * `Resolves #N` the trusted publisher writes for issue-backed work. A body
 * without that exact line (incident work, legacy or edited text) binds no
 * issue here; the link is evidence of WHICH issue to read, never fulfillment
 * evidence itself.
 */
export function closingIssueNumber(body: string | null): number | null {
  if (body === null) return null;
  const match = /^Resolves #([0-9]{1,10})$/m.exec(body);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value >= 1 ? value : null;
}

export function blocked(
  reason: Extract<MergeOutcomeV1, { outcome: "blocked" }>["reason"],
  head: GitSha | null,
): PortResultV1<MergeOutcomeV1> {
  // Bounded operational diagnostic: a fixed enum reason and an exact Git SHA
  // (or null) only; the returned outcome is unchanged.
  console.error(JSON.stringify({
    event: "sentinel_merge_blocked",
    reason,
    head,
  }));
  return portOk({ outcome: "blocked", reason, head });
}

/**
 * The exact shape of one merge call (#331): the trusted per-target policy,
 * squash only where the repository allows it (merge commits where it forbids
 * squash), with the pull request title and its `Resolves #N` line as the
 * squash commit. An invalid policy refuses with its precise reason; an
 * unreadable repository setting is the read's own retryable error. Neither
 * ever falls back to another method.
 */
export async function mergeShapeV1(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  policies: Readonly<Record<string, unknown>>,
  readSettings: () => Promise<PortResultV1<RepositoryMergeSettingsV1>>,
  title: string,
  issueNumber: number | null,
): Promise<PortResultV1<MergePullShapeV1>> {
  const policy = targetDeliveryPolicyV1(repository, policies);
  let settings: RepositoryMergeSettingsV1 | null = null;
  if (policy.ok && policy.policy.mergeMethod === "squash") {
    const read = await readSettings();
    if (!read.ok) return read;
    settings = read.value;
  }
  const method = effectiveMergeMethodV1(policy, settings);
  if (!method.ok) {
    console.error(JSON.stringify({
      event: "sentinel_merge_policy_refused",
      reason: method.reason,
    }));
    return portError("invalid", method.reason);
  }
  if (method.method === "merge") return portOk({ method: "merge" });
  return portOk({
    method: "squash",
    ...squashCommitMessageV1(title, issueNumber),
  });
}
