import { canonicalStringify } from "../contracts/canonical.ts";
import { isPassportWorkTrial } from "./passport-work-trial.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
/** Repair loop internals: review result. */
import type { ReviewObservationV1 } from "../contracts/ports.ts";
import {
  deriveUnresolvedSeverities,
  parseReviewReceiptV1,
  type ReviewReceiptV1,
} from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  reviewEvidenceRef,
  reviewOperationKey,
  reviewReceiptId,
} from "./keys.ts";
import { REVIEW_POLL_MS } from "./loop-bounds.ts";
import {
  configFor,
  mergeEvidence,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import {
  hasBlockingFindings,
  isUnboundReviewObservation,
  reviewSubmittedAt,
  reviewWaitSince,
} from "./loop-review-records.ts";
import { requestReviewFor } from "./loop-review-request.ts";
import { reviewRoundsSpentOut } from "./loop-review-round-cap.ts";
import {
  persistTransition,
  persistWork,
  replaceWorkMutation,
} from "./loop-state.ts";
import {
  readDeliveryTaskContext,
  readIssueForModel,
  semanticRefusalKind,
} from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  classifyReviewTerminalDisposition,
  TASK_ACCEPTANCE_MISSING_DETAIL,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
  TASK_ACCEPTANCE_UNCERTAIN_DETAIL,
  taskAcceptanceRefusal,
} from "./review-gate.ts";
import {
  TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
  withAcceptanceFinding,
} from "./acceptance-correction.ts";
import {
  advanceToCorrection,
  advanceToDelivery,
  advanceToReview,
  clearIntent,
  markBlocked,
  setIntent,
  setWait,
} from "./transitions.ts";
import {
  REVIEW_ROUND_CEILING_REJECTED,
  REVIEW_ROUND_CEILING_UNACCEPTED,
} from "./review-round-cap.ts";

/** Missing acceptance, or Passport uncertainty, may request a new counted review. */
export async function recoverMissingTaskReview(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  observedOperationKey: string,
): Promise<StepResultV1 | null> {
  const trialUncertain = isPassportWorkTrial(record.repository) &&
    receipt.taskAcceptance?.verdict === "uncertain";
  const issueNumber = record.related.issueNumber;
  const config = configFor(deps, record.repository);
  if (
    record.source.kind !== "issue" || issueNumber === null ||
    record.source.id !== String(issueNumber) ||
    record.related.incidentId !== null ||
    record.counters.reviewRounds < 1 ||
    (receipt.taskAcceptance !== null && !trialUncertain) ||
    receipt.outcome !== "completed" ||
    receipt.resultId === null || receipt.completedAt === null ||
    !sameRepositoryIdentity(receipt.repository, record.repository) ||
    receipt.pullRequest.number !== record.target.pr ||
    receipt.pullRequest.head !== record.target.head ||
    receipt.pullRequest.base !== record.target.base ||
    receipt.expectedReviewer !== deps.github.reviewerIdentity ||
    receipt.observedReviewer !== deps.github.reviewerIdentity ||
    receipt.findingsUncounted !== 0 || hasBlockingFindings(receipt)
  ) return null;
  if (
    config === null || config.liveStartLimits === null ||
    config.sessionBound === null
  ) {
    return {
      kind: "deferred",
      detail:
        "missing task acceptance recovery requires enabled model admission",
    };
  }
  if (
    record.intent !== null &&
    (record.intent.kind !== "review_request" ||
      record.intent.key !== observedOperationKey ||
      record.intent.expectedHead !== record.target.head ||
      record.intent.pr !== record.target.pr)
  ) return null;
  if (await readIssueForModel(deps, record) === "unavailable") {
    return {
      kind: "deferred",
      detail:
        "missing task acceptance recovery requires an eligible live issue",
    };
  }
  const nextKey = reviewOperationKey(
    record.target.pr!,
    record.target.head!,
    record.counters.reviewRounds + 1,
  );
  if (
    context.snapshot.reservations.some((charge) =>
      sameRepositoryIdentity(charge.repository, record.repository) &&
      charge.taskId === record.id && charge.head === record.target.head &&
      charge.purpose === "review_request" &&
      charge.attempt > record.counters.reviewRounds
    ) || context.snapshot.reviews.some((review) =>
      sameRepositoryIdentity(review.repository, record.repository) &&
      review.pullRequest.number === record.target.pr &&
      review.pullRequest.head === record.target.head &&
      review.completedAt === null
    )
  ) {
    return {
      kind: "deferred",
      detail: "missing task acceptance recovery has an outstanding review",
    };
  }
  const next = await deps.github.observeReview({
    operationKey: nextKey,
    prNumber: record.target.pr!,
    head: record.target.head!,
  });
  if (!next.ok || !isUnboundReviewObservation(next.value)) {
    return {
      kind: "deferred",
      detail:
        "missing task acceptance recovery requires an unused review attempt",
    };
  }
  const existing = context.snapshot.reviews.find((review) =>
    review.id === receipt.id
  );
  const immutableContent = (value: ReviewReceiptV1) => ({
    ...value,
    observedAt: 0,
    submittedAt: 0,
  });
  if (
    trialUncertain && existing !== undefined &&
    canonicalStringify(immutableContent(existing)) !==
      canonicalStringify(immutableContent(receipt))
  ) {
    return {
      kind: "deferred",
      detail: "uncertain task acceptance recovery receipt content changed",
    };
  }
  if (
    existing !== undefined && (
      existing.requestId !== receipt.requestId ||
      existing.resultId !== receipt.resultId ||
      existing.outcome !== "completed" ||
      canonicalStringify(existing.taskAcceptance ?? null) !==
        canonicalStringify(receipt.taskAcceptance ?? null) ||
      existing.pullRequest.head !== receipt.pullRequest.head ||
      existing.pullRequest.base !== receipt.pullRequest.base ||
      existing.pullRequest.number !== receipt.pullRequest.number ||
      !sameRepositoryIdentity(existing.repository, receipt.repository) ||
      existing.expectedReviewer !== receipt.expectedReviewer ||
      existing.observedReviewer !== receipt.observedReviewer ||
      existing.findingsUncounted !== 0 ||
      hasBlockingFindings(existing)
    )
  ) {
    return {
      kind: "deferred",
      detail: "missing task acceptance recovery receipt identity changed",
    };
  }
  const now = deps.clock.now();
  const ready = advanceToReview(
    clearIntent(record, now),
    {
      pr: record.target.pr!,
      head: record.target.head!,
    },
    { reason: "review_quota", since: now, until: now },
    now,
  );
  const retained = {
    ...ready,
    evidence: mergeEvidence(ready.evidence, [{
      kind: "review_receipt" as const,
      ref: reviewEvidenceRef(receipt.id),
    }]),
  };
  const saved = await persistTransition(deps, context, (draft) => {
    replaceWorkMutation(retained)(draft);
    if (existing === undefined) draft.reviews.push(receipt);
  });
  if (saved.kind !== "progress") return saved;
  return await requestReviewFor(deps, context, retained, retained.target.pr!);
}

