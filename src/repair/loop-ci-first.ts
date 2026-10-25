/**
 * Repair loop internals: the CI-first review gate (owner decision 2026-10-16,
 * "CI first, then review, then merge").
 *
 * `requestReviewFor` calls `gateReviewOnCi` after its freshness gate (so the
 * head is the exact published candidate on the current base) and before any
 * review reservation. It is the one choke point every review request passes
 * (publication, new pull request, recovered push, no-verdict re-request,
 * missing-review recovery, expired observation and post-drain), so no review
 * is ever requested for a head whose required CI is not green:
 *
 * - green, with every expected check present: the review proceeds exactly
 *   as before. Expected are the check names of each base check suite that
 *   shares a name with the head (`absentExpectedChecks`, sentinel issue
 *   #154): GitHub creates a `needs:` job's check run only once its
 *   dependencies finish, so green existing runs alone are not green CI;
 * - running, absent or not yet created checks (or a base whose runs cannot
 *   be read to tell), an Actions run whose job never started (a billing or
 *   spending-limit stop, on the head or the base: no evidence either way),
 *   a failed check still running on the base, or a failure
 *   no base evidence attributes (the base check was cancelled, absent or
 *   inconclusive, or the head's own check never concluded): a bounded
 *   `ci_pending` wait (`since` kept across polls) and, for a never-reviewed
 *   head, a precise park after `PRE_REVIEW_CI_BOUND_MS` that the launcher's
 *   re-run and green rules re-admit; meanwhile a moved base refreshes the
 *   head at its next poll;
 * - a candidate-caused failure: the exhausted park once `CI_FIX_ATTEMPTS` are
 *   spent; a head reviewed clean on this base returns to `work` for the
 *   existing CI correction; a never-reviewed head gets the CI fix marker where
 *   the pre-review route is open (`preReviewCiFixRouteOpen`), and otherwise
 *   parks awaiting a CI fix;
 * - a red base: a 30-minute `backoff`, nothing charged.
 *
 * A head already reviewed clean on this base (the re-request after a missing
 * task acceptance, the only reviewed head that asks for another review) waits
 * where it is and never parks: at `work` it would read as awaiting a CI
 * correction (`headAwaitsCiCorrection`, identical in R79) whose non-failing
 * exit delivers it to a merge gate that refuses the missing acceptance on
 * every run, and every CI park can be returned to `work` or to `delivery` by
 * the launcher.
 *
 * No path here reserves anything or moves a counter: a CI fix is charged only
 * at its own admission (`counters.retries` through `countRetry`), after the
 * failure is re-derived from live check runs (`confirmPreReviewCiFix`).
 */
import { ownBaseRed } from "./base-repair.ts";
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1, WorkWaitV1 } from "../contracts/work-record.ts";
import {
  attributeFailedChecks,
  checkPending,
  ciCorrectable,
  ciCorrectionFinding,
  ciCorrectionRouteOpen,
  ciFixExhaustedDetail,
  decideCiDisposition,
  failedChecks,
  latestChecks,
  preReviewAbsentDetail,
  preReviewPendingDetail,
  preReviewRedDetail,
  preReviewUnattributedDetail,
} from "./ci-rejection.ts";
import {
  ciFixesLeft,
  ciFixMarker,
  PRE_REVIEW_CI_BOUND_MS,
  preReviewCiFixRouteOpen,
} from "./ci-first-policy.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { absentExpectedChecks, decideCiGate } from "./loop-checks.ts";
import {
  observeHeadFailure,
  RED_BASE_RECHECK_MS,
  waitSince,
} from "./loop-ci-correction.ts";
import {
  headAcceptedByReview,
  headAwaitsPreReviewCiFix,
} from "./loop-review-records.ts";
import { legacyCutoff } from "./loop-review-round-cap.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  advanceToCorrection,
  clearWait,
  markBlocked,
  setWait,
} from "./transitions.ts";

const UNAVAILABLE: StepResultV1 = {
  kind: "deferred",
  detail: "CI check observation unavailable",
};

