/**
 * Deterministic hot/cold tier planning for the repair state (pure; no I/O).
 *
 * A tier move is always a whole FAMILY: one issue work record plus every
 * reservation (live or archived) charged to it, every review receipt and every
 * release request bound to one of those reservations. Families move together
 * so a hot reader never sees a live record whose charges or proofs are cold,
 * and a promoted family returns exactly as it left.
 *
 * Demotion is conservative. A family is demoted only when:
 * - the work record is issue-sourced, `done` or `blocked`, carries no
 *   incomplete operation, and its issue is known closed: its repository's
 *   open-issue listing was complete this pass and does not contain it (an
 *   open issue keeps its record hot, because intake skips an issue that
 *   already has a hot record and would otherwise admit a duplicate);
 * - no hot record that stays hot depends on it;
 * - every reservation is terminally settled outside the widest rolling
 *   accounting window, so no live accounting, retry or duplicate-detection
 *   window changes, and none is referenced from outside the family or owned
 *   by a caller-protected recovery;
 * - every bound review is completed and every bound release request terminal.
 * Attempt memory, lessons, incidents, evidence, replays, cooldowns and
 * owner-successor reviews always stay hot: the lesson digest is derived from
 * the whole attempt memory, and moving it would regenerate that view.
 */

import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { MaxItems } from "../contracts/validation.ts";
import {
  isTerminalReservationV1,
  referencedReservationIdsV1,
  RESERVATION_ARCHIVE_ACCOUNTING_MS,
} from "./state-reservation-archive.ts";
import type {
  RepairColdDirectoryV1,
  RepairColdTierV1,
} from "./state-repair-tier-layout.ts";

/** Observations the trusted maintenance caller supplies for one pass. */
export interface RepairTierPolicyV1 {
  /** Trusted clock for the accounting-window age check and the manifest. */
  now: number;
  /** Repositories whose COMPLETE open-issue listing this pass observed. */
  listedRepositories: readonly RepositoryIdentityV1[];
  /** `workItemIdForIssue` of every open issue in the listed repositories. */
  openIssueWorkIds: ReadonlySet<string>;
  /** Work ids a caller still owns (queue custody, matrix recovery). */
  protectedWorkIds?: ReadonlySet<string>;
  /** Reservation ids a dedicated recovery owns; their families stay hot. */
  protectedReservationIds?: ReadonlySet<string>;
  /** Maximum rows one pass demotes; later families are deferred. */
  demotionBudget: number;
}

/** One exact row move between the tiers (same bytes, same file name). */
export interface RepairTierMoveV1 {
  id: string;
  /** Collection the row occupies before the move. */
  from: RepairColdDirectoryV1;
  /** Collection the row occupies after the move. */
  to: RepairColdDirectoryV1;
}

interface Family {
  workId: string;
  moves: RepairTierMoveV1[];
}

function repositoryKey(repository: RepositoryIdentityV1): string {
  return `${repository.owner}/${repository.name}#${repository.installationId}`;
}

