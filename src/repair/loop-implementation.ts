/** Repair loop internals: implementation. */
import type { ModelRunRequestV1 } from "../contracts/ports.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  priorAttemptFactsForRecordV1,
  repositoryPriorFactsForRecordV1,
  repositoryRegressionFactsV1,
} from "./attempt-policy.ts";
import { candidateBranch, implementationIntentKey } from "./keys.ts";
import {
  checkGithubCooldown,
  cooldownProofRef,
  implementationModelId,
  ISSUE_PREREQUISITE_RETRY_MS,
  OPERATION_MARGIN_MS,
  REASONING,
  runBoundsProofRef,
} from "./loop-bounds.ts";
import {
  correctionFindings,
  headRejectedByReview,
} from "./loop-review-records.ts";
import {
  loadSnapshot,
  persistTransition,
  persistWork,
  replaceWorkMutation,
} from "./loop-state.ts";
import { readBase, readIssueForModel } from "./loop-task-context.ts";
import type {
  LoopContextV1,
  PreparedImplementationV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  clearIntent,
  decompositionPartOf,
  decompositionScopeNote,
  markBlocked,
  setIntent,
  setWait,
  startAttempt,
} from "./transitions.ts";

// ---------------------------------------------------------------------------
// Implementation: durable admission, durable intent, then one run.
// ---------------------------------------------------------------------------

