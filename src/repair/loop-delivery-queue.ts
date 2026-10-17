/**
 * The delivery step's line decision once a reviewed head's base moved before
 * it merged (`ensureBaseRefreshIntent` observed the new tip; nothing is
 * written yet): while another reviewed record of the repository goes first
 * (`deliveryQueueAhead`), the step defers with nothing written or charged; at
 * the front of the line the refresh proceeds. A record with a round left
 * refreshes for its next review; a spent record whose latest review
 * authorizes its head refreshes mechanically and carries that review
 * (`loop-carried-delivery.ts`, which decides that and parks every other spent
 * record).
 *
 * The line writes nothing, so it adds no state shape: generation 79, the
 * rollback target, refreshes every such record at once exactly as before.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { deliveryQueueAhead } from "./delivery-queue.ts";
import { legacyCutoff } from "./loop-review-round-cap.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";

/** Detail prefix of a delivery step deferred behind another record. */
export const DELIVERY_QUEUE_DEFERRED_PREFIX = "delivery queue: ";

/**
 * Null when `record` (its base moved to `tip`) is at the front of its
 * repository's delivery line and may refresh; otherwise the deferral.
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
    legacyCutoff(context),
  );
  return ahead === null ? null : {
    kind: "deferred",
    detail: `${DELIVERY_QUEUE_DEFERRED_PREFIX}${ahead.id} goes first`,
  };
}