export async function applyObservedReview(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  value: ReviewObservationV1,
  /** Exact identity this observation was read under; the receipt is bound to it. */
  observedOperationKey: string,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(deps, context, record, "resume");
  if (queueGuard !== null) return queueGuard;
  const now = deps.clock.now();
  if (value.observedHead !== record.target.head) {
    // A review of a different head never advances this task; one pending
    // request per head remains pending and no receipt is synthesized.
    const since = reviewWaitSince(record, now);
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "review_pending", since, until: now + REVIEW_POLL_MS },
        now,
      ),
    );
  }
  const id = await reviewReceiptId(
    observedOperationKey,
    value.observedHead!,
  );
  let receipt: ReviewReceiptV1;
  try {
    receipt = parseReviewReceiptV1({
      version: "v1",
      kind: "review_receipt",
      id,
      requestId: value.requestId,
      expectedReviewer: deps.github.reviewerIdentity,
      observedReviewer: value.reviewer,
      repository: record.repository,
      pullRequest: {
        number: record.target.pr!,
        head: value.observedHead!,
        base: value.observedBase ?? record.target.base,
      },
      outcome: value.status,
      resultId: value.resultId,
      summary: value.summary,
      findings: value.findings,
      findingsUncounted: 0,
      // Derive the distinct, canonical severity set before parsing. A review
      // may report several findings at one severity; passing duplicates makes
      // the strict receipt parser reject an otherwise valid result.
      unresolvedSeverities: deriveUnresolvedSeverities(value.findings),
      taskAcceptance: value.taskAcceptance,
      submittedAt: reviewSubmittedAt(record, value.completedAt, now),
      completedAt: value.completedAt,
      observedAt: value.receivedAt,
    });
  } catch {
    const since = reviewWaitSince(record, now);
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "review_pending", since, until: now + REVIEW_POLL_MS },
        now,
      ),
    );
  }
  let unresolved = hasBlockingFindings(receipt);
  // A completed code-quality verdict is still not a delivery. For an
  // issue-backed record the receipt must also carry the reviewer's POSITIVE
  // task acceptance bound to this exact source issue AND to the TRUSTED live
  // task text, independently re-read here: the model's echoed digest and
  // equality between two copied receipts are never fulfillment proof. A legacy
  // change-only receipt, a changed digest, a mismatch, an explicit
  // not_fulfilled/already_satisfied_at_base or an uncertain verdict is an
  // honest NO-DELIVERY disposition persisted with its static reason. Nothing
  // is merged, no issue is closed and the unrelated PR never becomes repair
  // evidence.
  if (!unresolved) {
    // Missing context (transient read failure, vanished issue, over-bound
    // text) fails closed as a bounded wait: no delivery is ever authorized
    // against an unverifiable task.
    const task = await readDeliveryTaskContext(deps, record);
    if (task === "unavailable") {
      const since = reviewWaitSince(record, now);
      return persistWork(
        deps,
        context,
        setWait(
          record,
          {
            reason: "review_quota",
            since,
            until: Math.max(now, since) + REVIEW_POLL_MS,
          },
          now,
        ),
      );
    }
    const disposition = classifyReviewTerminalDisposition(
      receipt,
      record,
      deps.github.reviewerIdentity,
      task,
    );
    if (
      disposition.kind === "qualified_already_satisfied" &&
      record.source.kind === "issue" && record.target.branch !== null
    ) {
      const next = setIntent(advanceToDelivery(clearIntent(record, now), now), {
        kind: "already_satisfied_closure",
        key:
          `satisfied:${record.target.pr}:${record.target.head}:${record.target.base}`,
        startedAt: now,
        branch: record.target.branch,
        expectedHead: record.target.head,
        observedBase: record.target.base,
        pr: record.target.pr,
        requestId: receipt.requestId,
        resultId: receipt.resultId,
      }, now);
      return persistTransition(deps, context, (draft) => {
        replaceWorkMutation({
          ...next,
          evidence: mergeEvidence(next.evidence, [{
            kind: "review_receipt",
            ref: reviewEvidenceRef(receipt.id),
          }]),
        })(draft);
        if (!draft.reviews.some((review) => review.id === receipt.id)) {
          draft.reviews.push(receipt);
        }
      });
    }
    const refusal = taskAcceptanceRefusal(receipt, record, task);
    if (refusal === TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL) {
      // JAM B6: the reviewer judged THIS issue's live text and found the
      // candidate does not satisfy it. That is a P1 (an unaccepted candidate
      // never merges), so the receipt carries the reviewer's acceptance
      // statement as its leading P1 finding and the record continues exactly
      // as a P0/P1 verdict does below: a correction while a round is left
      // (B6a). With none left, or when the receipt cannot carry the finding,
      // it parks once on the owner-gated message (B6b), never re-admitted.
      const corrected = await withAcceptanceFinding(receipt);
      if (corrected === null || reviewRoundsSpentOut(context, record)) {
        return parkWithReceipt(
          deps,
          context,
          record,
          corrected ?? receipt,
          TASK_ACCEPTANCE_OWNER_GATE_DETAIL,
        );
      }
      receipt = corrected;
      unresolved = true;
    } else if (refusal !== null) {
      if (
        refusal === TASK_ACCEPTANCE_MISSING_DETAIL ||
        (isPassportWorkTrial(record.repository) &&
          refusal === TASK_ACCEPTANCE_UNCERTAIN_DETAIL)
      ) {
        // At the hard review-round ceiling a missing acceptance is final: the
        // generation-79 recovery answers its own detail with another review,
        // so the record parks with the ceiling message and the receipt.
        if (reviewRoundsSpentOut(context, record)) {
          return parkWithReceipt(
            deps,
            context,
            record,
            receipt,
            REVIEW_ROUND_CEILING_UNACCEPTED,
          );
        }
        const recovered = await recoverMissingTaskReview(
          deps,
          context,
          record,
          receipt,
          observedOperationKey,
        );
        if (recovered !== null) return recovered;
      }
      return persistWork(
        deps,
        context,
        // Blocked, not retired: the publication identity is preserved for
        // audit and nothing is merged or closed for the issue.
        markBlocked(record, semanticRefusalKind(refusal), refusal, now),
      );
    }
  }
  // A blocking verdict in the last affordable round can never be corrected
  // into a reviewed head (the correction would need another round): the
  // record parks with the rejecting receipt instead of a model start.
  if (unresolved && reviewRoundsSpentOut(context, record)) {
    return parkWithReceipt(
      deps,
      context,
      record,
      receipt,
      REVIEW_ROUND_CEILING_REJECTED,
    );
  }
  const withEvidence: WorkRecordV1 = {
    ...record,
    evidence: mergeEvidence(record.evidence, [{
      kind: "review_receipt",
      ref: reviewEvidenceRef(receipt.id),
    }]),
    updatedAt: now,
  };
  return persistTransition(deps, context, (draft) => {
    const index = draft.work.findIndex((work) => work.id === record.id);
    draft.work[index] = unresolved
      ? advanceToCorrection(clearIntent(withEvidence, now), now)
      : advanceToDelivery(clearIntent(withEvidence, now), now);
    if (!draft.reviews.some((review) => review.id === receipt.id)) {
      draft.reviews.push(receipt);
    }
  });
}

/**
 * Park at the review-round ceiling keeping the observed receipt and its
 * evidence ref exactly as a correction or delivery would: one write, nothing
 * charged, settled or refunded.
 */
function parkWithReceipt(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  message: string,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const parked = markBlocked(clearIntent(record, now), "other", message, now);
  return persistTransition(deps, context, (draft) => {
    replaceWorkMutation({
      ...parked,
      evidence: mergeEvidence(parked.evidence, [{
        kind: "review_receipt",
        ref: reviewEvidenceRef(receipt.id),
      }]),
    })(draft);
    if (!draft.reviews.some((review) => review.id === receipt.id)) {
      draft.reviews.push(receipt);
    }
  });
}
