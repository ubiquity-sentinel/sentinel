/** Evidence-expiry gates for re-admitting blocked, already charged work. */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS,
  HOSTED_AUTONOMY_LOST_CANDIDATE,
} from "./hosted-autonomy-policy.ts";

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

/**
 * A preserved candidate whose authenticated producer is gone: the retained
 * candidate-preservation intent names a settled (charged) admission, and the
 * producing matrix artifact is past retention, so neither the historical
 * recovery nor any later import can ever restore it. The task restarts from
 * its base with a fresh, separately charged admission; the old charge and any
 * orphaned candidate ref are left exactly as they are.
 */
export function lostCandidateRetry(
  record: RepairStateSnapshotV1["work"][number],
  snapshot: RepairStateSnapshotV1,
  now: number,
): boolean {
  if (record.nextStep !== "blocked" || record.blocker === null) return false;
  if (record.source.kind !== "issue" || record.target.pr !== null) return false;
  const intent = record.intent;
  if (intent === null || intent.kind !== "candidate_preservation") {
    return false;
  }
  const message = record.blocker.message;
  if (
    !HOSTED_AUTONOMY_LOST_CANDIDATE.some((prefix) => message.startsWith(prefix))
  ) {
    return false;
  }
  const charge = snapshot.reservations.find((reservation) =>
    reservation.id === intent.requestId && reservation.taskId === record.id
  );
  if (charge === undefined || charge.outcome === "reserved") return false;
  return Number.isSafeInteger(now) &&
    now - charge.createdAt >= HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS;
}
