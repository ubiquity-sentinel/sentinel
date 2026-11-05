/**
 * Compact cold-tier discovery in the hot manifest. Maintenance needs repository
 * identities, not archived records, to observe reopenings (even with no hot
 * work left). Repositories are retained until the cold tier empties; an extra
 * issue listing is safe, forgetting a cold repository is not.
 *
 * Existing tier refs have no directory. Only that migration reads cold work
 * and requests once; the next expected-head tier write records the directory.
 */
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { OpContext, StateGitOps } from "./state-git.ts";
import { parseStateManifest } from "./state-records.ts";
import type {
  RepairTierDirectoryV1,
  StateManifestV1,
} from "./state-records.ts";
import { readColdCatalog, readColdTier } from "./state-repair-tier-layout.ts";
import type {
  RepairColdCatalogV1,
  RepairColdTierV1,
} from "./state-repair-tier-layout.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type {
  RepairTierMoveV1,
  RepairTierPolicyV1,
} from "./state-repair-tier-plan.ts";
import { repositoryTierKey } from "./state-repair-tier-plan.ts";

export async function readRepairManifest(
  io: StateGitOps,
  op: OpContext,
  head: string,
): Promise<PortResultV1<StateManifestV1>> {
  const read = await io.git(op, ["show", `${head}:manifest.json`]);
  if (!read.ok) return io.gitFailure("unavailable", "show", read);
  try {
    return portOk(
      parseStateManifest(JSON.parse(read.stdout), "$.manifest", "repair"),
    );
  } catch {
    return portError("invalid", "repair tier manifest failed validation");
  }
}

export function tierRepositories(
  repositories: readonly RepositoryIdentityV1[],
): RepositoryIdentityV1[] {
  const byKey = new Map(
    repositories.map((row) => [repositoryTierKey(row), row]),
  );
  return [...byKey].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map((
    [, row],
  ) => row);
}

export async function readRepairTierDirectory(
  io: StateGitOps,
  op: OpContext,
  head: string,
  catalog?: RepairColdCatalogV1,
): Promise<
  PortResultV1<{ directory: RepairTierDirectoryV1; legacy: boolean }>
> {
  const manifest = await readRepairManifest(io, op, head);
  if (!manifest.ok) return manifest;
  if (manifest.value.repairTier !== undefined) {
    return portOk({ directory: manifest.value.repairTier, legacy: false });
  }
  const read = catalog === undefined
    ? await readColdCatalog(io, op, head)
    : portOk(catalog);
  if (!read.ok) return read;
  const cold = await readColdTier(io, op, {
    ...read.value,
    entries: read.value.entries.filter((row) =>
      row.path.startsWith("repair-archive/work/") ||
      row.path.startsWith("repair-archive/releaseRequests/")
    ),
  }, { partial: true });
  if (!cold.ok) return cold;
  return portOk({
    legacy: read.value.tree !== null,
    directory: {
      repositories: tierRepositories([
        ...cold.value.work.map((row) => row.repository),
        ...cold.value.releaseRequests.map((row) => row.target.repository),
      ]),
      workIds: cold.value.work.map((row) => row.id).sort(),
      openReleaseRequests: cold.value.releaseRequests.filter((row) =>
        row.status === "open"
      ).length,
    },
  });
}

/** No archive walk at all on an unchanged pass once the directory exists. */
export function tierNeedsPromotion(
  directory: RepairTierDirectoryV1,
  hot: RepairStateSnapshotV1,
  policy: RepairTierPolicyV1,
): boolean {
  if (policy.promoteAll === true && directory.workIds.length > 0) return true;
  const wanted = new Set([
    ...policy.openIssueWorkIds,
    ...hot.work.flatMap((row) => row.dependencies),
  ]);
  return directory.workIds.some((id) => wanted.has(id)) ||
    (policy.releasePath === "enabled" && directory.openReleaseRequests > 0);
}

export function nextTierDirectory(
  directory: RepairTierDirectoryV1,
  hot: RepairStateSnapshotV1,
  demoted: readonly RepairTierMoveV1[],
  promoted: readonly RepairTierMoveV1[],
  openReleaseRequests: number,
): RepairTierDirectoryV1 {
  const workIds = new Set(directory.workIds);
  for (const move of promoted) {
    if (move.from === "work") workIds.delete(move.id);
  }
  for (const move of demoted) if (move.from === "work") workIds.add(move.id);
  return {
    repositories: tierRepositories([
      ...directory.repositories,
      ...hot.work.map((row) => row.repository),
      ...hot.releaseRequests.map((row) => row.target.repository),
    ]),
    workIds: [...workIds].sort(),
    openReleaseRequests,
  };
}

/** Checked by the full-ledger reader and before a tier candidate can push. */
export function tierDirectoryMessage(
  directory: RepairTierDirectoryV1,
  cold: RepairColdTierV1,
): string | null {
  const workIds = cold.work.map((row) => row.id).sort();
  if (JSON.stringify(workIds) !== JSON.stringify(directory.workIds)) {
    return "repair tier directory does not match cold work";
  }
  if (
    directory.openReleaseRequests !==
      cold.releaseRequests.filter((row) => row.status === "open").length
  ) {
    return "repair tier directory does not match cold release requests";
  }
  const repositories = new Set(directory.repositories.map(repositoryTierKey));
  if (
    [
      ...cold.work.map((row) => row.repository),
      ...cold.releaseRequests.map((row) => row.target.repository),
    ].some((row) => !repositories.has(repositoryTierKey(row)))
  ) {
    return "repair tier directory is missing a cold repository";
  }
  return null;
}
