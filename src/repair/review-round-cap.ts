/**
 * The hard review-round ceiling (owner decision 2026-10-16: "ai.ubq.fi issue
 * 684 / PR 1059 reached 44 rounds; 44 rounds is insane, 3 round max").
 *
 * Pure policy shared by the runtime repair loop and the protected launcher:
 * no I/O or clock, so the launcher can ship it before
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
import { hasBlockingSeverity } from "../contracts/review-receipt.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../host/hosted-runtime-rollout.ts";

/**
 * Review rounds a CI-first-era task may spend. Owner decision 2026-10-16 set
 * three; owner decision 2026-10-24 ("you can have up to five reviews") raised
 * it to five after native reviews returned unparseable results on about one
 * attempt in three, each spending a round. See `reviewRoundCeilingFor`.
 */
export const MAX_REVIEW_ROUNDS = 5;

/**
 * The 2026-10-16 ceiling. A record from before the CI-first era keeps it, and
 * the legacy exception is defined against it, so the legacy class, the
 * spent-round delivery rules and every pre-era record behave exactly as they
 * did under three.
 */
export const LEGACY_REVIEW_ROUND_CEILING = 3;

/** Prefix of every ceiling park message; parks are matched by exact text. */
export const REVIEW_ROUND_CEILING_PREFIX = "review round ceiling reached: ";

/** No completed review binds the record's current head. */
export const REVIEW_ROUND_CEILING_UNREVIEWED =
  `${REVIEW_ROUND_CEILING_PREFIX}the current head has no completed review`;
/** The latest completed review of the current head left a P0 unresolved. */
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

/**
 * Parks of the carried-review delivery (`loop-carried-delivery.ts`), each a
 * fixed prefix followed by its exact evidence. None is ever merged by the
 * launcher; each is final for the runtime (no further refresh, fix or review).
 */
/** The reviewed head's own CI stayed pending past the bound (moved base). */
export const REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX =
  `${REVIEW_ROUND_CEILING_PREFIX}the reviewed head's required CI did not finish within 6 hours: `;
/** The refreshed head's patch is not the reviewed patch. */
export const REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX =
  `${REVIEW_ROUND_CEILING_PREFIX}the refreshed head does not carry the reviewed patch: `;
/** The refreshed head's own required CI failed. */
export const REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX =
  `${REVIEW_ROUND_CEILING_PREFIX}the refreshed head's required CI failed: `;
/** The refreshed head's own required CI stayed pending past the bound. */
export const REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX =
  `${REVIEW_ROUND_CEILING_PREFIX}the refreshed head's required CI did not finish within 6 hours: `;
/**
 * The patch proof, the pull request's head, the launcher's carried merge or
 * its delivery record stayed unavailable past the bound.
 */
export const REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX =
  `${REVIEW_ROUND_CEILING_PREFIX}the carried delivery stalled for 6 hours: `;
/**
 * The base moved again after the most mechanical refreshes one reviewed head
 * may be carried through (`CARRIED_REFRESH_LIMIT`).
 */
export const REVIEW_ROUND_CEILING_CARRIED_REFRESH_LIMIT_PREFIX =
  `${REVIEW_ROUND_CEILING_PREFIX}the base moved again after the carried refresh limit: `;
/**
 * The launcher's carried merge landed on another tip than the refreshed
 * head's own base (the tip moved between its uncached re-read and the merge),
 * so the merged tree is not the one the head's CI tested: written by the
 * launcher's delivery pass instead of the delivery record, never delivered.
 */
export const REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX =
  `${REVIEW_ROUND_CEILING_PREFIX}the carried merge landed off its tip: `;

/** Every park message, in a fixed order. */
export const REVIEW_ROUND_CEILING_MESSAGES: readonly string[] = [
  REVIEW_ROUND_CEILING_UNREVIEWED,
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_REVIEWED,
];

