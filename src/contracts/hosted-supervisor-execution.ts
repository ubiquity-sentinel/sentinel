import {
  expectBoolean,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  fail,
  MaxText,
} from "./validation.ts";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
  RETIRED_HOSTED_SUPERVISOR_REPOSITORY,
} from "./hosted-supervisor-types.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
  HostedNotStartedProofV1,
  HostedRunProofV1,
} from "./hosted-supervisor-types.ts";

export const EXECUTION_KEYS = [
  "id",
  "runId",
  "runAttempt",
  "launcherSha",
  "purpose",
  "revision",
  "generation",
  "releaseId",
  "createdAt",
] as const;
export const PROOF_KEYS = [
  "execution",
  "workflowId",
  "workflowPath",
  "repository",
  "ref",
  "jobId",
  "startedAt",
  "finishedAt",
  "observedAt",
  "outcome",
  "startupReady",
  "settled",
  "baseSha",
  "terminalAt",
  "logDigest",
] as const;
export const NOT_STARTED_KEYS = [
  "execution",
  "workflowId",
  "workflowPath",
  "repository",
  "ref",
  "jobId",
  "finishedAt",
  "observedAt",
  "outcome",
  "evidenceDigest",
] as const;

export function parseHostedExecutionIntentV1(
  input: unknown,
  path = "$",
): HostedExecutionIntentV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, EXECUTION_KEYS, path);

  const runId = expectPositiveInt(obj.runId, `${path}.runId`);
  const runAttempt = expectPositiveInt(obj.runAttempt, `${path}.runAttempt`);
  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  if (id !== `${runId}:${runAttempt}:repair`) {
    fail(
      `${path}.id`,
      "invalid_lifecycle",
      "execution id must be exactly runId:runAttempt:repair",
    );
  }
  const launcherSha = expectGitSha(obj.launcherSha, `${path}.launcherSha`);
  const purpose = expectEnum(
    obj.purpose,
    ["bootstrap", "ordinary", "prior", "candidate", "rollback"],
    `${path}.purpose`,
  );
  const revision = expectGitSha(obj.revision, `${path}.revision`);
  const generation = expectPositiveInt(obj.generation, `${path}.generation`);
  const releaseId = expectNullableString(
    obj.releaseId,
    `${path}.releaseId`,
    MaxText.recordId,
  );
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`);

  const unscoped = purpose === "bootstrap" || purpose === "ordinary";
  if (unscoped !== (releaseId === null)) {
    fail(
      `${path}.releaseId`,
      "invalid_lifecycle",
      "releaseId is null exactly for bootstrap/ordinary executions",
    );
  }
  return {
    id,
    runId,
    runAttempt,
    launcherSha,
    purpose,
    revision,
    generation,
    releaseId,
    createdAt,
  };
}

export function parseHostedRunProofV1(
  input: unknown,
  path = "$",
): HostedRunProofV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, PROOF_KEYS, path);

  const execution = parseHostedExecutionIntentV1(
    obj.execution,
    `${path}.execution`,
  );
  const workflowId = expectPositiveInt(obj.workflowId, `${path}.workflowId`);
  if (workflowId !== HOSTED_SUPERVISOR_WORKFLOW_ID) {
    fail(
      `${path}.workflowId`,
      "invalid_lifecycle",
      "proof workflow id is not the fixed supervisor workflow",
    );
  }
  const workflowPath = expectNonEmptyString(
    obj.workflowPath,
    `${path}.workflowPath`,
    MaxText.path,
  );
  if (workflowPath !== HOSTED_SUPERVISOR_WORKFLOW_PATH) {
    fail(
      `${path}.workflowPath`,
      "invalid_lifecycle",
      "proof workflow path is not the fixed supervisor workflow",
    );
  }
  const rawRepository = expectNonEmptyString(
    obj.repository,
    `${path}.repository`,
    MaxText.name + MaxText.owner + 1,
  );
  if (
    rawRepository !== HOSTED_SUPERVISOR_REPOSITORY &&
    rawRepository !== RETIRED_HOSTED_SUPERVISOR_REPOSITORY
  ) {
    fail(
      `${path}.repository`,
      "invalid_lifecycle",
      "proof repository is not the fixed supervisor repository",
    );
  }
  const repository = HOSTED_SUPERVISOR_REPOSITORY;
  const ref = expectNonEmptyString(obj.ref, `${path}.ref`, MaxText.ref);
  if (ref !== HOSTED_SUPERVISOR_REF) {
    fail(
      `${path}.ref`,
      "invalid_lifecycle",
      "proof ref is not the fixed supervisor ref",
    );
  }
  const jobId = expectPositiveInt(obj.jobId, `${path}.jobId`);
  const startedAt = expectTimestamp(obj.startedAt, `${path}.startedAt`);
  const finishedAt = expectTimestamp(obj.finishedAt, `${path}.finishedAt`);
  const observedAt = expectTimestamp(obj.observedAt, `${path}.observedAt`);
  const outcome = expectEnum(
    obj.outcome,
    ["healthy", "failed"],
    `${path}.outcome`,
  );
  const startupReady = expectBoolean(
    obj.startupReady,
    `${path}.startupReady`,
  );
  const settled = expectBoolean(obj.settled, `${path}.settled`);
  if (settled !== true) {
    fail(
      `${path}.settled`,
      "invalid_lifecycle",
      "an unsettled run is never proof",
    );
  }
  const baseSha = expectNullable(obj.baseSha, `${path}.baseSha`, expectGitSha);
  const terminalAt = expectNullable(
    obj.terminalAt,
    `${path}.terminalAt`,
    expectTimestamp,
  );
  const logDigest = expectSha256Hex(obj.logDigest, `${path}.logDigest`);

  const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
  if (startedAt + tolerance < execution.createdAt) {
    fail(
      `${path}.startedAt`,
      "invalid_lifecycle",
      "startedAt precedes the execution intent beyond clock tolerance",
    );
  }
  if (finishedAt < startedAt) {
    fail(
      `${path}.finishedAt`,
      "invalid_lifecycle",
      "finishedAt cannot precede startedAt",
    );
  }
  if (observedAt + tolerance < finishedAt) {
    fail(
      `${path}.observedAt`,
      "invalid_lifecycle",
      "observedAt precedes finishedAt beyond clock tolerance",
    );
  }
  if (
    terminalAt !== null &&
    (terminalAt + tolerance < startedAt ||
      terminalAt > finishedAt + tolerance)
  ) {
    fail(
      `${path}.terminalAt`,
      "invalid_lifecycle",
      "terminalAt must fall within the observed job bounds",
    );
  }
  if (outcome === "healthy") {
    if (!startupReady) {
      fail(
        `${path}.startupReady`,
        "invalid_lifecycle",
        "a healthy proof requires startupReady true",
      );
    }
    if (baseSha === null) {
      fail(
        `${path}.baseSha`,
        "invalid_lifecycle",
        "a healthy proof requires the observed base SHA",
      );
    }
    if (terminalAt === null) {
      fail(
        `${path}.terminalAt`,
        "invalid_lifecycle",
        "a healthy proof requires the terminal instant",
      );
    }
  }
  return {
    execution,
    workflowId,
    workflowPath,
    repository,
    ref,
    jobId,
    startedAt,
    finishedAt,
    observedAt,
    outcome,
    startupReady,
    settled: true,
    baseSha,
    terminalAt,
    logDigest,
  };
}

export function parseHostedNotStartedProofV1(
  input: unknown,
  path = "$",
): HostedNotStartedProofV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, NOT_STARTED_KEYS, path);

  const execution = parseHostedExecutionIntentV1(
    obj.execution,
    `${path}.execution`,
  );
  const workflowId = expectPositiveInt(obj.workflowId, `${path}.workflowId`);
  if (workflowId !== HOSTED_SUPERVISOR_WORKFLOW_ID) {
    fail(
      `${path}.workflowId`,
      "invalid_lifecycle",
      "settlement workflow id is not the fixed supervisor workflow",
    );
  }
  const workflowPath = expectNonEmptyString(
    obj.workflowPath,
    `${path}.workflowPath`,
    MaxText.path,
  );
  if (workflowPath !== HOSTED_SUPERVISOR_WORKFLOW_PATH) {
    fail(
      `${path}.workflowPath`,
      "invalid_lifecycle",
      "settlement workflow path is not the fixed supervisor workflow",
    );
  }
  const rawRepository = expectNonEmptyString(
    obj.repository,
    `${path}.repository`,
    MaxText.name + MaxText.owner + 1,
  );
  if (
    rawRepository !== HOSTED_SUPERVISOR_REPOSITORY &&
    rawRepository !== RETIRED_HOSTED_SUPERVISOR_REPOSITORY
  ) {
    fail(
      `${path}.repository`,
      "invalid_lifecycle",
      "settlement repository is not the fixed supervisor repository",
    );
  }
  const repository = HOSTED_SUPERVISOR_REPOSITORY;
  const ref = expectNonEmptyString(obj.ref, `${path}.ref`, MaxText.ref);
  if (ref !== HOSTED_SUPERVISOR_REF) {
    fail(
      `${path}.ref`,
      "invalid_lifecycle",
      "settlement ref is not the fixed supervisor ref",
    );
  }
  const jobId = expectNullable(obj.jobId, `${path}.jobId`, expectPositiveInt);
  const finishedAt = expectTimestamp(obj.finishedAt, `${path}.finishedAt`);
  const observedAt = expectTimestamp(obj.observedAt, `${path}.observedAt`);
  const outcome = expectEnum(
    obj.outcome,
    ["not_started"],
    `${path}.outcome`,
  );
  const evidenceDigest = expectSha256Hex(
    obj.evidenceDigest,
    `${path}.evidenceDigest`,
  );
  const tolerance = HOSTED_ACTIONS_CLOCK_TOLERANCE_MS;
  if (finishedAt + tolerance < execution.createdAt) {
    fail(
      `${path}.finishedAt`,
      "invalid_lifecycle",
      "finishedAt precedes the execution intent beyond clock tolerance",
    );
  }
  if (observedAt + tolerance < finishedAt) {
    fail(
      `${path}.observedAt`,
      "invalid_lifecycle",
      "observedAt precedes finishedAt beyond clock tolerance",
    );
  }
  return {
    execution,
    workflowId,
    workflowPath,
    repository,
    ref,
    jobId,
    finishedAt,
    observedAt,
    outcome,
    evidenceDigest,
  };
}

/** Discriminated settlement parser: never treats no-execution as a run. */
export function parseHostedExecutionSettlementV1(
  input: unknown,
  path = "$",
): HostedExecutionSettlementV1 {
  const obj = expectRecord(input, path);
  if (obj.outcome === "not_started") {
    return parseHostedNotStartedProofV1(input, path);
  }
  return parseHostedRunProofV1(input, path);
}
