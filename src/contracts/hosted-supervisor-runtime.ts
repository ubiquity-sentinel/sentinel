import {
  expectBoolean,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";
import { HOSTED_RUNTIME_ID } from "./hosted-supervisor-types.ts";
import type {
  HostedPointerIntentV1,
  HostedRuntimeRecordV1,
} from "./hosted-supervisor-types.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedExecutionSettlementV1,
  parseHostedRunProofV1,
} from "./hosted-supervisor-execution.ts";
import { parseExecutionIds } from "./hosted-supervisor-verification.ts";

export const RUNTIME_KEYS = [
  "version",
  "kind",
  "id",
  "activeRevision",
  "generation",
  "lastHealthyProof",
  "lastExecutionProof",
  "nextOrdinaryAt",
  "execution",
  "createdAt",
  "updatedAt",
] as const;
export const POINTER_KEYS = [
  "action",
  "expectedRevision",
  "nextRevision",
  "expectedGeneration",
  "createdAt",
] as const;

export function parseHostedRuntimeRecordV1(
  input: unknown,
  path = "$",
): HostedRuntimeRecordV1 {
  const obj = expectRecord(input, path);
  const optionalKeys = [
    "verificationFailures",
    "failedVerificationIds",
    "lastVerificationId",
    "lastTurn",
    "ordinaryAdmission",
    "verificationBlocked",
  ];
  expectExactKeys(obj, [
    ...RUNTIME_KEYS,
    ...optionalKeys.filter((key) => Object.hasOwn(obj, key)),
  ], path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["hosted_runtime"], `${path}.kind`);

  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  if (id !== HOSTED_RUNTIME_ID) {
    fail(
      `${path}.id`,
      "invalid_lifecycle",
      "hosted runtime id is not the fixed self production runtime",
    );
  }
  const activeRevision = expectGitSha(
    obj.activeRevision,
    `${path}.activeRevision`,
  );
  const generation = expectPositiveInt(obj.generation, `${path}.generation`);
  const lastHealthyProof = expectNullable(
    obj.lastHealthyProof,
    `${path}.lastHealthyProof`,
    parseHostedRunProofV1,
  );
  if (lastHealthyProof !== null && lastHealthyProof.outcome !== "healthy") {
    fail(
      `${path}.lastHealthyProof`,
      "invalid_lifecycle",
      "lastHealthyProof must be a healthy proof",
    );
  }
  const lastExecutionProof = expectNullable(
    obj.lastExecutionProof,
    `${path}.lastExecutionProof`,
    parseHostedExecutionSettlementV1,
  );
  const nextOrdinaryAt = expectTimestamp(
    obj.nextOrdinaryAt,
    `${path}.nextOrdinaryAt`,
  );
  const execution = expectNullable(
    obj.execution,
    `${path}.execution`,
    parseHostedExecutionIntentV1,
  );
  if (execution !== null) {
    if (execution.revision !== activeRevision) {
      fail(
        `${path}.execution.revision`,
        "invalid_lifecycle",
        "an execution must bind the runtime pointer revision",
      );
    }
    if (execution.generation !== generation) {
      fail(
        `${path}.execution.generation`,
        "invalid_lifecycle",
        "an execution must bind the runtime pointer generation",
      );
    }
    // A settled execution is never still active, and a healthy proof of the
    // active execution would claim a settlement that removal contradicts. The
    // deterministic execution id is the identity: altered metadata must not
    // launder a settled execution back into the active slot.
    if (
      lastExecutionProof !== null &&
      lastExecutionProof.execution.id === execution.id
    ) {
      fail(
        `${path}.lastExecutionProof`,
        "invalid_lifecycle",
        "the active execution cannot already be its own settlement proof",
      );
    }
    if (
      lastHealthyProof !== null &&
      lastHealthyProof.execution.id === execution.id
    ) {
      fail(
        `${path}.lastHealthyProof`,
        "invalid_lifecycle",
        "the active execution cannot already have a healthy settlement",
      );
    }
  }
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`);
  const updatedAt = expectTimestamp(obj.updatedAt, `${path}.updatedAt`);
  if (createdAt > updatedAt) {
    fail(
      `${path}.createdAt`,
      "invalid_lifecycle",
      "createdAt cannot be after updatedAt",
    );
  }
  if (nextOrdinaryAt < createdAt) {
    fail(
      `${path}.nextOrdinaryAt`,
      "invalid_lifecycle",
      "nextOrdinaryAt cannot precede createdAt",
    );
  }
  const scheduling: Partial<HostedRuntimeRecordV1> = {};
  if (Object.hasOwn(obj, "verificationFailures")) {
    scheduling.verificationFailures = expectCount(
      obj.verificationFailures,
      `${path}.verificationFailures`,
    );
  }
  if (Object.hasOwn(obj, "failedVerificationIds")) {
    scheduling.failedVerificationIds = parseExecutionIds(
      obj.failedVerificationIds,
      `${path}.failedVerificationIds`,
    );
  }
  if (Object.hasOwn(obj, "lastVerificationId")) {
    scheduling.lastVerificationId = expectNullable(
      obj.lastVerificationId,
      `${path}.lastVerificationId`,
      (v, p) => expectNonEmptyString(v, p, MaxText.recordId),
    );
  }
  if (Object.hasOwn(obj, "lastTurn")) {
    scheduling.lastTurn = expectEnum(
      obj.lastTurn,
      ["ordinary", "verification"] as const,
      `${path}.lastTurn`,
    );
  }
  if (Object.hasOwn(obj, "verificationBlocked")) {
    scheduling.verificationBlocked = expectBoolean(
      obj.verificationBlocked,
      `${path}.verificationBlocked`,
    );
  }
  if (
    (scheduling.verificationFailures ?? 0) !==
      (scheduling.failedVerificationIds?.length ?? 0)
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "runtime failure count requires exact execution ids",
    );
  }
  if (Object.hasOwn(obj, "ordinaryAdmission")) {
    const a = expectRecord(obj.ordinaryAdmission, `${path}.ordinaryAdmission`);
    expectExactKeys(a, [
      "mode",
      "executionId",
      "revision",
      "generation",
      "failedVerificationIds",
    ], `${path}.ordinaryAdmission`);
    scheduling.ordinaryAdmission = {
      mode: expectEnum(
        a.mode,
        ["healthy", "degraded"],
        `${path}.ordinaryAdmission.mode`,
      ),
      executionId: expectNonEmptyString(
        a.executionId,
        `${path}.ordinaryAdmission.executionId`,
        MaxText.recordId,
      ),
      revision: expectGitSha(a.revision, `${path}.ordinaryAdmission.revision`),
      generation: expectPositiveInt(
        a.generation,
        `${path}.ordinaryAdmission.generation`,
      ),
      failedVerificationIds: parseExecutionIds(
        a.failedVerificationIds,
        `${path}.ordinaryAdmission.failedVerificationIds`,
      ),
    };
  }
  return {
    version: "v1",
    kind: "hosted_runtime",
    id,
    activeRevision,
    generation,
    lastHealthyProof,
    lastExecutionProof,
    nextOrdinaryAt,
    execution,
    createdAt,
    updatedAt,
    ...scheduling,
  };
}

export function parseHostedPointerIntentV1(
  input: unknown,
  path = "$",
): HostedPointerIntentV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, POINTER_KEYS, path);
  const action = expectEnum(
    obj.action,
    ["promote", "rollback"],
    `${path}.action`,
  );
  const expectedRevision = expectGitSha(
    obj.expectedRevision,
    `${path}.expectedRevision`,
  );
  const nextRevision = expectGitSha(
    obj.nextRevision,
    `${path}.nextRevision`,
  );
  if (expectedRevision === nextRevision) {
    fail(
      `${path}.nextRevision`,
      "invalid_lifecycle",
      "a pointer intent must move to a different revision",
    );
  }
  const expectedGeneration = expectPositiveInt(
    obj.expectedGeneration,
    `${path}.expectedGeneration`,
  );
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`);
  return {
    action,
    expectedRevision,
    nextRevision,
    expectedGeneration,
    createdAt,
  };
}
