/** Non-PR owner successor review journal, carried only by trusted repair state. */
import type { GitSha } from "./brands.ts";
import { canonicalStringify } from "./canonical.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedRunProofV1,
} from "./hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedRunProofV1,
} from "./hosted-supervisor.ts";
import { parseBudgetReservationV1 } from "./budget-reservation.ts";
import type { BudgetReservationV1 } from "./budget-reservation.ts";
import {
  parseExecution,
  parseReadyExecution,
} from "../github/journal-metadata.ts";
import type {
  ReviewJournalExecutionV1,
  ReviewJournalReadyExecutionV1,
} from "../github/journal-metadata.ts";
import { parseReviewResultV1 } from "../github/review-result-parser.ts";
import type { ReviewResultV1 } from "../github/review-result-contracts.ts";
import { validateReviewSnapshotV1 } from "../github/snapshot-manifest.ts";
import type { ReviewSnapshotV1 } from "../github/snapshot-manifest.ts";
import {
  expectBoolean,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectPositiveInt,
  expectRecord,
  expectSha256Hex,
  expectTimestamp,
  expectVersion,
  fail,
  MaxText,
} from "./validation.ts";

export interface OwnerSuccessorReviewBindingV1 {
  releaseId: string;
  requestSha256: string;
  intentSha256: string;
  ownerBindingId: string;
  ownerBindingSha256: string;
  workId: string;
  issueNumber: number;
  taskSha256: string;
  successorRevision: GitSha;
  successorGeneration: number;
  snapshot: ReviewSnapshotV1;
  nativeOwner: HostedExecutionIntentV1;
  health: HostedRunProofV1;
  expectedReleaseHead: GitSha;
  expectedRepairHead: GitSha;
  requestId: string;
  invocationId: string;
}
export interface OwnerSuccessorReviewV1 {
  version: "v1";
  kind: "owner_successor_review";
  id: string;
  phase: "intent" | "running" | "completed" | "failed";
  binding: OwnerSuccessorReviewBindingV1;
  reservation: BudgetReservationV1;
  execution: ReviewJournalExecutionV1 | null;
  readyExecution: ReviewJournalReadyExecutionV1 | null;
  result: ReviewResultV1 | null;
  resultSha256: string | null;
  close: { settled: boolean; failure: string | null; timedOut: boolean } | null;
  nativeCustody: "pending" | "settled";
  createdAt: number;
  updatedAt: number;
}

export interface OwnerSuccessorTaskAcceptanceV1 {
  version: "v1";
  kind: "owner_successor_task_acceptance";
  id: string;
  review: OwnerSuccessorReviewV1;
  reviewSha256: string;
  nativeOwnerProof: HostedRunProofV1;
  expectedRepairHead: GitSha;
  expectedReleaseHead: GitSha;
  producerRevision: GitSha;
  controllerRevision: GitSha;
  controllerRun: { runId: number; runAttempt: number; launcherSha: GitSha };
  createdAt: number;
}

export function parseOwnerSuccessorTaskAcceptanceV1(
  input: unknown,
  path = "$",
): OwnerSuccessorTaskAcceptanceV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "version",
    "kind",
    "id",
    "review",
    "reviewSha256",
    "nativeOwnerProof",
    "expectedRepairHead",
    "expectedReleaseHead",
    "producerRevision",
    "controllerRevision",
    "controllerRun",
    "createdAt",
  ], path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["owner_successor_task_acceptance"], `${path}.kind`);
  const review = parseOwnerSuccessorReviewV1(obj.review, `${path}.review`);
  const nativeOwnerProof = parseHostedRunProofV1(
    obj.nativeOwnerProof,
    `${path}.nativeOwnerProof`,
  );
  const producerRevision = expectGitSha(
    obj.producerRevision,
    `${path}.producerRevision`,
  );
  const controller = expectRecord(obj.controllerRun, `${path}.controllerRun`);
  expectExactKeys(
    controller,
    ["runId", "runAttempt", "launcherSha"],
    `${path}.controllerRun`,
  );
  const controllerRun = {
    runId: expectPositiveInt(controller.runId, `${path}.controllerRun.runId`),
    runAttempt: expectPositiveInt(
      controller.runAttempt,
      `${path}.controllerRun.runAttempt`,
    ),
    launcherSha: expectGitSha(
      controller.launcherSha,
      `${path}.controllerRun.launcherSha`,
    ),
  };
  const controllerRevision = expectGitSha(
    obj.controllerRevision,
    `${path}.controllerRevision`,
  );
  if (
    review.phase !== "completed" ||
    review.result?.taskAcceptance?.verdict !== "fulfilled" ||
    review.result.taskAcceptance.issueNumber !== review.binding.issueNumber ||
    review.result.taskAcceptance.taskDigest !== review.binding.taskSha256 ||
    review.result.findings.some((f) => f.priority <= 1) ||
    nativeOwnerProof.outcome !== "healthy" ||
    canonicalStringify(nativeOwnerProof.execution) !==
      canonicalStringify(review.binding.nativeOwner) ||
    producerRevision !== review.binding.successorRevision ||
    controllerRun.launcherSha !== controllerRevision
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner acceptance requires genuine fulfilled successor review and native owner settlement",
    );
  }
  return {
    version: "v1",
    kind: "owner_successor_task_acceptance",
    id: expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId),
    review,
    reviewSha256: expectSha256Hex(obj.reviewSha256, `${path}.reviewSha256`),
    nativeOwnerProof,
    expectedRepairHead: expectGitSha(
      obj.expectedRepairHead,
      `${path}.expectedRepairHead`,
    ),
    expectedReleaseHead: expectGitSha(
      obj.expectedReleaseHead,
      `${path}.expectedReleaseHead`,
    ),
    producerRevision,
    controllerRevision,
    controllerRun,
    createdAt: expectTimestamp(obj.createdAt, `${path}.createdAt`),
  };
}

