/**
 * The hard review-round ceiling (owner decision 2026-10-16: "ai.ubq.fi issue
 * 684 / PR 1059 reached 44 rounds; 44 rounds is insane, 3 round max").
 *
 * Pure policy shared by the runtime repair loop and the protected launcher:
 * no I/O, no clock and only types imported, so the launcher can ship it before
 * the runtime does. A task has spent the larger of its unrefunded
 * `review_request` admissions and its review-round counter less its refunds;
 * once that reaches its ceiling no further review is requested anywhere, and
 * a record that could only continue through another review parks with one of
 * the fixed messages below (its PR, head, evidence and charges kept).
 *
 * Rollback contract: nothing here is persisted except a blocker of the
 * existing `other` kind whose message starts with `REVIEW_ROUND_CEILING_PREFIX`,
 * which no generation-79 re-admission, re-arm or recovery rule matches.
 *
 * Delivery contract: a park is never handed back for review. Only the
 * REVIEWED and BASE_MOVED parks (`isDeliverableReviewRoundCeilingPark`) may be
 * merged, and only by the spent-round delivery rule, which re-verifies the
 * latest completed current-head review and the required CI itself.
 */
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";

/** Review rounds any task may spend, everywhere (owner decision 2026-10-16). */
export const MAX_REVIEW_ROUNDS = 3;

/** Prefix of every ceiling park message; parks are matched by exact text. */
export const REVIEW_ROUND_CEILING_PREFIX = "review round ceiling reached: ";

/** No completed review binds the record's current head. */
export const REVIEW_ROUND_CEILING_UNREVIEWED =
  `${REVIEW_ROUND_CEILING_PREFIX}the current head has no completed review`;
/** The latest completed review of the current head left a P0/P1 unresolved. */
export const REVIEW_ROUND_CEILING_REJECTED =
  `${REVIEW_ROUND_CEILING_PREFIX}unresolved P0/P1 findings remain`;
/** The latest completed review of the current head accepted no task. */
export const REVIEW_ROUND_CEILING_UNACCEPTED =
  `${REVIEW_ROUND_CEILING_PREFIX}the completed review carries no task acceptance`;
/** The base moved after the last review; a refreshed head needs a round. */
export const REVIEW_ROUND_CEILING_BASE_MOVED =
  `${REVIEW_ROUND_CEILING_PREFIX}the base moved after the last review`;
/** The latest completed review of the current head authorizes delivery. */
export const REVIEW_ROUND_CEILING_REVIEWED =
  `${REVIEW_ROUND_CEILING_PREFIX}the reviewed head awaits delivery`;

/** Every park message, in a fixed order. */
export const REVIEW_ROUND_CEILING_MESSAGES: readonly string[] = [
  REVIEW_ROUND_CEILING_UNREVIEWED,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_REVIEWED,
];

/**
 * One-time legacy exception (owner decision 2026-10-16): ai.ubq.fi records
 * whose rounds were spent under the old review-before-CI order and whose CI is
 * red each get exactly ONE final current-head review. The table is that class
 * (`legacyReviewRoundClassPin`) evaluated over live repair state
 * `LEGACY_REVIEW_ROUND_CUT` (commit 18369d9b9, manifest sequence 38912,
 * 2026-10-17T09:07Z): the owner's twelve (595, 597, 605, 610, 618, 668, 672,
 * 673, 680, 694, 698, 879, exactly the class at the decision-time state,
 * sequence 36388) and the sixteen that generation 79 parked the same way
 * since (137, 575, 602, 634, 638, 678, 679, 693, 754 by sequence 37449, then
 * 583, 615, 617, 629, 633, 650 and 1128). Generation 79 keeps adding to the
 * class until generation 80 installs, so the table is regenerated from the
 * state generation 80 installs over (the cut) and the launcher reports every
 * class member the table does not pin at its live count, every pass
 * (`legacyReviewRoundTableDrift`). Each pin is the record's spent rounds at
 * the cut; the ceiling is the pin + 1, so a record that spent past its pin
 * gets nothing (fails closed).
 */
export const LEGACY_REVIEW_ROUND_PINS: ReadonlyMap<number, number> = new Map([
  [137, 5],
  [575, 3],
  [583, 4],
  [595, 4],
  [597, 5],
  [602, 6],
  [605, 3],
  [610, 3],
  [615, 3],
  [617, 3],
  [618, 7],
  [629, 3],
  [633, 3],
  [634, 4],
  [638, 5],
  [650, 3],
  [668, 4],
  [672, 3],
  [673, 7],
  [678, 6],
  [679, 6],
  [680, 4],
  [693, 3],
  [694, 3],
  [698, 9],
  [754, 3],
  [879, 3],
  [1128, 5],
]);

/** The live repair state commit `LEGACY_REVIEW_ROUND_PINS` was derived at. */
export const LEGACY_REVIEW_ROUND_CUT = {
  stateCommit: "18369d9b95da761ec5ca5c59ce7335ced6c429e0",
  sequence: 38912,
} as const;
const LEGACY_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
};

type RoundRecord = Pick<
  WorkRecordV1,
  "id" | "repository" | "source" | "related" | "counters" | "intent" | "target"
