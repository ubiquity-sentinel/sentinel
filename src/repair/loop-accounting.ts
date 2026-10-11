/** Repair loop internals: accounting. */
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { loadSnapshot, persistTransition } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  RunBoundsV1,
  StepResultV1,
} from "./loop-types.ts";
import { markBlocked } from "./transitions.ts";

export async function settleAndBlock(
  deps: RepairCycleDepsV1,
  reservationId: string,
  outcome: "submitted" | "ambiguous",
  record: WorkRecordV1,
  message: string,
  now: number,
): Promise<WorkRecordV1> {
  // Settlement is done before the record moves: an uncertain start must be
  // charged (ambiguous) before the task is blocked for authoritative
  // disposition; a proven completed run settles as submitted.
  await deps.budget.settleModelStart({
    id: reservationId,
    outcome,
    proofRef: null,
  });
  return markBlocked(record, "other", message, now);
}

/**
 * Persist a record transition after a settlement write: the settlement moved
 * the authoritative head, so the exact new state is reread first and the
 * transition is applied against it (never a stale CAS reapply).
 */
export async function persistAfterSettlement(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
  mutate: (draft: RepairStateSnapshotV1) => void,
): Promise<StepResultV1> {
  const fresh = await loadSnapshot(deps, bounds);
  if (fresh === null) {
    return { kind: "state_error", detail: "repair state unavailable" };
  }
  return persistTransition(deps, fresh, mutate);
}

/**
 * Durable settlement of one review admission. "ambiguous" preserves the
 * charge for a lost/uncertain response; "submitted" records the confirmed
 * invocation; "confirmed_not_submitted" refunds a start that is provably
 * never submitted and requires the restricted run-bound proof ref. An
 * already-charged terminal outcome is idempotent in effect and never adds a
 * second charge; a contradictory terminal outcome stops safely.
 */
export async function settleReviewCharge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  reservationId: string,
  outcome: "submitted" | "ambiguous" | "confirmed_not_submitted",
  proofRef: string | null = null,
): Promise<StepResultV1> {
  const settled = await deps.budget.settleModelStart({
    id: reservationId,
    outcome,
    proofRef,
  });
  if (settled.status === "settled" || settled.status === "idempotent") {
    return { kind: "progress" };
  }
  if (settled.status === "invalid") {
    // A contradictory terminal outcome: reconcile the exact reservation
    // before deciding. An already charged (submitted/ambiguous) reservation
    // preserves the charge; anything else fails closed.
    const read = await loadSnapshot(deps, context.bounds);
    if (read === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const existing = read.snapshot.reservations.find(
      (item) => item.id === reservationId,
    );
    if (
      existing !== undefined &&
      (existing.outcome === "submitted" || existing.outcome === "ambiguous")
    ) {
      return { kind: "progress" };
    }
    return { kind: "state_error", detail: "review charge contradiction" };
  }
  return { kind: "state_error", detail: "review budget settlement failed" };
}
