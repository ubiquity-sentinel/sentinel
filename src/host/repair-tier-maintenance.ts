/**
 * One bounded hot/cold repair-tier step for the existing maintenance pass.
 *
 * It reads the hot snapshot once, observes the complete open-issue listing
 * of every repository that snapshot names, then asks the trusted repair
 * writer to promote every reopened cold family and demote eligible families
 * within `demotionBudget`. It never throws and never fails the run: an
 * unavailable listing only narrows which records may move this pass, a
 * passed deadline skips the write, and a state conflict, ambiguity or error
 * defers the step to the next pass. Its outcome carries counts only (no
 * URLs, bodies or credentials).
 *
 * Release-deferred families (Sentinel #325): with the release path observed
 * disabled, a family holding an open release request moves cold unchanged
 * and the pass counts the moved requests (`releaseRequestsMovedToCold`).
 * With it observed enabled, the target tips are read first, those families
 * are promoted unchanged within the budget, and each promoted open request
 * whose candidate is no longer its target tip is recorded as a terminal
 * supersession IN THE SAME tier commit (`releaseRequestsSuperseded`). A
 * failed write therefore leaves the family cold, and the next pass re-reads
 * the tip and re-evaluates it, every pass, until the supersession is recorded.
 */

import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1, StateReadResultV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { workItemIdForIssue } from "../repair/keys.ts";
import { isGatewayVpsRepository } from "../repair/vps-delivery.ts";
import { repositoryTierKey } from "../state/state-repair-tier-plan.ts";
import type {
  RepairTierHotReadV1,
  RepairTierStore,
} from "../state/state-repair-tier-store.ts";

export interface RepairTierMaintenanceDepsV1 {
  /** The trusted repair-role store (never a model-worker capability). */
  store: Pick<RepairTierStore, "tierRepair"> & {
    readRepair(): Promise<
      PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
    >;
    /** Hot read plus the compact discovery directory (no archive walk). */
    readRepairForTiering?: () => Promise<PortResultV1<RepairTierHotReadV1>>;
  };
  /** Complete open-issue numbers of one repository, or a typed failure. */
  listOpenIssueNumbers(
    repository: RepositoryIdentityV1,
  ): Promise<PortResultV1<readonly number[]>>;
  /** Current target (default-branch) tip; read only with release enabled. */
  readTargetTip?(
    repository: RepositoryIdentityV1,
  ): Promise<PortResultV1<GitSha | null>>;
  /**
   * Release path from the positively read release ref (`releasePathDisabled`).
   * Absent or unreadable: no release-deferred family moves either way.
   */
  releasePath?(): Promise<PortResultV1<"disabled" | "enabled">>;
  clock: { now(): number };
  /** No listing starts and no tier write is offered at or after this time. */
  deadlineAt: number;
  /** Ids the caller still owns, derived from the exact snapshot read. */
  protect?(snapshot: RepairStateSnapshotV1): {
    workIds: ReadonlySet<string>;
    reservationIds: ReadonlySet<string>;
  };
  demotionBudget: number;
}

export interface RepairTierMaintenanceResultV1 {
  status: "applied" | "unchanged" | "deferred" | "absent";
  /** Closed reason of a deferral; null otherwise. */
  reason: string | null;
  /** Hot records the step's read returned (null when nothing was read). */
  recordsRead: number | null;
  demoted: number;
  promoted: number;
  deferred: number;
  /** Open release requests moved cold this pass; null when not observed. */
  releaseRequestsMovedToCold: number | null;
  /** Promoted open requests recorded superseded; null when not observed. */
  releaseRequestsSuperseded: number | null;
  beforeHead: GitSha | null;
  appliedHead: GitSha | null;
  /** The exact hot snapshot the transition started from. */
  before: RepairStateSnapshotV1 | null;
  action: string;
}