>;
type Ledger = { readonly reservations: readonly BudgetReservationV1[] };

function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

/** The ai.ubq.fi issue number of exactly this record identity, or null. */
function legacyIssue(record: RoundRecord): number | null {
  const issue = record.related.issueNumber;
  if (
    issue === null || !sameRepository(record.repository, LEGACY_REPOSITORY) ||
    record.source.kind !== "issue" || record.source.id !== String(issue) ||
    record.id !== `issue-ubiquity-ai.ubq.fi-${issue}`
  ) return null;
  return issue;
}

/** The legacy pin of exactly this listed record, or null. */
export function legacyReviewRoundPin(record: RoundRecord): number | null {
  const issue = legacyIssue(record);
  return issue === null ? null : LEGACY_REVIEW_ROUND_PINS.get(issue) ?? null;
}

/** The merge gate's CI-red blockers (`loop-checks.ts`, `ci-rejection.ts`). */
const CI_RED_PREFIXES = [
  "CI checks failed: ",
  "CI checks failed without base evidence: ",
];

/**
 * The owner's legacy class, for regenerating `LEGACY_REVIEW_ROUND_PINS` from a
 * repair state taken before generation 80 runs: an ai.ubq.fi issue record
 * parked CI-red by the merge gate whose spent rounds already reach
 * `MAX_REVIEW_ROUNDS` (all of them spent under the old review-before-CI
 * order). Returns those spent rounds (its pin), otherwise null. The runtime
 * never consults it: only the table grants the one final round.
 */
export function legacyReviewRoundClassPin(
  snapshot: Ledger,
  record: RoundRecord & Pick<WorkRecordV1, "nextStep" | "blocker">,
): number | null {
  const blocker = record.blocker;
  if (
    legacyIssue(record) === null || record.nextStep !== "blocked" ||
    blocker === null || blocker.kind !== "other" ||
    !CI_RED_PREFIXES.some((prefix) => blocker.message.startsWith(prefix))
  ) return null;
  const spent = reviewRoundsSpent(snapshot, record);
  return spent >= MAX_REVIEW_ROUNDS ? spent : null;
}

/**
 * One live class member the pinned table disagrees with: no pin at all
 * (`unpinned`, generation 79 parked it after the cut) or a pin other than its
 * live spent rounds (`pin_mismatch`: a round spent past the pin before the
 * install, which loses the one final round, or a final round already spent
 * on a head that turned red again).
 */
export interface LegacyReviewRoundDriftV1 {
  id: string;
  issue: number;
  kind: "unpinned" | "pin_mismatch";
  pin: number | null;
  spent: number;
}

/**
 * Every record of the owner's legacy class over `snapshot`
 * (`legacyReviewRoundClassPin`) that `LEGACY_REVIEW_ROUND_PINS` does not pin
 * at exactly its spent rounds, by issue number. The table is regenerated at
 * the cut; this is what the launcher reports on every pass so a drifted table
 * is never silent. Pure; it grants nothing.
 */
export function legacyReviewRoundTableDrift(
  snapshot: Ledger & {
    readonly work: readonly (
      & RoundRecord
      & Pick<WorkRecordV1, "nextStep" | "blocker">
    )[];
  },
): LegacyReviewRoundDriftV1[] {
  const drift: LegacyReviewRoundDriftV1[] = [];
  for (const record of snapshot.work) {
    const spent = legacyReviewRoundClassPin(snapshot, record);
    if (spent === null) continue;
    const issue = legacyIssue(record)!;
    const pin = LEGACY_REVIEW_ROUND_PINS.get(issue) ?? null;
    if (pin === spent) continue;
    drift.push({
      id: record.id,
      issue,
      kind: pin === null ? "unpinned" : "pin_mismatch",
      pin,
      spent,
    });
  }
  return drift.sort((a, b) => a.issue - b.issue);
}

/** The record's ceiling: its legacy pin + 1, otherwise `MAX_REVIEW_ROUNDS`. */
export function reviewRoundCeiling(record: RoundRecord): number {
  const pin = legacyReviewRoundPin(record);
  return pin === null ? MAX_REVIEW_ROUNDS : pin + 1;
}

/**
 * The admission the next review request completes instead of charging anew:
 * still `reserved` at the record's next attempt on its current head while no
 * intent names it (the admission was written, its intent write was lost).
 */
function nextAdmission(charge: BudgetReservationV1, record: RoundRecord) {
  return charge.outcome === "reserved" && record.intent === null &&
    charge.head === record.target.head &&
    charge.attempt === record.counters.reviewRounds + 1;
}

/**
 * Rounds this task has spent: the larger of (a) its `review_request`
 * admissions in the durable ledger (any head, PR or generation; ambiguous and
 * in-flight ones included, a proven `confirmed_not_submitted` refund and the
 * not-yet-completed next admission excluded) and (b) its review-round counter
 * less those refunds (every refund path also bumps the counter). The ledger
 * catches a lowered or lagging counter; the counter catches a round counted
 * without a charge.
 */
