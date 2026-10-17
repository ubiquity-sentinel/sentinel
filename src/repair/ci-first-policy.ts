/**
 * CI-first pipeline policy (owner decision 2026-10-16): "CI first, then
 * review, then merge." A candidate's required CI must be green before any
 * review is requested. A red head gets charged CI fixes that do NOT count as
 * review rounds, at most `CI_FIX_ATTEMPTS` per record, after which the record
 * parks with a precise blocker and nothing more is spent on it. Review runs
 * only on green heads, and every corrected head passes CI again before its
 * next review.
 *
 * Pure policy shared by the runtime repair loop and the protected launcher:
 * no I/O, no clock, and nothing imported but types and the pure review-round
 * ceiling (`review-round-cap.ts`, which owns the round count and the one
 * legacy rule), so the launcher can ship it before the runtime does.
 *
 * Rollback contract (generation 80, rollback target R79 549c7a691): nothing
 * here adds a field, key or enum value. The CI fix count is the existing
 * `counters.retries` (every R79 row carries it, no R79 runtime path writes or
 * reads it beyond change detection, and `countRetry` keeps the parser's
 * `retries <= attempts` rule). The parks are blockers of the existing `other`
 * kind whose messages match no R79 or L79 re-admission prefix, and the fix
 * marker is an existing `backoff` wait whose `since` equals its `until`.
 */
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { WorkRecordV1, WorkWaitV1 } from "../contracts/work-record.ts";
import {
  type LegacyCutoff,
  legacyFinalRoundOpen,
  MAX_REVIEW_ROUNDS,
  reviewRoundsLeft,
} from "./review-round-cap.ts";

/**
 * Review rounds a record may spend (owner decision 2026-10-16: 3, hard): the
 * review-round ceiling itself, never a second constant.
 */
export const CI_FIRST_REVIEW_ROUNDS = MAX_REVIEW_ROUNDS;

/**
 * CI fixes one record may spend, counted in `counters.retries` and never
 * lowered. An admission refunded as provably never submitted still counts:
 * at most three fixes ever run.
 */
export const CI_FIX_ATTEMPTS = 3;

/** Bound on waiting for a head's CI to finish before its review. */
export const PRE_REVIEW_CI_BOUND_MS = 6 * 60 * 60_000;

/**
 * Whether a HOSTED run may open the pre-review CI fix route (a fix of a red
 * head no review has completed on). A hosted fix runs as a matrix cell, and a
 * cell planned in one run may be consumed by a later run, which after a
 * failed generation runs the rollback target's code. R79 (549c7a691), the
 * rollback target of generation 80, refuses a CI fix cell for a never-reviewed
 * head as a generic provenance refusal that would fail every later repair run
 * (tests/host/matrix-ci-first-gen79_test.ts), so generation 80 keeps this
 * route closed in hosted runs: a red, never-reviewed head parks there with
 * `CI_PRE_REVIEW_RED_PREFIX` until a generation whose rollback target carries
 * generation 80's consumer opens it. In-process runs never plan a cell.
 * Every refreshed head is a head no review has completed on, so a REVIEWED
 * record whose refreshed head is red parks there too (live, most refreshes
 * failed on lint drift). Generation 81 (R80 as its rollback target, this flag
 * true, its runtime in `HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`) is therefore a
 * ship condition of generation 80: its fix rule re-admits those parks through
 * the CI fix marker (tests/repair/ci-first-refresh-red_test.ts).
 */
export const HOSTED_PRE_REVIEW_CI_FIXES = false;

/**
 * The pre-review CI fix route is open for this run: always in process, and in
 * a hosted (matrix) run only once `HOSTED_PRE_REVIEW_CI_FIXES` is set.
 */
export function preReviewCiFixRouteOpen(
  deps: { externalImplementations?: boolean },
): boolean {
  return deps.externalImplementations !== true || HOSTED_PRE_REVIEW_CI_FIXES;
}

/** Terminal park of a red head whose CI fixes are spent; nothing matches it. */
export const CI_FIX_EXHAUSTED_PREFIX =
  `CI fix attempts exhausted (${CI_FIX_ATTEMPTS} of ${CI_FIX_ATTEMPTS}): `;

/** Park of a red, never-reviewed head waiting for a CI fix route. */
export const CI_PRE_REVIEW_RED_PREFIX =
  "CI red before review; awaiting a CI fix: ";

/** Park of a head whose CI did not finish within `PRE_REVIEW_CI_BOUND_MS`. */
export const CI_PRE_REVIEW_PENDING_PREFIX =
  "CI did not finish before review within 6 hours: ";

/** The two pre-review parks the launcher may re-admit (never the exhausted). */
export const CI_PRE_REVIEW_PARK_PREFIXES: readonly string[] = [
  CI_PRE_REVIEW_RED_PREFIX,
  CI_PRE_REVIEW_PENDING_PREFIX,
];

/** A CI fix is still available to this record. */
export function ciFixesLeft(record: Pick<WorkRecordV1, "counters">): boolean {
  return record.counters.retries < CI_FIX_ATTEMPTS;
}

/**
 * The CI fix marker: a red, never-reviewed head returned to `work` to await
 * its live-confirmed fix carries a zero-length `backoff` wait. No other path
 * writes a `backoff` whose `since` equals its `until`.
 */
export function ciFixMarker(now: number): WorkWaitV1 {
  return { reason: "backoff", since: now, until: now };
}

/** True for the CI fix marker wait. */
export function isCiFixMarker(wait: WorkWaitV1 | null): boolean {
  return wait !== null && wait.reason === "backoff" && wait.until !== null &&
    wait.since === wait.until;
}

/**
 * One-time legacy exception (owner decision 2026-10-16): ai.ubq.fi records
 * that spent their review rounds under the old review-before-CI order and are
 * on a red head. Each gets its CI fixes and then exactly ONE final
 * current-head review on the green head. The class and the count are the
 * review-round ceiling's own rule (`legacyReviewRoundPin`,
 * `legacyFinalRoundOpen`, `legacyFinalRoundArmed` and `reviewRoundsLeft` in
 * `review-round-cap.ts`): at least three rounds admitted before the CI-first
 * runtime's activation (`cutoff`, handed to the runtime by the launcher that
 * pinned it), counted over the durable ledger, so the final review spends the
 * round and a record that spent past its pin gets nothing.
 *
 * A review round is left for the head a CI fix (or a correction) produces
 * exactly when that count leaves one: fewer than `CI_FIRST_REVIEW_ROUNDS`
 * spent, or a legacy record whose final round is still open (a CI fix arms
 * it for the fixed head's review). CI fix charges are not `review_request`
 * admissions and never count as review rounds.
 */
export function reviewRoundAvailable(
  ledger: { readonly reservations: readonly BudgetReservationV1[] },
  record: Parameters<typeof reviewRoundsLeft>[1],
  cutoff?: LegacyCutoff,
): boolean {
  return reviewRoundsLeft(ledger, record, cutoff) > 0 ||
    legacyFinalRoundOpen(ledger, record, cutoff);
}
