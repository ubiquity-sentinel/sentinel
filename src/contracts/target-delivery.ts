/**
 * Trusted per-target delivery policy (#331): how an accepted Sentinel pull
 * request lands on its target's default branch.
 *
 * `squash` keeps the deterministic base-refresh and conflict-resolution
 * commits of a Sentinel branch off the default branch: the branch collapses
 * into one commit titled by the pull request with its `Resolves #N` line.
 * `merge` keeps a two-parent merge commit. The policy lives here, in trusted
 * code; `sentinel.targets.json` stays a slug list and never selects it. The
 * reviewed head is still the merge input under the expected-head guard: only
 * the shape of the resulting default-branch commit changes.
 *
 * A configured value that is not exactly one of the two methods is refused
 * with a precise reason (the merge is not attempted); it never falls back.
 */
import type { RepositoryIdentityV1 } from "./shared.ts";

export type TargetMergeMethodV1 = "squash" | "merge";

export interface TargetDeliveryPolicyV1 {
  readonly mergeMethod: TargetMergeMethodV1;
}

/** The default for every target without an explicit row. */
export const DEFAULT_TARGET_DELIVERY_POLICY: TargetDeliveryPolicyV1 = {
  mergeMethod: "squash",
};

/**
 * Explicit per-target rows, keyed by lower-case `owner/name`. A target that
 * forbids squash merges needs no row: its repository setting
 * (`allow_squash_merge: false`) keeps merge commits (`effectiveMergeMethodV1`).
 * Values are validated at use, so a malformed row fails closed.
 */
export const TARGET_DELIVERY_POLICIES: Readonly<Record<string, unknown>> = {};

export type TargetDeliveryPolicyResultV1 =
  | { readonly ok: true; readonly policy: TargetDeliveryPolicyV1 }
  | { readonly ok: false; readonly reason: string };

/** Strict parse of one policy row; any other shape is refused. */
export function parseTargetDeliveryPolicyV1(
  value: unknown,
): TargetDeliveryPolicyResultV1 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "target delivery policy is not an object" };
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "mergeMethod") {
    return {
      ok: false,
      reason: "target delivery policy must carry exactly mergeMethod",
    };
  }
  const method = (value as Record<string, unknown>).mergeMethod;
  if (method !== "squash" && method !== "merge") {
    return {
      ok: false,
      reason: 'target delivery policy mergeMethod must be "squash" or "merge"',
    };
  }
  return { ok: true, policy: { mergeMethod: method } };
}

/** The trusted delivery policy of one exact repository identity. */
export function targetDeliveryPolicyV1(
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  table: Readonly<Record<string, unknown>> = TARGET_DELIVERY_POLICIES,
): TargetDeliveryPolicyResultV1 {
  const key = `${repository.owner}/${repository.name}`.toLowerCase();
  if (!Object.hasOwn(table, key)) {
    return { ok: true, policy: DEFAULT_TARGET_DELIVERY_POLICY };
  }
  return parseTargetDeliveryPolicyV1(table[key]);
}

/** The repository merge settings GitHub reports (`GET /repos/{o}/{n}`). */
export interface RepositoryMergeSettingsV1 {
  readonly allowSquashMerge: boolean;
  readonly allowMergeCommit: boolean;
}

export type EffectiveMergeMethodV1 =
  | { readonly ok: true; readonly method: TargetMergeMethodV1 }
  | { readonly ok: false; readonly reason: string };

/**
 * The method one merge call uses: the policy's `squash` only where the
 * repository allows squash merges, merge commits where it forbids them. An
 * unreadable setting refuses the squash policy (the next pass re-reads); a
 * `merge` policy needs no setting.
 */
export function effectiveMergeMethodV1(
  policy: TargetDeliveryPolicyResultV1,
  settings: RepositoryMergeSettingsV1 | null,
): EffectiveMergeMethodV1 {
  if (!policy.ok) return { ok: false, reason: policy.reason };
  if (policy.policy.mergeMethod === "merge") {
    return { ok: true, method: "merge" };
  }
  if (settings === null) {
    return {
      ok: false,
      reason: "repository squash merge setting is unavailable",
    };
  }
  return { ok: true, method: settings.allowSquashMerge ? "squash" : "merge" };
}

/**
 * The exact squash commit: the pull request title, and the `Resolves #N` line
 * of issue-backed work as the body (empty for incident work). Further plain
 * evidence lines (a carried merge's proof) follow after a blank line.
 */
export function squashCommitMessageV1(
  title: string,
  issueNumber: number | null,
  evidence?: string,
): { readonly title: string; readonly message: string } {
  const lines = issueNumber === null ? [] : [`Resolves #${issueNumber}`];
  if (evidence !== undefined && evidence.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(evidence);
  }
  return { title, message: lines.join("\n") };
}