export function reviewRoundsSpent(
  snapshot: Ledger,
  record: RoundRecord,
): number {
  let charged = 0;
  let refunded = 0;
  for (const charge of snapshot.reservations) {
    if (
      charge.purpose !== "review_request" || charge.taskId !== record.id ||
      !sameRepository(charge.repository, record.repository)
    ) continue;
    if (charge.outcome === "confirmed_not_submitted") refunded++;
    else if (!nextAdmission(charge, record)) charged++;
  }
  return Math.max(charged, record.counters.reviewRounds - refunded);
}

/**
 * True once the task has spent the ordinary ceiling (`MAX_REVIEW_ROUNDS`) by
 * the same count. The spent-round delivery rule qualifies a record on this: a
 * listed legacy record's one final round is extra, kept for a CI-fixed head.
 */
export function ordinaryReviewRoundsSpent(
  snapshot: Ledger,
  record: RoundRecord,
): boolean {
  return reviewRoundsSpent(snapshot, record) >= MAX_REVIEW_ROUNDS;
}

/**
 * Reviews this task may still request: its ceiling minus the rounds spent,
 * never below zero. A listed legacy record gets at most its one round.
 */
export function reviewRoundsLeft(
  snapshot: Ledger,
  record: RoundRecord,
): number {
  const left = reviewRoundCeiling(record) - reviewRoundsSpent(snapshot, record);
  if (left <= 0) return 0;
  return legacyReviewRoundPin(record) === null ? left : 1;
}

/**
 * The latest completed review of the record's current head on its pull
 * request (by completion, then observation instant, then id), or null.
 */
export function latestCompletedReview(
  snapshot: { readonly reviews: readonly ReviewReceiptV1[] },
  record: Pick<WorkRecordV1, "repository" | "target">,
): ReviewReceiptV1 | null {
  const { head, pr } = record.target;
  if (head === null || pr === null) return null;
  let latest: ReviewReceiptV1 | null = null;
  for (const review of snapshot.reviews) {
    if (
      review.outcome !== "completed" || review.pullRequest.number !== pr ||
      review.pullRequest.head !== head ||
      !sameRepository(review.repository, record.repository)
    ) continue;
    if (latest === null || laterReview(review, latest)) latest = review;
  }
  return latest;
}

function laterReview(a: ReviewReceiptV1, b: ReviewReceiptV1): boolean {
  const at = (review: ReviewReceiptV1) => review.completedAt ?? -1;
  if (at(a) !== at(b)) return at(a) > at(b);
  if (a.observedAt !== b.observedAt) return a.observedAt > b.observedAt;
  return a.id > b.id;
}

/**
 * The fixed park message the latest completed review of the current head
 * selects: none (UNREVIEWED); an unresolved P0/P1 or an uncounted finding
 * (REJECTED); an issue task without a positive task acceptance (UNACCEPTED);
 * otherwise REVIEWED. A moved base is the caller's own BASE_MOVED.
 */
export function ceilingParkMessage(
  snapshot: { readonly reviews: readonly ReviewReceiptV1[] },
  record: Pick<WorkRecordV1, "repository" | "target" | "source">,
): string {
  const latest = latestCompletedReview(snapshot, record);
  if (latest === null) return REVIEW_ROUND_CEILING_UNREVIEWED;
  if (
    latest.findingsUncounted !== 0 ||
    latest.unresolvedSeverities.some((severity) =>
      severity === "P0" || severity === "P1"
    )
  ) return REVIEW_ROUND_CEILING_REJECTED;
  if (
    record.source.kind === "issue" &&
    (latest.taskAcceptance ?? null)?.verdict !== "fulfilled"
  ) return REVIEW_ROUND_CEILING_UNACCEPTED;
  return REVIEW_ROUND_CEILING_REVIEWED;
}

/** True for a record the ceiling parked (any of the fixed messages). */
export function isReviewRoundCeilingPark(
  record: Pick<WorkRecordV1, "nextStep" | "blocker">,
): boolean {
  return record.nextStep === "blocked" && record.blocker?.kind === "other" &&
    REVIEW_ROUND_CEILING_MESSAGES.includes(record.blocker.message);
}

/**
 * The parks the spent-round delivery rule may merge from, by exact message:
 * the reviewed head awaits delivery (REVIEWED) or the base moved after its
 * last review (BASE_MOVED, deliverable only by a moved-base merge of that
 * reviewed head). The message is shape, never authority: the rule itself
 * requires the latest completed review of the exact head and base to leave no
 * unresolved P0/P1, and green required CI on that head. The other parks (no
 * completed review, unresolved P0/P1, no task acceptance) never merge.
 */
export const REVIEW_ROUND_CEILING_DELIVERABLE_MESSAGES: readonly string[] = [
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_REVIEWED,
];

/** True for a REVIEWED or BASE_MOVED ceiling park, exactly. */
export function isDeliverableReviewRoundCeilingPark(
  record: Pick<WorkRecordV1, "nextStep" | "blocker">,
): boolean {
  return record.nextStep === "blocked" && record.blocker?.kind === "other" &&
    REVIEW_ROUND_CEILING_DELIVERABLE_MESSAGES.includes(record.blocker.message);
}
