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
 * The line is ordered by delivery readiness, then age (`createdAt`, then id):
 * a spent record is held only by a contender landing on the tip, the head of
 * the line in flight (its refresh, or the head it refreshed onto the tip, on
 * its way to its CI and review, sentinel #329) or a deliverable one ahead of
 * it (`delivery-queue.ts`), so only the head of the line ever refreshes and a
 * waiting record keeps its reviewed head and base. The line writes nothing,
 * so it adds no state shape: generation 80, the rollback target, holds every
 * other record behind a refresh this line admitted, as it does its own.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { deliveryQueueAhead, deliveryTrainHold } from "./delivery-queue.ts";
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
  // An open delivery train of this repository (sentinel #330) lands its
  // members on one CI run: no member's head is refreshed under it, and no
  // other record refreshes onto a tip the train is about to move.
  const train = deliveryTrainHold(context.deliveryTrainHolds ?? [], record);
  if (train !== null) {
    return {
      kind: "deferred",
      detail: `${DELIVERY_QUEUE_DEFERRED_PREFIX}train ${train.operationId} ${
        train.members.includes(record.id) ? "lands it" : "goes first"
      }`,
    };
  }
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
