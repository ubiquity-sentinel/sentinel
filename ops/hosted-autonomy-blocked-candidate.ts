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
import {
  DETERMINISTIC_PUBLICATION_DETAILS,
  PUBLICATION_PROTECTED_DETAIL,
} from "../src/github/snapshot-policy.ts";
import { blockedCandidateBinding } from "../src/host/matrix-blocked-candidate.ts";
import { MATRIX_PRESERVATION_UNCERTAINTY_DETAIL } from "../src/host/matrix-uncertainty-maintenance.ts";
import {
  candidatePreservationRef,
  implementationIntentKey,
} from "../src/repair/keys.ts";
import { CONFLICT_PROTECTED_DETAIL } from "../src/repair/conflict-resolution.ts";
import { clearIntent, markBlocked } from "../src/repair/transitions.ts";

/** The runtime's deterministic trusted-content refusal (loop-preservation.ts). */
export const PRESERVATION_VALIDATION_REFUSED =
  "candidate preservation validation refused";

/**
 * The runtime's terminal owner-reserved block for a candidate that touches a
 * protected path: R78 and R79 write exactly this message when the
 * implementation result hits a protected path (loop-implementation-result.ts)
 * and when a resolved merge does (conflict-resolution.ts). No retry rule and
 * no preservation disposition class matches it; the owner handles it.
 */
export const CANDIDATE_PROTECTED_BLOCKER: string = CONFLICT_PROTECTED_DETAIL;

/**
 * What one restore wrote: the exact preserved descriptor, the runtime's own
 * validation-refusal block, the runtime's own protected-path block, or
 * nothing at all (null).
 */
export type CandidateRestoreV1 = "preserved" | "refused" | "protected" | null;

type PreservationUnfinishedReason =
  | "binding_mismatch"
  | "precheck_failed"
  | "preserver_error"
  | "ref_mismatch"
  | "state_unavailable"
  | "state_changed"
  | "clock_invalid"
  | "clock_regressed"
  | "cas_not_applied";

function reportUnfinishedPreservation(
  taskId: string,
  reason: PreservationUnfinishedReason,
  error?: { kind: string; detail: string },
): void {
  console.log(JSON.stringify({
    kind: "sentinel_candidate_preservation_unfinished",
    taskId,
    reason,
    ...(error === undefined
      ? {}
      : { error: error.kind, detail: error.detail.slice(0, 160) }),
  }));
}

/**
 * The second closed parked-preservation class: historical matrix custody
 * parked the exact candidate with its submitted admission and a pending
 * preservation intent (MATRIX_PRESERVATION_UNCERTAINTY_DETAIL). It carries no
 * producer binding, so only native ref evidence can restore it.
 */
export function isParkedPreservation(record: WorkRecordV1): boolean {
  return record.nextStep === "blocked" && record.wait === null &&
    record.blocker?.kind === "other" &&
    record.blocker.message === MATRIX_PRESERVATION_UNCERTAINTY_DETAIL &&
    exactPendingPreservation(record);
}

/**
 * The in-flight preservation class: the consumer settled the exact
 * candidate's submitted admission and saved its pending preservation intent,
 * but no repair job holding the candidate's objects ran the work step since
 * (the consumer failed right after its write, or maintenance consumed the
 * cell and could not finish the preservation in that same pass). A
 * native-carrier repair job reads only its own run's artifacts, so its
 * own preservation finds nothing and only ever waits `unavailable`. Only the
 * exact producer's artifact holds those objects. No time, generation or
 * stall count enters this class, and none ever retires it.
 */
export function isInflightPreservation(record: WorkRecordV1): boolean {
  return record.nextStep === "work" && record.blocker === null &&
    (record.wait === null || record.wait.reason === "unavailable") &&
    exactPendingPreservation(record);
}

