/** Truthful non-PR owner-successor operation over the existing private native channel. */
import {
  type OwnerSuccessorReviewV1,
  parseOwnerSuccessorReviewV1,
} from "../contracts/owner-successor-review.ts";
import {
  expectEnum,
  expectExactKeys,
  expectPattern,
  expectRecord,
  fail,
} from "../contracts/validation.ts";
import {
  parseExecution,
  type ReviewJournalExecutionV1,
} from "../github/journal-metadata.ts";

export interface OwnerSuccessorCustodyRegistration {
  kind: "owner_successor";
  review: OwnerSuccessorReviewV1;
}
export interface OwnerSuccessorCustodyArm {
  requestId: string;
  execution: ReviewJournalExecutionV1;
}
export interface OwnerSuccessorCustody {
  registerOwnerSuccessor(
    input: OwnerSuccessorCustodyRegistration,
  ): Promise<void>;
  armOwnerSuccessor(input: OwnerSuccessorCustodyArm): Promise<void>;
  settledOwnerSuccessor(input: { requestId: string }): Promise<void>;
}
function requestId(value: unknown): string {
  return expectPattern(
    value,
    "$.requestId",
    /^owner-successor-request:[0-9a-f]{64}$/,
    "invalid_pattern",
    "expected exact owner successor request identity",
    128,
  );
}
export function parseOwnerSuccessorCustodyRegistration(
  value: unknown,
): OwnerSuccessorCustodyRegistration {
  const obj = expectRecord(value, "$");
  expectExactKeys(obj, ["kind", "review"], "$");
  expectEnum(obj.kind, ["owner_successor"], "$.kind");
  const review = parseOwnerSuccessorReviewV1(obj.review);
  requestId(review.binding.requestId);
  if (review.phase !== "intent" || review.reservation.outcome !== "reserved") {
    fail(
      "$",
      "invalid_lifecycle",
      "owner successor custody requires its genuine charged intent",
    );
  }
  return { kind: "owner_successor", review };
}
export function parseOwnerSuccessorCustodyArm(
  value: unknown,
): OwnerSuccessorCustodyArm {
  const obj = expectRecord(value, "$");
  expectExactKeys(obj, ["requestId", "execution"], "$");
  return {
    requestId: requestId(obj.requestId),
    execution: parseExecution(obj.execution, "$.execution"),
  };
}
export function parseOwnerSuccessorCustodySettled(
  value: unknown,
): { requestId: string } {
  const obj = expectRecord(value, "$");
  expectExactKeys(obj, ["requestId"], "$");
  return { requestId: requestId(obj.requestId) };
}