export function parseOwnerSuccessorReviewBindingV1(
  input: unknown,
  path = "$",
): OwnerSuccessorReviewBindingV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "releaseId",
    "requestSha256",
    "intentSha256",
    "ownerBindingId",
    "ownerBindingSha256",
    "workId",
    "issueNumber",
    "taskSha256",
    "successorRevision",
    "successorGeneration",
    "snapshot",
    "nativeOwner",
    "health",
    "expectedReleaseHead",
    "expectedRepairHead",
    "requestId",
    "invocationId",
  ], path);
  const nativeOwner = parseHostedExecutionIntentV1(
    obj.nativeOwner,
    `${path}.nativeOwner`,
  );
  const health = parseHostedRunProofV1(obj.health, `${path}.health`);
  const successorRevision = expectGitSha(
    obj.successorRevision,
    `${path}.successorRevision`,
  );
  const successorGeneration = expectPositiveInt(
    obj.successorGeneration,
    `${path}.successorGeneration`,
  );
  const snapshotFailure = validateReviewSnapshotV1(obj.snapshot);
  if (snapshotFailure !== null) {
    fail(path, "invalid_lifecycle", "owner review snapshot is invalid");
  }
  const snapshot = structuredClone(obj.snapshot) as ReviewSnapshotV1;
  if (
    nativeOwner.purpose !== "ordinary" || nativeOwner.releaseId !== null ||
    nativeOwner.revision !== successorRevision ||
    nativeOwner.generation !== successorGeneration ||
    health.outcome !== "healthy" ||
    health.execution.revision !== successorRevision ||
    health.execution.generation !== successorGeneration ||
    snapshot.head !== successorRevision
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner review requires genuine own successor health and ordinary native owner",
    );
  }
  return {
    releaseId: expectNonEmptyString(
      obj.releaseId,
      `${path}.releaseId`,
      MaxText.recordId,
    ),
    requestSha256: expectSha256Hex(obj.requestSha256, `${path}.requestSha256`),
    intentSha256: expectSha256Hex(obj.intentSha256, `${path}.intentSha256`),
    ownerBindingId: expectNonEmptyString(
      obj.ownerBindingId,
      `${path}.ownerBindingId`,
      MaxText.recordId,
    ),
    ownerBindingSha256: expectSha256Hex(
      obj.ownerBindingSha256,
      `${path}.ownerBindingSha256`,
    ),
    workId: expectNonEmptyString(
      obj.workId,
      `${path}.workId`,
      MaxText.recordId,
    ),
    issueNumber: expectPositiveInt(obj.issueNumber, `${path}.issueNumber`),
    taskSha256: expectSha256Hex(obj.taskSha256, `${path}.taskSha256`),
    successorRevision,
    successorGeneration,
    snapshot,
    nativeOwner,
    health,
    expectedReleaseHead: expectGitSha(
      obj.expectedReleaseHead,
      `${path}.expectedReleaseHead`,
    ),
    expectedRepairHead: expectGitSha(
      obj.expectedRepairHead,
      `${path}.expectedRepairHead`,
    ),
    requestId: expectNonEmptyString(
      obj.requestId,
      `${path}.requestId`,
      MaxText.recordId,
    ),
    invocationId: expectNonEmptyString(
      obj.invocationId,
      `${path}.invocationId`,
      MaxText.recordId,
    ),
  };
}