export async function prepareImplementationStart(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
  beforeAdmission?: (request: ModelRunRequestV1) => Promise<boolean>,
): Promise<StepResultV1 | PreparedImplementationV1> {
  // No NEW model work after the 90-minute cutoff (or at/after the total run
  // deadline): the start is rejected before any reservation is made (nothing
  // is charged), and the record stays exactly as it was so a later run inside
  // the cutoff starts it. The step is deferred, not terminal, so lower-ranked
  // deterministic work still runs.
  const bounds = context.bounds;
  if (deps.clock.now() >= bounds.modelCutoff) {
    return {
      kind: "deferred",
      detail: "implementation start is past the model cutoff",
    };
  }
  const now = deps.clock.now();
  const bound = config.sessionBound;
  if (bound === null) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "manual", since: now, until: null },
        now,
      ),
    );
  }

  // A cooling installation never reserves a model start: the shared gate is
  // checked before the issue read (the first GitHub prerequisite) and again
  // immediately before the admission below.
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

  // The issue value is read BEFORE the reservation (and after the initial
  // gate): an unavailable issue returns a wait with ZERO reservation/model and
  // never an ambiguous unsent model intent. The value is kept for the model
  // invocation below.
  const issue = await readIssueForModel(deps, record);
  if (issue === "unavailable") {
    // Prerequisite gating (closed/absent issue, unknown relations, parent or
    // open native blocker) defers to the next hour with ZERO reservation and
    // zero model start: a dependency that closes by then, or a source that
    // recovers, is re-read on that poll. Not an indefinite wait.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "unavailable",
          since: now,
          until: now + ISSUE_PREREQUISITE_RETRY_MS,
        },
        now,
      ),
    );
  }

  // Recheck the latest shared gate and the run bounds after this awaited
  // prerequisite: a newly discovered rate limit must never consume an
  // admission, and a start that crossed the cutoff stays deferred with zero
  // reservation.
  const admissionCooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (admissionCooling.kind === "state_error") {
    return { kind: "state_error", detail: admissionCooling.detail };
  }
  if (admissionCooling.kind === "deferred") {
    return { kind: "deferred", detail: admissionCooling.detail };
  }
  // Queued issue work has no saved candidate, checkpoint, PR or open intent:
  // its target base is only the development tip captured at intake, so it may
  // have gone stale while the work waited. Refresh it through the same
  // configured-ref read before any model reservation, so admission and the
  // model request use the CURRENT development base instead of an obsolete one.
  // A base read fault keeps the record, counters and history untouched and
  // defers with the existing bounded unavailable wait (zero reservation).
  if (
    record.source.kind === "issue" &&
    record.target.head === null &&
    record.target.checkpoint === null &&
    record.target.pr === null &&
    record.intent === null
  ) {
    const latestBase = await readBase(deps, record.repository);
    if (latestBase === null) {
      return persistWork(
        deps,
        context,
        setWait(
          record,
          {
            reason: "unavailable",
            since: now,
            until: now + ISSUE_PREREQUISITE_RETRY_MS,
          },
          now,
        ),
      );
    }
    if (latestBase !== record.target.base) {
      // Persist ONLY target.base and updatedAt: the immutable source revision,
      // counters, evidence/history, creation time and every other identity are
      // preserved. The returned progress reloads the authoritative state, so
      // the admission below and the existing cooldown/bounds checks run again
      // against the refreshed record (new base, same identity).
      const refreshed: WorkRecordV1 = {
        ...record,
        target: { ...record.target, base: latestBase },
        updatedAt: deps.clock.now(),
      };
      return persistWork(deps, context, refreshed);
    }
  }

  const startsAt = deps.clock.now();
  if (
    startsAt >= bounds.modelCutoff ||
    startsAt + bound.maxDurationMs + OPERATION_MARGIN_MS > bounds.runDeadline
  ) {
    return {
      kind: "deferred",
      detail:
        "implementation start is past the model cutoff or no longer fits the run bounds",
    };
  }

  const rejectedHead = headRejectedByReview(context.snapshot, record);
  const findings = correctionFindings(context.snapshot, record);
  const part = decompositionPartOf(record.id);
  const priorAttempts = priorAttemptFactsForRecordV1(
    context.snapshot,
    record,
    deps.controllerSha,
  );
  const repositoryLessons = repositoryPriorFactsForRecordV1(
    context.snapshot,
    record,
    deps.controllerSha,
  );
  const regressions = repositoryRegressionFactsV1(
    context.snapshot,
    record.repository,
    deps.controllerSha,
  );
  const request: ModelRunRequestV1 = {
    taskId: record.id,
    repository: record.repository,
    base: record.target.base,
    ...(rejectedHead && record.target.head !== null
      ? { checkoutBase: record.target.head }
      : {}),
    issue,
    evidence: record.evidence,
    ...(findings === null ? {} : { reviewFindings: findings }),
    ...(part === null
      ? {}
      : { scopeNote: decompositionScopeNote(part.index, part.total) }),
    ...(priorAttempts.length === 0 ? {} : { priorAttempts }),
    ...(repositoryLessons.length === 0 ? {} : { repositoryLessons }),
    ...(regressions.length === 0 ? {} : { regressions }),
    model: implementationModelId(deps),
    reasoning: REASONING,
    maxDurationMs: bound.maxDurationMs,
    maxOutputChars: bound.maxOutputChars,
  };
  if (beforeAdmission !== undefined && !await beforeAdmission(request)) {
    return {
      kind: "deferred",
      detail: "implementation cannot fit its immutable dispatch artifact",
    };
  }

  const reservation = await deps.budget.reserveModelStart({
    repository: record.repository,
    taskId: record.id,
    head: record.target.base,
    attempt: record.counters.attempts + 1,
    purpose: record.counters.attempts === 0 ? "implementation" : "retry",
  });
  if (reservation.status === "deferred") {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "budget_cap", since: now, until: reservation.retryAt },
        now,
      ),
    );
  }
  if (
    reservation.status === "duplicate" ||
    reservation.status === "disabled" ||
    reservation.status === "invalid"
  ) {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "unavailable",
        `model admission refused: ${reservation.status}`,
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
        { reason: "unavailable", since: now, until: null },
        now,
      ),
    );
  }
  const durable = reservation;

  // The reservation write moved the state head; reload before persisting intent.
  const fresh = await loadSnapshot(deps, context.bounds);
  if (fresh === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  const current = fresh.snapshot.work.find((work) => work.id === record.id);
  if (current === undefined) {
    return {
      kind: "state_error",
      detail: "work record vanished after admission",
    };
  }

  const attempted = startAttempt(current, deps.clock.now());
  const intent = implementationIntent(
    durable.reservation.id,
    attempted,
    deps.clock.now(),
  );
  const withIntent = setIntent(attempted, intent, deps.clock.now());
  const persisted = await persistTransition(
    deps,
    fresh,
    replaceWorkMutation(withIntent),
  );
  if (persisted.kind !== "progress") return persisted;

  // Recheck the shared gate immediately before the model run: the durable
  // admission and intent writes were awaited wall-clock work. A cooldown
  // discovered now is a KNOWN-NOT-SUBMITTED denial: the start is refunded
  // with the existing confirmed_not_submitted settlement (sanitized cooldown
  // proof ref), the unsent intent is cleared, and the step defers so the
  // already-counted attempt gives the next run a fresh reservation identity.
  const runCooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (runCooling.kind === "state_error") {
    return { kind: "state_error", detail: runCooling.detail };
  }
  if (runCooling.kind === "deferred") {
    // The gate wait itself may have crossed the total run deadline, in which
    // case the denial is a run-bounds fact, not the cooldown: match the
    // refund proof ref and the returned static detail to the actual reason.
    const deadlineCrossed = deps.clock.now() >= context.bounds.runDeadline;
    const refunded = await deps.budget.settleModelStart({
      id: durable.reservation.id,
      outcome: "confirmed_not_submitted",
      proofRef: deadlineCrossed
        ? runBoundsProofRef(durable.reservation.id)
        : cooldownProofRef(durable.reservation.id),
    });
    if (refunded.status !== "settled" && refunded.status !== "idempotent") {
      return {
        kind: "state_error",
        detail: "cooldown admission settlement failed",
      };
    }
    const afterRefund = await loadSnapshot(deps, context.bounds);
    if (afterRefund === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const cleared = clearIntent(withIntent, deps.clock.now());
    const persisted = await persistTransition(
      deps,
      afterRefund,
      replaceWorkMutation(cleared),
    );
    if (persisted.kind !== "progress") return persisted;
    return {
      kind: "deferred",
      detail: deadlineCrossed
        ? "implementation start crossed the run bounds after admission"
        : "github cooldown discovered before model run",
    };
  }

  // Late-admission recheck: the durable admission and intent preparation are
  // awaited wall-clock work, so the cutoff (or the declared-maximum-plus-
  // margin fit) may have been crossed AFTER the entry gate. A start that is
  // provably never submitted is refunded with confirmed_not_submitted (never
  // charged as ambiguous or submitted), its unsent intent is cleared, and the
  // already-counted attempt gives the next run a fresh reservation identity so
  // it resumes without a duplicate start.
  const readyAt = deps.clock.now();
  if (
    readyAt >= bounds.modelCutoff ||
    readyAt + bound.maxDurationMs + OPERATION_MARGIN_MS > bounds.runDeadline
  ) {
    const refunded = await deps.budget.settleModelStart({
      id: durable.reservation.id,
      outcome: "confirmed_not_submitted",
      proofRef: runBoundsProofRef(durable.reservation.id),
    });
    if (refunded.status !== "settled" && refunded.status !== "idempotent") {
      return {
        kind: "state_error",
        detail: "late admission settlement failed",
      };
    }
    const afterRefund = await loadSnapshot(deps, context.bounds);
    if (afterRefund === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const cleared = clearIntent(withIntent, deps.clock.now());
    const persisted = await persistTransition(
      deps,
      afterRefund,
      replaceWorkMutation(cleared),
    );
    if (persisted.kind !== "progress") return persisted;
    return {
      kind: "deferred",
      detail: "implementation start crossed the run bounds after admission",
    };
  }

  return {
    kind: "prepared",
    record: withIntent,
    context: fresh,
    reservationId: durable.reservation.id,
    request,
  };
}

export function implementationIntent(
  reservationId: string,
  record: WorkRecordV1,
  now: number,
) {
  return {
    kind: "implementation" as const,
    key: implementationIntentKey(reservationId),
    startedAt: now,
    branch: candidateBranch(record.id),
    expectedHead: null,
    observedBase: record.target.base,
    pr: null,
    requestId: reservationId,
    resultId: null,
  };
}
