/**
 * Repair loop internals: a merge is booked only on exactly its reviewed base.
 *
 * GitHub's merge API guards only the head, and branch rules no longer gate a
 * merge (owner directive 2026-10-24), so a base that moved between the review
 * and the merge makes the merged tree one no CI ran on (live 2026-10-24:
 * Passport PRs 154 and 171). The REST merge makes a merge commit, so a merge
 * is the reviewed tree only when that commit's parents are exactly [reviewed
 * base, reviewed head]; the port refuses a moved base before the call
 * (`base_mismatch`) and reports any other landing as `merged_off_tip`.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { MergeOutcomeV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { isNativeQueueTarget } from "../github/native-queue-guard.ts";
import {
  QUEUE_MODE_CEILING,
  QUEUE_PROOF_ACTIVATED,
} from "../github/queue-runtime-policy.ts";
import type { RepairCycleDepsV1 } from "./loop-types.ts";

/** Park message prefix of a merge that landed off its reviewed base. */
export const MERGED_OFF_TIP_PREFIX = "the merge landed off its reviewed base: ";

type OffTipOutcome = Extract<MergeOutcomeV1, { outcome: "merged_off_tip" }>;

/**
 * Whether a merge observed on `repository` may be the native queue's own
 * merge, which has the queue's parents and keeps its own proof: only on a
 * native queue target while the queue can merge or its delivery proof is
 * activated. With both off (the shipped configuration) Sentinel merges there
 * through the REST path like anywhere else, so the parents are checked
 * (stage-1 review, 2026-10-25: a lost response after an off-tip merge was
 * otherwise booked).
 */
export function queueMayHaveMerged(
  repository: WorkRecordV1["repository"],
): boolean {
  return isNativeQueueTarget(repository) &&
    (QUEUE_MODE_CEILING !== "off" || QUEUE_PROOF_ACTIVATED);
}

/** True only for a merge commit on exactly [base, head]. */
export function mergedExactlyOnBase(
  parents: readonly GitSha[],
  base: GitSha,
  head: GitSha,
): boolean {
  return parents.length === 2 && parents[0] === base && parents[1] === head;
}

/** The fixed park message naming the merge, its parents and the expected pair. */
export function mergedOffTipMessage(
  outcome: OffTipOutcome,
  base: GitSha,
): string {
  return `${MERGED_OFF_TIP_PREFIX}merge ${outcome.mergeSha} has parents ${
    outcome.parents.join(",") || "none"
  }, not ${base},${outcome.head}`;
}

/**
 * How a pull request the loop observed merged (merge-intent reconciliation)
 * landed: the bookable `merged` outcome on exactly [reviewed base, head], the
 * `merged_off_tip` outcome otherwise, or `unavailable` when the merge commit
 * cannot be read (a bounded wait; never booked unproven). A merge the native
 * queue may have made (`queueMayHaveMerged`) and a host without the read
 * capability keep the observed merge as before.
 */
export async function observedMergeLanding(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  head: GitSha,
  mergeSha: GitSha,
): Promise<MergeOutcomeV1 | "unavailable"> {
  const merged: MergeOutcomeV1 = { outcome: "merged", head, mergeSha };
  const read = deps.github.readCommitParents;
  if (read === undefined || queueMayHaveMerged(record.repository)) {
    return merged;
  }
  let parents;
  try {
    parents = await read.call(deps.github, mergeSha);
  } catch {
    return "unavailable";
  }
  if (!parents.ok || parents.value === null) return "unavailable";
  return mergedExactlyOnBase(parents.value, record.target.base, head)
    ? merged
    : { outcome: "merged_off_tip", head, mergeSha, parents: parents.value };
}