function byId(left: { id: string }, right: { id: string }): number {
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function demotableWork(
  record: WorkRecordV1,
  listed: ReadonlySet<string>,
  policy: RepairTierPolicyV1,
): boolean {
  return record.source.kind === "issue" &&
    (record.nextStep === "done" || record.nextStep === "blocked") &&
    record.intent === null &&
    listed.has(repositoryKey(record.repository)) &&
    !policy.openIssueWorkIds.has(record.id) &&
    !(policy.protectedWorkIds?.has(record.id) ?? false);
}

/** Every demotable family of one pass, ordered by work id (unbudgeted). */
export function planRepairDemotions(
  hot: RepairStateSnapshotV1,
  policy: RepairTierPolicyV1,
): RepairTierMoveV1[][] {
  const listed = new Set(policy.listedRepositories.map(repositoryKey));
  const cutoff = policy.now - RESERVATION_ARCHIVE_ACCOUNTING_MS;
  const protectedReservations = policy.protectedReservationIds ?? new Set();

  const reservationsByTask = new Map<
    string,
    { id: string; directory: RepairColdDirectoryV1 }[]
  >();
  const reservationRows: {
    row: BudgetReservationV1;
    directory: RepairColdDirectoryV1;
  }[] = [
    ...hot.reservations.map((row) => ({
      row,
      directory: "reservations" as const,
    })),
    ...(hot.reservationArchive ?? []).map((row) => ({
      row,
      directory: "reservationArchive" as const,
    })),
  ];
  const blockedTasks = new Set<string>();
  for (const { row, directory } of reservationRows) {
    if (
      !isTerminalReservationV1(row) || row.settledAt! > cutoff ||
      protectedReservations.has(row.id)
    ) {
      blockedTasks.add(row.taskId);
      continue;
    }
    const rows = reservationsByTask.get(row.taskId) ?? [];
    rows.push({ id: row.id, directory });
    reservationsByTask.set(row.taskId, rows);
  }

  const families = new Map<string, Family>();
  const familyOfReservation = new Map<string, string>();
  for (const work of hot.work) {
    if (!demotableWork(work, listed, policy) || blockedTasks.has(work.id)) {
      continue;
    }
    const moves: RepairTierMoveV1[] = [{
      id: work.id,
      from: "work",
      to: "work",
    }];
    for (const reservation of reservationsByTask.get(work.id) ?? []) {
      moves.push({
        id: reservation.id,
        from: reservation.directory,
        to: reservation.directory,
      });
      familyOfReservation.set(reservation.id, work.id);
    }
    families.set(work.id, { workId: work.id, moves });
  }

  // Bind reviews and release requests to their family; a non-terminal bound
  // row keeps its whole family hot.
  const drop = (workId: string) => {
    const family = families.get(workId);
    if (family === undefined) return;
    families.delete(workId);
    for (const move of family.moves) familyOfReservation.delete(move.id);
  };
  for (const review of hot.reviews) {
    const workId = familyOfReservation.get(review.requestId);
    if (workId === undefined) continue;
    if (review.outcome !== "completed") {
      drop(workId);
      continue;
    }
    families.get(workId)!.moves.push({
      id: review.id,
      from: "reviews",
      to: "reviews",
    });
  }
  for (const request of hot.releaseRequests) {
    const workId = familyOfReservation.get(request.source.reviewRequestId);
    if (workId === undefined) continue;
    if (request.status === "open") {
      drop(workId);
      continue;
    }
    families.get(workId)?.moves.push({
      id: request.id,
      from: "releaseRequests",
      to: "releaseRequests",
    });
  }
  // References from rows outside every family (an incomplete operation of
  // another work record, an owner-successor review) keep a family hot.
  const outside: RepairStateSnapshotV1 = {
    ...hot,
    work: hot.work.filter((row) => !families.has(row.id)),
    releaseRequests: hot.releaseRequests.filter((row) =>
      !familyOfReservation.has(row.source.reviewRequestId)
    ),
  };
  for (const id of referencedReservationIdsV1(outside, true)) {
    const workId = familyOfReservation.get(id);
    if (workId !== undefined) drop(workId);
  }
  // A record that stays hot may never lose a dependency (fixpoint).
  for (let changed = true; changed;) {
    changed = false;
    for (const work of hot.work) {
      if (families.has(work.id)) continue;
      for (const dependency of work.dependencies) {
        if (families.has(dependency)) {
          drop(dependency);
          changed = true;
        }
      }
    }
  }

  return [...families.values()]
    .sort((left, right) =>
      left.workId < right.workId ? -1 : left.workId > right.workId ? 1 : 0
    )
    .map((family) => family.moves);
}

/**
 * Takes whole families in order while they fit the per-pass budget; the
 * first family always fits so an undersized budget still progresses. Every
 * later family is deferred to the next pass (never an error).
 */
export function takeDemotionBudget(
  families: readonly RepairTierMoveV1[][],
  demotionBudget: number,
): { demote: RepairTierMoveV1[]; deferred: number } {
  const budget = Math.max(0, Math.floor(demotionBudget));
  const demote: RepairTierMoveV1[] = [];
  let deferred = 0;
  for (const family of families) {
    const fits = demote.length + family.length <= budget ||
      (demote.length === 0 && budget > 0);
    if (fits && deferred === 0) demote.push(...family);
    else deferred += family.length;
  }
  return { demote, deferred };
}

/**
 * Plans the promotions of one pass: every cold family whose issue is open
 * again (or that a hot record depends on) returns hot unchanged, together
 * with its cold dependencies. Promotions are never deferred: a reopened issue
 * must be hot before intake, or intake would admit a duplicate record.
 */
export function planRepairPromotions(
  hot: RepairStateSnapshotV1,
  cold: RepairColdTierV1,
  policy: Pick<RepairTierPolicyV1, "openIssueWorkIds">,
): RepairTierMoveV1[] {
  const coldWork = new Map<string, WorkRecordV1>(
    cold.work.map((row) => [row.id, row]),
  );
  const selected = new Set<string>();
  const visit = (id: string) => {
    const record = coldWork.get(id);
    if (record === undefined || selected.has(id)) return;
    selected.add(id);
    for (const dependency of record.dependencies) visit(dependency);
  };
  for (const id of policy.openIssueWorkIds) visit(id);
  for (const work of hot.work) {
    for (const dependency of work.dependencies) visit(dependency);
  }
  if (selected.size === 0) return [];

  const reservations: {
    row: BudgetReservationV1;
    from: RepairColdDirectoryV1;
  }[] = [
    ...cold.reservations.map((row) => ({
      row,
      from: "reservations" as const,
    })),
    ...cold.reservationArchive.map((row) => ({
      row,
      from: "reservationArchive" as const,
    })),
  ];
  const moves: RepairTierMoveV1[] = [];
  const reservationIds = new Set<string>();
  let live = hot.reservations.length;
  for (const id of [...selected].sort()) {
    moves.push({ id, from: "work", to: "work" });
  }
  for (
    const { row, from } of [...reservations].sort((left, right) =>
      byId(left.row, right.row)
    )
  ) {
    if (!selected.has(String(row.taskId))) continue;
    reservationIds.add(row.id);
    // A live-origin row returns live unless the bounded live ledger is full;
    // it is terminal and past the accounting window, exactly the row the
    // writer's own capacity compaction would archive, so it then returns to
    // the hot archive with the same bytes.
    let to: RepairColdDirectoryV1 = from;
    if (from === "reservations") {
      if (live < MaxItems.snapshotRecords) live++;
      else to = "reservationArchive";
    }
    moves.push({ id: row.id, from, to });
  }
  for (const review of cold.reviews) {
    if (reservationIds.has(review.requestId)) {
      moves.push({ id: review.id, from: "reviews", to: "reviews" });
    }
  }
  for (const request of cold.releaseRequests) {
    if (reservationIds.has(request.source.reviewRequestId)) {
      moves.push({
        id: request.id,
        from: "releaseRequests",
        to: "releaseRequests",
      });
    }
  }
  return moves;
}
