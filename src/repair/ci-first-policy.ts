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
 * Rollback contract (generation 80, rollback target R79 549c7a691; kept by
 * generation 81, rollback target R80 e48e7e110): nothing here adds a field,
 * key or enum value. The CI fix count is the existing `counters.retries`
 * (every R79 row carries it, no R79 runtime path writes or reads it beyond
 * change detection, and `countRetry` keeps the parser's `retries <= attempts`
 * rule). Older generations did write it and nothing reset it at the CI-first
 * activation, so a live row may start with CI fixes already spent
 * (`CI_FIX_ATTEMPTS`, issue #155). The parks are blockers of the existing
 * `other` kind whose messages match no R79 or L79 re-admission prefix, and
 * the fix marker is an existing `backoff` wait whose `since` equals its
 * `until`.
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
 *
 * The counter is the record's lifetime count, not its count since the
 * CI-first activation. A row whose `retries` an older generation raised
 * starts with those fixes spent (issue #155; at state 719d8f30d
 * issue-ubiquity-sentinel-61 carries 3 and parks
 * `CI fix attempts exhausted (3 of 3)` without a fix, sentinel-76 carries 2
 * and gets one, sentinel-21 carries 1 and gets two). This is kept on
 * purpose: counting only `retry` charges admitted after the activation is
 * not derivable safely, because every implementation admission after the
 * first is a `retry` charge (a P0 correction, a conflict resolution, a
 * retried implementation as well as a CI fix). Resetting such rows is an
 * owner decision.
 */
export const CI_FIX_ATTEMPTS = 3;

/** Bound on waiting for a head's CI to finish before its review. */
export const PRE_REVIEW_CI_BOUND_MS = 6 * 60 * 60_000;

/**
 * Whether a HOSTED run may open the pre-review CI fix route (a fix of a red
 * head no review has completed on: a new candidate, and also a REVIEWED
 * record's refreshed head, since every refreshed head is one no review has
 * completed on). A hosted fix runs as a matrix cell, and a cell planned in
 * one run may be consumed by a later run, which after a failed generation
 * runs the rollback target's code. R79 (549c7a691), the rollback target of
 * generation 80, refused that cell as a generic provenance refusal that would
 * fail every later repair run (tests/host/matrix-ci-first-gen79_test.ts), so
 * generation 80 kept the route closed and parked such a head with
 * `CI_PRE_REVIEW_RED_PREFIX` (live, most refreshes failed on lint drift).
 * Generation 81's rollback target is R80 (e48e7e110), whose consumer isolates
 * every pre-review fix cell generation 81 plans as an authenticated runtime
 * mismatch with the charge kept reserved (same test), and whose own loop
 * parks the CI fix marker precisely, uncharged
 * (tests/repair/ci-first-rollback-gen80_test.ts): generation 81 opens it. A
 * fix is charged in `counters.retries`, never a review round, at most
 * `CI_FIX_ATTEMPTS` per record. The launcher's fix rule re-admits a park R80
 * wrote once this runtime is pinned in `HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`.
 */
export const HOSTED_PRE_REVIEW_CI_FIXES = true;

/**
 * The pre-review CI fix route is open for this run: always in process, and in
 * a hosted (matrix) run once `HOSTED_PRE_REVIEW_CI_FIXES` is set (generation
 * 81).
 */
export function preReviewCiFixRouteOpen(
  deps: { externalImplementations?: boolean },
): boolean {
  return deps.externalImplementations !== true || HOSTED_PRE_REVIEW_CI_FIXES;
}

/**
 * Park of a red head whose CI fixes are spent (by the pre-review gate, or by
 * the merge gate for a reviewed head). No fix and no refresh ever re-admits
 * it; the launcher's once-per-head re-run and green rule take the pre-review
 * gate's park of a head no review has completed on (generation 81).
 */
export const CI_FIX_EXHAUSTED_PREFIX =
  `CI fix attempts exhausted (${CI_FIX_ATTEMPTS} of ${CI_FIX_ATTEMPTS}): `;

/** Park of a red, never-reviewed head waiting for a CI fix route. */
export const CI_PRE_REVIEW_RED_PREFIX =
  "CI red before review; awaiting a CI fix: ";

/** Park of a head whose CI did not finish within `PRE_REVIEW_CI_BOUND_MS`. */
export const CI_PRE_REVIEW_PENDING_PREFIX =
  "CI did not finish before review within 6 hours: ";

/**
 * The two pre-review parks the launcher may re-admit by a CI fix or a
 * moved-base refresh (never the exhausted one, which only its re-run and
 * green rules take).
 */
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

/** Re-observation interval while a head's base itself is red (30 minutes). */
export const RED_BASE_RECHECK_MS = 30 * 60_000;

/**
 * True while `wait` is a red base's hold still running at `now`: a `backoff`
 * whose recheck is `RED_BASE_RECHECK_MS` or more after its start, as every
 * red-base hold's is (the CI-first gate's `base_red`, the pre-review fix's,
 * the pre-merge correction's and the carried gate's each recheck that long
 * after the re-arm, from a start at or before it). No other timed `backoff`
 * is that long, and each of them starts at its own write: the CI fix marker
 * is zero-length, the carried-merge marker four minutes and the merge port's
 * refusal backoff `CHECK_POLL_MS`.
 */
export function isRedBaseHold(wait: WorkWaitV1 | null, now: number): boolean {
  return wait !== null && wait.reason === "backoff" && wait.until !== null &&
    wait.until - wait.since >= RED_BASE_RECHECK_MS && now < wait.until;
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
 * it for the fixed head's review). CI fix charges
 * are not `review_request` admissions and never count as review rounds.
 */
export function reviewRoundAvailable(
  ledger: { readonly reservations: readonly BudgetReservationV1[] },
  record: Parameters<typeof reviewRoundsLeft>[1],
  cutoff?: LegacyCutoff,
): boolean {
  return reviewRoundsLeft(ledger, record, cutoff) > 0 ||
    legacyFinalRoundOpen(ledger, record, cutoff);
}
