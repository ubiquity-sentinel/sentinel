/**
 * The delivery step's decision once a reviewed head's base moved before it
 * merged (`ensureBaseRefreshIntent` observed the new tip; nothing is written
 * yet):
 *
 * - no review round left (the hard ceiling): the refreshed head could never
 *   be reviewed, so nothing is refreshed. The head's own required CI is read
 *   first, through the merge gate's own CI gate: a red head parks with the
 *   merge gate's precise `CI checks failed: ...` blocker (never charged, and
 *   the owner's one-time legacy class predicate sees it), pending CI waits at
 *   `delivery`, and only a green head parks BASE_MOVED, the reviewed head
 *   kept for the owner-gated moved-base merge;
 * - a round left: the line decides (`deliveryQueueAhead`). While another
 *   reviewed record of the repository goes first, the step defers with
 *   nothing written or charged; at the front of the line the refresh
 *   proceeds.
 *
 * Every shape written is one generation 79 already writes and parses itself
 * (`ci_pending` wait, merge-gate CI block, the ceiling park).
 */
import type { GitSha } from "../contracts/brands.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { deliveryQueueAhead } from "./delivery-queue.ts";
import { gateDeliveryOnChecks } from "./loop-checks.ts";
import { parkAtReviewRoundCeiling } from "./loop-review-round-cap.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { REVIEW_ROUND_CEILING_BASE_MOVED } from "./review-round-cap.ts";

/** Detail prefix of a delivery step deferred behind another record. */
export const DELIVERY_QUEUE_DEFERRED_PREFIX = "delivery queue: ";

/**
 * The spent record's park on a moved base: a red head keeps the merge gate's
 * own CI blocker, pending CI waits, a green head parks BASE_MOVED. `parked`
 * is the record to persist (the caller may have cleared a stale merge intent).
 */
export async function parkSpentOnMovedBase(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  parked: WorkRecordV1,
): Promise<StepResultV1> {
  const gated = await gateDeliveryOnChecks(
    deps,
    context,
    parked,
    deps.clock.now(),
    "attribute",
  );
  if (gated !== null) return gated;
  return parkAtReviewRoundCeiling(
    deps,
    context,
    parked,
    REVIEW_ROUND_CEILING_BASE_MOVED,
  );
}

/**
 * Null when `record` (a round left, its base moved to `tip`) is at the front
 * of its repository's delivery line and may refresh; otherwise the deferral.
 */
export function deliveryQueueDeferral(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  tip: GitSha,
): StepResultV1 | null {
  const ahead = deliveryQueueAhead(
    context.snapshot,
    record,
    tip,
    deps.clock.now(),
  );
  return ahead === null ? null : {
    kind: "deferred",
    detail: `${DELIVERY_QUEUE_DEFERRED_PREFIX}${ahead.id} goes first`,
  };
}
