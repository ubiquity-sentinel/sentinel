// Frozen parser from 1838df313105bab219d71602695a7f758a65125e; only import paths change.
import {
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
} from "../../../src/contracts/validation.ts";
import { HOSTED_RUNTIME_ID } from "../../../src/contracts/hosted-supervisor-types.ts";
import type {
  HostedPointerIntentV1,
  HostedRuntimeRecordV1,
} from "../../../src/contracts/hosted-supervisor-types.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedExecutionSettlementV1,
  parseHostedRunProofV1,
} from "../../../src/contracts/hosted-supervisor-execution.ts";

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
  expectExactKeys(obj, RUNTIME_KEYS, path);
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