/**
 * One-time legacy exception (owner decision 2026-10-16), by rule: ai.ubq.fi
 * issue records whose review rounds were spent under the old
 * review-before-CI order and whose CI is red each get their CI fixes and then
 * exactly ONE final current-head review on the green head.
 *
 * "Spent under the old order" is "admitted before the FIRST CI-first runtime
 * (generation 80) was activated". `cutoff` is ONE instant no later than that
 * first activation: the instant of the launcher commit that pins generation
 * 80's install (`LEGACY_REVIEW_CUTOFF`), written before the install can
 * happen. It is pinned once and never moves: every later CI-first runtime
 * joins the pin's revision list and receives the SAME instant, so a record
 * new under generation 80 is legacy under no later runtime either (round-2
 * recheck P2: a per-revision instant let generation 81's own pin turn
 * generation-80 records legacy and give them a fourth round). The launcher
 * hands it to runs of exactly those revisions; with no cutoff (null) nothing
 * is legacy. A record's pin is the rounds it had spent before the cutoff
 * (`legacyReviewRoundPin`), and the record is in the class once that pin
 * reaches `LEGACY_REVIEW_ROUND_CEILING`:
 *
 * - a record new under the CI-first runtime has no admission before its
 *   activation, so its pin is 0 and it can never get a fourth round;
 * - a record in flight at the activation (in review or delivery on a red
 *   head, live 645, 646, 657, 663 and 1140) carries every round it spent, so
 *   it is covered whatever step it is in, with no table to regenerate;
 * - a round the old runtime admitted after the cutoff (between the pin
 *   commit and the install) is not counted, so that record has spent past
 *   its pin and gets no final round (fails closed; the launcher reports it,
 *   `legacyReviewRoundClassDrift`).
 *
 * The final round is OPEN while the record has spent exactly its pin
 * (`legacyFinalRoundOpen`): only a CI fix may then be admitted for it (the
 * CI fix route acts on a red head alone). It is ARMED once a CI fix (a
 * counted `retry` admission) was charged at or after the cutoff
 * (`legacyFinalRoundArmed`): only then may a review spend it. So a class
 * member whose head is green, or whose latest review left an unresolved
 * P0/P1, gets no further review: its rounds are spent like any other record's.
 */
export interface LegacyReviewCutoffPinV1 {
  /**
   * Epoch milliseconds no later than the FIRST CI-first activation: the
   * instant of the launcher commit that pins generation 80's install. Set
   * once, by that commit; null until then. Never moved by a later pin.
   */
  readonly activatedNotBefore: number | null;
  /**
   * Every CI-first runtime revision (exact, never a generation number) whose
   * runs receive the cutoff: generation 80's, then each later CI-first
   * runtime's, appended by the commit that pins its install. Appending a
   * revision never changes `activatedNotBefore`.
   */
  readonly revisions: readonly string[];
}

/**
 * The one legacy cutoff, pinned by the launcher commit that pins the
 * generation-80 runtime for installation: that commit set the instant (its
 * own, 2026-10-17T17:05:00Z) and the first revision (R80); a later CI-first
 * runtime only appends its revision.
 */
export const LEGACY_REVIEW_CUTOFF: LegacyReviewCutoffPinV1 = {
  activatedNotBefore: 1792256700000,
  revisions: [
    ...new Set([
      // Generation 80 (R80), pinned by its launcher commit at 1792256700000.
      "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481",
      // Generation 81 (R81), pinned by its launcher commit.
      "da98f5f49c45b57cfa97a45fe647c36b1021f302",
      ...HOSTED_RUNTIME_ROLLOUT.legacyReview,
    ]),
  ],
};

/** One recorded execution (release custody or the current run). */
export interface LegacyCutoffExecutionV1 {
  readonly revision: string;
  readonly createdAt: number;
}

/**
 * The legacy cutoff a run of exactly `revision` receives, or null. The
 * revision must be one of the pin's CI-first revisions, and the pinned
 * instant a positive safe integer no later than EVERY recorded execution of
 * ANY of those revisions (`executions`: the current run and release custody):
 * an instant later than one of them is provably not the first CI-first
 * activation bound (for example a later install commit that moved it to its
 * own instant), and then no record is legacy under any revision.
 */
export function legacyReviewCutoffFor(
  revision: string,
  executions: readonly LegacyCutoffExecutionV1[],
  pin: LegacyReviewCutoffPinV1 = LEGACY_REVIEW_CUTOFF,
): number | null {
  const bound = pin.activatedNotBefore;
  if (!validLegacyCutoff(bound) || !pin.revisions.includes(revision)) {
    return null;
  }
  return executions.every((execution) =>
      !pin.revisions.includes(execution.revision) ||
      execution.createdAt >= bound
    )
    ? bound
    : null;
}

/** A cutoff is a positive safe integer epoch instant, or nothing. */
export function validLegacyCutoff(cutoff: unknown): cutoff is number {
  return typeof cutoff === "number" && Number.isSafeInteger(cutoff) &&
    cutoff > 0;
}

const LEGACY_REPOSITORY: RepositoryIdentityV1 = {
  owner: "ubiquity",
  name: "ai.ubq.fi",
  installationId: 155687488,
};

type RoundRecord =
  & Pick<
    WorkRecordV1,
    | "id"
    | "repository"
    | "source"
    | "related"
    | "counters"
    | "intent"
    | "target"
  >
  & Partial<Pick<WorkRecordV1, "createdAt">>;
