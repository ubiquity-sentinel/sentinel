/** Ephemeral trusted-publisher custody for an issue review at one exact base. */
import type { GitSha } from "../contracts/brands.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectPattern,
  expectRecord,
  expectSha256Hex,
  fail,
} from "../contracts/validation.ts";
import { parseExecution } from "./journal-metadata.ts";
import type { ReviewJournalExecutionV1 } from "./journal-metadata.ts";

export interface BaseReviewOwnerRegistrationV1 {
  repository: RepositoryIdentityV1;
  base: GitSha;
  taskDigest: string;
  reservationId: string;
  requestId: string;
  ownerRunId: string;
}

export interface BaseReviewOwnerArmV1 {
  requestId: string;
  execution: ReviewJournalExecutionV1;
}

/** No admission, state, credentials or executable choice crosses this channel. */
export interface BaseReviewOwnerCustodyV1 {
  registerBaseReview(input: BaseReviewOwnerRegistrationV1): Promise<void>;
  armBaseReview(input: BaseReviewOwnerArmV1): Promise<void>;
  settledBaseReview(input: { requestId: string }): Promise<void>;
}

function requestId(value: unknown): string {
  return expectPattern(
    value,
    "$.requestId",
    /^base-review-[0-9a-f]{64}$/,
    "invalid_pattern",
    "expected exact base-review reservation identity",
    76,
  );
}

export function parseBaseReviewOwnerRegistration(
  value: unknown,
): BaseReviewOwnerRegistrationV1 {
  const obj = expectRecord(value, "$");
  expectExactKeys(obj, [
    "repository",
    "base",
    "taskDigest",
    "reservationId",
    "requestId",
    "ownerRunId",
  ], "$");
  const reservationId = expectSha256Hex(obj.reservationId, "$.reservationId");
  const id = requestId(obj.requestId);
  if (id !== "base-review-" + reservationId) {
    fail(
      "$.requestId",
      "invalid_lifecycle",
      "base review reservation mismatch",
    );
  }
  return {
    repository: parseRepositoryIdentity(obj.repository, "$.repository"),
    base: expectGitSha(obj.base, "$.base"),
    taskDigest: expectSha256Hex(obj.taskDigest, "$.taskDigest"),
    reservationId,
    requestId: id,
    ownerRunId: expectNonEmptyString(obj.ownerRunId, "$.ownerRunId", 256),
  };
}

export function parseBaseReviewOwnerArm(value: unknown): BaseReviewOwnerArmV1 {
  const obj = expectRecord(value, "$");
  expectExactKeys(obj, ["requestId", "execution"], "$");
  return {
    requestId: requestId(obj.requestId),
    execution: parseExecution(obj.execution, "$.execution"),
  };
}

export function parseBaseReviewOwnerSettled(
  value: unknown,
): { requestId: string } {
  const obj = expectRecord(value, "$");
  expectExactKeys(obj, ["requestId"], "$");
  return { requestId: requestId(obj.requestId) };
}