/** The exact charged, unpreserved candidate every restorable class shares. */
function exactPendingPreservation(record: WorkRecordV1): boolean {
  const intent = record.intent;
  return record.source.kind === "issue" &&
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

/** Any class the shared preservation tail (and its ref gate) may complete. */
export function restorableCandidate(record: WorkRecordV1): boolean {
  return restorableParkedCandidate(record) || isInflightPreservation(record);
}

export interface BlockedCandidatePreservationInputV1 {
  record: WorkRecordV1;
  state: StateReadView & RepairStateWriter;
  github: GitHubPort;
  clock: Clock;
  readbackFailure(write: PortResultV1<StateWriteResultV1>): Error;
  /**
   * Record the trusted validator's deterministic refusal (see
   * preserveBlockedCandidate). Only the parked runtime-mismatch restore sets
   * it; every other caller keeps custody on any failure.
   */
  recordRefusal?: true;
}

export async function restoreBlockedCandidate(
  input: BlockedCandidatePreservationInputV1 & {
    wave: MatrixAuthenticatedWaveV1;
  },
): Promise<CandidateRestoreV1> {
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
  ) {
    reportUnfinishedPreservation(record.id, "binding_mismatch");
    return null;
  }
  return await preserveBlockedCandidate({ ...input, recordRefusal: true });
}

/**
 * An in-flight record binds to no blocker, so it binds to the cell itself:
 * exactly one planned cell of its charged request, task, intent key, base and
 * repository, and exactly one result for that cell whose authenticated receipt
 * and bundle both carry the recorded candidate head. The ingest that just
 * rehydrated those objects verified that receipt and bundle; the shared tail
 * then proves the exact ref before the one write.
 */
export async function restoreInflightCandidate(
  input: BlockedCandidatePreservationInputV1 & {
    wave: MatrixAuthenticatedWaveV1;
  },
): Promise<CandidateRestoreV1> {
  const { record, wave } = input;
  const intent = record.intent;
  if (!isInflightPreservation(record) || !intent) {
    reportUnfinishedPreservation(record.id, "binding_mismatch");
    return null;
  }
  const cells = wave.plan.cells.filter((cell) =>
    cell.reservationId === intent.requestId
  );
  const results = wave.results.filter((row) =>
    cells.some((cell) => cell.cellId === row.cellId)
  );
  if (
    cells.length !== 1 || results.length !== 1 ||
    cells[0].taskId !== record.id || cells[0].intentKey !== intent.key ||
    cells[0].expectedBase !== record.target.base ||
    canonicalStringify(cells[0].repository) !==
      canonicalStringify(record.repository) ||
    results[0].reservationId !== intent.requestId ||
    results[0].taskId !== record.id ||
    results[0].receipt?.candidate?.head !== record.target.head ||
    results[0].bundle?.head !== record.target.head
  ) {
    reportUnfinishedPreservation(record.id, "binding_mismatch");
    return null;
  }
  return await preserveBlockedCandidate(input);
}

/**
 * The trusted tail every blocked-candidate recovery shares: the record must
 * still be byte-identical in state, the trusted preserver must prove the
 * exact candidate on its deterministic preservation ref, and one
 * expected-head CAS returns the record to `work` with that preserved
 * descriptor (an in-flight record's `unavailable` wait clears with its
 * intent). The charge stays as it is: nothing is refunded or started.
 *
 * With `recordRefusal`, the trusted validator's deterministic verdict on
 * these exact immutable objects, for the record's own deterministic
 * preservation ref, is the one refusal that is recorded, and only while that
 * ref reads back as absent (an exact candidate already at its ref keeps
 * custody). The same CAS clears the intent and blocks the record with the
 * target, head and descriptor kept. A protected entry verdict is the
 * runtime's own terminal block for a candidate that touches a protected path
 * (CANDIDATE_PROTECTED_BLOCKER, loop-implementation-result.ts): no pass
 * re-admits it for a fresh charge. Every other verdict is the runtime's own
 * transition for it (loop-preservation.ts), PRESERVATION_VALIDATION_REFUSED,
 * which the preservation disposition's REFUSED class owns from there. Any
 * other failure proves nothing and writes nothing.
 */
