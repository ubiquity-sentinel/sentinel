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
  taskAcceptanceRefusal,
} from "./review-gate.ts";
import {
  advanceToCorrection,
  advanceToDelivery,
  advanceToReview,
  clearIntent,
  markBlocked,
  setIntent,
  setWait,
} from "./transitions.ts";

/** Missing acceptance permits another review, never delivery or receipt rewriting. */
export async function recoverMissingTaskReview(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  observedOperationKey: string,
): Promise<StepResultV1 | null> {
  const issueNumber = record.related.issueNumber;
  const config = configFor(deps, record.repository);
  if (
    record.source.kind !== "issue" || issueNumber === null ||
    record.source.id !== String(issueNumber) ||
    record.related.incidentId !== null ||
    record.counters.reviewRounds < 1 ||
    receipt.taskAcceptance !== null || receipt.outcome !== "completed" ||
    receipt.resultId === null || receipt.completedAt === null ||
    !sameRepositoryIdentity(receipt.repository, record.repository) ||
    receipt.pullRequest.number !== record.target.pr ||
    receipt.pullRequest.head !== record.target.head ||
    receipt.pullRequest.base !== record.target.base ||
    receipt.expectedReviewer !== deps.github.reviewerIdentity ||
    receipt.observedReviewer !== deps.github.reviewerIdentity ||
    receipt.findingsUncounted !== 0 || receipt.unresolvedSeverities.length !== 0
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
  if (
    existing !== undefined && (
      existing.requestId !== receipt.requestId ||
      existing.resultId !== receipt.resultId ||
      existing.outcome !== "completed" ||
      (existing.taskAcceptance ?? null) !== null ||
      existing.pullRequest.head !== receipt.pullRequest.head ||
      existing.pullRequest.base !== receipt.pullRequest.base ||
      existing.pullRequest.number !== receipt.pullRequest.number ||
      !sameRepositoryIdentity(existing.repository, receipt.repository) ||
      existing.expectedReviewer !== receipt.expectedReviewer ||
      existing.observedReviewer !== receipt.observedReviewer ||
      existing.findingsUncounted !== 0 ||
      existing.unresolvedSeverities.length !== 0
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
  const unresolved = hasBlockingFindings(receipt);
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
    if (refusal !== null) {
      if (refusal === TASK_ACCEPTANCE_MISSING_DETAIL) {
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