type Ledger = { readonly reservations: readonly BudgetReservationV1[] };
/** The legacy cutoff an evaluation runs under; absent or null is none. */
export type LegacyCutoff = number | null | undefined;

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

/** Counted (never refunded) admissions of `purpose` for exactly this task. */
function countedCharges(
  snapshot: Ledger,
  record: RoundRecord,
  purpose: BudgetReservationV1["purpose"],
): BudgetReservationV1[] {
  return snapshot.reservations.filter((charge) =>
    charge.purpose === purpose && charge.taskId === record.id &&
    sameRepository(charge.repository, record.repository) &&
    charge.outcome !== "confirmed_not_submitted"
  );
}

/**
 * The record's legacy pin under `cutoff`: the rounds it had spent before the
 * cutoff (its spent rounds less its counted review admissions created at or
 * after the cutoff), when the record is an ai.ubq.fi issue record with at
 * least one counted review admission before the cutoff (so it existed under
 * the old order) and that count reaches `LEGACY_REVIEW_ROUND_CEILING`;
 * otherwise null.
 * A record new under the CI-first runtime has no admission before the cutoff
 * and is never legacy, whatever its counter says.
 */
export function legacyReviewRoundPin(
  snapshot: Ledger,
  record: RoundRecord,
  cutoff: LegacyCutoff,
): number | null {
  if (!validLegacyCutoff(cutoff) || legacyIssue(record) === null) return null;
  const charges = countedCharges(snapshot, record, "review_request").filter(
    (charge) => !nextAdmission(charge, record),
  );
  const after = charges.filter((charge) => charge.createdAt >= cutoff).length;
  if (after === charges.length) return null;
  const pin = reviewRoundsSpent(snapshot, record) - after;
  return pin >= LEGACY_REVIEW_ROUND_CEILING ? pin : null;
}

/**
 * The legacy record's one final round is still unspent: no review was
 * admitted for it at or after the cutoff, so it has spent exactly its pin.
 * Only a CI fix may be admitted on this alone.
 */
export function legacyFinalRoundOpen(
  snapshot: Ledger,
  record: RoundRecord,
  cutoff: LegacyCutoff,
): boolean {
  const pin = legacyReviewRoundPin(snapshot, record, cutoff);
  return pin !== null && reviewRoundsSpent(snapshot, record) === pin;
}

/**
 * The open final round may be spent by a review: a CI fix of this record was
 * admitted (a counted `retry` charge) at or after the cutoff.
 */
export function legacyFinalRoundArmed(
  snapshot: Ledger,
  record: RoundRecord,
  cutoff: LegacyCutoff,
): boolean {
  return legacyFinalRoundOpen(snapshot, record, cutoff) &&
    countedCharges(snapshot, record, "retry").some((charge) =>
      charge.createdAt >= cutoff!
    );
}

/** The merge gate's CI-red blockers (`loop-checks.ts`, `ci-rejection.ts`). */
const CI_RED_PREFIXES = [
  "CI checks failed: ",
  "CI checks failed without base evidence: ",
];

/**
 * The shape of the owner's legacy class as the owner named it (decision-time
 * state, sequence 36388): an ai.ubq.fi issue record parked CI-red by the merge
 * gate whose spent rounds reach `LEGACY_REVIEW_ROUND_CEILING`. Returns those spent
 * rounds, otherwise null. It grants nothing; the launcher compares it with the
 * rule (`legacyReviewRoundClassDrift`).
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
  return spent >= LEGACY_REVIEW_ROUND_CEILING ? spent : null;
}

/**
 * One record of the owner's class shape the rule gives no final round: no
 * pin at all (`unpinned`: fewer than three rounds admitted before the cutoff)
 * or a pin other than its spent rounds (`pin_mismatch`: a round admitted after
 * the cutoff, by the old runtime between the pin commit and the install, or a
 * final round already spent on a head that turned red again).
 */
export interface LegacyReviewRoundDriftV1 {
  id: string;
  issue: number;
  kind: "unpinned" | "pin_mismatch";
  pin: number | null;
  spent: number;
}

/**
 * Every record of the owner's class shape (`legacyReviewRoundClassPin`) whose
 * final round the rule does not keep open under `cutoff`, by issue number.
 * The launcher reports these on every pass so a record the rule leaves out is
 * never silent. Pure; it grants nothing. Empty without a cutoff.
 */
