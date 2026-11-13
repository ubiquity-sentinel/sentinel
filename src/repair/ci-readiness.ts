/** Shared, state-free ordering of published CI validation and base refresh. */
import type { GitSha } from "../contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { isRedBaseHold, PRE_REVIEW_CI_BOUND_MS } from "./ci-first-policy.ts";
import { CONFLICT_MARKER_KIND } from "./conflict-resolution.ts";
import {
  DELIVERY_QUEUE_IDLE_MS,
  DELIVERY_QUEUE_STALL_LIMIT,
  deliveryQueueAhead,
  lineBefore,
  reviewInFlight,
} from "./delivery-queue.ts";
import {
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import { type LegacyCutoff, reviewedHeadCarried } from "./review-round-cap.ts";

type Snapshot = Pick<
  RepairStateSnapshotV1,
  "work" | "reviews" | "reservations" | "releaseRequests"
>;

/**
 * Detail prefix of a pre-review base refresh deferred behind another record's
 * validation (`ensureReviewFreshness`). Fixed text: the advisory step line
 * reports it as the closed reason code `ci_line`.
 */
export const CI_VALIDATION_DEFERRED_PREFIX = "CI validation: ";

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

/**
 * A head the stall rule, a running red-base hold or the pre-review CI bound
 * has not released: it can still act on its own next step. Idleness is not
 * read here, so an untouched refresh candidate still ORDERS the refreshes of
 * its repository (`ready` below) instead of letting every idle sibling refresh
 * onto one tip in the same pass.
 */
function actionable(record: WorkRecordV1, now: number): boolean {
  if (
    (record.counters.stalled ?? 0) >= DELIVERY_QUEUE_STALL_LIMIT ||
    isRedBaseHold(record.wait, now)
  ) return false;
  return record.wait?.reason !== "ci_pending" ||
    now - record.wait.since < PRE_REVIEW_CI_BOUND_MS;
}

/** Actionable and written within the idle bound: it may hold a validation. */
function live(record: WorkRecordV1, now: number): boolean {
  return actionable(record, now) &&
    now - record.updatedAt < DELIVERY_QUEUE_IDLE_MS;
}

/**
 * A base refresh holds the line only while it can still act. A closed/absent
 * source issue is retired by the implementation step and its prerequisite wait
 * is `unavailable`; a conflict-marked refresh parks on that same hourly
 * prerequisite wait until the marker is resolved or retired. Neither can make
 * progress from the queue, so counting it as validating would freeze every
 * same-repository refresh behind it indefinitely.
 */
function baseRefreshCanAct(record: WorkRecordV1, tip: GitSha): boolean {
  const intent = record.intent;
  if (intent?.kind !== "base_refresh" || intent.observedBase !== tip) {
    return false;
  }
  return (intent.resultId !== null ||
    intent.failure?.kind !== CONFLICT_MARKER_KIND) &&
    record.wait?.reason !== "unavailable";
}

/**
 * Preserve validation already admitted on the tip, then reuse the delivery
 * line and oldest ready refresh. No new count limit, state or wait is added.
 * Existing idle/stall/CI bounds release a head that can no longer advance.
 *
 * Fairness (sentinel 2026-11-13): a record with no reviewed head to carry
 * (`reviewedHeadCarried` false) loses no review by refreshing, and a sibling
 * merely awaiting its own CI on the tip, or holding an unexecuted refresh of
 * it, has paid no review a merge ahead of it would discard. Such a sibling
 * therefore holds it only from ahead in line (`lineBefore`: oldest
 * `createdAt`, then id, the delivery pass's own order), so a candidate
 * published on the current tip can no longer overtake an older green head on
 * every pass. A sibling whose review is in flight (`reviewInFlight`) keeps
 * holding whatever their order, and a record that carries a reviewed head
 * keeps the unchanged order, so no review is spent twice.
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
  const carried = reviewedHeadCarried(snapshot, record);
  const candidates = snapshot.work.filter((other) =>
    other.id !== record.id &&
    sameRepositoryIdentity(other.repository, record.repository) &&
    publishedCiCandidate(other) && actionable(other, now) &&
    !snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, other)
    )
  ).sort(compareCiReadiness);
  const validating = candidates.find((other) => {
    if (!live(other, now)) return false;
    const onTip = other.target.base === tip;
    if (onTip && reviewInFlight(other)) return true;
    const ciOnTip = onTip && other.wait?.reason === "ci_pending";
    return (baseRefreshCanAct(other, tip) || ciOnTip) &&
      (carried || lineBefore(other, record));
  });
  if (validating !== undefined) return validating;
  const ready = candidates.find((other) =>
    other.intent === null && other.target.base !== tip &&
    compareCiReadiness(other, record) < 0
  );
  return ready ?? null;
}
