/**
 * One bounded hot/cold repair-tier step for the existing maintenance pass.
 *
 * It observes each configured repository's complete open-issue listing,
 * then asks the trusted repair writer to promote every reopened cold family
 * and demote eligible families within `demotionBudget`. It never throws and
 * never fails the run: an unavailable listing only narrows which records may
 * move this pass, and a state conflict, ambiguity or error defers the step
 * to the next pass. Action strings carry counts only (no URLs or bodies).
 *
 * Release-deferred families (Sentinel #325): with the release path observed
 * disabled, a family holding an open release request moves cold unchanged
 * and the pass counts the moved requests (`releaseRequestsMovedToCold`).
 * With it observed enabled, the target tips are read first, those families
 * are promoted unchanged within the budget, and each promoted open request
 * whose candidate is no longer its target tip is recorded as a terminal
 * supersession by an ordinary expected-head repair write (no accounting
 * change, no deletion; the delivery record is untouched).
 */

import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type { GitHubIssueV1 } from "../contracts/ports-github-requests.ts";
import type { RepairStateWriter } from "../contracts/ports-state.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { workItemIdForIssue } from "../repair/keys.ts";
import { isGatewayVpsRepository } from "../repair/vps-delivery.ts";
import type { RepairTierStore } from "../state/mod.ts";
import { repositoryTierKey, supersedeReleaseRequest } from "../state/mod.ts";

export interface RepairTierMaintenanceDepsV1 {
  /** The trusted repair-role store (never a model-worker capability). */
  store: RepairTierStore & {
    readRepair(): Promise<
      PortResultV1<
        | { status: "found"; head: GitSha; snapshot?: RepairStateSnapshotV1 }
        | { status: "absent" }
      >
    >;
    /** Needed only to record a supersession after a release promotion. */
    writeRepair?: RepairStateWriter["writeRepair"];
  };
  /** Each repository with its own issue port; a failed listing is skipped. */
  repositories: readonly {
    repository: RepositoryIdentityV1;
    listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>>;
    /** Current target (default-branch) tip; read only with release enabled. */
    readTargetTip?(): Promise<PortResultV1<GitSha | null>>;
  }[];
  /**
   * Release path from the positively read release ref (`releasePathDisabled`).
   * Absent or unreadable: no release-deferred family moves either way.
   */
  releasePath?(): Promise<PortResultV1<"disabled" | "enabled">>;
  clock: { now(): number };
  protectedWorkIds?: ReadonlySet<string>;
  protectedReservationIds?: ReadonlySet<string>;
  demotionBudget: number;
}

/** Counts of one pass for the throughput metrics collector. */
export interface RepairTierMaintenanceSummaryV1 {
  action: string;
  /** Open release requests moved cold this pass; null when not observed. */
  releaseRequestsMovedToCold: number | null;
  /** Promoted open requests recorded superseded; null when not observed. */
  releaseRequestsSuperseded: number | null;
}

export async function runRepairTierMaintenance(
  deps: RepairTierMaintenanceDepsV1,
): Promise<string> {
  return (await runRepairTierMaintenanceSummary(deps)).action;
}

async function observeReleasePath(
  deps: RepairTierMaintenanceDepsV1,
): Promise<"disabled" | "enabled" | undefined> {
  if (deps.releasePath === undefined) return undefined;
  try {
    const read = await deps.releasePath();
    return read.ok ? read.value : undefined;
  } catch {
    return undefined;
  }
}

async function readTargetTips(
  deps: RepairTierMaintenanceDepsV1,
): Promise<Map<string, GitSha>> {
  const tips = new Map<string, GitSha>();
  for (const entry of deps.repositories) {
    if (entry.readTargetTip === undefined) continue;
    try {
      const read = await entry.readTargetTip();
      if (read.ok && read.value !== null) {
        tips.set(repositoryTierKey(entry.repository), read.value);
      }
    } catch {
      // An unread tip only defers that repository's release promotions.
    }
  }
  return tips;
}

/**
 * Records each promoted open request whose candidate is no longer its target
 * tip as terminal (expected-head, one retry on a concurrent write). Returns
 * the number recorded, or null when the write could not be made this pass.
 */
