/** Strict evidence of a trusted custodian closing one original review owner. */
import {
  canonicalStringify,
  canonicalStringifySha256,
} from "../contracts/canonical.ts";
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { parseRepositoryIdentity } from "../contracts/shared.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  expectBoolean,
  expectEnum,
  expectExactKeys,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  fail,
} from "../contracts/validation.ts";
import { parseExecution, parseReviewJournalValue } from "./journal-metadata.ts";
import type {
  ReviewJournalExecutionV1,
  ReviewJournalIntentV1,
  ReviewJournalRunningV1,
  ReviewJournalV1,
} from "./journal-metadata.ts";
import type { PortResultV1 } from "../contracts/ports.ts";

export type ReviewOwnerPendingJournalV1 =
  | ReviewJournalIntentV1
  | ReviewJournalRunningV1;

export interface ReviewOwnerRegistrationV1 {
  repository: RepositoryIdentityV1;
  reviewId: number;
  journal: ReviewOwnerPendingJournalV1;
  bodyDigest: string;
}

export interface ReviewOwnerSettlementCarrierV1
  extends ReviewOwnerRegistrationV1 {
  version: "v1";
  kind: "review_owner_settled";
  ownerExecution: HostedExecutionIntentV1;
  preparedExecution: ReviewJournalExecutionV1 | null;
  settledAt: number;
  submissionSettled: true;
  finalizationSettled: true;
  processSettled: true;
  noRetainedHandle: true;
}

export interface HostedReviewOwnerSettlementV1 {
  version: "v1";
  kind: "hosted_review_owner_settled";
  execution: HostedExecutionIntentV1;
  carrier: ReviewOwnerSettlementCarrierV1;
}

export interface ReviewOwnerSettlementProofV1 {
  record: HostedReviewOwnerSettlementV1;
  jobId: number;
  observedAt: number;
  finishedAt: number;
  logDigest: string;
}

export interface ReviewOwnerSettlementResolverV1 {
  read(
    input: ReviewOwnerRegistrationV1,
  ): Promise<PortResultV1<ReviewOwnerSettlementProofV1 | null>>;
}

/** Private trusted child/custodian channel, never a model capability. */
export interface ReviewOwnerCustodyV1 {
  register(input: ReviewOwnerRegistrationV1): Promise<void>;
  settled(input: ReviewOwnerRegistrationV1): Promise<void>;
}

export function parseReviewOwnerRegistration(
  input: unknown,
): ReviewOwnerRegistrationV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(
    obj,
    ["repository", "reviewId", "journal", "bodyDigest"],
    "$",
  );
  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const journal = parseReviewJournalValue(obj.journal);
  if (
    journal.phase === "ready" || journal.ownerExecution === undefined ||
    journal.repository.owner !== repository.owner ||
    journal.repository.name !== repository.name ||
    journal.requestedAt < journal.ownerExecution.createdAt
  ) {
    fail(
      "$.journal",
      "invalid_lifecycle",
      "review owner pending binding is unavailable",
    );
  }
  const reviewId = expectPositiveInt(obj.reviewId, "$.reviewId");
  if (journal.phase === "running" && journal.reviewId !== reviewId) {
    fail("$.reviewId", "invalid_lifecycle", "review owner id mismatch");
  }
  return {
    repository,
    reviewId,
    journal,
    bodyDigest: expectSha256Hex(obj.bodyDigest, "$.bodyDigest"),
  };
}

export function parseReviewOwnerSettlementCarrier(
  input: unknown,
): ReviewOwnerSettlementCarrierV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, [
    "version",
    "kind",
    "ownerExecution",
    "repository",
    "reviewId",
    "journal",
    "bodyDigest",
    "preparedExecution",
    "settledAt",
    "submissionSettled",
    "finalizationSettled",
    "processSettled",
    "noRetainedHandle",
  ], "$");
  expectEnum(obj.version, ["v1"], "$.version");
  expectEnum(obj.kind, ["review_owner_settled"], "$.kind");
  const registration = parseReviewOwnerRegistration({
    repository: obj.repository,
    reviewId: obj.reviewId,
    journal: obj.journal,
    bodyDigest: obj.bodyDigest,
  });
  const ownerExecution = parseHostedExecutionIntentV1(obj.ownerExecution);
  if (
    canonicalStringify(ownerExecution) !==
      canonicalStringify(registration.journal.ownerExecution)
  ) {
    fail(
      "$.ownerExecution",
      "invalid_lifecycle",
      "review owner execution mismatch",
    );
  }
  const preparedExecution = obj.preparedExecution === null
    ? null
    : parseExecution(obj.preparedExecution, "$.preparedExecution");
  if (
    preparedExecution !== null &&
    preparedExecution.ownerRunId !== ownerExecution.id
  ) {
    fail(
      "$.preparedExecution",
      "invalid_lifecycle",
      "prepared review owner mismatch",
    );
  }
  if (
    registration.journal.phase === "running" &&
    canonicalStringify(preparedExecution) !==
      canonicalStringify(registration.journal.execution)
  ) {
    fail(
      "$.preparedExecution",
      "invalid_lifecycle",
      "prepared review identity mismatch",
    );
  }
  const settledAt = expectTimestamp(obj.settledAt, "$.settledAt");
  if (settledAt < registration.journal.requestedAt) {
    fail(
      "$.settledAt",
      "invalid_lifecycle",
      "review owner settlement precedes request",
    );
  }
  for (
    const key of [
      "submissionSettled",
      "finalizationSettled",
      "processSettled",
      "noRetainedHandle",
    ] as const
  ) {
    if (!expectBoolean(obj[key], `$.${key}`)) {
      fail(`$.${key}`, "invalid_lifecycle", "unproved review owner settlement");
    }
  }
  return {
    ...registration,
    version: "v1",
    kind: "review_owner_settled",
    ownerExecution,
    preparedExecution,
    settledAt,
    submissionSettled: true,
    finalizationSettled: true,
    processSettled: true,
    noRetainedHandle: true,
  };
}

export function parseHostedReviewOwnerSettlement(
  input: unknown,
): HostedReviewOwnerSettlementV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, ["version", "kind", "execution", "carrier"], "$");
  expectEnum(obj.version, ["v1"], "$.version");
  expectEnum(obj.kind, ["hosted_review_owner_settled"], "$.kind");
  const execution = parseHostedExecutionIntentV1(obj.execution);
  const carrier = parseReviewOwnerSettlementCarrier(obj.carrier);
  if (
    canonicalStringify(execution) !== canonicalStringify(carrier.ownerExecution)
  ) fail("$.execution", "invalid_lifecycle", "hosted review owner mismatch");
  return {
    version: "v1",
    kind: "hosted_review_owner_settled",
    execution,
    carrier,
  };
}

export async function reviewOwnerRegistration(
  repository: RepositoryIdentityV1,
  reviewId: number,
  journal: ReviewJournalV1,
  body: string,
): Promise<ReviewOwnerRegistrationV1> {
  return parseReviewOwnerRegistration({
    repository,
    reviewId,
    journal,
    bodyDigest: await canonicalStringifySha256(body),
  });
}

export function sameReviewOwnerRegistration(
  a: ReviewOwnerRegistrationV1,
  b: ReviewOwnerRegistrationV1,
): boolean {
  return canonicalStringify(a) === canonicalStringify(b);
}
