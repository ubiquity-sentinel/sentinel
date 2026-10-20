import { canonicalStringify } from "./canonical.ts";
import { parseHostedExecutionSettlementV1 } from "./hosted-supervisor-execution.ts";
import type {
  HostedAbandonmentV1,
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
  HostedVerificationJournalV1,
} from "./hosted-supervisor-types.ts";
import {
  expectArray,
  expectCount,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectNonEmptyString,
  expectNullable,
  expectRecord,
  expectTimestamp,
  fail,
  MaxText,
} from "./validation.ts";

export const HOSTED_VERIFICATION_LIMIT = 2;
export function emptyHostedVerification(): HostedVerificationJournalV1 {
  return {
    attempts: 0,
    failures: 0,
    lastExecutionId: null,
    lastFailure: null,
    executionIds: [],
    settledExecutionIds: [],
  };
}
export function parseExecutionIds(
  input: unknown,
  path: string,
  max = 2,
): string[] {
  const ids = expectArray(
    input,
    path,
    max,
    (v, p) => expectNonEmptyString(v, p, MaxText.recordId),
  );
  if (new Set(ids).size !== ids.length) {
    fail(path, "invalid_lifecycle", "execution ids must be unique");
  }
  return ids;
}
export function parseHostedVerification(input: unknown, path: string) {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, ["prior", "candidate"], path);
  return {
    prior: parseJournal(obj.prior, `${path}.prior`),
    candidate: parseJournal(obj.candidate, `${path}.candidate`),
  };
}
function parseJournal(
  input: unknown,
  path: string,
): HostedVerificationJournalV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "attempts",
    "failures",
    "lastExecutionId",
    "lastFailure",
    "executionIds",
    "settledExecutionIds",
  ], path);
  const result: HostedVerificationJournalV1 = {
    attempts: expectCount(obj.attempts, `${path}.attempts`),
    failures: expectCount(obj.failures, `${path}.failures`),
    lastExecutionId: expectNullable(
      obj.lastExecutionId,
      `${path}.lastExecutionId`,
      (v, p) => expectNonEmptyString(v, p, MaxText.recordId),
    ),
    lastFailure: expectNullable(
      obj.lastFailure,
      `${path}.lastFailure`,
      (value, path) => {
        const failure = expectRecord(value, path);
        expectExactKeys(failure, ["proof", "reason"], path);
        const proof = parseHostedExecutionSettlementV1(
          failure.proof,
          `${path}.proof`,
        );
        const reason = expectEnum(
          failure.reason,
          ["execution_failed", "not_started"] as const,
          `${path}.reason`,
        );
        if (
          proof.outcome === "healthy" ||
          reason !==
            (proof.outcome === "failed" ? "execution_failed" : "not_started")
        ) {
          fail(
            path,
            "invalid_lifecycle",
            "failure reason must match native settlement",
          );
        }
        return { proof, reason };
      },
    ),
    executionIds: parseExecutionIds(obj.executionIds, `${path}.executionIds`),
    settledExecutionIds: parseExecutionIds(
      obj.settledExecutionIds,
      `${path}.settledExecutionIds`,
    ),
  };
  if (
    result.attempts !== result.executionIds.length ||
    result.failures > result.settledExecutionIds.length ||
    result.lastExecutionId !== (result.executionIds.at(-1) ?? null) ||
    result.settledExecutionIds.some((id) =>
      !result.executionIds.includes(id)
    ) ||
    (result.failures === 0) !== (result.lastFailure === null) ||
    result.lastFailure !== null &&
      (result.lastFailure.proof.outcome === "healthy" ||
        !result.settledExecutionIds.includes(
          result.lastFailure.proof.execution.id,
        ))
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "verification journal must bind bounded exact admissions and settlements",
    );
  }
  return result;
}
export function parseHostedAbandonment(
  input: unknown,
  path: string,
): HostedAbandonmentV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, [
    "reason",
    "fromPhase",
    "executionIds",
    "recordedAt",
    ...(Object.hasOwn(obj, "successorRevision") ? ["successorRevision"] : []),
  ], path);
  const result: HostedAbandonmentV1 = {
    reason: expectEnum(obj.reason, [
      "prior_verification_exhausted",
      "candidate_verification_exhausted",
      "candidate_verification_failed",
      "included_in_successor",
    ], `${path}.reason`),
    fromPhase: expectEnum(obj.fromPhase, [
      "requested",
      "promoting",
      "verifying",
      "rollback_pending",
      "rollback_verifying",
    ], `${path}.fromPhase`),
    executionIds: parseExecutionIds(
      obj.executionIds,
      `${path}.executionIds`,
      4,
    ),
    recordedAt: expectTimestamp(obj.recordedAt, `${path}.recordedAt`),
    ...(Object.hasOwn(obj, "successorRevision")
      ? {
        successorRevision: expectGitSha(
          obj.successorRevision,
          `${path}.successorRevision`,
        ),
      }
      : {}),
  };
  if (
    (result.reason === "included_in_successor") !==
      (result.successorRevision !== undefined)
  ) {
    fail(
      path,
      "invalid_lifecycle",
      "only successor inclusion records the exact successor",
    );
  }
  return result;
}
const same = (a: unknown, b: unknown) =>
  canonicalStringify(a) === canonicalStringify(b);

