/**
 * Per-repository delivery queue (CI first, then review, then merge; owner
 * directive 2026-10-30 retired the review-round ceiling, so a spent round
 * count is accounting and never a park).
 *
 * A reviewed head whose base moved before it merged needs a refreshed head.
 * When several reviewed records of one repository wait on the same tip, every
 * merge moves the base of all the others, so the queue serialises those
 * refreshes, by delivery readiness and then pull request number (JAM J3, live
 * 2026-10-17/18: ordered by number alone, red heads awaiting a CI fix and
 * CI-fixed heads on the tip awaiting their CI held the line for hours ahead of
 * 698 and 879, green, reviewed and delivered). Each reviewed, published,
 * unmerged issue task of the repository with at least one review round spent
 * (a contender) stands in one of five places (`lineStanding`):
 * - `landing`: it moves the tip next with no further review: a carried
 *   refresh in flight, or a reviewed head on the tip waiting to merge in
 *   `delivery` (or a carried refreshed head heading for the launcher's
 *   carried merge);
 * - `ready`: deliverable now on a moved base: its head needs no new review
 *   (`reviewedHeadCarried`: its latest review is clean and accepted, and the
 *   record carries it), its next step the one mechanical refresh (its
 *   reviewed head in `delivery` with no CI wait, which the step that reads it
 *   green clears once, or a carried refreshed head whose base moved again);
 * - `re_review`: heading for a review on the tip: a refresh in flight, a
 *   head published on the tip and waiting for its CI or its review at
 *   `work`, or a review in flight there;
 * - `reviewed`: reviewed, in `delivery` on a moved base, whose corrected
 *   head is reviewed again after its refresh;
 * - `waiting`: not deliverable now: a reviewed head returned to `work` for
 *   its CI fix or correction, a reviewed head whose CI is still pending, a
 *   head waiting for its CI or its review on a moved base (its own review
 *   request refreshes it first), a head on the tip held by its red base while
 *   that hold runs (`isRedBaseHold`), or a record without a clean accepted
 *   review of its carried head (it parks instead).
 *
 * Every contender takes the same order: a record that will be reviewed at
 * `work` or `review` (`re_review`), like any other, waits only while a
 * contender is `landing` or a `ready` or `reviewed` one is ahead of it (lower
 * pull request number, then record id); nothing that still needs a CI fix or
 * its CI ever holds it. A deliverable record (its head needs no new review)
 * waits only while a contender is `landing` or a `ready` one is ahead of it,
 * so it takes the line as soon as it is deliverable and nothing that still
 * needs a review holds it. A `waiting` contender holds nobody. Otherwise the
 * step defers: nothing is written, charged, refreshed, pushed or requested,
 * and the next run asks again. Only one record lands at a time, CI runs on its
 * new head before its review or its carried merge, and it merges before the
 * next one refreshes, so the launcher's one merge per pass moves the base once
 * and a base move caused by the queue's own merges never costs a waiting
 * record work it had already finished.
 *
 * No contender starves: a deliverable record waits only for one landing
 * (bounded by the stall and idle rules below, the carried waits' six hours
 * and the launcher's merge) and for the deliverable records ahead of it,
 * finitely many, each of which lands (or parks) in its turn.
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
 * A head on the tip whose failing check is red on the tip too (the CI-first
 * gate's `base_red` backoff, or the pre-merge or carried gate's) waits for a
 * base move, and only a merge moves the tip: holding the records whose merge
 * could move it is a circle the stall rule broke only after 12 re-arms of a
 * 30-minute hold (live Passport 2026-10-24: records 13 and 14 held 22
 * reviewed records for 18 hours). It holds nobody while that hold runs; once
 * it is due, it stands as before until its own step re-arms the hold or
 * moves on. A running CI wait cannot be told from one whose jobs never
 * started (the wait records neither), so it keeps holding, bounded by the
 * stall rule at the five-minute poll.
 *
 * Pure policy over the authenticated snapshot, the freshly observed tip and
 * the step's clock. It persists nothing, so it adds no state shape, blocker,
 * wait or line: under generation 80, the rollback target, a refresh this line
 * admitted is a `landing` contender too (a base-refresh intent, or a carried
 * refreshed head on the tip), and that runtime's line holds every other
 * record behind it (behind a head held by its red base as well, which is
 * only slower).
 */
