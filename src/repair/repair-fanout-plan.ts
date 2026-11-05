/**
 * The repository fan-out plan of one supervisor run (issue #328).
 *
 * One repository cell is planned for every configured repository that holds
 * at least one live (hot, not done) work record at the exact state head the
 * plan reads. The plan is bound to that head, the run and its attempt by a
 * canonical digest; every delta a cell returns names that digest, so the
 * trusted writer accepts only deltas of the plan it expects. Planning reads
 * state and writes nothing.
 */
import type { GitSha } from "../contracts/brands.ts";
import {
  canonicalDigestV1,
  type RepairDeltaBindingV1,
  sameRepositoryV1,
} from "../contracts/repair-delta.ts";
import type { RepositoryConfigV1 } from "../contracts/repository-config.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";

/** GitHub Actions caps one matrix at 256 jobs. */
export const MAX_REPAIR_FANOUT_CELLS = 256;

export interface RepairFanoutPlanV1 {
  version: "v1";
  kind: "repair_fanout_plan";
  runId: number;
  runAttempt: number;
  baseHead: GitSha;
  /** Sorted by installation, owner and name; each at most once. */
  repositories: RepositoryIdentityV1[];
}

export interface RepairFanoutMatrixV1 {
  include: { repository: string; installationId: number }[];
}

function order(left: RepositoryIdentityV1, right: RepositoryIdentityV1) {
  const a = `${left.installationId}/${left.owner}/${left.name}`;
  const b = `${right.installationId}/${right.owner}/${right.name}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function planRepairFanoutV1(input: {
  snapshot: RepairStateSnapshotV1;
  head: GitSha;
  configs: readonly RepositoryConfigV1[];
  runId: number;
  runAttempt: number;
}): RepairFanoutPlanV1 {
  const repositories = input.configs
    .map((config) => config.repository)
    .filter((repository) =>
      input.snapshot.work.some((record) =>
        record.nextStep !== "done" &&
        sameRepositoryV1(record.repository, repository)
      )
    )
    .sort(order)
    .filter((repository, index, all) =>
      index === 0 || order(all[index - 1], repository) !== 0
    )
    .slice(0, MAX_REPAIR_FANOUT_CELLS);
  return {
    version: "v1",
    kind: "repair_fanout_plan",
    runId: input.runId,
    runAttempt: input.runAttempt,
    baseHead: input.head,
    repositories,
  };
}

/** The binding every delta of this plan must carry. */
export async function repairFanoutBindingV1(
  plan: RepairFanoutPlanV1,
): Promise<RepairDeltaBindingV1> {
  return {
    runId: plan.runId,
    runAttempt: plan.runAttempt,
    planDigest: await canonicalDigestV1(plan),
  };
}

/** The `strategy.matrix` value of the repository cells (empty: no cell). */
export function repairFanoutMatrixV1(
  plan: RepairFanoutPlanV1,
): RepairFanoutMatrixV1 {
  return {
    include: plan.repositories.map((repository) => ({
      repository: `${repository.owner}/${repository.name}`,
      installationId: repository.installationId,
    })),
  };
}
