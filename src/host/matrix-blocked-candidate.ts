/** Closed producer identities of historical preservation and correction work. */
import type { GitSha } from "../contracts/brands.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { candidateBranch, implementationIntentKey } from "../repair/keys.ts";

const MISMATCH =
  /^authenticated historical matrix runtime mismatch; producer=([1-9][0-9]*):([1-9][0-9]*); runtime=([0-9a-f]{40}); plan=([0-9a-f]{64}); artifact=([1-9][0-9]*); archive=sha256:([0-9a-f]{64}); planner=([1-9][0-9]*); result=([0-9a-f]{64}); original admission retained$/;

export function blockedCandidateBinding(record: WorkRecordV1) {
  const intent = record.intent;
  if (
    record.nextStep !== "blocked" || record.blocker?.kind !== "other" ||
    record.wait !== null || record.source.kind !== "issue" ||
    intent?.kind !== "candidate_preservation" || intent.requestId === null ||
    intent.key !== implementationIntentKey(intent.requestId) ||
    intent.expectedHead !== record.target.head ||
    intent.observedBase !== record.target.base ||
    intent.resultId !== null || intent.pr !== null ||
    record.target.head === null || record.target.head === record.target.base ||
    record.target.candidateState?.preserved !== null
  ) return null;
  return mismatchBinding(record.blocker.message);
}

/** An unconsumed correction retains its exact published predecessor and charge. */
export function blockedImplementationBinding(record: WorkRecordV1) {
  const intent = record.intent;
  const { head, base, pr, branch, candidateState } = record.target;
  const preserved = candidateState?.preserved;
  if (
    record.nextStep !== "blocked" || record.blocker?.kind !== "other" ||
    record.wait !== null || record.source.kind !== "issue" ||
    intent?.kind !== "implementation" || intent.requestId === null ||
    intent.key !== implementationIntentKey(intent.requestId) ||
    intent.branch !== branch || branch !== candidateBranch(record.id) ||
    intent.expectedHead !== null || intent.resultId !== null ||
    intent.pr !== null || intent.observedBase !== base ||
    head === null || head === base || pr === null ||
    candidateState?.publishedHead !== head || !preserved ||
    preserved.head !== head || preserved.base !== base ||
    preserved.operationKey === intent.key
  ) return null;
  return mismatchBinding(record.blocker.message);
}

function mismatchBinding(message: string) {
  const match = MISMATCH.exec(message);
  if (!match) return null;
  const [runId, runAttempt, artifactId, plannerJobId] = [
    match[1],
    match[2],
    match[5],
    match[7],
  ].map(Number);
  if (
    ![runId, runAttempt, artifactId, plannerJobId].every(Number.isSafeInteger)
  ) return null;
  return {
    runId,
    runAttempt,
    runtimeSha: match[3] as GitSha,
    planDigest: match[4],
    artifactId,
    archiveDigest: "sha256:" + match[6],
    plannerJobId,
    resultDigest: match[8],
  };
}

/** Producer selection shares descriptors; preservation keeps its strict class. */
export function blockedRecoveryBinding(record: WorkRecordV1) {
  return blockedCandidateBinding(record) ??
    blockedImplementationBinding(record);
}

/** Normal pending work or an exactly bound historical result. */
export function isMatrixRecoveryPending(record: WorkRecordV1): boolean {
  return (record.nextStep === "work" && record.intent !== null &&
    ["implementation", "candidate_preservation"].includes(
      record.intent.kind,
    )) ||
    blockedRecoveryBinding(record) !== null;
}

/** Blocked records may be read only through their exact authenticated producer. */
export function blockedCandidateMatchesProducer(
  record: WorkRecordV1,
  producer: { runId: number; runAttempt: number; revision: GitSha } | undefined,
): boolean {
  const binding = blockedCandidateBinding(record);
  return binding !== null && producer !== undefined &&
    binding.runId === producer.runId &&
    binding.runAttempt === producer.runAttempt &&
    binding.runtimeSha === producer.revision;
}

export function blockedRecoveryMatchesProducer(
  record: WorkRecordV1,
  producer: { runId: number; runAttempt: number; revision: GitSha } | undefined,
): boolean {
  const binding = blockedRecoveryBinding(record);
  return binding !== null && producer !== undefined &&
    binding.runId === producer.runId &&
    binding.runAttempt === producer.runAttempt &&
    binding.runtimeSha === producer.revision;
}
