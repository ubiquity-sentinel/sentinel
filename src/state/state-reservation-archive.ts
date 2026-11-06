/**
 * Reservation-ledger compaction at the trusted write boundary.
 *
 * The repair snapshot bounds the live `reservations` collection
 * (`MaxItems.snapshotRecords`). Once it is full, every admission write is
 * rejected and no model start can be reserved. This function makes room by
 * moving the OLDEST terminal reservations into the durable
 * `reservationArchive` collection:
 *
 * - an unsettled reservation is never moved (it still owns its start);
 * - a settled `ambiguous` row is never moved: the contract still allows
 *   `ambiguous` → `submitted` / `confirmed_not_submitted`, and
 *   `matrix-uncertainty-maintenance` resolves it in the live ledger;
 * - a row is only eligible once its immutable terminal settlement is older
 *   than the attempt-memory/duplicate-detection window (the 6h transient
 *   decay), so the loop breaker and exact-id duplicate refusal still see it
 *   live for the whole window they need;
 * - every moved row is retained in the archive, which accounting and
 *   duplicate-detection readers consult, so no charge or proof is lost;
 * - the archive has its own bound and is itself compactable: when it exceeds
 *   `MaxItems.reservationArchiveRecords`, the oldest rows past the rolling
 *   seven-day accounting window are retired (rows inside that window are never
 *   dropped — if they alone exceed the bound the write fails closed).
 */

import { parseRepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import { MaxItems } from "../contracts/validation.ts";

/** The attempt-memory transient decay window (`ATTEMPT_TRANSIENT_DECAY_MS`). */
export const RESERVATION_LEDGER_RETENTION_MS = 6 * 60 * 60 * 1000;

/** The widest rolling accounting window (`SEVEN_DAY_WINDOW_MS`). */
export const RESERVATION_ARCHIVE_ACCOUNTING_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A precise capacity refusal: the live ledger cannot be made to fit without
 * moving a row the contract still allows to resolve. The trusted writer
 * surfaces this message as an `invalid` write error so admission reports a
 * distinct `rejected` status instead of looping on transient `unavailable`.
 */
export class ReservationLedgerCapacityError extends Error {
  constructor(
    readonly live: number,
    readonly overflow: number,
    readonly eligible: number,
  ) {
    super(
      `reservation ledger capacity refused: ${live} live reservations need ` +
        `${overflow} archived rows but only ${eligible} terminal settled rows ` +
        "are older than the retention window; non-terminal or recent rows " +
        "cannot be archived",
    );
    this.name = "ReservationLedgerCapacityError";
  }
}

/** Outcomes no later transition can change (unlike a settled `ambiguous`). */
export function isTerminalReservationV1(
  record: BudgetReservationV1,
): boolean {
  return record.settledAt !== null &&
    (record.outcome === "submitted" ||
      record.outcome === "confirmed_not_submitted");
}

/** Only terminal rows past the rolling seven-day accounting window retire. */
export function isRetirableReservationV1(
  record: BudgetReservationV1,
  updatedAt: number,
): boolean {
  return isTerminalReservationV1(record) &&
    record.settledAt! <= updatedAt - RESERVATION_ARCHIVE_ACCOUNTING_MS;
}

/**
 * Reservation ids still referenced by live state. Such a row is never moved
 * out of the live ledger (its exact charge/proof is still needed there) and is
 * never retired from the archive. Owner-successor reviews are retained
 * indefinitely, so every one of their reservation ids blocks retirement; for
 * archiving only their still-running phases block, because a completed review
 * is a terminal journal whose reader resolves the archived row explicitly.
 *
 * Attempt memory carries a fingerprint/id family, never a reservation id, and
 * release requests carry a review-request id; both are included defensively so
 * any future exact reservation binding cannot be archived by accident.
 */
export function referencedReservationIdsV1(
  snapshot: RepairStateSnapshotV1,
  includeTerminalOwnerReviews = false,
): Set<string> {
  const ids = new Set<string>();
  for (const work of snapshot.work) {
    if (work.intent?.requestId) ids.add(work.intent.requestId);
  }
  for (const request of snapshot.releaseRequests) {
    if (request.source.reviewRequestId) {
      ids.add(request.source.reviewRequestId);
    }
  }
  for (const operation of snapshot.ownerSuccessorReviews ?? []) {
    if (
      includeTerminalOwnerReviews ||
      operation.phase === "intent" ||
      operation.phase === "running"
    ) {
      ids.add(operation.reservation.id);
    }
  }
  return ids;
}

function olderFirst(
  left: BudgetReservationV1,
  right: BudgetReservationV1,
): number {
  const leftAt = left.settledAt ?? left.createdAt;
  const rightAt = right.settledAt ?? right.createdAt;
  if (leftAt !== rightAt) return leftAt - rightAt;
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function archivedById(
  left: BudgetReservationV1,
  right: BudgetReservationV1,
): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Moves the oldest eligible terminal reservations into the archive until the
 * live collection fits, and compacts the archive to its own bound. Returns the
 * input unchanged when nothing moves; the caller still validates the result.
 */
export function compactReservationLedgerV1(
  snapshot: RepairStateSnapshotV1,
): RepairStateSnapshotV1 {
  const live = snapshot.reservations;
  const existing = snapshot.reservationArchive ?? [];
  const atLiveBound = live.length <= MaxItems.snapshotRecords;
  const atArchiveBound = existing.length <= MaxItems.reservationArchiveRecords;
  if (atLiveBound && atArchiveBound) return snapshot;
  if (!Number.isSafeInteger(snapshot.updatedAt)) return snapshot;

  const settledCutoff = snapshot.updatedAt - RESERVATION_LEDGER_RETENTION_MS;
  const accountingCutoff = snapshot.updatedAt -
    RESERVATION_ARCHIVE_ACCOUNTING_MS;
  const overflow = Math.max(0, live.length - MaxItems.snapshotRecords);
  const referenced = referencedReservationIdsV1(snapshot);
  const eligible = overflow === 0 ? [] : live
    .filter((record) =>
      !referenced.has(record.id) && isTerminalReservationV1(record) &&
      record.settledAt! <= settledCutoff
    )
    .sort(olderFirst);
  const moved = eligible.slice(0, overflow);
  if (moved.length < overflow) {
    throw new ReservationLedgerCapacityError(
      live.length,
      overflow,
      eligible.length,
    );
  }

  let archive = [...existing, ...moved].sort(archivedById);
  if (archive.length > MaxItems.reservationArchiveRecords) {
    let excess = archive.length - MaxItems.reservationArchiveRecords;
    const retained = referencedReservationIdsV1(snapshot, true);
    const retired = new Set<string>();
    // Only retire rows already held in the archive. A row moved from live
    // must survive this transition unchanged; retiring it here would make
    // validateRepairTransition reject an otherwise recoverable admission.
    for (const record of [...existing].sort(olderFirst)) {
      if (excess === 0) break;
      if (retained.has(record.id)) continue;
      if (!isTerminalReservationV1(record)) continue;
      if (record.settledAt! > accountingCutoff) continue;
      retired.add(record.id);
      excess--;
    }
    if (retired.size > 0) {
      archive = archive.filter((record) => !retired.has(record.id));
    }
    if (archive.length > MaxItems.reservationArchiveRecords) {
      // Everything left is still inside the accounting window or
      // non-terminal: fail closed rather than lose a charge or a live row.
      throw new ReservationLedgerCapacityError(
        live.length,
        archive.length - MaxItems.reservationArchiveRecords,
        eligible.length,
      );
    }
  }

  const movedIds = new Set(moved.map((record) => record.id));
  const next: RepairStateSnapshotV1 = {
    ...snapshot,
    reservations: movedIds.size === 0
      ? live
      : live.filter((record) => !movedIds.has(record.id)),
    ...(archive.length === 0 ? {} : { reservationArchive: archive }),
  };
  if (archive.length === 0) delete next.reservationArchive;
  // The caller is the trusted writer; validate here so a compaction that
  // could not make room fails before any Git mutation with a real contract
  // error instead of an opaque later rejection.
  return parseRepairStateSnapshotV1(next);
}
