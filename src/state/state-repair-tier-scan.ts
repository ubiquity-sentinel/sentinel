/**
 * The once-per-generation retired-pull cold scan of the tier transition.
 *
 * Records retired because their source issue closed, demoted before the
 * demotion rule kept such a record hot while its own pull request is
 * unsettled, are cold where the hosted retired-pull pass cannot see them.
 * When the hot snapshot holds no complete scan for the installed runtime
 * generation, this reads the cold WORK rows only (one `cat-file --batch`)
 * and returns at most `RETIRED_PULL_SCAN_PROMOTIONS` pending ids to promote.
 * When those are every pending cold record, the scan row for the generation
 * is formed too, and the caller writes it in the SAME tier commit as the
 * promotions; a pass that still leaves pending rows cold writes no row, so
 * the next pass scans again. A scan that finds nothing still records its row,
 * so later passes of the generation read no cold blob for it.
 */
import { canonicalStringify } from "../contracts/canonical.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import {
  parseRepairTierScanV1,
  RETIRED_PULL_COLD_SCAN_ID,
} from "../contracts/repair-tier-scan.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { OpContext, StateGitOps } from "./state-git.ts";
import { sha256Hex } from "./state-records.ts";
import {
  readColdTier,
  REPAIR_COLD_PREFIX,
  type RepairColdCatalogV1,
} from "./state-repair-tier-layout.ts";
import {
  type RepairTierPolicyV1,
  retiredPullScanDue,
  retiredPullScanSeeds,
} from "./state-repair-tier-plan.ts";

/** Hot collection directory of the scan row. */
export const TIER_SCAN_DIRECTORY = "tierScans";

export interface RetiredPullScanPlanV1 {
  /** Cold work ids to promote this pass (bounded, id order). */
  seeds: string[];
  /** The scan row's hot file, when this pass completes the scan. */
  marker: { path: string; sha: string } | null;
}

export async function planRetiredPullScan(
  io: StateGitOps,
  op: OpContext,
  catalog: RepairColdCatalogV1,
  prior: RepairStateSnapshotV1,
  policy: RepairTierPolicyV1,
): Promise<PortResultV1<RetiredPullScanPlanV1>> {
  if (!retiredPullScanDue(prior, policy)) {
    return portOk({ seeds: [], marker: null });
  }
  const prefix = `${REPAIR_COLD_PREFIX}/work/`;
  const entries = catalog.entries.filter((entry) =>
    entry.path.startsWith(prefix)
  );
  let seeds: string[] = [];
  let complete = true;
  if (entries.length > 0) {
    const cold = await readColdTier(io, op, {
      tree: catalog.tree,
      entries,
    }, { partial: true });
    if (!cold.ok) return cold;
    ({ seeds, complete } = retiredPullScanSeeds(cold.value.work));
  }
  if (!complete) return portOk({ seeds, marker: null });
  const row = parseRepairTierScanV1({
    version: "v1",
    kind: "repair_tier_scan",
    id: RETIRED_PULL_COLD_SCAN_ID,
    generation: policy.retiredPullScanGeneration,
    scannedAt: Math.max(prior.updatedAt, policy.now),
  });
  const blob = await io.git(op, ["hash-object", "-w", "--stdin"], {
    stdin: new TextEncoder().encode(`${canonicalStringify(row)}\n`),
  });
  const sha = blob.stdout.trim();
  if (!blob.ok || !/^[0-9a-f]{40}$/.test(sha)) {
    return portError("unavailable", "could not form the tier scan row");
  }
  return portOk({
    seeds,
    marker: {
      path: `${TIER_SCAN_DIRECTORY}/${await sha256Hex(row.id)}.json`,
      sha,
    },
  });
}
