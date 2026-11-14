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
 * has not released: it can still act on its own next step. The CI bound
 * releases only a head awaiting its CI on `tip`, where its step reads that CI:
 * a head on a moved base asks this line before its CI gate and the deferral
 * writes nothing, so its `ci_pending` is whatever an earlier poll left (live
 * sentinel 2026-11-13: 397, green since 17:16Z, still carried its 17:10Z wait
 * at midnight) and says nothing about its CI. Idleness is not read here, so an
 * untouched refresh candidate still ORDERS the refreshes of its repository
 * (`ready` below) instead of letting every idle sibling refresh onto one tip
 * in the same pass.
 */
function actionable(record: WorkRecordV1, tip: GitSha, now: number): boolean {
  if (
    (record.counters.stalled ?? 0) >= DELIVERY_QUEUE_STALL_LIMIT ||
    isRedBaseHold(record.wait, now)
  ) return false;
  return record.target.base !== tip || record.wait?.reason !== "ci_pending" ||
    now - record.wait.since < PRE_REVIEW_CI_BOUND_MS;
}

/** Actionable and written within the idle bound: it may hold a validation. */
function live(record: WorkRecordV1, tip: GitSha, now: number): boolean {
  return actionable(record, tip, now) &&
    now - record.updatedAt < DELIVERY_QUEUE_IDLE_MS;
}

/** The line's own order as a sort (`lineBefore`: oldest, then id). */
function lineOrder(a: WorkRecordV1, b: WorkRecordV1): number {
  return lineBefore(a, b) ? -1 : lineBefore(b, a) ? 1 : 0;
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
 *
 * Front (sentinel 2026-11-13/14): the first in line that can act goes first.
 * Heads on a moved base refresh oldest first (`lineBefore`), never by the wait
 * an earlier step left: ranking a leftover `ci_pending` last put 271 ahead of
 * 268 (green on its refreshed head since 19:47Z) at 20:39Z and, from 00:18Z,
 * 398 (an expired `unavailable` from 18:16Z) ahead of 268 and 397. A record
 * that cannot act (stalled) holds nobody and lost its place: it waits behind
 * every record that can, validating or ready, instead of refreshing beside
 * the front (312, stalled at 180, refreshed onto 386's tip at 23:00:17Z and
 * both were reviewed at 00:12Z and 00:13Z).
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
  const back = !actionable(record, tip, now);
  const candidates = snapshot.work.filter((other) =>
    other.id !== record.id &&
    sameRepositoryIdentity(other.repository, record.repository) &&
    publishedCiCandidate(other) && actionable(other, tip, now) &&
    !snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, other)
    )
  ).sort(lineOrder);
  const validating = candidates.find((other) => {
    if (!live(other, tip, now)) return false;
    const onTip = other.target.base === tip;
    if (onTip && reviewInFlight(other)) return true;
    const ciOnTip = onTip && other.wait?.reason === "ci_pending";
    return (baseRefreshCanAct(other, tip) || ciOnTip) &&
      (carried || back || lineBefore(other, record));
  });
  if (validating !== undefined) return validating;
  const ready = candidates.find((other) =>
    other.intent === null && other.target.base !== tip &&
    (back || lineBefore(other, record))
  );
  return ready ?? null;
}
