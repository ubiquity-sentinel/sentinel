/**
 * The launcher's merge call shape (#331): the trusted per-target delivery
 * policy (`src/contracts/target-delivery.ts`), squash only where the target
 * repository allows it, merge commits where it forbids squash. A squash
 * commit is the pull request title with its `Resolves #N` line (a carried
 * merge's plain evidence follows after a blank line). The reviewed head is
 * the merge input under the expected-head guard (`sha`) for every method.
 *
 * Any unreadable fact or invalid policy value yields null: the launcher
 * refuses the merge for this pass (`merge_refused`) and never falls back to
 * another method.
 */
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  effectiveMergeMethodV1,
  type RepositoryMergeSettingsV1,
  squashCommitMessageV1,
  TARGET_DELIVERY_POLICIES,
  targetDeliveryPolicyV1,
} from "../src/contracts/target-delivery.ts";
import { closingIssueNumber } from "../src/github/port-merge-policy.ts";

type HostedRequest = (
  method: string,
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown | null>;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** `GET /repos/{o}/{n}` merge settings, or null when unreadable. */
export function parseRepositoryMergeSettings(
  raw: unknown,
): RepositoryMergeSettingsV1 | null {
  const repo = record(raw);
  if (
    repo === null || typeof repo["allow_squash_merge"] !== "boolean" ||
    typeof repo["allow_merge_commit"] !== "boolean"
  ) return null;
  return {
    allowSquashMerge: repo["allow_squash_merge"],
    allowMergeCommit: repo["allow_merge_commit"],
  };
}

/** The exact `PUT /pulls/{n}/merge` body for one pull, or null to refuse. */
export async function hostedMergeBody(
  request: HostedRequest,
  repository: Pick<RepositoryIdentityV1, "owner" | "name">,
  number: number,
  head: string,
  evidence?: string,
  policies: Readonly<Record<string, unknown>> = TARGET_DELIVERY_POLICIES,
): Promise<Record<string, unknown> | null> {
  const scope = `${repository.owner}/${repository.name}`;
  const policy = targetDeliveryPolicyV1(repository, policies);
  let settings: RepositoryMergeSettingsV1 | null = null;
  if (policy.ok && policy.policy.mergeMethod === "squash") {
    settings = parseRepositoryMergeSettings(
      await request("GET", `/repos/${scope}`),
    );
  }
  const method = effectiveMergeMethodV1(policy, settings);
  if (!method.ok) {
    console.error(JSON.stringify({
      event: "sentinel_merge_policy_refused",
      reason: method.reason,
    }));
    return null;
  }
  if (method.method === "merge") {
    return evidence === undefined
      ? { sha: head, merge_method: "merge" }
      : { sha: head, merge_method: "merge", commit_message: evidence };
  }
  const pull = record(await request("GET", `/repos/${scope}/pulls/${number}`));
  const pullHead = record(pull?.["head"])?.["sha"];
  const title = pull?.["title"];
  const body = pull?.["body"];
  if (
    pull === null || pullHead !== head || typeof title !== "string" ||
    title.length === 0 || (body !== null && typeof body !== "string")
  ) return null;
  const text = squashCommitMessageV1(
    title,
    closingIssueNumber(body),
    evidence,
  );
  return {
    sha: head,
    merge_method: "squash",
    commit_title: text.title,
    commit_message: text.message,
  };
}

/**
 * The trees a squash landing proof needs (#331), read only for a merge
 * commit with a single parent: the merge commit's tree and the pull head's
 * tree. Null for either fact when it cannot be read.
 */
export async function readSquashTrees(
  request: HostedRequest,
  scope: string,
  mergeCommit: unknown,
  head: string,
): Promise<{ mergeTree: string | null; headTree: string | null }> {
  const treeOf = (commit: unknown): string | null => {
    const tree = record(record(record(commit)?.["commit"])?.["tree"])?.["sha"];
    return typeof tree === "string" && /^[0-9a-f]{40}$/.test(tree)
      ? tree
      : null;
  };
  return {
    mergeTree: treeOf(mergeCommit),
    headTree: treeOf(await request("GET", `/repos/${scope}/commits/${head}`)),
  };
}