/** Back at `work` with exactly this wait (no blocker, no intent change). */
function atWork(
  record: WorkRecordV1,
  wait: WorkWaitV1,
  now: number,
): WorkRecordV1 {
  return setWait(advanceToCorrection(record, now), wait, now);
}

/**
 * Hold the head for its CI with exactly this wait. A head reviewed clean on
 * this base keeps its current step (`review` for the missing-acceptance
 * re-request, whose next observation re-requests the task-bound review
 * through this gate): at `work` it would read as awaiting a CI correction.
 * Any other head waits at `work`, where its publication step gates it again.
 */
function holdForCi(
  context: LoopContextV1,
  record: WorkRecordV1,
  wait: WorkWaitV1,
  now: number,
): WorkRecordV1 {
  return headAcceptedByReview(context.snapshot, record)
    ? setWait(record, wait, now)
    : atWork(record, wait, now);
}

/**
 * The bounded pre-review CI wait: re-polled every `CHECK_POLL_MS` with its
 * original `since`, and parked with `detail` once `PRE_REVIEW_CI_BOUND_MS`
 * has passed. A head reviewed clean on this base is never parked (see
 * `holdForCi`): its missing-acceptance recovery re-polls it like R79 does.
 */
function awaitChecks(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  checks: readonly GitHubCheckV1[],
  now: number,
  detail: (checks: readonly GitHubCheckV1[]) => string = preReviewPendingDetail,
): Promise<StepResultV1> {
  const since = waitSince(record, "ci_pending", now);
  if (
    now - since >= PRE_REVIEW_CI_BOUND_MS &&
    !headAcceptedByReview(context.snapshot, record)
  ) {
    return persistWork(
      deps,
      context,
      markBlocked(record, "other", detail(checks), now),
    );
  }
  return persistWork(
    deps,
    context,
    holdForCi(context, record, {
      reason: "ci_pending",
      since,
      until: deps.clock.now() + CHECK_POLL_MS,
    }, now),
  );
}

/** A candidate-caused failure on the head a review was about to judge. */
function routeCandidateFailure(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  checks: readonly GitHubCheckV1[],
  now: number,
): Promise<StepResultV1> {
  if (!ciFixesLeft(record)) {
    return persistWork(
      deps,
      context,
      markBlocked(record, "other", ciFixExhaustedDetail(checks), now),
    );
  }
  // A head already reviewed clean against this base (a re-request after a
  // missing task acceptance) takes the existing CI correction route; if its
  // failure is gone by the correction's admission, `confirmCiCorrection`
  // returns it to `review`, never to the merge gate that refuses it. (R79
  // runs the same correction while the failure persists; only a failure
  // that clears between a rollback and that admission reaches R79's own
  // non-failing exit into delivery.)
  if (
    ciCorrectionRouteOpen(deps) &&
    ciCorrectable(record, context.snapshot, legacyCutoff(context)) &&
    headAcceptedByReview(context.snapshot, record)
  ) {
    return persistWork(deps, context, advanceToCorrection(record, now));
  }
  // Any other red head has no completed review: a new candidate, and also a
  // REVIEWED record's refreshed head. Both take the CI fix marker where the
  // pre-review fix route is open (in process, and hosted from generation 81)
  // and park where it is closed (hosted generation 80, or no fix or round
  // left by the ceiling's own count).
  const marked = atWork(record, ciFixMarker(now), now);
  if (
    headAwaitsPreReviewCiFix(
      context.snapshot,
      marked,
      preReviewCiFixRouteOpen(deps),
      legacyCutoff(context),
    )
  ) return persistWork(deps, context, marked);
  return persistWork(
    deps,
    context,
    markBlocked(record, "other", preReviewRedDetail(checks), now),
  );
}

/**
 * The CI-first gate over the record's exact published head on its current
 * base. Null means CI is green and the review request may proceed; anything
 * else is the step result (a wait, a fix marker or a park), with nothing
 * reserved and no counter moved.
 */