/** Every hot record one snapshot holds (the hot read's record count). */
export function hotRecordCount(snapshot: RepairStateSnapshotV1): number {
  let count = 0;
  for (const value of Object.values(snapshot)) {
    if (Array.isArray(value)) count += value.length;
  }
  return count;
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

function describe(
  out: RepairTierMaintenanceResultV1,
  releasePath: "disabled" | "enabled" | undefined,
): string {
  if (out.status === "deferred") {
    return `repair-tier:deferred:${out.reason ?? "unknown"}`;
  }
  if (out.status === "absent") return "repair-tier:absent";
  const base = out.status === "applied"
    ? `repair-tier:promoted:${out.promoted}:demoted:${out.demoted}` +
      `:deferred:${out.deferred}`
    : `repair-tier:unchanged:deferred:${out.deferred}`;
  const release = releasePath === undefined
    ? ""
    : `:release-${releasePath}:moved-cold:${
      out.releaseRequestsMovedToCold ?? 0
    }:superseded:${out.releaseRequestsSuperseded ?? 0}`;
  return `${base}:read:${out.recordsRead ?? 0}${release}`;
}

export async function runRepairTierMaintenance(
  deps: RepairTierMaintenanceDepsV1,
): Promise<RepairTierMaintenanceResultV1> {
  let releasePath: "disabled" | "enabled" | undefined;
  const result = (
    status: RepairTierMaintenanceResultV1["status"],
    fields: Partial<RepairTierMaintenanceResultV1> = {},
  ): RepairTierMaintenanceResultV1 => {
    const out: RepairTierMaintenanceResultV1 = {
      status,
      reason: null,
      recordsRead: null,
      demoted: 0,
      promoted: 0,
      deferred: 0,
      releaseRequestsMovedToCold: null,
      releaseRequestsSuperseded: null,
      beforeHead: null,
      appliedHead: null,
      before: null,
      action: "",
      ...fields,
    };
    out.action = describe(out, releasePath);
    return out;
  };
  let recordsRead: number | null = null;
  try {
    if (deps.clock.now() >= deps.deadlineAt) {
      return result("deferred", { reason: "deadline" });
    }
    const read: PortResultV1<RepairTierHotReadV1> = await (
      deps.store.readRepairForTiering?.() ?? deps.store.readRepair()
    );
    if (!read.ok) return result("deferred", { reason: read.error.kind });
    if (read.value.status !== "found") return result("absent");
    const snapshot = read.value.snapshot;
    const head = read.value.head;
    recordsRead = hotRecordCount(snapshot);
    releasePath = await observeReleasePath(deps);

    const repositories = new Map<string, RepositoryIdentityV1>();
    const addRepository = (repository: RepositoryIdentityV1) =>
      repositories.set(repositoryTierKey(repository), repository);
    for (const row of snapshot.work) addRepository(row.repository);
    for (const row of snapshot.releaseRequests) {
      addRepository(row.target.repository);
    }
    for (const repository of read.value.tierRepositories ?? []) {
      addRepository(repository);
    }
    const listed: RepositoryIdentityV1[] = [];
    const openIssueWorkIds = new Set<string>();
    const tips = new Map<string, GitSha>();
    for (const repository of repositories.values()) {
      if (deps.clock.now() >= deps.deadlineAt) break;
      const issues = await deps.listOpenIssueNumbers(repository);
      if (issues.ok) {
        listed.push(repository);
        for (const number of issues.value) {
          openIssueWorkIds.add(workItemIdForIssue(repository, number));
        }
      }
      if (releasePath !== "enabled" || deps.readTargetTip === undefined) {
        continue;
      }
      try {
        const tip = await deps.readTargetTip(repository);
        if (tip.ok && tip.value !== null) {
          tips.set(repositoryTierKey(repository), tip.value);
        }
      } catch {
        // An unread tip only defers that repository's release promotions.
      }
    }
    if (deps.clock.now() >= deps.deadlineAt) {
      return result("deferred", { reason: "deadline", recordsRead });
    }
    const protectedIds = deps.protect?.(snapshot);
    const tier = await deps.store.tierRepair({
      expectedHead: head,
      now: deps.clock.now(),
      listedRepositories: listed,
      openIssueWorkIds,
      ...(protectedIds === undefined ? {} : {
        protectedWorkIds: protectedIds.workIds,
        protectedReservationIds: protectedIds.reservationIds,
      }),
      demotionBudget: deps.demotionBudget,
      ...(releasePath === undefined ? {} : {
        releasePath,
        releaseDeferredDeliveryExcluded: isGatewayVpsRepository,
        releaseTargetTips: tips,
      }),
    });
    if (!tier.ok) {
      return result("deferred", { reason: tier.error.kind, recordsRead });
    }
    const value = tier.value;
    const observed = releasePath !== undefined;
    if (value.status === "unchanged") {
      return result("unchanged", {
        recordsRead,
        deferred: value.deferred,
        releaseRequestsMovedToCold: observed ? 0 : null,
        releaseRequestsSuperseded: observed ? 0 : null,
        beforeHead: head,
        before: snapshot,
      });
    }
    if (value.status === "applied") {
      return result("applied", {
        recordsRead,
        demoted: value.demoted,
        promoted: value.promoted,
        deferred: value.deferred,
        releaseRequestsMovedToCold: observed
          ? value.releaseRequestsMovedToCold
          : null,
        releaseRequestsSuperseded: observed
          ? value.releaseRequestsSuperseded
          : null,
        beforeHead: head,
        appliedHead: value.head,
        before: snapshot,
      });
    }
    return result("deferred", { reason: value.status, recordsRead });
  } catch {
    return result("deferred", { reason: "exception", recordsRead });
  }
}

/** The #325 name for the same step (one implementation). */
export const runRepairTierMaintenanceSummary = runRepairTierMaintenance;
