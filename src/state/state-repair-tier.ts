/**
 * Trusted hot/cold tier transitions and the explicit full-ledger read view.
 *
 * A tier transition is formed with Git plumbing only: the prior tree is read
 * into a private index, each moved row's index entry is re-pointed from one
 * tier path to the other with the SAME blob id, and only the manifest is
 * rewritten (sequence + 1, stateHead = prior head). Before the candidate is
 * offered for a non-force expected-head push it is re-read and checked: the
 * hot snapshot and the cold tier both validate, no id is in both tiers, and
 * the multiset of (logical record path, blob id) over hot+cold is exactly the
 * prior one. Nothing is rewritten, refunded, regenerated or dropped.
 */

import { canonicalStringify } from "../contracts/canonical.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { BudgetReservationV1 } from "../contracts/budget-reservation.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import { portError, portOk } from "../contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import type { GitRunResultV1, OpContext, StateGitOps } from "./state-git.ts";
import { MANIFEST_KIND, sha256Hex } from "./state-records.ts";
import type { StateManifestV1 } from "./state-records.ts";
import {
  parseStateTreeListing,
  readColdCatalog,
  readColdTier,
  REPAIR_COLD_LAYOUT_PATH,
  REPAIR_COLD_LAYOUT_TEXT,
  REPAIR_COLD_PREFIX,
  validateTierDisjoint,
} from "./state-repair-tier-layout.ts";
import type {
  RepairColdCatalogV1,
  RepairColdTierV1,
} from "./state-repair-tier-layout.ts";
import {
  planRepairDemotions,
  planRepairPromotions,
  repositoryTierKey,
  takeDemotionBudget,
} from "./state-repair-tier-plan.ts";
import {
  planReleasePromotions,
  supersedeReleaseRequest,
} from "./state-repair-tier-release.ts";
import type {
  RepairTierMoveV1,
  RepairTierPolicyV1,
} from "./state-repair-tier-plan.ts";

/** Explicit hot+cold view for readers that must see the whole ledger. */
export interface RepairTieredSnapshotV1 {
  /** Exactly the snapshot the hot read returns at the same head. */
  hot: RepairStateSnapshotV1;
  cold: RepairColdTierV1;
}

/** Release-deferred movement of one pass (Sentinel #325). */
export interface RepairTierReleaseMovesV1 {
  /** Open release requests moved cold (release path disabled). */
  releaseRequestsMovedToCold: number;
  /** Ids of open release requests promoted hot (release path enabled). */
  promotedOpenReleaseRequestIds: string[];
  /**
   * Promoted open requests recorded superseded IN THE SAME tier commit (their
   * candidate is no longer the target tip read this pass). Atomic with the
   * promotion: a failed write leaves the family cold, so the next pass
   * re-reads the tip and re-evaluates it until the supersession is recorded.
   */
  releaseRequestsSuperseded: number;
}

export type RepairTierResultV1 =
  | { status: "unchanged"; head: GitSha; deferred: number }
  | ({
    status: "applied";
    head: GitSha;
    demoted: number;
    promoted: number;
    deferred: number;
  } & RepairTierReleaseMovesV1)
  | { status: "conflict"; currentHead: GitSha | null }
  | { status: "ambiguous"; currentHead: GitSha | null };

/** Store hooks the tier transition needs beyond plain Git plumbing. */
export interface RepairTierIoV1 extends StateGitOps {
  readHotTree(
    op: OpContext,
    commit: string,
  ): Promise<PortResultV1<RepairStateSnapshotV1>>;
  commitTree(
    op: OpContext,
    tree: string,
    parent: GitSha,
  ): Promise<GitRunResultV1>;
}

/** Every reservation across both tiers: hot live, hot archive, then cold. */
export function allReservationsAcrossTiersV1(
  view: RepairTieredSnapshotV1,
): BudgetReservationV1[] {
  return [
    ...view.hot.reservations,
    ...(view.hot.reservationArchive ?? []),
    ...view.cold.reservations,
    ...view.cold.reservationArchive,
  ];
}

/** Every work record across both tiers. */
export function allWorkAcrossTiersV1(
  view: RepairTieredSnapshotV1,
): WorkRecordV1[] {
  return [...view.hot.work, ...view.cold.work];
}

