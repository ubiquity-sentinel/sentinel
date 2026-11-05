/**
 * One bounded hot/cold repair-tier step for the existing maintenance pass.
 *
 * It observes each configured repository's complete open-issue listing,
 * then asks the trusted repair writer to promote every reopened cold family
 * and demote eligible families within `demotionBudget`. It never throws and
 * never fails the run: an unavailable listing only narrows which records may
 * move this pass, and a state conflict, ambiguity or error defers the step
 * to the next pass. Action strings carry counts only (no URLs or bodies).
 */

import type { GitSha } from "../contracts/brands.ts";
import type { PortResultV1 } from "../contracts/ports.ts";
import type { GitHubIssueV1 } from "../contracts/ports-github-requests.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import { workItemIdForIssue } from "../repair/keys.ts";
import type { RepairTierStore } from "../state/mod.ts";

export interface RepairTierMaintenanceDepsV1 {
  /** The trusted repair-role store (never a model-worker capability). */
  store: RepairTierStore & {
    readRepair(): Promise<
      PortResultV1<
        | { status: "found"; head: GitSha }
        | { status: "absent" }
      >
    >;
  };
  /** Each repository with its own issue port; a failed listing is skipped. */
  repositories: readonly {
    repository: RepositoryIdentityV1;
    listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>>;
  }[];
  clock: { now(): number };
  protectedWorkIds?: ReadonlySet<string>;
  protectedReservationIds?: ReadonlySet<string>;
  demotionBudget: number;
}

export async function runRepairTierMaintenance(
  deps: RepairTierMaintenanceDepsV1,
): Promise<string> {
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
    const read = await deps.store.readRepair();
    if (!read.ok) return `repair-tier:deferred:${read.error.kind}`;
    if (read.value.status !== "found") return "repair-tier:absent";
    const result = await deps.store.tierRepair({
      expectedHead: read.value.head,
      now: deps.clock.now(),
      listedRepositories: listed,
      openIssueWorkIds,
      ...(deps.protectedWorkIds === undefined
        ? {}
        : { protectedWorkIds: deps.protectedWorkIds }),
      ...(deps.protectedReservationIds === undefined
        ? {}
        : { protectedReservationIds: deps.protectedReservationIds }),
      demotionBudget: deps.demotionBudget,
    });
    if (!result.ok) return `repair-tier:deferred:${result.error.kind}`;
    const value = result.value;
    switch (value.status) {
      case "unchanged":
        return `repair-tier:unchanged:deferred:${value.deferred}`;
      case "applied":
        return `repair-tier:promoted:${value.promoted}:demoted:${value.demoted}` +
          `:deferred:${value.deferred}`;
      default:
        return `repair-tier:deferred:${value.status}`;
    }
  } catch {
    return "repair-tier:deferred:exception";
  }
}
