import { guardQueueOperation } from "./loop-queue-guard.ts";
/** Repair loop internals: review request. */
import type { ReviewObservationV1 } from "../contracts/ports.ts";
import { REVIEW_TASK_SHAPE_DETAIL } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { candidateBranch, reviewOperationKey } from "./keys.ts";
import { prepareExistingPrEffect } from "./loop-existing-pr.ts";
import { hasTakeoverCustody } from "../github/existing-pr-takeover-provenance.ts";
import {
  persistAfterSettlement,
  settleReviewCharge,
} from "./loop-accounting.ts";
import {
  checkGithubCooldown,
  cooldownProofRef,
  OPERATION_MARGIN_MS,
  REVIEW_BOUND_MS,
  REVIEW_POLL_MS,
  runBoundsProofRef,
} from "./loop-bounds.ts";
import { gateReviewOnCi } from "./loop-ci-first.ts";
import { retireClosedPublication } from "./loop-records.ts";
import { reviewRoundCeilingGate } from "./loop-review-round-cap.ts";
import {
  loadSnapshot,
  persistTransition,
  persistWork,
  replaceWorkMutation,
} from "./loop-state.ts";
import {
  ensureReviewFreshness,
  readReviewTaskStatement,
} from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  advanceToReview,
  clearIntent,
  clearWait,
  countReviewRound,
  markBlocked,
  markTerminalBlocked,
  setIntent,
  setWait,
} from "./transitions.ts";

