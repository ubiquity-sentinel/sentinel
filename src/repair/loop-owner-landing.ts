/**
 * Repair loop internals: the delivery of an owner-landing record (a published
 * candidate that changes a protected path; see `owner-landing.ts`). Sentinel
 * never merges it. Its delivery step reads the pull request: a merge by
 * anyone else completes the record through the ordinary human-merge path, a
 * closed pull request parks it, and an open one goes through the unchanged
 * review and CI merge gates, which end in the owner wait instead of a merge.
 */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { completeHumanMerge } from "./human-merge.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { executeMerge } from "./loop-merge.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { causedWait } from "./loop-wait-cause.ts";
import { OWNER_MERGE_WAIT_CAUSE, ownerMergeWait } from "./owner-landing.ts";
import { markTerminalBlocked, setWait } from "./transitions.ts";

/**
 * The end of every merge gate of an owner-landing record: a reviewed,
 * CI-green head waits for its owner's merge and re-reads its pull request
 * after the owner poll. No merge intent is ever written.
 */
export function parkForOwnerMerge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  now: number,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    setWait(
      record,
      causedWait(deps, ownerMergeWait(record, now), OWNER_MERGE_WAIT_CAUSE),
      now,
    ),
  );
}

/** The delivery step of an owner-landing record without an intent. */
export async function ownerLandingDelivery(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  const read = await deps.github.readPullRequest(record.target.pr!);
  const at = deps.clock.now();
  if (!read.ok || read.value === null) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
        at,
      ),
    );
  }
  const pull = read.value;
  if (pull.state === "merged") {
    if (pull.mergeSha === null) {
      return {
        kind: "deferred",
        detail: "merged pull request observation has no merge SHA",
      };
    }
    // A foreign pull or branch is an identity contradiction, not a human
    // merge of this record's publication (as in merge reconciliation).
    if (
      pull.number !== record.target.pr || pull.headRef !== record.target.branch
    ) {
      return persistWork(
        deps,
        context,
        markTerminalBlocked(
          record,
          "other",
          "observed merged head identity mismatch",
          at,
        ),
      );
    }
    return completeHumanMerge(deps, context, record, pull, pull.mergeSha);
  }
  if (pull.state === "closed") {
    return persistWork(
      deps,
      context,
      markTerminalBlocked(
        record,
        "other",
        "pull request closed before merge",
        at,
      ),
    );
  }
  return executeMerge(deps, context, record);
}
