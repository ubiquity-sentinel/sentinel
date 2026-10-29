import { routeExistingPr } from "./loop-existing-pr.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
/** Repair loop internals: work. */
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
  implementationPortFailureDetail,
} from "./attempt-policy.ts";
import { candidateBranch } from "./keys.ts";
import {
  ensureBaseRefreshIntent,
  executeBaseRefreshIntent,
} from "./loop-base-refresh.ts";
import {
  MATRIX_ARTIFACT_DEFERRED,
  MATRIX_IMPLEMENTATION_DEFERRED,
} from "./loop-bounds.ts";
import { ciCorrectionRouteOpen } from "./ci-rejection.ts";
import { preReviewCiFixRouteOpen } from "./ci-first-policy.ts";
import {
  conflictResolutionAdmissible,
  conflictResolutionRouteOpen,
} from "./conflict-resolution.ts";
import { correctFailedHeadBeforeRefresh } from "./loop-ci-correction.ts";
import { executeConflictResolutionStep } from "./loop-conflict-resolution.ts";
import { retryAlreadySatisfiedClosure, retryClosure } from "./loop-closure.ts";
import { ensureEvidence } from "./loop-evidence.ts";
import {
  handleImplementationUncertainty,
  handleModelReceipt,
  settleFailedImplementation,
} from "./loop-implementation-result.ts";
import { prepareImplementationStart } from "./loop-implementation.ts";
import { executeMerge, reconcileMergeIntent } from "./loop-merge.ts";
import { executeCandidatePreservation } from "./loop-preservation.ts";
import { executePublishStep } from "./loop-publication.ts";
import { configFor, releaseRequestMatchesDelivery } from "./loop-records.ts";
import { observeReleaseAcceptance } from "./loop-release.ts";
import { ensureBeforeReplay } from "./loop-replay-before.ts";
import { candidateValidated } from "./loop-replay-validation.ts";
import { observeReview } from "./loop-review-observation.ts";
import { requestReviewFor } from "./loop-review-request.ts";
import {
  headAwaitsCiCorrection,
  headNeedsCorrection,
} from "./loop-review-records.ts";
import { recoverClosedReviewWait } from "./loop-review-recovery.ts";
import {
  legacyCutoff,
  parkAtReviewRoundCeiling,
  reviewRoundsSpentOut,
} from "./loop-review-round-cap.ts";
import { deliveryQueueDeferral } from "./loop-delivery-queue.ts";
import {
  executeCarriedDelivery,
  spentOnMovedBase,
} from "./loop-carried-delivery.ts";
import { legacyFinalRoundOpen } from "./review-round-cap.ts";
import { persistTransition, persistWork } from "./loop-state.ts";
import type {
  CarryV1,
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { assignTarget, markBlocked } from "./transitions.ts";

// ---------------------------------------------------------------------------
// Step dispatch.
// ---------------------------------------------------------------------------

export function executeStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  switch (record.nextStep) {
    case "work":
      return executeWorkStep(deps, context, record);
    case "review":
      return observeReview(deps, context, record);
    case "delivery":
      return executeDeliveryStep(deps, context, record);
    case "blocked":
    case "done":
      return Promise.resolve({ kind: "idle" });
  }
}