export async function preserveBlockedCandidate(
  input: BlockedCandidatePreservationInputV1,
): Promise<CandidateRestoreV1> {
  const { record, state, github, clock } = input;
  const intent = record.intent;
  if (!restorableCandidate(record) || !intent || !intent.branch) {
    reportUnfinishedPreservation(record.id, "precheck_failed");
    return null;
  }
  const before = await state.readRepair();
  if (!before.ok || before.value.status !== "found") {
    reportUnfinishedPreservation(record.id, "state_unavailable");
    return null;
  }
  if (
    canonicalStringify(
      before.value.snapshot.work.find((row) => row.id === record.id),
    ) !== canonicalStringify(record)
  ) {
    reportUnfinishedPreservation(record.id, "state_changed");
    return null;
  }
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
  let refusal: string | null = null;
  if (!preserved.ok) {
    if (
      input.recordRefusal !== true || preserved.error.kind !== "invalid" ||
      !DETERMINISTIC_PUBLICATION_DETAILS.includes(preserved.error.detail) ||
      candidate.ref !== await candidatePreservationRef(
          record.repository,
          record.id,
          intent.key,
        )
    ) {
      // Nothing is written for an unfinished preservation; the bounded
      // diagnostic names the task and the trusted preserver's static verdict
      // so a candidate that never reaches its ref is visible in the job log.
      reportUnfinishedPreservation(
        record.id,
        "preserver_error",
        preserved.error,
      );
      return null;
    }
    const observed = await github.readRef(candidate.ref);
    if (!observed.ok || observed.value !== null) {
      reportUnfinishedPreservation(record.id, "ref_mismatch");
      return null;
    }
    refusal = preserved.error.detail === PUBLICATION_PROTECTED_DETAIL
      ? CANDIDATE_PROTECTED_BLOCKER
      : PRESERVATION_VALIDATION_REFUSED;
  } else {
    const observed = await github.readRef(candidate.ref);
    if (!observed.ok || observed.value?.sha !== candidate.head) {
      reportUnfinishedPreservation(record.id, "ref_mismatch");
      return null;
    }
  }
  const fresh = await state.readRepair();
  if (!fresh.ok || fresh.value.status !== "found") {
    reportUnfinishedPreservation(record.id, "state_unavailable");
    return null;
  }
  if (
    fresh.value.head !== before.value.head ||
    canonicalStringify(fresh.value.snapshot) !==
      canonicalStringify(before.value.snapshot)
  ) {
    reportUnfinishedPreservation(record.id, "state_changed");
    return null;
  }
  const now = clock.now();
  if (!Number.isSafeInteger(now)) {
    reportUnfinishedPreservation(record.id, "clock_invalid");
    return null;
  }
  if (now < fresh.value.snapshot.updatedAt) {
    reportUnfinishedPreservation(record.id, "clock_regressed");
    return null;
  }
  const next = {
    ...fresh.value.snapshot,
    stateHead: fresh.value.head,
    sequence: fresh.value.snapshot.sequence + 1,
    updatedAt: now,
    work: fresh.value.snapshot.work.map((row) =>
      row.id !== record.id
        ? row
        : refusal !== null
        ? markBlocked(clearIntent(row, now), "other", refusal, now)
        : {
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
    ),
  };
  const written = await state.writeRepair(next, fresh.value.head);
  if (!written.ok || written.value.status !== "applied") {
    reportUnfinishedPreservation(record.id, "cas_not_applied");
    return null;
  }
  const readback = await state.readRepair();
  if (
    !readback.ok || readback.value.status !== "found" ||
    readback.value.head !== written.value.head ||
    canonicalStringify(readback.value.snapshot) !== canonicalStringify(next)
  ) throw input.readbackFailure(written);
  return refusal === null
    ? "preserved"
    : refusal === CANDIDATE_PROTECTED_BLOCKER
    ? "protected"
    : "refused";
}
