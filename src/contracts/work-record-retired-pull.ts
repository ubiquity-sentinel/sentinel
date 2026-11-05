/**
 * The retired-record pull-request settlement predicate, shared by the hosted
 * maintenance pass that closes Sentinel's own orphaned pull requests and the
 * repair-tier demotion rule that keeps such a record hot until it is settled.
 */
import type { WorkRecordV1 } from "./work-record-types.ts";

/**
 * The exact retirement blocker of a record whose source issue closed (the
 * same text as `HOSTED_AUTONOMY_RETIRED` and `RETIRED_TARGET_MESSAGE`).
 */
export const SOURCE_ISSUE_CLOSED_RETIREMENT =
  "source issue is closed; the repair no longer exists";

/** The branch prefix of every Sentinel repair candidate. */
export const SENTINEL_REPAIR_BRANCH_PREFIX = "sentinel/repair/";

/**
 * True for an issue record retired because its source issue closed while it
 * still binds a pull request on a Sentinel repair branch that no settlement
 * (`retiredPullClosure`) has been recorded for yet. Any other blocker, a
 * record without a pull request and a settled pull request are false.
 */
export function retiredPullClosurePending(
  record: Pick<
    WorkRecordV1,
    "source" | "nextStep" | "blocker" | "target" | "retiredPullClosure"
  >,
): boolean {
  const pr = record.target.pr;
  const branch = record.target.branch;
  return record.source.kind === "issue" &&
    record.nextStep === "blocked" &&
    record.blocker?.kind === "other" &&
    record.blocker.message === SOURCE_ISSUE_CLOSED_RETIREMENT &&
    pr !== null &&
    branch !== null &&
    branch.startsWith(SENTINEL_REPAIR_BRANCH_PREFIX) &&
    record.retiredPullClosure?.pr !== pr;
}