export async function executeWorkStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(deps, context, record, "resume");
  if (queueGuard !== null) return queueGuard;
  const existingPr = await routeExistingPr(deps, context, record);
  if (existingPr.status === "step") return existingPr.step;
  const config = configFor(deps, record.repository);
  if (config === null) {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "unavailable",
        "repository not configured",
        deps.clock.now(),
      ),
    );
  }

  // A review wait parked on a closed-unmerged PR is recovered BEFORE any
  // intent dispatch: the dead wait pins the record ahead of the publish
  // reconciliation that could otherwise clear it.
  const recovered = await recoverClosedReviewWait(deps, context, record);
  if (recovered !== null) return recovered;

  // A pending candidate-preservation intent is reconciled BEFORE any other
  // work: the exact produced candidate is made durable through the real
  // preservation capability, and no implementation/review start may repair it.
  if (
    record.intent !== null && record.intent.kind === "candidate_preservation"
  ) {
    return executeCandidatePreservation(deps, context, record);
  }

  // A saved implementation intent is never resubmitted; fail closed.
  if (record.intent !== null && record.intent.kind === "implementation") {
    if (deps.externalImplementations === true) {
      return MATRIX_ARTIFACT_DEFERRED;
    }
    return handleImplementationUncertainty(deps, context, record);
  }

  // A new-format record without a preserved descriptor (and without the
  // pending preservation intent handled above) must stop safely: it is never
  // regenerated, never published and never reviewed from an unverified head.
  const candidateState = record.target.candidateState;
  if (candidateState !== undefined && candidateState.preserved === null) {
    if (existingPr.status !== "custody_ready") {
      return {
        kind: "deferred",
        detail: "candidate preservation descriptor unavailable",
      };
    }
    if (
      record.intent === null && !headNeedsCorrection(
        context.snapshot,
        record,
        ciCorrectionRouteOpen(deps),
        preReviewCiFixRouteOpen(deps),
        legacyCutoff(context),
      )
    ) return await requestReviewFor(deps, context, record, record.target.pr!);
  }

  // A saved base-refresh intent is reconciled wherever it is observed (the
  // work step as well as delivery): the old candidate is preserved until the
  // exact deterministic prepared commit was actually published. A pending
  // conflict resolution on an open route is the one refresh intent that
  // starts model work: its charged attempt runs as an implementation step.
  if (record.intent !== null && record.intent.kind === "base_refresh") {
    if (
      conflictResolutionAdmissible(
        conflictResolutionRouteOpen(deps),
        context.snapshot,
        record,
        legacyCutoff(context),
      ) !== null
    ) {
      return executeConflictResolutionStep(
        deps,
        context,
        record,
        () => executeImplementationStep(deps, context, record, config),
      );
    }
    return executeBaseRefreshIntent(deps, context, record);
  }

  // Hard review-round ceiling: with no round left no candidate this step
  // could implement, correct, publish or open a replacement PR for can ever
  // be reviewed, so nothing is charged or pushed and the record parks. An
  // operation already in flight finishes first (above, or in the publication
  // reconciliation, whose review request parks at the same ceiling). Two
  // exceptions: a legacy record whose one final round is still open takes the
  // CI fix of its reviewed red head (below; the fix arms that round), and a
  // refreshed head that carries its earlier review's exact patch is handed,
  // once its own CI is green, to the launcher's carried merge under that
  // review (`loop-carried-delivery.ts`).
  if (
    record.intent === null && reviewRoundsSpentOut(context, record) &&
    !legacyCiFixPending(deps, context, record)
  ) {
    const carried = await executeCarriedDelivery(deps, context, record);
    if (carried !== null) return carried;
    return parkAtReviewRoundCeiling(deps, context, record);
  }

  // Deterministic branch identity before any model work.
  if (record.target.branch === null) {
    return persistWork(
      deps,
      context,
      assignTarget(
        record,
        { base: record.target.base, branch: candidateBranch(record.id) },
        deps.clock.now(),
      ),
    );
  }

  const evidenceOk = await ensureEvidence(deps, context.snapshot, record);
  if (evidenceOk.record !== null) {
    const evidenceRecord = evidenceOk.evidence;
    return persistTransition(deps, context, (draft) => {
      const index = draft.work.findIndex((work) => work.id === record.id);
      draft.work[index] = evidenceOk.record!;
      if (evidenceRecord !== null) {
        if (!draft.evidence.some((item) => item.id === evidenceRecord.id)) {
          draft.evidence.push(evidenceRecord);
        }
      }
    });
  }

  const carry: CarryV1 = {
    beforeRun: null,
    fixtureRef: null,
    fixtureDigest: null,
    testIds: null,
    replayCommandId: null,
    beforeReason: "",
  };

  const reproduced = await ensureBeforeReplay(
    deps,
    context.snapshot,
    record,
    carry,
  );
  if (reproduced !== null) {
    return persistWork(deps, context, reproduced);
  }

  if (
    record.target.head === null ||
    headNeedsCorrection(
      context.snapshot,
      record,
      ciCorrectionRouteOpen(deps),
      preReviewCiFixRouteOpen(deps),
      legacyCutoff(context),
    )
  ) {
    return executeImplementationStep(deps, context, record, config);
  }

  // An unpublished candidate head must be PUBLISHED before any refresh that
  // requires it to already be the PR head: the pre-publication refresh gate is
  // deliberately absent here. The refresh dependency is enforced by the ONE
  // central freshness gate in requestReviewFor after successful publication.

  // A head exists: it is publishable only after a validated replay result, or
  // immediately for a non-incident task (no fabricated fixture here).
  const validated = await candidateValidated(deps, context, record, carry);
  if (validated.kind === "blocked") {
    return persistWork(deps, context, validated.record);
  }
  if (validated.kind === "state_error") {
    return { kind: "state_error", detail: validated.detail };
  }
  if (validated.kind === "retry") {
    return executeImplementationStep(deps, context, record, config);
  }
  return executePublishStep(deps, context, record, config);
}

/**
 * The in-process serial consumer of one prepared implementation start: run the
 * exact prepared request through the injected model port and hand the receipt
 * (or the trusted failure) to the same receipt consumer the matrix ingester
 * uses. The matrix path prepares in the trusted planner and consumes in the
 * trusted ingester instead.
 */
