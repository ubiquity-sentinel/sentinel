/**
 * The serial repair job's two repository fan-out advisory lines (#328), as
 * the launcher re-emits them into the hosted job log (`scanStepLines`):
 *
 * - `sentinel_repair_handback`: the same-run takeover of the records this
 *   run's completed repository cells handed back (`read` with the records it
 *   woke, or `unavailable` when the authenticated read failed);
 * - `sentinel_repair_fanout_delegation`: the serial pass found no verified
 *   delegation plan and steps every record itself (`unavailable`).
 *
 * Both carry `outcome`, never `status` (the launcher's child-status scan
 * reads any line with its own `status` as a second child record), and no
 * record id. They are advisory only: nothing reads them back as evidence.
 * The parsers accept only the exact key set and closed values and rebuild
 * the line, so nothing else a child prints is echoed.
 */
export const REPAIR_HANDBACK_KIND = "sentinel_repair_handback";
export const REPAIR_FANOUT_DELEGATION_KIND =
  "sentinel_repair_fanout_delegation";

/** Upper bound on the woken-record count one hand-back line may report. */
export const MAX_REPAIR_HANDBACK_RECORDS = 100_000;

export interface RepairHandbackLineV1 {
  kind: typeof REPAIR_HANDBACK_KIND;
  outcome: "read" | "unavailable";
  records: number;
}

export interface RepairFanoutDelegationLineV1 {
  kind: typeof REPAIR_FANOUT_DELEGATION_KIND;
  outcome: "unavailable";
}

const HANDBACK_KEYS = ["kind", "outcome", "records"].join();
const DELEGATION_KEYS = ["kind", "outcome"].join();

function keysOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return Object.keys(value).sort().join();
}

/** The strictly re-parsed hand-back takeover line, or null. */
export function parseRepairHandbackLine(
  value: unknown,
): RepairHandbackLineV1 | null {
  if (keysOf(value) !== HANDBACK_KEYS) return null;
  const line = value as Record<string, unknown>;
  if (
    line.kind !== REPAIR_HANDBACK_KIND ||
    (line.outcome !== "read" && line.outcome !== "unavailable") ||
    typeof line.records !== "number" || !Number.isSafeInteger(line.records) ||
    line.records < 0 || line.records > MAX_REPAIR_HANDBACK_RECORDS
  ) return null;
  return {
    kind: REPAIR_HANDBACK_KIND,
    outcome: line.outcome,
    records: line.records,
  };
}

/** The strictly re-parsed no-delegation line, or null. */
export function parseRepairFanoutDelegationLine(
  value: unknown,
): RepairFanoutDelegationLineV1 | null {
  if (keysOf(value) !== DELEGATION_KEYS) return null;
  const line = value as Record<string, unknown>;
  if (
    line.kind !== REPAIR_FANOUT_DELEGATION_KIND ||
    line.outcome !== "unavailable"
  ) return null;
  return { kind: REPAIR_FANOUT_DELEGATION_KIND, outcome: "unavailable" };
}
