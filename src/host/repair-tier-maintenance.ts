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
 */

import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1, StateReadResultV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { workItemIdForIssue } from "../repair/keys.ts";
import type { RepairTierStore } from "../state/state-repair-tier-store.ts";

export interface RepairTierMaintenanceDepsV1 {
  /** The trusted repair-role store (never a model-worker capability). */
  store: Pick<RepairTierStore, "tierRepair"> & {
    readRepair(): Promise<
      PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
    >;
  };
  /** Complete open-issue numbers of one repository, or a typed failure. */
  listOpenIssueNumbers(
    repository: RepositoryIdentityV1,
  ): Promise<PortResultV1<readonly number[]>>;
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

function repositoryKey(repository: RepositoryIdentityV1): string {
  return `${repository.owner}/${repository.name}#${repository.installationId}`;
}

export async function runRepairTierMaintenance(
  deps: RepairTierMaintenanceDepsV1,
): Promise<RepairTierMaintenanceResultV1> {
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
      beforeHead: null,
      appliedHead: null,
      before: null,
      action: "",
      ...fields,
    };
    out.action = status === "deferred"
      ? `repair-tier:deferred:${out.reason ?? "unknown"}`
      : status === "absent"
      ? "repair-tier:absent"
      : `repair-tier:${status}:read:${out.recordsRead ?? 0}:promoted:` +
        `${out.promoted}:demoted:${out.demoted}:deferred:${out.deferred}`;
    return out;
  };
  let recordsRead: number | null = null;
  try {
    if (deps.clock.now() >= deps.deadlineAt) {
      return result("deferred", { reason: "deadline" });
    }
    const read = await deps.store.readRepair();
    if (!read.ok) return result("deferred", { reason: read.error.kind });
    if (read.value.status !== "found") return result("absent");
    const snapshot = read.value.snapshot;
    const head = read.value.head;
    recordsRead = hotRecordCount(snapshot);

    const repositories = new Map<string, RepositoryIdentityV1>();
    for (const row of snapshot.work) {
      repositories.set(repositoryKey(row.repository), row.repository);
    }
    const listed: RepositoryIdentityV1[] = [];
    const openIssueWorkIds = new Set<string>();
    for (const repository of repositories.values()) {
      if (deps.clock.now() >= deps.deadlineAt) break;
      const issues = await deps.listOpenIssueNumbers(repository);
      if (!issues.ok) continue;
      listed.push(repository);
      for (const number of issues.value) {
        openIssueWorkIds.add(workItemIdForIssue(repository, number));
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
    });
    if (!tier.ok) {
      return result("deferred", { reason: tier.error.kind, recordsRead });
    }
    const value = tier.value;
    if (value.status === "unchanged") {
      return result("unchanged", {
        recordsRead,
        deferred: value.deferred,
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
