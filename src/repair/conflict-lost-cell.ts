/**
 * Repair loop internals: trusted settlement of a LOST conflict-resolution cell.
 *
 * A hosted conflict resolution is admitted by the matrix planner as a marked
 * implementation intent (`conflictResolutionInFlight`) bound to one `reserved`
 * charge. Its cell's artifact is the only way that charge is ever consumed.
 * When the artifact will never arrive (the job was cancelled, timed out or
 * lost its runner before uploading), nothing consumed it: the serial work step
 * defers the marked intent forever (`MATRIX_ARTIFACT_DEFERRED`), the producer
 * walk reports the cell `missing` on every pass, and the planner never grants
 * again because the record no longer holds the pending refresh intent the
 * resolution was admitted from. Live: `issue-ubiquity-ai.ubq.fi-1176`.
 *
 * A cell is LOST only on one of two provable facts:
 *
 * - `run`: its own authenticated producer run (the plan that names this exact
 *   reservation) is natively completed, and that run's complete authenticated
 *   artifact listing holds no artifact for the cell (the producer pass ingests
 *   the wave and the consumer reports the cell `missing`); or
 * - `expired`: its admission is at least `CONFLICT_CELL_EVIDENCE_EXPIRY_MS`
 *   old, past which no artifact of it can exist any more (cell artifacts are
 *   retained 7 days) and no consumer or rollback can authenticate it. This is
 *   the bounded rule for an admission whose producer the walk cannot reach.
 *
 * The settlement keeps every charge: the reservation becomes `ambiguous`
 * (never refunded; a lost cell proves nothing about non-submission), and the
 * record returns, at `work`, to the exact pending refresh intent of (PR, H, B)
 * with the conflict marker, so the ordinary admission
 * (`conflictResolutionAdmissible`) re-confirms the conflict live and charges a
 * fresh resolution, or clears the intent when the base moved. A lost cell is
 * not a failed resolution: no model result was ever consumed, so the "one
 * charge per (task, base tip)" rule for a FAILED resolution does not apply.
 * Nothing else on the record changes (head, PR, preserved descriptor,
 * counters), so the exact-head and custody rules of the admission still hold.
 */
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  CONFLICT_CELL_EVIDENCE_EXPIRY_MS,
  conflictMarker,
  conflictResolutionInFlight,
} from "./conflict-resolution.ts";
import { baseRefreshIntentKey, implementationIntentKey } from "./keys.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
import {
  loadSnapshot,
  persistTransition,
  replaceWorkMutation,
} from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";

/** Admission age past which a conflict cell's evidence provably expired. */
export const LOST_CONFLICT_CELL_EXPIRY_MS = CONFLICT_CELL_EVIDENCE_EXPIRY_MS;

/** The exact charged in-flight resolution a lost cell settles. */
export interface LostConflictCellV1 {
  reservationId: string;
  mergeBase: GitSha;
}

/** Which provable fact establishes the loss: the producer run id, or age. */
export type LostConflictCellProofV1 = { runId: number } | "expired";

/**
 * The in-flight conflict resolution `record` holds, bound exactly to its own
 * charge, or null. The charge is `reserved`, or already `ambiguous` while the
 * record still holds the same marked intent at `work` (this settlement's own
 * torn pair: the charge write landed and the record write did not), which is
 * finished, never refused.
 */
export function lostConflictCellBinding(
  snapshot: Pick<RepairStateSnapshotV1, "reservations">,
  record: WorkRecordV1,
): LostConflictCellV1 | null {
  const intent = record.intent;
  const mergeBase = conflictResolutionInFlight(intent);
  const { base, branch, head, pr } = record.target;
  if (
    intent === null || mergeBase === null || record.nextStep !== "work" ||
    record.source.kind !== "issue" || intent.resultId !== null ||
    intent.requestId === null || head === null || pr === null ||
    branch === null || head === base ||
    intent.key !== implementationIntentKey(intent.requestId)
  ) return null;
  const charge = snapshot.reservations.find((row) =>
    row.id === intent.requestId
  );
  if (
    charge === undefined || charge.taskId !== record.id ||
    canonicalStringify(charge.repository) !==
      canonicalStringify(record.repository) ||
    charge.head !== base || charge.attempt !== record.counters.attempts ||
    (charge.purpose !== "implementation" && charge.purpose !== "retry")
  ) return null;
  const charged =
    (charge.outcome === "reserved" && charge.settledAt === null) ||
    (charge.outcome === "ambiguous" && charge.settledAt !== null);
  return charged ? { reservationId: charge.id, mergeBase } : null;
}

/** True when the record's in-flight admission is past the evidence expiry. */
export function lostConflictCellExpired(
  record: WorkRecordV1,
  now: number,
): boolean {
  const intent = record.intent;
  return intent !== null &&
    now - intent.startedAt >= LOST_CONFLICT_CELL_EXPIRY_MS;
}

/**
 * The record after the settlement: the exact pending refresh intent of
 * (PR, H, B) with a fresh conflict marker, at `work`, nothing else changed.
 */
export function repentLostConflictCell(
  record: WorkRecordV1,
  mergeBase: GitSha,
  now: number,
): WorkRecordV1 {
  const { branch, head, pr } = record.target;
  return {
    ...record,
    nextStep: "work",
    wait: null,
    blocker: null,
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(pr!, head!, mergeBase),
      startedAt: now,
      branch,
      expectedHead: head,
      observedBase: mergeBase,
      pr,
      requestId: null,
      resultId: null,
      failure: conflictMarker(mergeBase, now),
    },
    updatedAt: now,
  };
}

/** The one observability line of a settled lost cell. */
export function lostCellLine(
  recordId: string,
  reservationId: string,
  proof: LostConflictCellProofV1,
): string {
  return `lost-cell:${recordId}:${reservationId}:${
    proof === "expired" ? "expired" : proof.runId
  }`;
}

/**
 * Settle the lost cell of `record` (its binding re-proved against the
 * context's snapshot): the charge first (`ambiguous`, charged), then the
 * record's return to the pending resolution against the fresh state.
 */
export async function settleLostConflictCell(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  proof: LostConflictCellProofV1,
): Promise<StepResultV1> {
  const binding = lostConflictCellBinding(context.snapshot, record);
  if (binding === null) {
    return { kind: "state_error", detail: "lost cell binding unavailable" };
  }
  const queueGuard = await guardQueueOperation(deps, context, record, "resume");
  if (queueGuard !== null) return queueGuard;
  const settled = await deps.budget.settleModelStart({
    id: binding.reservationId,
    outcome: "ambiguous",
    proofRef: null,
  });
  if (settled.status !== "settled" && settled.status !== "idempotent") {
    return { kind: "state_error", detail: "budget settlement failed" };
  }
  // The settlement moved the head: the record is re-proved unchanged in the
  // exact new state before it moves (never a stale reapply over another
  // writer's change).
  const fresh = await loadSnapshot(deps, context.bounds);
  if (fresh === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  const current = fresh.snapshot.work.find((row) => row.id === record.id);
  if (
    current === undefined ||
    canonicalStringify(current) !== canonicalStringify(record)
  ) return { kind: "state_error", detail: "lost cell record changed" };
  const now = deps.clock.now();
  const step = await persistTransition(
    deps,
    fresh,
    replaceWorkMutation(
      repentLostConflictCell(record, binding.mergeBase, now),
    ),
  );
  if (step.kind === "progress") {
    console.log(lostCellLine(record.id, binding.reservationId, proof));
  }
  return step;
}