import type { GitSha } from "../contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import { carriedLine, latestPullReview } from "./carried-review.ts";
import { isRedBaseHold } from "./ci-first-policy.ts";
import {
  type LegacyCutoff,
  reviewedHeadCarried,
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

/**
 * True while `record` holds its repository's delivery line (pure, no tip):
 * a reviewed, published, unmerged issue task with no release request that
 * is neither stalled (`DELIVERY_QUEUE_STALL_LIMIT`) nor idle
 * (`DELIVERY_QUEUE_IDLE_MS`). The launcher reads a carried head the runtime
 * awaits on every pass only while it holds the line.
 */
export function holdsDeliveryLine(
  snapshot: QueueSnapshot,
  record: WorkRecordV1,
  now: number,
): boolean {
  return contender(snapshot, record, now);
}

/** Line order of two records on moved bases: pull request, then id. */
export function lineBefore(
  a: Pick<WorkRecordV1, "id" | "target">,
  b: Pick<WorkRecordV1, "id" | "target">,
): boolean {
  const left = a.target.pr ?? Number.MAX_SAFE_INTEGER;
  const right = b.target.pr ?? Number.MAX_SAFE_INTEGER;
  return left !== right ? left < right : a.id < b.id;
}

/** Where a contender stands in its repository's line (see the module). */
export type DeliveryLineStandingV1 =
  | "landing"
  | "ready"
  | "re_review"
  | "reviewed"
  | "waiting";

/**
 * Where `other` (a contender, `holdsDeliveryLine`) stands against `tip` at
 * `now` under the run's legacy `cutoff` (pure; see the module).
 */
export function lineStanding(
  snapshot: QueueSnapshot,
  other: WorkRecordV1,
  tip: GitSha,
  now: number,
  /** The run's legacy cutoff; the line no longer reads a round count. */
  _cutoff?: LegacyCutoff,
): DeliveryLineStandingV1 {
  // `spent` is the reviewed-head fact, not a round count: the head needs no
  // new review (owner directive 2026-10-30 retired the ceiling; a spent
  // count no longer stands in for it).
  const spent = reviewedHeadCarried(snapshot, other);
  // The latest completed pull request review (any head) is clean, and
  // whether it judged the current head (a reviewed head) or an earlier one
  // (a refreshed or corrected head).
  const clean = carriedLine(snapshot, other);
  const ownReview =
    latestPullReview(snapshot, other)?.pullRequest.head === other.target.head;
  if (other.intent?.kind === "base_refresh") {
    return spent ? "landing" : "re_review";
  }
  if (other.target.base === tip) {
    const standing = tipStanding(other, spent, clean, ownReview);
    // Held by the tip's own red check with a round left: only a merge moves
    // the tip, and this record would hold every record whose merge could
    // (see the module). A spent or delivering head keeps standing `landing`:
    // releasing the records behind it would only refresh them onto the red
    // tip, where the carried gate's six-hour bound parks each one for good.
    return standing === "re_review" && isRedBaseHold(other.wait, now)
      ? "waiting"
      : standing;
  }
  if (!spent) return other.nextStep === "delivery" ? "reviewed" : "waiting";
  if (!clean) return "waiting";
  // Its reviewed head's CI still pending is not deliverable now (the step
  // that reads it green clears the wait before it defers).
  if (other.nextStep === "delivery") {
    return ownReview && other.wait?.reason !== "ci_pending"
      ? "ready"
      : "waiting";
  }
  return other.nextStep === "work" && !ownReview ? "ready" : "waiting";
}

/** A contender's standing on the tip (`lineStanding`, before a red base). */
function tipStanding(
  other: WorkRecordV1,
  spent: boolean,
  clean: boolean,
  ownReview: boolean,
): DeliveryLineStandingV1 {
  if (other.nextStep === "delivery") return "landing";
  if (other.nextStep === "review") return "re_review";
  // At `work`: a refreshed head heading for its carried merge or for its
  // next review; a reviewed head here awaits its CI fix or correction.
  if (ownReview) return "waiting";
  if (spent) return clean ? "landing" : "waiting";
  return "re_review";
}

/** Precedence of the contenders that hold a record, for the deferral. */
const HOLD_ORDER: readonly DeliveryLineStandingV1[] = [
  "landing",
  "ready",
  "re_review",
  "reviewed",
];

/**
 * The record that must go first before `record` (a reviewed delivery record
 * whose base moved to `tip`: deliverable now with no round left, or with a
 * round left for its refreshed head's review) may refresh at `now`, or null
 * when it is at the front of its repository's line. Of several, the one
 * nearest to landing, then first in line.
 */
export function deliveryQueueAhead(
  snapshot: QueueSnapshot,
  record: WorkRecordV1,
  tip: GitSha,
  now: number,
  /** The legacy review cutoff of the run (`review-round-cap.ts`). */
  cutoff?: LegacyCutoff,
): WorkRecordV1 | null {
  const deliverable = reviewedHeadCarried(snapshot, record);
  let ahead: { other: WorkRecordV1; rank: number } | null = null;
  for (const other of snapshot.work) {
    if (
      other.id === record.id ||
      !sameRepositoryIdentity(other.repository, record.repository) ||
      !contender(snapshot, other, now)
    ) continue;
    const standing = lineStanding(snapshot, other, tip, now, cutoff);
    const holds = standing === "landing" ||
      (standing === "ready" && (!deliverable || lineBefore(other, record))) ||
      (!deliverable &&
        (standing === "re_review" ||
          (standing === "reviewed" && lineBefore(other, record))));
    if (!holds) continue;
    const rank = HOLD_ORDER.indexOf(standing);
    if (
      ahead === null || rank < ahead.rank ||
      (rank === ahead.rank && lineBefore(other, ahead.other))
    ) ahead = { other, rank };
  }
  return ahead?.other ?? null;
}
