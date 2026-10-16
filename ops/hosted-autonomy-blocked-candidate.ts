/** Complete one historical preservation only after native import and remote proof. */
import { canonicalStringify } from "../src/contracts/canonical.ts";
import type {
  Clock,
  GitHubPort,
  PortResultV1,
  RepairStateWriter,
  StateReadView,
  StateWriteResultV1,
} from "../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../src/contracts/work-record.ts";
import type { MatrixAuthenticatedWaveV1 } from "../src/host/matrix-artifact-port.ts";
import { matrixDigestV1 } from "../src/contracts/matrix.ts";
import { blockedCandidateBinding } from "../src/host/matrix-blocked-candidate.ts";
import { MATRIX_PRESERVATION_UNCERTAINTY_DETAIL } from "../src/host/matrix-uncertainty-maintenance.ts";
import { implementationIntentKey } from "../src/repair/keys.ts";

/**
 * The second closed parked-preservation class: historical matrix custody
 * parked the exact candidate with its submitted admission and a pending
 * preservation intent (MATRIX_PRESERVATION_UNCERTAINTY_DETAIL). It carries no
 * producer binding, so only native ref evidence can restore it.
 */
export function isParkedPreservation(record: WorkRecordV1): boolean {
  const intent = record.intent;
  return record.nextStep === "blocked" && record.wait === null &&
    record.blocker?.kind === "other" &&
    record.blocker.message === MATRIX_PRESERVATION_UNCERTAINTY_DETAIL &&
    record.source.kind === "issue" &&
    intent?.kind === "candidate_preservation" && intent.requestId !== null &&
    intent.key === implementationIntentKey(intent.requestId) &&
    intent.branch !== null &&
    intent.expectedHead === record.target.head &&
    intent.observedBase === record.target.base &&
    intent.resultId === null && intent.pr === null &&
    record.target.head !== null &&
    record.target.head !== record.target.base &&
    record.target.candidateState?.preserved === null;
}

/** Either parked class whose exact preservation ref may restore it. */
export function restorableParkedCandidate(record: WorkRecordV1): boolean {
  return blockedCandidateBinding(record) !== null ||
    isParkedPreservation(record);
}

export interface BlockedCandidatePreservationInputV1 {
  record: WorkRecordV1;
  state: StateReadView & RepairStateWriter;
  github: GitHubPort;
  clock: Clock;
  readbackFailure(write: PortResultV1<StateWriteResultV1>): Error;
}

export async function restoreBlockedCandidate(
  input: BlockedCandidatePreservationInputV1 & {
    wave: MatrixAuthenticatedWaveV1;
  },
): Promise<boolean> {
  const { record, wave } = input;
  const binding = blockedCandidateBinding(record);
  const intent = record.intent;
  const result = wave.results.find((row) =>
    row.reservationId === intent?.requestId
  );
  if (
    !binding || !intent || !intent.branch || !result ||
    binding.planDigest !== wave.planDigest ||
    binding.plannerJobId !== wave.provenance.plannerJobId ||
    binding.resultDigest !== await matrixDigestV1(result)
  ) return false;
  return await preserveBlockedCandidate(input);
}

/**
 * The trusted tail every blocked-candidate recovery shares: the record must
 * still be byte-identical in state, the trusted preserver must prove the
 * exact candidate on its deterministic preservation ref, and one
 * expected-head CAS returns the record to `work` with that preserved
 * descriptor. The charge stays as it is: nothing is refunded or started.
 */
export async function preserveBlockedCandidate(
  input: BlockedCandidatePreservationInputV1,
): Promise<boolean> {
  const { record, state, github, clock } = input;
  const intent = record.intent;
  if (!restorableParkedCandidate(record) || !intent || !intent.branch) {
    return false;
  }
  const before = await state.readRepair();
  if (
    !before.ok || before.value.status !== "found" ||
    canonicalStringify(
        before.value.snapshot.work.find((row) => row.id === record.id),
      ) !== canonicalStringify(record)
  ) return false;
  const candidate = {
    operationKey: intent.key,
    base: record.target.base,
    head: record.target.head!,
    ref: intent.branch,
  };
  const preserved = await github.preserveCandidate({
    taskId: record.id,
    candidate,
    publishedHead: record.target.candidateState!.publishedHead,
  });
  if (!preserved.ok) return false;
  const observed = await github.readRef(candidate.ref);
  if (!observed.ok || observed.value?.sha !== candidate.head) return false;
  const fresh = await state.readRepair();
  if (
    !fresh.ok || fresh.value.status !== "found" ||
    fresh.value.head !== before.value.head ||
    canonicalStringify(fresh.value.snapshot) !==
      canonicalStringify(before.value.snapshot)
  ) return false;
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < fresh.value.snapshot.updatedAt) {
    return false;
  }
  const next = {
    ...fresh.value.snapshot,
    stateHead: fresh.value.head,
    sequence: fresh.value.snapshot.sequence + 1,
    updatedAt: now,
    work: fresh.value.snapshot.work.map((row) =>
      row.id === record.id
        ? {
          ...row,
          nextStep: "work" as const,
          blocker: null,
          wait: null,
          intent: null,
          target: {
            ...row.target,
            candidateState: {
              preserved: candidate,
              publishedHead: row.target.candidateState!.publishedHead,
            },
          },
          updatedAt: now,
        }
        : row
    ),
  };
  const written = await state.writeRepair(next, fresh.value.head);
  if (!written.ok || written.value.status !== "applied") return false;
  const readback = await state.readRepair();
  if (
    !readback.ok || readback.value.status !== "found" ||
    readback.value.head !== written.value.head ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) throw input.readbackFailure(written);
  return true;
}
