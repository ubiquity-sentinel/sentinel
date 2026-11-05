/**
 * Full-ledger (hot + cold) read for readers that must see every repair
 * record: status totals, reports, run summaries and park listings.
 *
 * The merged snapshot is a READ-ONLY view. Cold reservations are placed in
 * the archive collection (every cold reservation is terminally settled, the
 * archive's own invariant), so `allReservationsV1` and `findReservationV1`
 * resolve them exactly as they resolve archived rows. It is never a write
 * input: the trusted writer refuses any snapshot that recreates a cold row.
 * A store without the tier capability (a test fake, an older store) falls
 * back to its ordinary read, which then already holds every record.
 */

import type {
  PortResultV1,
  StateReadResultV1,
  StateReadView,
} from "../contracts/ports.ts";
import { portOk } from "../contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { RepairTieredSnapshotV1 } from "./state-repair-tier.ts";
import type { RepairTierStore } from "./state-repair-tier-store.ts";

function byId<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** One read-only snapshot holding both tiers (cold reservations archived). */
export function mergeRepairTiersV1(
  view: RepairTieredSnapshotV1,
): RepairStateSnapshotV1 {
  const { hot, cold } = view;
  const archive = [
    ...(hot.reservationArchive ?? []),
    ...cold.reservations,
    ...cold.reservationArchive,
  ];
  const merged: RepairStateSnapshotV1 = {
    ...hot,
    work: byId([...hot.work, ...cold.work]),
    reviews: byId([...hot.reviews, ...cold.reviews]),
    releaseRequests: byId([...hot.releaseRequests, ...cold.releaseRequests]),
  };
  if (archive.length > 0) merged.reservationArchive = byId(archive);
  return merged;
}

/** Reads the full ledger when the store has tiers, else its ordinary read. */
export async function readRepairLedgerV1(
  state:
    & Pick<StateReadView, "readRepair">
    & Partial<Pick<RepairTierStore, "readRepairTiered">>,
): Promise<PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>> {
  if (typeof state.readRepairTiered !== "function") {
    return await state.readRepair();
  }
  const read = await state.readRepairTiered();
  if (!read.ok) return read;
  if (read.value.status === "absent") {
    return portOk({ status: "absent", currentHead: null, ref: read.value.ref });
  }
  return portOk({
    status: "found",
    head: read.value.head,
    ref: read.value.ref,
    snapshot: mergeRepairTiersV1(read.value.view),
  });
}
