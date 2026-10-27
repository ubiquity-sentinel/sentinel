/** Shared, state-free ordering of published CI validation and base refresh. */
import type { GitSha } from "../contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { isRedBaseHold, PRE_REVIEW_CI_BOUND_MS } from "./ci-first-policy.ts";
import {
  DELIVERY_QUEUE_IDLE_MS,
  DELIVERY_QUEUE_STALL_LIMIT,
  deliveryQueueAhead,
} from "./delivery-queue.ts";
import {
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import type { LegacyCutoff } from "./review-round-cap.ts";

type Snapshot = Pick<
  RepairStateSnapshotV1,
  "work" | "reviews" | "reservations" | "releaseRequests"
>;

/** A published identity, never an unpublished or superseded candidate. */
export function publishedCiCandidate(record: WorkRecordV1): boolean {
  const { head, pr, branch, candidateState } = record.target;
  if (
    head === null || pr === null || branch === null ||
    record.source.kind !== "issue"
  ) return false;
  if (
    record.blocker !== null ||
    !["work", "review", "delivery"].includes(record.nextStep)
  ) return false;
  return candidateState === undefined ||
    (candidateState.publishedHead === head &&
      candidateState.preserved?.head === head &&
      candidateState.preserved.base === record.target.base);
}

/** Oldest validation demand first; stable across unrelated workflow run IDs. */
export function compareCiReadiness(a: WorkRecordV1, b: WorkRecordV1): number {
  return Number(a.wait?.reason === "ci_pending") -
      Number(b.wait?.reason === "ci_pending") ||
    (a.wait?.since ?? a.createdAt) - (b.wait?.since ?? b.createdAt) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Exact-tip CI waits are useful demand; an old head cannot claim tip coverage. */
export function currentCiValidation(
  record: WorkRecordV1,
  tip: GitSha | null,
): boolean {
  return tip !== null && record.target.base === tip &&
    publishedCiCandidate(record) &&
    record.intent === null && record.wait?.reason === "ci_pending";
}

function live(record: WorkRecordV1, now: number): boolean {
  if (
    (record.counters.stalled ?? 0) >= DELIVERY_QUEUE_STALL_LIMIT ||
    now - record.updatedAt >= DELIVERY_QUEUE_IDLE_MS ||
    isRedBaseHold(record.wait, now)
  ) return false;
  return record.wait?.reason !== "ci_pending" ||
    now - record.wait.since < PRE_REVIEW_CI_BOUND_MS;
}

/**
 * Preserve validation already admitted on the tip, then reuse the delivery
 * line and oldest ready refresh. No new count limit, state or wait is added.
 * Existing idle/stall/CI bounds release a head that can no longer advance.
 */
export function ciRefreshAhead(
  snapshot: Snapshot,
  record: WorkRecordV1,
  tip: GitSha,
  now: number,
  cutoff?: LegacyCutoff,
): WorkRecordV1 | null {
  const delivery = deliveryQueueAhead(snapshot, record, tip, now, cutoff);
  if (delivery !== null) return delivery;
  const candidates = snapshot.work.filter((other) =>
    other.id !== record.id &&
    sameRepositoryIdentity(other.repository, record.repository) &&
    publishedCiCandidate(other) && live(other, now) &&
    !snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, other)
    )
  ).sort(compareCiReadiness);
  const validating = candidates.find((other) =>
    (other.intent?.kind === "base_refresh" &&
      other.intent.observedBase === tip) ||
    (other.target.base === tip &&
      (other.wait?.reason === "ci_pending" || other.nextStep === "review" ||
        other.intent?.kind === "review_request"))
  );
  if (validating !== undefined) return validating;
  const ready = candidates.find((other) =>
    other.intent === null && other.target.base !== tip &&
    compareCiReadiness(other, record) < 0
  );
  return ready ?? null;
}