export async function requestReviewFor(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  prNumber: number,
  /**
   * The operation key of a review journal the caller just observed concluded
   * without a verdict: at the ceiling, a review intent bound to it is over.
   */
  concludedKey: string | null = null,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(deps, context, record, "resume");
  if (queueGuard !== null) return queueGuard;
  // The hard review-round ceiling comes first (owner decision 2026-10-16):
  // with no round left nothing is read, reserved or refreshed, and the record
  // parks. Every request path (publication, PR creation, no verdict, expiry,
  // missing acceptance, drain, launcher grants) passes through here.
  const capped = reviewRoundCeilingGate(deps, context, record, concludedKey);
  if (capped !== null) return await capped;
  const now = deps.clock.now();
  // A review request is NEW model work (it consumes the shared model-start
  // budget and starts a reviewer session): at/after the 90-minute cutoff OR
  // the total run deadline (a tighter caller deadline already governs it) it
  // is rejected BEFORE any reservation, and the record stays unchanged so the
  // next run inside the bounds performs it. Deferral never blocks lower-ranked
  // deterministic work (the run continues and ends in the typed margin).
  if (
    now >= context.bounds.modelCutoff ||
    now >= context.bounds.runDeadline
  ) {
    return {
      kind: "deferred",
      detail: "review request is past the run bounds",
    };
  }
  const head = record.target.head!;
  // The round this request consumes is the attempt's durable identity: round
  // one is the original request for this head, and a later round is a distinct
  // operation with its own key, reservation and journal.
  const operationKey = reviewOperationKey(
    prNumber,
    head,
    record.counters.reviewRounds + 1,
  );

  // A cooling installation never reserves a review request: the shared gate is
  // checked immediately before the admission (the only awaited prerequisite is
  // the bounds check already done above).
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
  // THE one pre-budget freshness gate for every successful push, PR creation
  // and recovered push: the exact candidate must be the ACTUAL published
  // branch/PR head with a matching preservation descriptor, and the configured
  // base must still be the target base before any review reservation exists.
  const freshness = await ensureReviewFreshness(
    deps,
    context,
    record,
    prNumber,
  );
  if (freshness === "closed_unmerged") {
    // Only the publication identity is retired: the preserved candidate, the
    // target head, the base and every counter stay exactly as they were, so
    // the next publish step creates the replacement pull request for the same
    // reviewed bytes. No model, review or merge effect happens here.
    return persistWork(
      deps,
      context,
      retireClosedPublication(record, deps.clock.now()),
    );
  }
  if (freshness !== null) return freshness;
  // CI first (owner decision 2026-10-16): the exact fresh head is reviewed
  // only once its required CI is green. Pending CI waits (bounded), a red
  // head routes to its CI fix or a precise park, a red base backs off; none
  // of them reserves a review or counts a round.
  const gated = await gateReviewOnCi(deps, context, record);
  if (gated !== null) return gated;
  // The cooling check was awaited wall-clock work and only guards the total
  // deadline: recheck the 90-minute model cutoff (and the deadline) at the
  // current clock immediately before the admission, so a start that crossed
  // the bounds stays deferred with zero reservation.
  const requestAt = deps.clock.now();
  if (
    requestAt >= context.bounds.modelCutoff ||
    requestAt >= context.bounds.runDeadline
  ) {
    return {
      kind: "deferred",
      detail: "review request is past the run bounds",
    };
  }

  // The FULL structured-review bound must fit before the loop deadline's
  // reserved finalization margin, and no review may be admitted in the last
  // seconds merely because now < deadline. latestStartAt is additionally
  // bounded by the ORIGINAL run model cutoff, so a shortened loop deadline
  // never shifts that cutoff later. Both bounds flow through the submission,
  // the transport and the producer, which rechecks them after the snapshot,
  // after preparation and after the running-journal readback — immediately
  // before the single start.
  const latestStartAt = Math.min(
    context.bounds.modelCutoff,
    context.bounds.runDeadline - OPERATION_MARGIN_MS - REVIEW_BOUND_MS,
  );
  const settleBy = latestStartAt + REVIEW_BOUND_MS;
  if (requestAt >= latestStartAt) {
    return {
      kind: "deferred",
      detail: "review request cannot fit the remaining run bounds",
    };
  }

  // The independent review must judge the EXACT live source-issue task, not
  // only the change. The bounded, digest-bound statement is read BEFORE any
  // admission, so an issue-backed request is never submitted without the
  // criterion its acceptance will be bound to (and never charged for a review
  // that could not establish task completion). Work without a source issue
  // carries no statement and keeps the unchanged change-only review contract.
  const task = await readReviewTaskStatement(deps, record);
  if (task === "read_failed") {
    return {
      kind: "deferred",
      detail: "review task statement read is unavailable",
    };
  }
  if (task === "not_open") {
    // There is no live task to deliver against: the issue is closed or gone.
    // No task-bound review can be requested, so the record is parked with an
    // explicit stale-source blocker instead of spending a review or merging.
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "stale_source",
        "source issue is not open: no task-bound review can be requested",
        deps.clock.now(),
      ),
    );
  }
  if (task === "malformed") {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "missing_evidence",
        REVIEW_TASK_SHAPE_DETAIL,
        deps.clock.now(),
      ),
    );
  }

  // Review requests share the one rolling model-start budget: durable
  // admission precedes invocation, with a deterministic task/head/round
  // identity, so observation/recovery never resubmits or adds a second
  // charge. No budget bypass exists here — requestReview is a GitHubPort
  // method and admission failure simply prevents invocation.
  const queueBeforeAdmission = await guardQueueOperation(
    deps,
    context,
    record,
    "resume",
  );
  if (queueBeforeAdmission !== null) return queueBeforeAdmission;
  const reservation = await deps.budget.reserveModelStart({
    repository: record.repository,
    taskId: record.id,
    head,
    attempt: record.counters.reviewRounds + 1,
    purpose: "review_request",
  });
  if (reservation.status === "deferred") {
    // Quota exhaustion is the explicit TRANSIENT state, never a terminal
    // block: the record keeps its publication and the review-drain pass
    // retries it (oldest/highest-priority first) when the budget returns.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "review_quota", since: now, until: reservation.retryAt },
        now,
      ),
    );
  }
  if (
    reservation.status === "duplicate" &&
    reservation.reservation.outcome !== "reserved"
  ) {
    // The same review identity was already admitted and settled, but its
    // operation intent is gone: a state contradiction, never a re-invocation.
    // The publication identity is dead, so the block clears it.
    return persistWork(
      deps,
      context,
      markTerminalBlocked(
        record,
        "unavailable",
        "review admission already settled without an intent",
        now,
      ),
    );
  }
  if (reservation.status === "disabled" || reservation.status === "invalid") {
    return persistWork(
      deps,
      context,
      markTerminalBlocked(
        record,
        "unavailable",
        `review admission refused: ${reservation.status}`,
        now,
      ),
    );
  }
  if (
    reservation.status === "conflict" ||
    reservation.status === "ambiguous" ||
    reservation.status === "unavailable"
  ) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "review_quota",
          since: now,
          until: now + REVIEW_POLL_MS,
        },
        now,
      ),
    );
  }
  // admitted, or duplicate whose prior reservation is still reserved: the
  // identical admission is completed exactly once, never charged twice.
  const reservationId = reservation.reservation.id;

  // The admission write moved the state head; reload before persisting intent.
  const fresh = await loadSnapshot(deps, context.bounds);
  if (fresh === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  const current = fresh.snapshot.work.find((work) => work.id === record.id);
  if (current === undefined) {
    return {
      kind: "state_error",
      detail: "work record vanished after review admission",
    };
  }
  const admittedGuard = await guardQueueOperation(
    deps,
    fresh,
    current,
    "resume",
  );
  if (admittedGuard !== null) return admittedGuard;

  const intent = {
    kind: "review_request" as const,
    key: operationKey,
    startedAt: now,
    branch: hasTakeoverCustody(record)
      ? record.target.branch
      : candidateBranch(record.id),
    expectedHead: head,
    observedBase: current.target.base,
    pr: prNumber,
    requestId: reservationId,
    resultId: null,
  };
  const withIntent = setIntent(current, intent, now);
  const persisted = await persistTransition(
    deps,
    fresh,
    replaceWorkMutation(withIntent),
  );
  if (persisted.kind !== "progress") return persisted;
  const intendedGuard = await guardQueueOperation(
    deps,
    fresh,
    withIntent,
    "resume",
  );
  if (intendedGuard !== null) return intendedGuard;

  // Recheck the shared gate immediately before the requestReview call: the
  // reservation and intent writes were awaited wall-clock work. A cooldown
  // discovered now is a known-not-submitted denial: the admission is refunded
  // with the existing confirmed_not_submitted settlement (sanitized cooldown
  // proof ref), the unsent intent is cleared, and the prepared round gives the
  // next run a fresh reservation identity so it resumes without a duplicate
  // start.
  const beforeSubmit = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (beforeSubmit.kind === "state_error") {
    return { kind: "state_error", detail: beforeSubmit.detail };
  }
  if (beforeSubmit.kind === "deferred") {
    // The gate wait itself may have crossed the total run deadline, in which
    // case the denial is a run-bounds fact, not the cooldown: match the
    // refund proof ref and the returned static detail to the actual reason.
    const deadlineCrossed = deps.clock.now() >= context.bounds.runDeadline;
    const refunded = await settleReviewCharge(
      deps,
      context,
      reservationId,
      "confirmed_not_submitted",
      deadlineCrossed
        ? runBoundsProofRef(reservationId)
        : cooldownProofRef(reservationId),
    );
    if (refunded.kind !== "progress") return refunded;
    const cleared = countReviewRound(
      clearIntent(withIntent, deps.clock.now()),
      deps.clock.now(),
    );
    const persistedClear = await persistAfterSettlement(
      deps,
      context.bounds,
      replaceWorkMutation(cleared),
    );
    if (persistedClear.kind !== "progress") return persistedClear;
    return {
      kind: "deferred",
      detail: deadlineCrossed
        ? "review request crossed the run bounds after admission"
        : "github cooldown discovered before review request",
    };
  }

  // Late-admission recheck AFTER the final beforeSubmit gate: the gate wait is
  // awaited wall-clock work, so the review's latest admissible start instant
  // (bounded by the ORIGINAL model cutoff and the loop deadline minus the full
  // review bound and finalization margin) OR the total run deadline may have
  // been crossed with the grant. A review start that is provably never
  // submitted is refunded with confirmed_not_submitted, its unsent intent is
  // cleared, and the round counter it already prepared gives the next run a
  // fresh reservation identity so it resumes without a duplicate start.
  if (
    deps.clock.now() >= latestStartAt ||
    deps.clock.now() >= context.bounds.runDeadline
  ) {
    const refunded = await settleReviewCharge(
      deps,
      context,
      reservationId,
      "confirmed_not_submitted",
      runBoundsProofRef(reservationId),
    );
    if (refunded.kind !== "progress") return refunded;
    const cleared = countReviewRound(
      clearIntent(withIntent, deps.clock.now()),
      deps.clock.now(),
    );
    const persistedClear = await persistAfterSettlement(
      deps,
      context.bounds,
      replaceWorkMutation(cleared),
    );
    if (persistedClear.kind !== "progress") return persistedClear;
    return {
      kind: "deferred",
      detail: "review request crossed the run bounds after admission",
    };
  }

  const submitGuard = await guardQueueOperation(
    deps,
    fresh,
    withIntent,
    "resume",
  );
  if (submitGuard !== null) return submitGuard;

  // Invocation happens strictly after the durable intent exists.
  const custody = await prepareExistingPrEffect(deps, fresh, withIntent, {
    operation: "review",
    ...(task === null ? {} : { taskDigest: task.digest }),
  });
  const submitted = custody.ok
    ? await deps.github.requestReview({
      prNumber,
      expectedHead: head,
      expectedBase: current.target.base,
      expectedReviewer: deps.github.reviewerIdentity,
      operationKey,
      latestStartAt,
      settleBy,
      task,
    }, custody.value)
    : custody;
  if (!submitted.ok) {
    // The response may have been lost after submission: the start stays
    // charged as ambiguous and the saved intent makes the next run observe
    // the exact remote review state instead of resubmitting.
    const settled = await settleReviewCharge(
      deps,
      context,
      reservationId,
      "ambiguous",
    );
    if (settled.kind !== "progress") return settled;
    return { kind: "progress" }; // observed next run; never re-request blindly
  }
  if (submitted.value.outcome === "ambiguous") {
    const settled = await settleReviewCharge(
      deps,
      context,
      reservationId,
      "ambiguous",
    );
    if (settled.kind !== "progress") return settled;
    return { kind: "progress" }; // observed next run; never re-request blindly
  }
  const settled = await settleReviewCharge(
    deps,
    context,
    reservationId,
    "submitted",
  );
  if (settled.kind !== "progress") return settled;
  return persistAfterSettlement(
    deps,
    context.bounds,
    replaceWorkMutation(
      advanceToReview(
        countReviewRound(clearIntent(withIntent, now), now),
        { pr: prNumber, head },
        {
          reason: "review_pending",
          since: submitted.value.requestedAt,
          until: Math.max(now, submitted.value.requestedAt) + REVIEW_POLL_MS,
        },
        now,
      ),
    ),
  );
}

/**
 * One bounded recovery step for an attempt that produced no accepted verdict.
 *
 * A no-verdict attempt is not a pass and not a rejection: the exact head stays
 * recorded, the bounded static reason stays observable, and — while the
 * task's review-round allowance remains — one fresh attempt is requested for
 * the same head as a new, separately charged operation. Once the allowance is
 * spent the request's ceiling gate parks the record instead of polling a
 * terminal disposition or charging another round. A review intent still
 * bound to the concluded journal (`operationKey`, the identity it was read
 * under) is recovered by that park, counted once and cleared (issue #155).
 */
export async function recoverFromNoVerdictReview(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  pr: number,
  _value: ReviewObservationV1,
  operationKey: string | null = null,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  // Each round is its own durable, uniquely admitted review request, bounded
  // by the hard ceiling in requestReviewFor (owner decision 2026-10-16: three
  // rounds; ai.ubq.fi 684 / PR 1059 re-requested 35 no-verdict rounds here).
  // A record is never merged because a round count ran out.
  return await requestReviewFor(
    deps,
    context,
    clearWait(record, now),
    pr,
    operationKey,
  );
}
