/**
 * Per-repository delivery queue (owner decisions 2026-10-16: review rounds are
 * capped at three, hard; CI first, then review, then merge; a PR whose three
 * rounds are spent with no unresolved P0/P1 merges).
 *
 * A reviewed head whose base moved before it merged needs a refreshed head,
 * and the refreshed head needs a review round of its own. When several
 * reviewed records of one repository wait on the same tip, every merge moves
 * the base of all the others: refreshed and reviewed together, each merge
 * cost every one of them a round, so three merges left the rest at the hard
 * ceiling on a moved base (a BASE_MOVED park that only the owner-gated
 * moved-base merge could deliver). Live, 8 of the 17 ai.ubq.fi PRs merged
 * since 2026-10-16T00:00Z needed four or more reviewed heads, every one of
 * them clean, each new head a refresh after a base move.
 *
 * The queue serialises those refreshes. A reviewed delivery record whose
 * base moved (with a review round left, or spent with a clean latest review,
 * which refreshes mechanically and carries that review,
 * `loop-carried-delivery.ts`) refreshes only when no other reviewed record of
 * its repository (an issue task with a published pull request and at least
 * one review round spent, not yet merged) is
 * - in flight on the current tip: published there and waiting for its CI or
 *   in a correction at `work` with a round left for its review, a refreshed
 *   head at `work` heading for its carried merge, in review, or reviewed and
 *   waiting to merge in `delivery`;
 * - refreshing (a `base_refresh` intent); or
 * - ahead of it in line: on a moved base too, with a round left or a clean
 *   latest review, and a lower pull request number (then record id).
 * Otherwise the step defers: nothing is written, charged, refreshed, pushed or
 * requested, and the next run asks again. Only the record at the front of the
 * line refreshes, CI runs on its new head before its review, and it merges
 * before the next one refreshes, so a base move caused by the queue's own
 * merges never costs a waiting record a round.
 *
 * A stuck contender holds nobody, so it never blocks the line: one that made
 * no durable progress in its last `DELIVERY_QUEUE_STALL_LIMIT` executions
 * (`counters.stalled`, the loop's own no-progress count, reset by every
 * durable change; live 594 re-armed the same wait 104 times), or one nothing
 * has written for `DELIVERY_QUEUE_IDLE_MS` (a step that defers without a write
 * on every run; live 647 and 604 sat in review untouched for 81 and 33
 * hours). A refreshed head waiting on its CI and its review re-arms its wait
 * every poll and stays far inside both.
 *
 * Pure policy over the authenticated snapshot and the freshly observed tip.
 * It persists nothing, so it adds no state shape: generation 79, the rollback
 * target, refreshes every such record at once exactly as before.
 */
import type { GitSha } from "../contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import { carriedLine } from "./carried-review.ts";
import {
  type LegacyCutoff,
  reviewRoundsLeft,
  reviewRoundsSpent,
} from "./review-round-cap.ts";

/** Executions without durable progress after which a record holds nobody. */
export const DELIVERY_QUEUE_STALL_LIMIT = 12;

/** Time without any write after which a record holds nobody (2 hours). */
export const DELIVERY_QUEUE_IDLE_MS = 2 * 60 * 60_000;

type QueueSnapshot = Pick<
  RepairStateSnapshotV1,
  "work" | "reservations" | "releaseRequests" | "reviews"
>;

/** A reviewed, published, unmerged issue task that competes for the tip. */
function contender(
  snapshot: QueueSnapshot,
  other: WorkRecordV1,
  now: number,
): boolean {
  if (
    other.nextStep !== "work" && other.nextStep !== "review" &&
    other.nextStep !== "delivery"
  ) return false;
  const { pr, head, base } = other.target;
  if (
    pr === null || head === null || base === null ||
    other.source.kind !== "issue" ||
    (other.counters.stalled ?? 0) >= DELIVERY_QUEUE_STALL_LIMIT ||
    !(now - other.updatedAt < DELIVERY_QUEUE_IDLE_MS)
  ) return false;
  if (
    snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, other)
    )
  ) return false;
  return reviewRoundsSpent(snapshot, other) > 0;
}

/** Line order of two records on moved bases: pull request, then id. */
function lineBefore(a: WorkRecordV1, b: WorkRecordV1): boolean {
  const left = a.target.pr ?? Number.MAX_SAFE_INTEGER;
  const right = b.target.pr ?? Number.MAX_SAFE_INTEGER;
  return left !== right ? left < right : a.id < b.id;
}

/**
 * The record that must go first before `record` (a reviewed delivery record
 * with a review round left whose base moved to `tip`) may refresh at `now`,
 * or null when it is at the front of its repository's line.
 */
export function deliveryQueueAhead(
  snapshot: QueueSnapshot,
  record: WorkRecordV1,
  tip: GitSha,
  now: number,
  /** The legacy review cutoff of the run (`review-round-cap.ts`). */
  cutoff?: LegacyCutoff,
): WorkRecordV1 | null {
  for (const other of snapshot.work) {
    if (
      other.id === record.id ||
      !sameRepositoryIdentity(other.repository, record.repository) ||
      !contender(snapshot, other, now)
    ) continue;
    const left = reviewRoundsLeft(snapshot, other, cutoff);
    // A spent record whose latest review is clean refreshes and merges under
    // the carried review instead of parking.
    const carried = left === 0 && carriedLine(snapshot, other);
    if (other.target.base === tip) {
      // In review or reviewed and waiting to merge on the tip, or published
      // there at `work` with a round left for the review it is heading to (or
      // a refreshed head heading for its carried merge).
      if (other.nextStep !== "work" || left > 0 || carried) return other;
      continue;
    }
    if (other.intent?.kind === "base_refresh") return other;
    // A record with no round left and no clean review parks instead.
    if (left === 0 && !carried) continue;
    if (lineBefore(other, record)) return other;
  }
  return null;
}
