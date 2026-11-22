import {
  hasBlockingSeverity,
  type ReviewReceiptV1,
} from "../contracts/review-receipt.ts";
import {
  reviewTaskAcceptanceRefusal,
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL,
} from "../contracts/review-task-acceptance.ts";

export type ReviewDispositionV1 =
  | { kind: "accept" }
  | {
    kind: "already_satisfied";
    reason: typeof TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL;
  }
  | {
    kind: "correct";
    reason: "blocking findings" | typeof TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL;
  }
  | { kind: "hold"; reason: string };

/** Shared decision after the caller verifies its review transport and task identity. */
export function decideReviewDisposition(
  review: Pick<
    ReviewReceiptV1,
    "outcome" | "findingsUncounted" | "unresolvedSeverities"
  >,
  task: Parameters<typeof reviewTaskAcceptanceRefusal>[0],
): ReviewDispositionV1 {
  if (review.outcome !== "completed") {
    return { kind: "hold", reason: "incomplete receipt" };
  }
  if (review.findingsUncounted !== 0) {
    return { kind: "hold", reason: "uncounted findings" };
  }
  if (hasBlockingSeverity(review.unresolvedSeverities)) {
    return { kind: "correct", reason: "blocking findings" };
  }
  const refusal = reviewTaskAcceptanceRefusal(task);
  switch (refusal) {
    case null:
      return { kind: "accept" };
    case TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL:
      return { kind: "already_satisfied", reason: refusal };
    case TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL:
      return { kind: "correct", reason: refusal };
    default:
      return { kind: "hold", reason: refusal };
  }
}