export async function executeImplementationStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  config: RepositoryConfigV1,
): Promise<StepResultV1> {
  if (deps.externalImplementations === true) {
    return MATRIX_IMPLEMENTATION_DEFERRED;
  }
  const prepared = await prepareImplementationStart(
    deps,
    context,
    record,
    config,
  );
  if (prepared.kind !== "prepared") return prepared;
  const submitGuard = await guardQueueOperation(
    deps,
    prepared.context,
    prepared.record,
    "resume",
  );
  if (submitGuard !== null) return submitGuard;
  const receipt = await deps.model.runModel(prepared.request);
  if (!receipt.ok) {
    return settleFailedImplementation(
      deps,
      context,
      prepared.record,
      prepared.reservationId,
      implementationPortFailureDetail(
        receipt.error,
        ATTEMPT_DETAIL_NO_TRUSTED_RECEIPT,
      ),
    );
  }
  return handleModelReceipt(
    deps,
    prepared.context,
    prepared.record,
    prepared.reservationId,
    receipt.value,
    config,
  );
}

// ---------------------------------------------------------------------------
// Delivery phase: merge → release request → acceptance → closure.
// ---------------------------------------------------------------------------

export async function executeDeliveryStep(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(deps, context, record, "resume");
  if (queueGuard !== null) return queueGuard;
  if (record.target.pr === null || record.target.head === null) {
    return {
      kind: "state_error",
      detail: "delivery without PR/head identity",
    };
  }

  if (record.intent !== null) {
    if (record.intent.kind === "already_satisfied_closure") {
      return retryAlreadySatisfiedClosure(deps, context, record);
    }
    if (record.intent.kind === "base_refresh") {
      // A saved candidate-base refresh is reconciled before any other
      // delivery effect: the old candidate is preserved until the exact
      // deterministic prepared commit was actually published.
      return executeBaseRefreshIntent(deps, context, record);
    }
    if (record.intent.kind === "issue_closure") {
      return retryClosure(deps, context, record);
    }
    if (record.intent.kind === "merge") {
      return reconcileMergeIntent(deps, context, record);
    }
  }

  // Look up the durable release request by its SOURCE identity (exact PR and
  // reviewed head); the request's `revision` is the merged revision, which is
  // never the candidate head, so it cannot be the lookup key. The lookup also
  // binds the full target scope (owner/name/installation), the production
  // environment and the reviewed base: a request for another repository scope
  // or another base can never be observed — and therefore never closed — for
  // this delivery record. Retaining the merged revision inside the matched
  // request keeps one exact request per PR/head/base and never replays a merge
  // or fabricates a duplicate request.
  const existingRequest = context.snapshot.releaseRequests.find(
    (request) => releaseRequestMatchesDelivery(request, record),
  );
  if (existingRequest !== undefined) {
    // An existing release request is delivery bookkeeping: a base movement
    // never replaces or duplicates it.
    return observeReleaseAcceptance(deps, context, record, existingRequest);
  }
  const refresh = await refreshMovedBaseBeforeMerge(deps, context, record);
  if (refresh !== null) return refresh;
  return executeMerge(deps, context, record);
}

/**
 * The moved-base guard every fresh merge of an intent-free delivery passes
 * first (the ordinary delivery step and the post-drain continuation alike):
 * null when the configured base still is the reviewed base, or the step that
 * replaced the merge (a persisted refresh intent, a correction, a park or a
 * delivery-line deferral).
 *
 * Only an issue task with an existing candidate/PR, no other intent and an
 * available prepareBaseRefresh capability may persist a base-refresh intent:
 * an unsupported/fake port must never receive an intent it cannot execute.
 * The check happens BEFORE the merge path and never touches immutable
 * identities, counters, reviews or evidence.
 */
export async function refreshMovedBaseBeforeMerge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  if (
    record.intent !== null || record.source.kind !== "issue" ||
    deps.github.prepareBaseRefresh === undefined
  ) return null;
  // A reviewed head whose own change already broke its checks is corrected
  // before it could be refreshed onto the moved base (a legacy record whose
  // final round is open included: that CI fix is its exception). At the
  // hard ceiling the reviewed head's CI is read first and only a green head
  // whose latest review authorizes it refreshes, mechanically, to carry
  // that review (`spentOnMovedBase`; anything else parks). Every refresh
  // waits its turn in the repository's delivery line.
  return await ensureBaseRefreshIntent(
    deps,
    context,
    record,
    async (observedBase) => {
      const spent = reviewRoundsSpentOut(context, record);
      if (
        !spent ||
        legacyFinalRoundOpen(context.snapshot, record, legacyCutoff(context))
      ) {
        const corrected = await correctFailedHeadBeforeRefresh(
          deps,
          context,
          record,
        );
        if (corrected !== null) return corrected;
      }
      if (spent) {
        return await spentOnMovedBase(deps, context, record, observedBase);
      }
      return deliveryQueueDeferral(deps, context, record, observedBase);
    },
  );
}

/**
 * A legacy record whose one final round is still open, on a reviewed red head
 * awaiting its CI correction: its CI fix is admitted although every ordinary
 * round is spent (owner decision 2026-10-16: CI fixes, then exactly one final
 * review on the green head).
 */
function legacyCiFixPending(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): boolean {
  const cutoff = legacyCutoff(context);
  return legacyFinalRoundOpen(context.snapshot, record, cutoff) &&
    headAwaitsCiCorrection(
      context.snapshot,
      record,
      ciCorrectionRouteOpen(deps),
      cutoff,
    );
}