export function legacyReviewRoundClassDrift(
  snapshot: Ledger & {
    readonly work: readonly (
      & RoundRecord
      & Pick<WorkRecordV1, "nextStep" | "blocker">
    )[];
  },
  cutoff: LegacyCutoff,
): LegacyReviewRoundDriftV1[] {
  if (!validLegacyCutoff(cutoff)) return [];
  const drift: LegacyReviewRoundDriftV1[] = [];
  for (const record of snapshot.work) {
    const spent = legacyReviewRoundClassPin(snapshot, record);
    if (spent === null) continue;
    const pin = legacyReviewRoundPin(snapshot, record, cutoff);
    if (pin === spent) continue;
    drift.push({
      id: record.id,
      issue: legacyIssue(record)!,
      kind: pin === null ? "unpinned" : "pin_mismatch",
      pin,
      spent,
    });
  }
  return drift.sort((a, b) => a.issue - b.issue);
}

/**
 * The ordinary ceiling of one record (owner decision 2026-10-24): five for a
 * record of the CI-first era, three for a record created before the pinned
 * CI-first cutoff (`LEGACY_REVIEW_CUTOFF.activatedNotBefore`, 2026-10-17
 * 17:05 UTC), for one with any review admitted before it, and for one whose
 * creation time is not known. The legacy class and its final round are
 * defined only for pre-era records, so they keep their exact rules.
 */
export function reviewRoundCeilingFor(
  snapshot: Ledger,
  record: RoundRecord,
): number {
  const era = LEGACY_REVIEW_CUTOFF.activatedNotBefore;
  const preEra = era === null || typeof record.createdAt !== "number" ||
    record.createdAt < era ||
    countedCharges(snapshot, record, "review_request").some((charge) =>
      charge.createdAt < era!
    );
  return preEra ? LEGACY_REVIEW_ROUND_CEILING : MAX_REVIEW_ROUNDS;
}

/**
 * The record's ceiling: its legacy pin + 1 once that final round is armed,
 * otherwise `reviewRoundCeilingFor`.
 */
export function reviewRoundCeiling(
  snapshot: Ledger,
  record: RoundRecord,
  cutoff?: LegacyCutoff,
): number {
  return legacyFinalRoundArmed(snapshot, record, cutoff)
    ? legacyReviewRoundPin(snapshot, record, cutoff)! + 1
    : reviewRoundCeilingFor(snapshot, record);
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
 * True once the task has spent its ordinary ceiling (`reviewRoundCeilingFor`) by
 * the same count. The spent-round delivery rule qualifies a record on this: a
 * legacy record's one final round is extra, kept for a CI-fixed head.
 */
export function ordinaryReviewRoundsSpent(
  snapshot: Ledger,
  record: RoundRecord,
): boolean {
  return reviewRoundsSpent(snapshot, record) >=
    reviewRoundCeilingFor(snapshot, record);
}

/**
 * Reviews this task may still request: its ceiling (`reviewRoundCeilingFor`)
 * minus the rounds
 * spent, never below zero, or exactly the one final round of a legacy record
 * once a CI fix armed it (`legacyFinalRoundArmed`).
 */
export function reviewRoundsLeft(
  snapshot: Ledger,
  record: RoundRecord,
  cutoff?: LegacyCutoff,
): number {
  if (legacyFinalRoundArmed(snapshot, record, cutoff)) return 1;
  return Math.max(
    0,
    reviewRoundCeilingFor(snapshot, record) -
      reviewRoundsSpent(snapshot, record),
  );
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
 * selects: none (UNREVIEWED); an unresolved P0 or an uncounted finding
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
    hasBlockingSeverity(latest.unresolvedSeverities)
  ) return REVIEW_ROUND_CEILING_REJECTED;
  if (
    record.source.kind === "issue" &&
    (latest.taskAcceptance ?? null)?.verdict !== "fulfilled"
  ) return REVIEW_ROUND_CEILING_UNACCEPTED;
  return REVIEW_ROUND_CEILING_REVIEWED;
}

/**
 * True for a record the ceiling parked: any fixed message, or any message
 * under the ceiling prefix (the carried-delivery parks carry evidence).
 */
export function isReviewRoundCeilingPark(
  record: Pick<WorkRecordV1, "nextStep" | "blocker">,
): boolean {
  return record.nextStep === "blocked" && record.blocker?.kind === "other" &&
    (REVIEW_ROUND_CEILING_MESSAGES.includes(record.blocker.message) ||
      record.blocker.message.startsWith(REVIEW_ROUND_CEILING_PREFIX));
}

/**
 * The parks the spent-round delivery rule may merge from, by exact message:
 * the reviewed head awaits delivery (REVIEWED) or the base moved after its
 * last review (BASE_MOVED, deliverable only by a moved-base merge of that
 * reviewed head). The message is shape, never authority: the rule itself
 * requires the latest completed review of the exact head and base to leave no
 * unresolved P0, and green required CI on that head. The other parks (no
 * completed review, unresolved P0, no task acceptance) never merge.
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
