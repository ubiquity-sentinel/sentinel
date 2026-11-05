/**
 * Repair-tier scan memory: the one cold-tier scan a runtime generation owes.
 *
 * A record retired because its source issue closed whose own pull request is
 * still unsettled (`retiredPullClosurePending`) must be hot, where the hosted
 * maintenance pass closes Sentinel's own open pull request. Records demoted
 * before that rule existed are cold. The tier transition scans the cold work
 * rows once per installed runtime generation, promotes the pending ones
 * (bounded) and, once none is left, records this row in the SAME tier commit,
 * so later passes of that generation never read the cold tier for it again.
 *
 * The row is a cache in the repair snapshot's optional `tierScans` collection,
 * never an accounting or history record: a missing row only costs one scan.
 */
import {
  expectEnum,
  expectExactKeys,
  expectPositiveInt,
  expectRecord,
  expectTimestamp,
  expectVersion,
} from "./validation.ts";

/** The one scan row id. */
export const RETIRED_PULL_COLD_SCAN_ID = "retired-pull-cold-scan";

export interface RepairTierScanV1 {
  version: "v1";
  kind: "repair_tier_scan";
  id: typeof RETIRED_PULL_COLD_SCAN_ID;
  /** Runtime generation whose scan found no pending cold record left. */
  generation: number;
  scannedAt: number;
}

const KEYS = ["version", "kind", "id", "generation", "scannedAt"] as const;

export function parseRepairTierScanV1(
  input: unknown,
  path = "$",
): RepairTierScanV1 {
  const obj = expectRecord(input, path);
  expectExactKeys(obj, KEYS, path);
  expectVersion(obj.version, `${path}.version`);
  expectEnum(obj.kind, ["repair_tier_scan"], `${path}.kind`);
  expectEnum(obj.id, [RETIRED_PULL_COLD_SCAN_ID], `${path}.id`);
  return {
    version: "v1",
    kind: "repair_tier_scan",
    id: RETIRED_PULL_COLD_SCAN_ID,
    generation: expectPositiveInt(obj.generation, `${path}.generation`),
    scannedAt: expectTimestamp(obj.scannedAt, `${path}.scannedAt`),
  };
}