async function supersedePromoted(
  deps: RepairTierMaintenanceDepsV1,
  ids: readonly string[],
  tips: ReadonlyMap<string, GitSha>,
  now: number,
): Promise<number | null> {
  const write = deps.store.writeRepair;
  if (write === undefined) return null;
  const wanted = new Set(ids);
  for (let attempt = 0; attempt < 2; attempt++) {
    const read = await deps.store.readRepair();
    if (!read.ok || read.value.status !== "found") return null;
    const { head, snapshot } = read.value;
    if (snapshot === undefined) return null;
    let changed = 0;
    const releaseRequests = snapshot.releaseRequests.map((request) => {
      if (!wanted.has(request.id)) return request;
      const tip = tips.get(repositoryTierKey(request.target.repository));
      const next = tip === undefined
        ? null
        : supersedeReleaseRequest(request, tip);
      if (next === null) return request;
      changed++;
      return next;
    });
    if (changed === 0) return 0;
    const written = await write.call(deps.store, {
      ...snapshot,
      stateHead: head,
      sequence: snapshot.sequence + 1,
      updatedAt: Math.max(snapshot.updatedAt, now),
      releaseRequests,
    }, head);
    if (written.ok && written.value.status === "applied") return changed;
    if (!written.ok || written.value.status !== "conflict") return null;
  }
  return null;
}

function plain(action: string): RepairTierMaintenanceSummaryV1 {
  return {
    action,
    releaseRequestsMovedToCold: null,
    releaseRequestsSuperseded: null,
  };
}

export async function runRepairTierMaintenanceSummary(
  deps: RepairTierMaintenanceDepsV1,
): Promise<RepairTierMaintenanceSummaryV1> {
  try {
    const listed: RepositoryIdentityV1[] = [];
    const openIssueWorkIds = new Set<string>();
    for (const entry of deps.repositories) {
      const issues = await entry.listOpenIssues();
      if (!issues.ok) continue;
      listed.push(entry.repository);
      for (const issue of issues.value) {
        if (issue.state !== "open") continue;
        openIssueWorkIds.add(
          workItemIdForIssue(entry.repository, issue.number),
        );
      }
    }
    const releasePath = await observeReleasePath(deps);
    const tips = releasePath === "enabled"
      ? await readTargetTips(deps)
      : new Map<string, GitSha>();
    const read = await deps.store.readRepair();
    if (!read.ok) return plain(`repair-tier:deferred:${read.error.kind}`);
    if (read.value.status !== "found") return plain("repair-tier:absent");
    const now = deps.clock.now();
    const result = await deps.store.tierRepair({
      expectedHead: read.value.head,
      now,
      listedRepositories: listed,
      openIssueWorkIds,
      ...(deps.protectedWorkIds === undefined
        ? {}
        : { protectedWorkIds: deps.protectedWorkIds }),
      ...(deps.protectedReservationIds === undefined
        ? {}
        : { protectedReservationIds: deps.protectedReservationIds }),
      demotionBudget: deps.demotionBudget,
      ...(releasePath === undefined ? {} : {
        releasePath,
        releaseDeferredDeliveryExcluded: isGatewayVpsRepository,
        releaseTargetTips: tips,
      }),
    });
    if (!result.ok) {
      return plain(`repair-tier:deferred:${result.error.kind}`);
    }
    const value = result.value;
    const observed = releasePath !== undefined;
    const release = (moved: number, superseded: number | null) =>
      observed
        ? `:release-${releasePath}:moved-cold:${moved}:superseded:${
          superseded ?? "deferred"
        }`
        : "";
    switch (value.status) {
      case "unchanged":
        return {
          action: `repair-tier:unchanged:deferred:${value.deferred}` +
            release(0, 0),
          releaseRequestsMovedToCold: observed ? 0 : null,
          releaseRequestsSuperseded: observed ? 0 : null,
        };
      case "applied": {
        const superseded = value.promotedOpenReleaseRequestIds.length === 0
          ? 0
          : await supersedePromoted(
            deps,
            value.promotedOpenReleaseRequestIds,
            tips,
            now,
          );
        return {
          action:
            `repair-tier:promoted:${value.promoted}:demoted:${value.demoted}` +
            `:deferred:${value.deferred}` +
            release(value.releaseRequestsMovedToCold, superseded),
          releaseRequestsMovedToCold: observed
            ? value.releaseRequestsMovedToCold
            : null,
          releaseRequestsSuperseded: observed ? superseded : null,
        };
      }
      default:
        return plain(`repair-tier:deferred:${value.status}`);
    }
  } catch {
    return plain("repair-tier:deferred:exception");
  }
}
