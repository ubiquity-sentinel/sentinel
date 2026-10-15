/** Evidence-expiry gate for re-admitting blocked, already charged work. */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";

type WorkRecord = RepairStateSnapshotV1["work"][number];
type Reservations = RepairStateSnapshotV1["reservations"];

/**
 * When the blocked admission's producing evidence came into existence: the
 * creation of the exact charge its retained intent names, never a later
 * blocker refresh. A record without that charge falls back to its blocker.
 */
export function evidenceAnchor(
  record: WorkRecord,
  reservations: Reservations,
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

/**
 * True only for an unproduced implementation admission whose evidence is past
 * retention. The record must hold no candidate of any kind (no head, no pull
 * request, no preservation state), and a retained intent must be an
 * implementation intent whose own charge for this task is settled ambiguous.
 * Anything else (a review or preservation intent, a refunded, consumed,
 * still-reserved or foreign charge) is never re-admitted on age.
 */
export function evidenceExpired(
  record: WorkRecord,
  reservations: Reservations,
  now: number,
  minAgeMs: number,
): boolean {
  if (record.target.head !== null || record.target.pr !== null) return false;
  if (record.target.candidateState !== undefined) return false;
  const intent = record.intent;
  if (intent !== null) {
    if (intent.kind !== "implementation") return false;
    if (intent.expectedHead !== null || intent.pr !== null) return false;
    const charged = reservations.some((reservation) =>
      reservation.id === intent.requestId &&
      reservation.taskId === record.id &&
      reservation.purpose !== "review_request" &&
      reservation.outcome === "ambiguous" &&
      reservation.settledAt !== null
    );
    if (!charged) return false;
  }
  const anchor = evidenceAnchor(record, reservations);
  return anchor !== null && now - anchor >= minAgeMs;
}