/** No journal can be incremented without the corresponding durable admission/settlement. */
export function validateHostedVerificationTransition(
  before: HostedReleaseRecordV1,
  after: HostedReleaseRecordV1,
  runtime: HostedRuntimeRecordV1 | undefined,
  next: HostedRuntimeRecordV1 | undefined,
): string | null {
  for (const purpose of ["prior", "candidate"] as const) {
    const old = before.verification?.[purpose] ?? emptyHostedVerification();
    const value = after.verification?.[purpose] ?? emptyHostedVerification();
    if (same(old, value)) continue;
    const admitted = next?.execution;
    const settlement = next?.lastExecutionProof;
    const ids = [...old.executionIds];
    const settled = [...old.settledExecutionIds];
    let failures = old.failures, failure = old.lastFailure;
    if (value.attempts !== old.attempts) {
      if (
        runtime?.execution !== null || admitted == null ||
        admitted.purpose !== purpose || admitted.releaseId !== before.id ||
        value.attempts !== old.attempts + 1 ||
        old.attempts >= HOSTED_VERIFICATION_LIMIT
      ) return "verification attempts require exact atomic admission";
      ids.push(admitted.id);
    }
    if (!same(value.settledExecutionIds, old.settledExecutionIds)) {
      if (
        runtime?.execution == null || next?.execution !== null ||
        settlement == null ||
        settlement.execution.purpose !== purpose ||
        settlement.execution.releaseId !== before.id ||
        !same(runtime.execution, settlement.execution) ||
        !old.executionIds.includes(settlement.execution.id) ||
        old.settledExecutionIds.includes(settlement.execution.id)
      ) return "verification settlement requires its exact unsettled execution";
      settled.push(settlement.execution.id);
      if (settlement.outcome !== "healthy") {
        failures++;
        failure = {
          proof: settlement,
          reason: settlement.outcome === "failed"
            ? "execution_failed"
            : "not_started",
        };
      }
    }
    if (
      !same(value, {
        attempts: ids.length,
        failures,
        lastExecutionId: ids.at(-1) ?? null,
        lastFailure: failure,
        executionIds: ids,
        settledExecutionIds: settled,
      })
    ) return "verification journal cannot be rewritten";
  }
  return null;
}

