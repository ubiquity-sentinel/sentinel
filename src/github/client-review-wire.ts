// client review wire.

import type { GitSha } from "../contracts/brands.ts";
import type { PortErrorV1 } from "../contracts/ports.ts";
import { isGitSha } from "../contracts/brands.ts";
import { MAX_JOURNAL_BYTES } from "./review-journal.ts";

export type RequiredReviewOperationSlotV1 = "reviewId" | "head" | "body";

export const REQUIRED_REVIEW_DETAILS: Record<
  RequiredReviewOperationSlotV1,
  string
> = {
  reviewId: "invalid review id",
  head: "invalid review head",
  body: "invalid review body",
};

export interface ReviewOperationInputV1 {
  prNumber: number;
  reviewId?: number;
  head?: GitSha;
  body?: string;
}

/**
 * Input validation before any review request: positive safe-integer ids,
 * exact 40-hex head and a finite non-empty body within the journal byte
 * bound. The slots the operation requires are mandatory even when a runtime
 * caller violates TypeScript: an absent/undefined required value is the same
 * static invalid as a wrong-type one, and no request is ever issued.
 * Failures are static sanitized caller errors; nothing is echoed.
 */
export function validateReviewOperationInput(
  input: ReviewOperationInputV1,
  required: readonly RequiredReviewOperationSlotV1[],
): PortErrorV1 | null {
  if (!Number.isSafeInteger(input.prNumber) || input.prNumber < 1) {
    return { kind: "invalid", detail: "invalid pull request number" };
  }
  for (const slot of required) {
    if (input[slot] === undefined) {
      return { kind: "invalid", detail: REQUIRED_REVIEW_DETAILS[slot] };
    }
  }
  if (
    input.reviewId !== undefined &&
    (!Number.isSafeInteger(input.reviewId) || input.reviewId < 1)
  ) {
    return { kind: "invalid", detail: "invalid review id" };
  }
  if (input.head !== undefined && !isGitSha(input.head)) {
    return { kind: "invalid", detail: "invalid review head" };
  }
  if (input.body !== undefined) {
    if (
      typeof input.body !== "string" || input.body.length === 0 ||
      new TextEncoder().encode(input.body).length > MAX_JOURNAL_BYTES
    ) {
      return { kind: "invalid", detail: "invalid review body" };
    }
  }
  return null;
}
