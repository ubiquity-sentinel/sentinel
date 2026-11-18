/**
 * A fake world for `runBackupCiPass`: an in-memory store (with the canonical
 * fixed-string grep the real store view offers), fake leg reads, and per
 * target fake reads that count every call. Nothing touches a network.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import type { BackupCiTargetV1 } from "../../src/contracts/backup-ci.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { BackupCiPassDepsV1 } from "../../ops/backup-ci-pass.ts";
import type { BackupCiTargetReadsV1 } from "../../ops/backup-ci-plan-reads.ts";
import { RUNNER, T0 } from "../github/backup-ci-fixtures.ts";

export const sha = (n: number) => n.toString(16).padStart(40, "0") as GitSha;

export interface PassWorld {
  store: Map<string, unknown>;
  calls: Map<string, number>;
  lines: string[];
  /** Overrides of one target's reads (`owner/name`). */
  reads: Map<string, Partial<BackupCiTargetReadsV1>>;
  /** Repository answers by `owner/name` (default: public, id by order). */
  repos: Map<string, { id: number; private?: boolean; fullName?: string }>;
  inflight: number;
}

export function passWorld(): PassWorld {
  return {
    store: new Map(),
    calls: new Map(),
    lines: [],
    reads: new Map(),
    repos: new Map(),
    inflight: 0,
  };
}

const EMPTY_SNAPSHOT = {
  work: [],
  reservations: [],
  reviews: [],
  releaseRequests: [],
} as unknown as RepairStateSnapshotV1;

export function passDeps(
  world: PassWorld,
  targets: readonly BackupCiTargetV1[],
  over: Partial<BackupCiPassDepsV1> = {},
): BackupCiPassDepsV1 {
  const count = (k: string) =>
    world.calls.set(k, (world.calls.get(k) ?? 0) + 1);
  let next = 5000;
  const reads = (owner: string, name: string): BackupCiTargetReadsV1 => {
    const slug = `${owner}/${name}`;
    const repo = world.repos.get(slug) ?? { id: ++next };
    world.repos.set(slug, repo);
    const base: BackupCiTargetReadsV1 = {
      repository: () => {
        count(`repository:${slug}`);
        return Promise.resolve({
          id: repo.id,
          defaultBranch: "main",
          private: repo.private ?? false,
          fullName: repo.fullName ?? slug,
        });
      },
      branchTip: () => {
        count(`branchTip:${slug}`);
        return Promise.resolve(sha(0xabc));
      },
      checkRuns: () => {
        count(`checkRuns:${slug}`);
        return Promise.resolve([]);
      },
      suites: () => {
        count(`suites:${slug}`);
        return Promise.resolve([]);
      },
      statusContexts: () => {
        count(`statuses:${slug}`);
        return Promise.resolve(new Set<string>());
      },
      job: () => {
        count(`job:${slug}`);
        return Promise.resolve(null);
      },
      annotations: () => Promise.resolve([]),
      pull: () => Promise.resolve(null),
      compare: () => Promise.resolve(null),
      pullMerge: () => Promise.resolve("absent" as const),
    };
    return { ...base, ...(world.reads.get(slug) ?? {}) };
  };
  return {
    runId: 4000,
    launcherSha: "e".repeat(40) as GitSha,
    mode: "on",
    runnerId: RUNNER,
    now: () => T0,
    targets,
    calibrationCommits: () => [],
    snapshot: EMPTY_SNAPSHOT,
    store: {
      read: (path) => Promise.resolve(world.store.get(path) ?? null),
      pathsContaining: (fixed, prefix) =>
        Promise.resolve(
          [...world.store.entries()].filter(([path, value]) =>
            path.startsWith(prefix) && JSON.stringify(value).includes(fixed)
          ).map(([path]) => path).sort(),
        ),
    },
    legs: {
      legRuns: () => {
        count("legRuns");
        return Promise.resolve([]);
      },
      attempt: () => Promise.resolve(null),
      jobs: () => Promise.resolve(null),
      log: () => Promise.resolve(null),
      artifact: () => Promise.resolve(null),
      artifactZip: () => Promise.resolve(null),
      cancel: () => Promise.resolve(false),
      inflight: () => Promise.resolve(world.inflight),
      cellsActive: () => Promise.resolve(false),
    },
    sentinelId: 1,
    targetReads: reads,
    materialize: () => Promise.resolve(null),
    actionSource: (local) => ({ local, remote: () => Promise.resolve(null) }),
    workDir: Deno.makeTempDirSync({ prefix: "backup-ci-pass-fakes-" }),
    tokenNeedles: [],
    log: (line) => world.lines.push(line),
    sleep: () => Promise.resolve(),
    ...over,
  };
}

/** Total target reads of the counted kinds (every target). */
export function targetReadCount(world: PassWorld): number {
  return [...world.calls.entries()].filter(([k]) => k.includes(":"))
    .reduce((n, [, v]) => n + v, 0);
}