/** Reads the cold tier of `head` next to its already-read hot snapshot. */
export async function readRepairTieredView(
  io: StateGitOps,
  op: OpContext,
  head: string,
  hot: RepairStateSnapshotV1,
): Promise<PortResultV1<RepairTieredSnapshotV1>> {
  const catalog = await readColdCatalog(io, op, head);
  if (!catalog.ok) return catalog;
  const cold = await readColdTier(io, op, catalog.value);
  if (!cold.ok) return cold;
  const overlap = validateTierDisjoint(hot, cold.value);
  if (overlap !== null) return portError("invalid", overlap);
  return portOk({ hot, cold: cold.value });
}

/**
 * Refuses an ordinary hot write that would recreate a row the cold tier
 * already holds; the row must be promoted by the tier transition first.
 * Compares file names only (no cold blob is read).
 */
export function coldCollisionMessage(
  files: readonly { path: string }[],
  catalog: RepairColdCatalogV1,
): string | null {
  if (catalog.entries.length === 0) return null;
  const cold = new Set(catalog.entries.map((entry) => logicalPath(entry.path)));
  for (const file of files) {
    if (file.path === "manifest.json") continue;
    if (cold.has(logicalPath(file.path))) {
      return "a cold repair record must be promoted before it is written";
    }
  }
  return null;
}

