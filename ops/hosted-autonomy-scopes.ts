import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  HOSTED_AUTONOMY_BASE_BRANCH,
  hostedRepositoryKey,
  isHostedSelf,
} from "./hosted-autonomy-policy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
} from "./hosted-autonomy-types.ts";
import type { HostedDeliveryProof } from "./hosted-autonomy-delivery-proof.ts";

export interface HostedAutonomyScopeV1 {
  readonly repository: RepositoryIdentityV1;
  readonly key: string;
  readonly surface: HostedAutonomyGitHubV1 | null;
  readonly baseBranch: string | null;
}

/** Cache repository surfaces for one pass without borrowing another scope. */
export function createHostedAutonomyScopes(deps: HostedAutonomyDepsV1) {
  const scopes = new Map<string, Promise<HostedAutonomyScopeV1>>();
  const scopeFor = (
    repository: RepositoryIdentityV1,
  ): Promise<HostedAutonomyScopeV1> => {
    const key = hostedRepositoryKey(repository);
    const cached = scopes.get(key);
    if (cached !== undefined) return cached;
    const resolved = (async (): Promise<HostedAutonomyScopeV1> => {
      let surface: HostedAutonomyGitHubV1 | null = null;
      try {
        surface = deps.githubFor(repository);
      } catch {
        surface = null;
      }
      if (surface === null) {
        return { repository, key, surface: null, baseBranch: null };
      }
      if (isHostedSelf(repository)) {
        return {
          repository,
          key,
          surface,
          baseBranch: HOSTED_AUTONOMY_BASE_BRANCH,
        };
      }
      let baseBranch: string | null = null;
      try {
        baseBranch = await surface.readDefaultBranch();
      } catch {
        baseBranch = null;
      }
      return { repository, key, surface, baseBranch };
    })();
    scopes.set(key, resolved);
    return resolved;
  };
  const readTip = async (
    scope: HostedAutonomyScopeV1,
  ): Promise<string | null> => {
    const surface = scope.surface;
    const branch = scope.baseBranch;
    if (surface === null || branch === null) return null;
    try {
      return await surface.readBaseTip(branch);
    } catch {
      return null;
    }
  };
  const readPull = async (
    scope: HostedAutonomyScopeV1,
    number: number,
  ): Promise<HostedAutonomyPullV1 | null> => {
    const surface = scope.surface;
    if (surface === null) return null;
    try {
      return await surface.readPull(number, scope.baseBranch);
    } catch {
      return null;
    }
  };
  return { scopeFor, readTip, readPull };
}

/**
 * Shared pass facts; only verified retirement advances the snapshot and CAS
 * head within a phase. The runner rebuilds them on the fresh head before a
 * phase that follows another phase's write.
 */
export interface HostedAutonomyPassContextV1 {
  deps: HostedAutonomyDepsV1;
  /** Existing maintenance cutoff; absent for standalone callers. */
  deadlineAt?: number;
  passStartedAt?: number;
  actions: string[];
  revisions: string[];
  snapshot: RepairStateSnapshotV1;
  observedHead: string;
  initialHead: string;
  releaseSnapshot: ReleaseStateSnapshotV1;
  closedIssues: Set<string>;
  foreignMerged: Map<string, HostedDeliveryProof>;
  /** Reservations the dedicated matrix recoveries own (never disposed here). */
  dedicatedReservations: ReadonlySet<string>;
  /**
   * Work ids an earlier write of this same pass touched: a later phase leaves
   * them to the next pass (hosted-autonomy-continuation.ts). Absent or empty
   * before the pass's first write.
   */
  settled?: ReadonlySet<string>;
  scopeFor: ReturnType<typeof createHostedAutonomyScopes>["scopeFor"];
  readTip: ReturnType<typeof createHostedAutonomyScopes>["readTip"];
  readPull: ReturnType<typeof createHostedAutonomyScopes>["readPull"];
}

/** Admission only: an already-started operation still settles before return. */
export function hostedPassDeadlineReached(
  context: HostedAutonomyPassContextV1,
): boolean {
  if (context.deadlineAt === undefined) return false;
  try {
    const now = context.deps.clock.now();
    return !Number.isSafeInteger(context.deadlineAt) ||
      !Number.isSafeInteger(now) ||
      (context.passStartedAt !== undefined &&
        (!Number.isSafeInteger(context.passStartedAt) ||
          now < context.passStartedAt)) ||
      now > context.deadlineAt;
  } catch {
    return true;
  }
}
