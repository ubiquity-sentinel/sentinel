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

export async function restoreBlockedCandidate(input: {
  record: WorkRecordV1;
  wave: MatrixAuthenticatedWaveV1;
  state: StateReadView & RepairStateWriter;
  github: GitHubPort;
  clock: Clock;
  readbackFailure(write: PortResultV1<StateWriteResultV1>): Error;
}): Promise<boolean> {
  const { record, wave, state, github, clock } = input;
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
