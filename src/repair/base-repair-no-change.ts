/**
 * A base-repair task's no-change hold (2026-11-17, ai.ubq.fi 1370). The hold
 * ends only through a base review, which starts only on green CI at the
 * exact base, and a base-repair task's base is red by construction. When the
 * review cannot start for that reason (`BASE_REVIEW_CI_NOT_GREEN`), the hold
 * takes the ordinary no-change retry instead, under the existing bounds:
 * below `MAX_NO_CHANGE_BASE_REVIEWS` no-change outcomes of the issue
 * (`issueNoChangeOutcomes`, from attempt memory) and while the next start has
 * a new input (`identicalAttemptRefusalV1` would admit it), the record
 * returns to implementation, uncharged; that start is admitted and charged by
 * the ordinary gates and carries its red base's CI evidence
 * (`baseRepairStartFinding`). At the bound, or with no new input, it parks
 * with `BASE_REPAIR_NO_CHANGE_DETAIL`, uncharged. No state is added.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { BASE_REPAIR_NO_CHANGE_DETAIL } from "./base-repair.ts";
import {
  issueNoChangeOutcomes,
  MAX_NO_CHANGE_BASE_REVIEWS,
} from "./base-satisfaction-marker.ts";
import { identicalAttemptRefusalV1 } from "./identical-attempt.ts";
import { markBlocked } from "./transitions.ts";

/**
 * The next shape of base-repair `record`, held after a no-change outcome,
 * once its base review met `base` not green: the ordinary retry (back to
 * implementation, no intent, no wait) or the park. The retry's inputs are
 * judged at `base`, which its start refreshes to, under `runtimeSha`.
 */
export function baseRepairNoChangeNext(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  base: GitSha,
  runtimeSha: GitSha,
  now: number,
): WorkRecordV1 {
  const retry: WorkRecordV1 = {
    ...record,
    nextStep: "work",
    blocker: null,
    wait: null,
    intent: null,
    updatedAt: now,
  };
  const repeat = identicalAttemptRefusalV1(
    snapshot,
    { ...retry, target: { ...retry.target, base } },
    runtimeSha,
  );
  return repeat === null &&
      issueNoChangeOutcomes(snapshot, record) < MAX_NO_CHANGE_BASE_REVIEWS
    ? retry
    : markBlocked(record, "other", BASE_REPAIR_NO_CHANGE_DETAIL, now);
}