export function parseOwnerSuccessorReviewV1(
  input: unknown,
  path = "$",
): OwnerSuccessorReviewV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "version",
    "kind",
    "id",
    "phase",
    "binding",
    "reservation",
    "execution",
    "readyExecution",
    "result",
    "resultSha256",
    "close",
    "nativeCustody",
    "createdAt",
    "updatedAt",
  ], path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["owner_successor_review"], `${path}.kind`);
  const id = expectNonEmptyString(obj.id, `${path}.id`, MaxText.recordId);
  const phase = expectEnum(obj.phase, [
    "intent",
    "running",
    "completed",
    "failed",
  ], `${path}.phase`);
  const binding = parseOwnerSuccessorReviewBindingV1(
    obj.binding,
    `${path}.binding`,
  );
  const reservation = parseBudgetReservationV1(obj.reservation);
  const execution = obj.execution === null
    ? null
    : parseExecution(obj.execution, `${path}.execution`);
  const readyExecution = obj.readyExecution === null
    ? null
    : parseReadyExecution(obj.readyExecution, `${path}.readyExecution`);
  const result = obj.result === null ? null : parseReviewResultV1(obj.result);
  const resultSha256 = obj.resultSha256 === null
    ? null
    : expectSha256Hex(obj.resultSha256, `${path}.resultSha256`);
  const nativeCustody = expectEnum(
    obj.nativeCustody,
    ["pending", "settled"],
    `${path}.nativeCustody`,
  );
  let close: OwnerSuccessorReviewV1["close"] = null;
  if (obj.close !== null) {
    const value = expectRecord(obj.close, `${path}.close`);
    expectExactKeys(value, ["settled", "failure", "timedOut"], `${path}.close`);
    close = {
      settled: expectBoolean(value.settled, `${path}.close.settled`),
      timedOut: expectBoolean(value.timedOut, `${path}.close.timedOut`),
      failure: value.failure === null ? null : expectNonEmptyString(
        value.failure,
        `${path}.close.failure`,
        MaxText.message,
      ),
    };
  }
  const createdAt = expectTimestamp(obj.createdAt, `${path}.createdAt`),
    updatedAt = expectTimestamp(obj.updatedAt, `${path}.updatedAt`);
  if (
    createdAt > updatedAt || reservation.taskId !== binding.workId ||
    reservation.head !== binding.successorRevision ||
    reservation.purpose !== "review_request" ||
    reservation.repository.owner !== "Ubiquity-Sentinel" ||
    reservation.repository.name !== "sentinel" ||
    reservation.repository.installationId !== 0 ||
    (execution !== null &&
      (execution.ownerRunId !== binding.nativeOwner.id ||
        execution.invocationId !== binding.invocationId)) ||
    (readyExecution !== null &&
      (execution === null ||
        canonicalStringify(
            Object.fromEntries(
              Object.entries(readyExecution).filter(([key]) =>
                !["turnId", "resultId", "actual"].includes(key)
              ),
            ),
          ) !== canonicalStringify(execution)))
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner successor review identity is inconsistent",
    );
  }
  if (
    phase === "intent" &&
    (nativeCustody !== "pending" || execution !== null ||
      readyExecution !== null || result !== null || close !== null ||
      reservation.outcome !== "reserved")
  ) fail(path, "invalid_lifecycle", "owner intent cannot claim execution");
  if (
    phase === "running" &&
    (nativeCustody !== "pending" || execution === null ||
      readyExecution !== null || result !== null || close !== null ||
      reservation.outcome !== "reserved")
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "owner running review must retain its charged start intent",
    );
  }
  if (
    phase === "completed" &&
    (execution === null || readyExecution === null || result === null ||
      result.verdict === "unavailable" || resultSha256 === null ||
      close?.settled !== true || close.timedOut || close.failure !== null ||
      reservation.outcome !== "submitted" || reservation.settledAt === null ||
      nativeCustody !== "settled" ||
      readyExecution.actual.terminalOrigin !== "runtime" ||
      readyExecution.actual.observedTerminalStatus !== "completed")
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "completed owner review requires real settled native completion",
    );
  }
  if ((result === null) !== (resultSha256 === null)) {
    fail(
      path,
      "invalid_lifecycle",
      "owner result digest presence is inconsistent",
    );
  }
  return {
    version: "v1",
    kind: "owner_successor_review",
    id,
    phase,
    binding,
    reservation,
    execution,
    readyExecution,
    result,
    resultSha256,
    close,
    nativeCustody,
    createdAt,
    updatedAt,
  };
}

export function ownerSuccessorReviewTransition(
  prior: OwnerSuccessorReviewV1,
  next: OwnerSuccessorReviewV1,
): boolean {
  if (
    prior.id !== next.id || prior.createdAt !== next.createdAt ||
    prior.updatedAt > next.updatedAt ||
    canonicalStringify(prior.binding) !== canonicalStringify(next.binding) ||
    canonicalStringify({
        ...prior.reservation,
        outcome: null,
        settledAt: null,
        proofRef: null,
      }) !==
      canonicalStringify({
        ...next.reservation,
        outcome: null,
        settledAt: null,
        proofRef: null,
      }) ||
    (prior.execution !== null &&
      canonicalStringify(prior.execution) !==
        canonicalStringify(next.execution))
  ) return false;
  if (prior.phase === "completed" || prior.phase === "failed") {
    return canonicalStringify(prior) === canonicalStringify(next);
  }
  return prior.phase === "intent"
    ? ["intent", "running", "failed"].includes(next.phase)
    : ["running", "completed", "failed"].includes(next.phase);
}
