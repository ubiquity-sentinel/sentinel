import { parseDeploymentIdentity, parseRepositoryIdentity } from "./shared.ts";
import {
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";
import type { ReleaseRecordV1, ReleaseRequestV1 } from "./release-types.ts";
import {
  parseAcceptance,
  parseIntent,
  parseMonitoring,
  parseObserved,
  parseReceipts,
  sameIdentity,
} from "./release-lifecycle.ts";

/**
 * ReleaseRequestV1 and ReleaseRecordV1.
 *
 * A repair writer places a release request (exact accepted merged SHA plus
 * PR/review reference — never a model-chosen arbitrary revision). The release
 * writer exclusively owns release records: exact candidate/prior identities,
 * persisted promotion intent, the actually observed identity, monitored
 * acceptance with interrupted-coverage semantics, and rollback/error receipts.
 */

const REQUEST_KEYS = [
  "version",
  "kind",
  "id",
  "target",
  "revision",
  "source",
  "status",
  "failureReason",
  "createdAt",
] as const;
const REQUEST_TARGET_KEYS = ["repository", "environment"] as const;
const REQUEST_SOURCE_KEYS = [
  "pullRequest",
  "reviewRequestId",
  "reviewReceiptId",
  "head",
  "base",
] as const;
const RECORD_KEYS = [
  "version",
  "kind",
  "repository",
  "environment",
  "id",
  "requestId",
  "requestRevision",
  "candidate",
  "prior",
  "phase",
  "intent",
  "observed",
  "monitoring",
  "acceptance",
  "receipts",
  "createdAt",
  "updatedAt",
] as const;
const CANDIDATE_KEYS = ["identity", "buildTransactionId"] as const;
const PRIOR_KEYS = ["identity", "verifiedHealthyAt"] as const;

export function parseReleaseRequestV1(input: unknown): ReleaseRequestV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, REQUEST_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["release_request"], "$.kind");

  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);

  const targetObj = expectRecord(obj.target, "$.target");
  expectExactKeys(targetObj, REQUEST_TARGET_KEYS, "$.target");
  const target = {
    repository: parseRepositoryIdentity(
      targetObj.repository,
      "$.target.repository",
    ),
    environment: expectEnum(
      targetObj.environment,
      ["production", "isolated"],
      "$.target.environment",
    ),
  };
  const revision = expectGitSha(obj.revision, "$.revision");

  const sourceObj = expectRecord(obj.source, "$.source");
  expectExactKeys(sourceObj, REQUEST_SOURCE_KEYS, "$.source");
  const source = {
    pullRequest: expectPositiveInt(
      sourceObj.pullRequest,
      "$.source.pullRequest",
    ),
    reviewRequestId: expectNonEmptyString(
      sourceObj.reviewRequestId,
      "$.source.reviewRequestId",
      MaxText.recordId,
    ),
    reviewReceiptId: expectNullableString(
      sourceObj.reviewReceiptId,
      "$.source.reviewReceiptId",
      MaxText.recordId,
    ),
    head: expectGitSha(sourceObj.head, "$.source.head"),
    base: expectGitSha(sourceObj.base, "$.source.base"),
  };

  const status = expectEnum(
    obj.status,
    ["open", "fulfilled", "failed", "cancelled"],
    "$.status",
  );
  const failureReason = expectNullableString(
    obj.failureReason,
    "$.failureReason",
    MaxText.message,
  );
  if (
    (status === "failed" || status === "cancelled") && failureReason === null
  ) {
    fail(
      "$.failureReason",
      "invalid_lifecycle",
      "failed/cancelled request requires a reason",
    );
  }
  if ((status === "open" || status === "fulfilled") && failureReason !== null) {
    fail(
      "$.failureReason",
      "invalid_lifecycle",
      "open/fulfilled request has no failure reason",
    );
  }
  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");

  return {
    version: "v1",
    kind: "release_request",
    id,
    target,
    revision,
    source,
    status,
    failureReason,
    createdAt,
  };
}