/** Tier- and archive-independent identity of one record file. */
function logicalPath(path: string): string {
  const bare = path.startsWith(`${REPAIR_COLD_PREFIX}/`)
    ? path.slice(REPAIR_COLD_PREFIX.length + 1)
    : path;
  // Live and archived reservations share one id space (one row, two homes).
  return bare.replace(/^reservationArchive\//, "reservations/");
}

async function listAll(
  io: StateGitOps,
  op: OpContext,
  commit: string,
): Promise<PortResultV1<Map<string, string>>> {
  const listed = await io.git(op, ["ls-tree", "-r", commit]);
  if (!listed.ok) return io.gitFailure("unavailable", "ls-tree", listed);
  const entries = parseStateTreeListing(listed.stdout);
  if (!entries.ok) return entries;
  return portOk(new Map(entries.value.map((entry) => [entry.path, entry.sha])));
}

interface ResolvedMove {
  from: string;
  to: string;
  sha: string;
}

async function resolveMoves(
  moves: readonly RepairTierMoveV1[],
  tree: ReadonlyMap<string, string>,
  direction: "demote" | "promote",
): Promise<ResolvedMove[] | null> {
  const resolved: ResolvedMove[] = [];
  for (const move of moves) {
    const fileName = `${await sha256Hex(move.id)}.json`;
    const hotFrom = `${move.from}/${fileName}`;
    const coldFrom = `${REPAIR_COLD_PREFIX}/${move.from}/${fileName}`;
    const from = direction === "demote" ? hotFrom : coldFrom;
    const to = direction === "demote"
      ? `${REPAIR_COLD_PREFIX}/${move.to}/${fileName}`
      : `${move.to}/${fileName}`;
    const sha = tree.get(from);
    // A row stored under a retired legacy file name is never moved.
    if (sha === undefined || tree.has(to)) return null;
    resolved.push({ from, to, sha });
  }
  return resolved;
}

/** Same logical rows with the same blob ids, ignoring the tier and manifest. */
function preservationMessage(
  prior: ReadonlyMap<string, string>,
  next: ReadonlyMap<string, string>,
  /** Logical paths whose new blob is a recorded supersession (exact ids). */
  superseded: ReadonlyMap<string, string> = new Map(),
): string | null {
  const logical = (tree: ReadonlyMap<string, string>) => {
    const out = new Map<string, string>();
    for (const [path, sha] of tree) {
      if (path === "manifest.json" || path === REPAIR_COLD_LAYOUT_PATH) {
        continue;
      }
      const key = logicalPath(path);
      if (out.has(key)) return null;
      out.set(key, sha);
    }
    return out;
  };
  const before = logical(prior);
  const after = logical(next);
  if (before === null || after === null) {
    return "a tier transition cannot duplicate a record";
  }
  if (before.size !== after.size) {
    return "a tier transition cannot add or drop a record";
  }
  for (const [key, sha] of before) {
    const expected = superseded.get(key) ?? sha;
    if (after.get(key) !== expected) {
      return "a tier transition must move records byte-for-byte";
    }
  }
  return null;
}

/**
 * Forms (but never pushes) the tier transition of one pass on top of the
 * validated `prior` hot snapshot at `head`. Promotions of reopened families
 * are always included; demotions are bounded by the policy budget.
 */
export async function buildRepairTierCommit(
  io: RepairTierIoV1,
  op: OpContext,
  head: GitSha,
  prior: RepairStateSnapshotV1,
  policy: RepairTierPolicyV1,
): Promise<
  PortResultV1<
    | { status: "unchanged"; deferred: number }
    | ({
      status: "candidate";
      commit: GitSha;
      demoted: number;
      promoted: number;
      deferred: number;
    } & RepairTierReleaseMovesV1)
  >
> {
  const catalog = await readColdCatalog(io, op, head);
  if (!catalog.ok) return catalog;
  const priorTree = await listAll(io, op, head);
  if (!priorTree.ok) return priorTree;

  // Promotion needs cold content only when an open issue names a cold family
  // (or a hot record depends on one); the common pass reads no cold blob.
  const coldNames = new Set(catalog.value.entries.map((entry) => entry.path));
  let needsCold = policy.promoteAll === true &&
    catalog.value.entries.length > 0;
  const wanted = [
    ...policy.openIssueWorkIds,
    ...prior.work.flatMap((row) => row.dependencies),
  ];
  for (const id of wanted) {
    const path = `${REPAIR_COLD_PREFIX}/work/${await sha256Hex(id)}.json`;
    if (coldNames.has(path)) {
      needsCold = true;
      break;
    }
  }
  // With the release path enabled, release-deferred families return hot; the
  // cold request rows alone decide whether any open one is there.
  if (!needsCold && policy.releasePath === "enabled") {
    const requestPrefix = `${REPAIR_COLD_PREFIX}/releaseRequests/`;
    const requestEntries = catalog.value.entries.filter((entry) =>
      entry.path.startsWith(requestPrefix)
    );
    if (requestEntries.length > 0) {
      const requests = await readColdTier(io, op, {
        tree: catalog.value.tree,
        entries: requestEntries,
      }, { partial: true });
      if (!requests.ok) return requests;
      needsCold = requests.value.releaseRequests.some((row) =>
        row.status === "open"
      );
    }
  }
  let promoted: ResolvedMove[] = [];
  let releaseDeferred = 0;
  let promotedOpenReleaseRequestIds: string[] = [];
  const superseded = new Map<string, string>();
  if (needsCold) {
    const cold = await readColdTier(io, op, catalog.value);
    if (!cold.ok) return cold;
    const release = planReleasePromotions(cold.value, policy);
    releaseDeferred = release.deferred;
    const plan = planRepairPromotions(
      prior,
      cold.value,
      policy,
      release.seeds,
    );
    const openCold = new Set(
      cold.value.releaseRequests.filter((row) => row.status === "open").map((
        row,
      ) => row.id),
    );
    promotedOpenReleaseRequestIds = plan.filter((move) =>
      move.from === "releaseRequests" && openCold.has(move.id)
    ).map((move) => move.id).sort();
    const resolved = await resolveMoves(
      plan,
      priorTree.value,
      "promote",
    );
    if (resolved === null) {
      return portError("invalid", "a cold family could not be resolved");
    }
    // A promoted open request whose candidate is no longer the target tip
    // read this pass is recorded superseded in this same commit.
    const tips = policy.releaseTargetTips ?? new Map<string, GitSha>();
    for (const id of promotedOpenReleaseRequestIds) {
      const request = cold.value.releaseRequests.find((row) => row.id === id)!;
      const tip = tips.get(repositoryTierKey(request.target.repository));
      const next = tip === undefined
        ? null
        : supersedeReleaseRequest(request, tip);
      if (next === null) continue;
      const blob = await io.git(op, ["hash-object", "-w", "--stdin"], {
        stdin: new TextEncoder().encode(`${canonicalStringify(next)}\n`),
      });
      const blobSha = blob.stdout.trim();
      if (!blob.ok || !/^[0-9a-f]{40}$/.test(blobSha)) {
        return portError("unavailable", "could not form the supersession");
      }
      const path = `releaseRequests/${await sha256Hex(id)}.json`;
      const move = resolved.find((row) => row.to === path);
      if (move === undefined) {
        return portError("invalid", "a cold family could not be resolved");
      }
      move.sha = blobSha;
      superseded.set(logicalPath(path), blobSha);
    }
    if (
      policy.promoteAll === true &&
      resolved.length !== catalog.value.entries.length
    ) {
      return portError("invalid", "a cold row is not bound to a family");
    }
    promoted = resolved;
  }

  const families: RepairTierMoveV1[][] = [];
  // A promote-all transition (rollback preparation) never demotes.
  const demotable = policy.promoteAll === true
    ? []
    : planRepairDemotions(prior, policy);
  const resolvedFamilies = new Map<RepairTierMoveV1[], ResolvedMove[]>();
  for (const family of demotable) {
    const resolved = await resolveMoves(family, priorTree.value, "demote");
    if (resolved === null) continue;
    families.push(family);
    resolvedFamilies.set(family, resolved);
  }
  const budgeted = takeDemotionBudget(families, policy.demotionBudget);
  const taken = new Set(
    budgeted.demote.map((move) => `${move.from}:${move.id}`),
  );
  const takenFamilies = families.filter((family) =>
    family.every((move) => taken.has(`${move.from}:${move.id}`))
  );
  const demoted = takenFamilies.flatMap((family) =>
    resolvedFamilies.get(family)!
  );
  const openHot = new Set(
    prior.releaseRequests.filter((row) => row.status === "open").map((row) =>
      row.id
    ),
  );
  const releaseRequestsMovedToCold =
    takenFamilies.flat().filter((move) =>
      move.from === "releaseRequests" && openHot.has(move.id)
    ).length;
  const deferred = budgeted.deferred + releaseDeferred;
  if (promoted.length === 0 && demoted.length === 0) {
    return portOk({ status: "unchanged", deferred });
  }

  const manifest: StateManifestV1 = {
    version: "v1",
    kind: MANIFEST_KIND.repair,
    sequence: prior.sequence + 1,
    updatedAt: Math.max(prior.updatedAt, policy.now),
    stateHead: head,
  };
  const manifestBlob = await io.git(op, ["hash-object", "-w", "--stdin"], {
    stdin: new TextEncoder().encode(`${canonicalStringify(manifest)}\n`),
  });
  const manifestSha = manifestBlob.stdout.trim();
  if (!manifestBlob.ok || !/^[0-9a-f]{40}$/.test(manifestSha)) {
    return portError("unavailable", "could not form the tier manifest");
  }
  const zero = "0".repeat(40);
  const lines = [...promoted, ...demoted].flatMap((move) => [
    `0 ${zero}\t${move.from}`,
    `100644 ${move.sha}\t${move.to}`,
  ]);
  lines.push(`100644 ${manifestSha}\tmanifest.json`);
  // The layout marker exists exactly while the cold tier holds a record.
  const coldAfter = catalog.value.entries.length - promoted.length +
    demoted.length;
  if (catalog.value.tree === null && coldAfter > 0) {
    const marker = await io.git(op, ["hash-object", "-w", "--stdin"], {
      stdin: new TextEncoder().encode(REPAIR_COLD_LAYOUT_TEXT),
    });
    const markerSha = marker.stdout.trim();
    if (!marker.ok || !/^[0-9a-f]{40}$/.test(markerSha)) {
      return portError("unavailable", "could not form the tier marker");
    }
    lines.push(`100644 ${markerSha}\t${REPAIR_COLD_LAYOUT_PATH}`);
  } else if (catalog.value.tree !== null && coldAfter === 0) {
    lines.push(`0 ${zero}\t${REPAIR_COLD_LAYOUT_PATH}`);
  }
  const readTree = await io.git(op, ["read-tree", head]);
  if (!readTree.ok) {
    return portError("unavailable", "could not form the tier index");
  }
  const indexInfo = await io.git(op, ["update-index", "--index-info"], {
    stdin: new TextEncoder().encode(`${lines.join("\n")}\n`),
  });
  const tree = indexInfo.ok ? await io.git(op, ["write-tree"]) : indexInfo;
  const treeSha = tree.stdout.trim();
  if (!tree.ok || !/^[0-9a-f]{40}$/.test(treeSha)) {
    return portError("unavailable", "could not form the tier tree");
  }
  const commit = await io.commitTree(op, treeSha, head);
  const commitSha = commit.stdout.trim();
  if (!commit.ok || !/^[0-9a-f]{40}$/.test(commitSha)) {
    return portError("unavailable", "could not form the tier commit");
  }

  // Re-read the exact candidate before it can be offered for a push.
  const nextTree = await listAll(io, op, commitSha);
  if (!nextTree.ok) return nextTree;
  const preserved = preservationMessage(
    priorTree.value,
    nextTree.value,
    superseded,
  );
  if (preserved !== null) return portError("invalid", preserved);
  const hot = await io.readHotTree(op, commitSha);
  if (!hot.ok) return hot;
  const view = await readRepairTieredView(io, op, commitSha, hot.value);
  if (!view.ok) return view;
  return portOk({
    status: "candidate",
    commit: commitSha as GitSha,
    demoted: demoted.length,
    promoted: promoted.length,
    deferred,
    releaseRequestsMovedToCold,
    promotedOpenReleaseRequestIds,
    releaseRequestsSuperseded: superseded.size,
  });
}