export async function gateReviewOnCi(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  const head = record.target.head;
  if (head === null) {
    return { kind: "deferred", detail: "review requires a published head" };
  }
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  const now = deps.clock.now();
  const observed = await deps.github.readChecks(head);
  if (!observed.ok) return UNAVAILABLE;
  const checks = observed.value.checks;
  const decision = decideCiGate(checks);
  if (decision === "proceed") {
    // Every existing run is green; the jobs GitHub has not created yet are
    // awaited like running ones (bounded, uncharged, the same park prefix),
    // and so is a base whose runs cannot be read (no evidence either way).
    const absent = await absentExpectedChecks(deps, record, checks);
    if (absent !== null && absent.length === 0) return null;
    return awaitChecks(
      deps,
      context,
      record,
      [],
      now,
      () => preReviewAbsentDetail(absent),
    );
  }
  if (decision === "wait") {
    return awaitChecks(
      deps,
      context,
      record,
      latestChecks(checks).filter(checkPending),
      now,
    );
  }
  const failed = failedChecks(checks);
  // Only the failed names are attributed, so only they are read on the base:
  // an unrelated base run over the strict bounds (the self `development`
  // tip's `matrix_cell (<cellId>)` runs) cannot defer a red head forever.
  const base = await deps.github.readChecks(
    record.target.base,
    new Set(failed.map((check) => check.name)),
  );
  if (!base.ok) return UNAVAILABLE;
  const disposition = await ownBaseRed(
    deps,
    record,
    decideCiDisposition(attributeFailedChecks(failed, base.value.checks)),
    failed,
  );
  switch (disposition.kind) {
    case "candidate":
      return routeCandidateFailure(
        deps,
        context,
        record,
        disposition.checks,
        now,
      );
    case "base_pending":
      return awaitChecks(deps, context, record, failed, now);
    case "base_red":
      // The same check is red on the base: no fix can make it green, so
      // nothing is charged; a later base move refreshes the head first.
      return persistWork(
        deps,
        context,
        holdForCi(context, record, {
          reason: "backoff",
          since: waitSince(record, "backoff", now),
          until: deps.clock.now() + RED_BASE_RECHECK_MS,
        }, now),
      );
    case "unattributed":
      // No base evidence (a cancelled, absent or inconclusive base check, or
      // a head check that never concluded) proves nothing about the
      // candidate: it is awaited like a running base check, uncharged and
      // bounded, never a terminal block no launcher rule could re-admit.
      return awaitChecks(
        deps,
        context,
        record,
        disposition.checks,
        now,
        preReviewUnattributedDetail,
      );
  }
}

/**
 * Admission-time re-derivation for a red, never-reviewed head carrying the CI
 * fix marker (`headAwaitsPreReviewCiFix`). Only a live candidate-caused
 * failure yields the fix finding; an unavailable read defers without
 * mutation. A head that is no longer failing loses the marker uncharged (its
 * publication step then gates it again and requests the review once green),
 * a failure still running on the base or one no base evidence attributes
 * waits (the gate then bounds that wait), and a red base backs off.
 */
export async function confirmPreReviewCiFix(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<
  | {
    kind: "confirmed";
    finding: { severity: string; path: string | null; message: string };
  }
  | StepResultV1
> {
  const observed = await observeHeadFailure(deps, record);
  if (observed === null) return UNAVAILABLE;
  const now = deps.clock.now();
  switch (observed.kind) {
    case "candidate":
      return {
        kind: "confirmed",
        finding: ciCorrectionFinding(record.target.base, observed.checks),
      };
    case "clean":
      return persistWork(deps, context, clearWait(record, now));
    case "base_pending":
    case "unattributed":
      return persistWork(
        deps,
        context,
        atWork(record, {
          reason: "ci_pending",
          since: now,
          until: now + CHECK_POLL_MS,
        }, now),
      );
    case "base_red":
      return persistWork(
        deps,
        context,
        atWork(record, {
          reason: "backoff",
          since: now,
          until: now + RED_BASE_RECHECK_MS,
        }, now),
      );
  }
}