export function parseReleaseRecordV1(input: unknown): ReleaseRecordV1 {
  const obj = expectRecord(input, "$");
  expectExactKeys(obj, RECORD_KEYS, "$");
  expectVersion(obj.version, "$.version");
  expectEnum(obj.kind, ["release_record"], "$.kind");

  const repository = parseRepositoryIdentity(obj.repository, "$.repository");
  const environment = expectEnum(
    obj.environment,
    ["production", "isolated"],
    "$.environment",
  );
  const id = expectNonEmptyString(obj.id, "$.id", MaxText.recordId);
  const requestId = expectNonEmptyString(
    obj.requestId,
    "$.requestId",
    MaxText.recordId,
  );
  const requestRevision = expectGitSha(
    obj.requestRevision,
    "$.requestRevision",
  );

  const candidateObj = expectRecord(obj.candidate, "$.candidate");
  expectExactKeys(candidateObj, CANDIDATE_KEYS, "$.candidate");
  const candidate = {
    identity: parseDeploymentIdentity(
      candidateObj.identity,
      "$.candidate.identity",
    ),
    buildTransactionId: expectNonEmptyString(
      candidateObj.buildTransactionId,
      "$.candidate.buildTransactionId",
      MaxText.recordId,
    ),
  };
  if (requestRevision !== candidate.identity.gitSha) {
    fail(
      "$.candidate.identity.gitSha",
      "invalid_lifecycle",
      "candidate Git SHA must equal the request revision",
    );
  }

  const priorObj = expectRecord(obj.prior, "$.prior");
  expectExactKeys(priorObj, PRIOR_KEYS, "$.prior");
  const prior = {
    identity: parseDeploymentIdentity(priorObj.identity, "$.prior.identity"),
    verifiedHealthyAt: expectTimestamp(
      priorObj.verifiedHealthyAt,
      "$.prior.verifiedHealthyAt",
    ),
  };
  if (sameIdentity(prior.identity, candidate.identity)) {
    fail(
      "$.prior.identity",
      "invalid_lifecycle",
      "prior and candidate identities must differ",
    );
  }

  const phase = expectEnum(
    obj.phase,
    [
      "requested",
      "promoting",
      "monitoring",
      "accepted",
      "failed",
      "rolled_back",
    ],
    "$.phase",
  );
  const intent = expectNullable(obj.intent, "$.intent", parseIntent);
  const observed = parseObserved(obj.observed, "$.observed");
  const monitoring = parseMonitoring(obj.monitoring, "$.monitoring");
  const acceptance = expectNullable(
    obj.acceptance,
    "$.acceptance",
    (input, path) =>
      parseAcceptance(input, path, candidate.identity, prior.identity),
  );
  const receipts = parseReceipts(obj.receipts, "$.receipts");

  const createdAt = expectTimestamp(obj.createdAt, "$.createdAt");
  const updatedAt = expectTimestamp(obj.updatedAt, "$.updatedAt");
  if (createdAt > updatedAt) {
    fail(
      "$.createdAt",
      "invalid_lifecycle",
      "createdAt cannot be after updatedAt",
    );
  }

  // Fail-closed phase rules.
  if (
    phase === "promoting" && (intent === null || intent.action !== "promote")
  ) {
    fail(
      "$.intent",
      "invalid_lifecycle",
      'phase "promoting" requires a persisted promote intent',
    );
  }
  if (phase === "accepted") {
    if (
      !observed.verified || observed.identity === null ||
      !sameIdentity(observed.identity, candidate.identity)
    ) {
      fail(
        "$.observed",
        "invalid_lifecycle",
        "accepted release requires a verified observed candidate identity",
      );
    }
    if (
      !monitoring.continuous || monitoring.samples < 1 ||
      monitoring.startedAt === null
    ) {
      fail(
        "$.monitoring",
        "invalid_lifecycle",
        "accepted release requires continuous monitoring coverage",
      );
    }
    if (acceptance === null || !acceptance.passed) {
      fail(
        "$.acceptance",
        "invalid_lifecycle",
        "accepted release requires a passing acceptance result",
      );
    }
    if (!acceptance.continuous) {
      fail(
        "$.acceptance",
        "invalid_lifecycle",
        "acceptance result cannot be continuous=false when accepted",
      );
    }
    if (!sameIdentity(acceptance.identity, candidate.identity)) {
      fail(
        "$.acceptance.identity",
        "invalid_lifecycle",
        "acceptance must reference the exact candidate identity",
      );
    }
  }
  if (phase === "rolled_back") {
    const rollback = receipts.rollback;
    if (rollback === null || !rollback.ok) {
      fail(
        "$.receipts.rollback",
        "invalid_lifecycle",
        "rolled_back requires an ok rollback receipt",
      );
    }
    if (
      rollback.observedIdentity === null ||
      !sameIdentity(rollback.observedIdentity, prior.identity)
    ) {
      fail(
        "$.receipts.rollback",
        "invalid_lifecycle",
        "rollback must restore the recorded prior identity",
      );
    }
    if (
      !observed.verified || observed.identity === null ||
      !sameIdentity(observed.identity, prior.identity)
    ) {
      fail(
        "$.observed",
        "invalid_lifecycle",
        "after rollback the observed identity must be the prior identity",
      );
    }
  }
  if (phase === "failed" && receipts.error === null) {
    fail(
      "$.receipts.error",
      "invalid_lifecycle",
      'phase "failed" requires an error receipt',
    );
  }

  return {
    version: "v1",
    kind: "release_record",
    repository,
    environment,
    id,
    requestId,
    requestRevision,
    candidate,
    prior,
    phase,
    intent,
    observed,
    monitoring,
    acceptance,
    receipts,
    createdAt,
    updatedAt,
  };
}

export type {
  AcceptanceResultV1,
  AcceptanceThresholdResultV1,
  ReleaseErrorV1,
  ReleaseIntentActionV1,
  ReleaseIntentV1,
  ReleaseMonitoringV1,
  ReleaseObservedV1,
  ReleasePhaseV1,
  ReleaseReceiptV1,
  ReleaseRecordV1,
  ReleaseRequestStatusV1,
  ReleaseRequestV1,
  ReleaseTargetEnvironmentV1,
} from "./release-types.ts";
