/**
 * CI-first pipeline policy (owner decision 2026-10-16): "CI first, then
 * review, then merge." A candidate's required CI must be green before any
 * review is requested. A red head gets charged CI fixes that do NOT count as
 * review rounds. Owner directive 2026-10-30 removed the CI-fix attempt cap:
 * `counters.retries` remains lifetime accounting, but a spent count never
 * parks a record. Review runs only on green heads, and every corrected head
 * passes CI again before its next review.
 *
 * Pure policy shared by the runtime repair loop and the protected launcher:
 * no I/O, no clock, and nothing imported but types and the pure review-round
 * accounting (`review-round-cap.ts`), so the launcher can ship it before the
 * runtime does.
 *
 * Rollback contract (generation 80, rollback target R79 549c7a691; kept by
 * generation 81, rollback target R80 e48e7e110): nothing here adds a field,
 * key or enum value. The CI fix count is the existing `counters.retries`
 * (every R79 row carries it, no R79 runtime path writes or reads it beyond
 * change detection, and `countRetry` keeps the parser's `retries <= attempts`
 * rule). The fix marker is an existing `backoff` wait whose `since` equals
 * its `until`.
 */
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { WorkRecordV1, WorkWaitV1 } from "../contracts/work-record.ts";
import type { LegacyCutoff, reviewRoundsLeft } from "./review-round-cap.ts";

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
 * fix is charged in `counters.retries`, never a review round; the old
 * attempt cap is retired and the count is accounting only. The launcher's fix
 * rule re-admits a park R80 wrote once this runtime is pinned in
 * `HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`.
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
 * Historical blocker text of the retired CI-fix cap. No current path writes
 * it; it is retained so the launcher recognizes and re-admits old parks.
 */
export const CI_FIX_EXHAUSTED_PREFIX = "CI fix attempts exhausted (3 of 3): ";

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

/**
 * A CI fix is still available to this record. Owner directive 2026-10-30
 * retired the attempt cap: `counters.retries` is accounting, never a gate.
 */
export function ciFixesLeft(
  _record:
    & Pick<WorkRecordV1, "counters">
    & Partial<Pick<WorkRecordV1, "repository">>,
): boolean {
  return true;
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
 * A review round is available for the head a CI fix (or a correction)
 * produces. Owner directive 2026-10-30 retired the review-round ceiling, so
 * this is always true; the argument shape is retained for every caller that
 * shared the old ledger count.
 */
export function reviewRoundAvailable(
  _ledger: { readonly reservations: readonly BudgetReservationV1[] },
  _record: Parameters<typeof reviewRoundsLeft>[1],
  _cutoff?: LegacyCutoff,
): boolean {
  return true;
}