export function hostedOrdinaryAdmissionMode(
  runtime: HostedRuntimeRecordV1,
): "healthy" | "degraded" | null {
  if (runtime.verificationBlocked === true) return null;
  const healthy = runtime.lastHealthyProof;
  if (
    healthy?.outcome === "healthy" && healthy.startupReady &&
    healthy.execution.revision === runtime.activeRevision &&
    healthy.execution.generation === runtime.generation
  ) return "healthy";
  return (runtime.verificationFailures ?? 0) >= 2 &&
      (runtime.failedVerificationIds?.length ?? 0) >= 2
    ? "degraded"
    : null;
}
/** The durable execution-bound admission is checked again at every model-start consumer. */
export function hostedOrdinaryAdmitted(
  runtime: HostedRuntimeRecordV1,
): boolean {
  const execution = runtime.execution;
  if (execution?.purpose !== "ordinary") return false;
  const mode = hostedOrdinaryAdmissionMode(runtime);
  if (mode === "healthy") return true;
  const admission = runtime.ordinaryAdmission;
  return mode === "degraded" && admission?.mode === "degraded" &&
    admission.executionId === execution.id &&
    admission.revision === runtime.activeRevision &&
    admission.generation === runtime.generation &&
    same(admission.failedVerificationIds, runtime.failedVerificationIds);
}

export function validateHostedSchedulingTransition(
  before: HostedRuntimeRecordV1,
  after: HostedRuntimeRecordV1,
): string | null {
  // Compatible readers may still write the original runtime shape during the
  // staged rollout. Once tracking exists it can never be dropped or reset.
  const keys = [
    "verificationFailures",
    "failedVerificationIds",
    "lastVerificationId",
    "lastTurn",
    "ordinaryAdmission",
    "verificationBlocked",
  ] as const;
  if (
    !keys.some((key) => Object.hasOwn(before, key) || Object.hasOwn(after, key))
  ) return null;
  const moved = before.activeRevision !== after.activeRevision ||
    before.generation !== after.generation;
  const settlement = after.lastExecutionProof;
  const settled = before.execution !== null && after.execution === null &&
    settlement !== null && same(before.execution, settlement.execution);
  const failures = moved ? [] : [...(before.failedVerificationIds ?? [])];
  let lastId = moved ? null : before.lastVerificationId ?? null;
  if (settled && settlement.execution.purpose !== "ordinary") {
    lastId = settlement.execution.id;
    if (
      settlement.outcome === "failed" && failures.length < 2 &&
      !failures.includes(lastId)
    ) failures.push(lastId);
  }
  if (
    (after.verificationFailures ?? 0) !== failures.length ||
    !same(after.failedVerificationIds ?? [], failures) ||
    (after.lastVerificationId ?? null) !== lastId
  ) {
    return "runtime verification failures require exact settlement and generation";
  }
  const admission = before.execution === null && after.execution !== null;
  const expectedTurn = admission
    ? (after.execution!.purpose === "ordinary" ? "ordinary" : "verification")
    : before.lastTurn;
  if (after.lastTurn !== expectedTurn) {
    return "runtime turn changes only with admission";
  }
  if (
    !same(before.ordinaryAdmission ?? null, after.ordinaryAdmission ?? null)
  ) {
    if (
      !admission || after.execution?.purpose !== "ordinary" ||
      after.ordinaryAdmission?.executionId !== after.execution.id ||
      after.ordinaryAdmission.revision !== after.activeRevision ||
      after.ordinaryAdmission.generation !== after.generation ||
      after.ordinaryAdmission.mode !== hostedOrdinaryAdmissionMode(before) ||
      !same(
        after.ordinaryAdmission.failedVerificationIds,
        before.failedVerificationIds ?? [],
      )
    ) {
      return "ordinary admission requires durable current health or degraded failures";
    }
  }
  if (
    (after.verificationBlocked ?? false) !==
      (before.verificationBlocked ?? false) &&
    !(moved ||
      settled &&
        (settlement.execution.purpose === "bootstrap" ||
          settlement.execution.purpose === "rollback"))
  ) return "verification hold changes only with installation or restoration";
  return null;
}
