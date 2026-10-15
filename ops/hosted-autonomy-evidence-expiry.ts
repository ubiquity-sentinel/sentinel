/** Evidence-expiry anchor for re-admitting blocked, already charged work. */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";

/**
 * When the blocked admission's producing evidence came into existence: the
 * creation of the exact charge its retained intent names, never a later
 * blocker refresh. A record without that charge falls back to its blocker.
 */
export function evidenceAnchor(
  record: RepairStateSnapshotV1["work"][number],
  reservations: RepairStateSnapshotV1["reservations"],
): number | null {
  const requestId = record.intent?.requestId ?? null;
  if (requestId !== null) {
    const charge = reservations.find((reservation) =>
      reservation.id === requestId && reservation.taskId === record.id
    );
    return charge === undefined ? null : charge.createdAt;
  }
  const since = record.blocker?.since;
  return typeof since === "number" && Number.isSafeInteger(since)
    ? since
    : null;
}
