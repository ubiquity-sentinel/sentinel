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

/** Shared pass facts; only verified retirement advances the snapshot and CAS head. */
export interface HostedAutonomyPassContextV1 {
  deps: HostedAutonomyDepsV1;
  actions: string[];
  revisions: string[];
  snapshot: RepairStateSnapshotV1;
  observedHead: string;
  initialHead: string;
  releaseSnapshot: ReleaseStateSnapshotV1;
  closedIssues: Set<string>;
  foreignMerged: Map<string, unknown>;
  /** Reservations the dedicated matrix recoveries own (never disposed here). */
  dedicatedReservations: ReadonlySet<string>;
  scopeFor: ReturnType<typeof createHostedAutonomyScopes>["scopeFor"];
  readTip: ReturnType<typeof createHostedAutonomyScopes>["readTip"];
  readPull: ReturnType<typeof createHostedAutonomyScopes>["readPull"];
}
