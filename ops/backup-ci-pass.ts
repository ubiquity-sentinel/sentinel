/**
 * The trusted pass of `backup_ci` (docs/backup-ci-spec.md §9.2-§9.4):
 * ingest finished legs, then plan at most `free` new units fairly across
 * targets, materialize and tar them. Nothing is written here: the pass's
 * changes and units go to `pass.json`, and the `commit` step
 * (`backup-ci-dispatch.ts`) applies them in one store CAS commit and
 * dispatches the legs. Only hex, enum and integer values are logged.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  BACKUP_CI_MAX_COMMITS_READ_PER_TARGET,
  backupCiCalibrationPath,
  type BackupCiCommitFileV1,
  backupCiCommitPath,
  type BackupCiEntryKeyV1,
  type BackupCiNoEvidenceReasonV1,
  type BackupCiResultEntryV1,
  type BackupCiTargetV1,
  backupCiUnitDigest,
  type BackupCiUnitV1,
  type BackupCiWorkflowCoverageV1,
  isBackupCiCalibrated,
  parseBackupCiCalibration,
  parseBackupCiCommitFile,
  parseBackupCiUnit,
} from "../src/contracts/backup-ci.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  type BackupCiComparisonV1,
  type BackupCiNoEvidenceEventV1,
  mergeBackupCiFile,
} from "../src/github/backup-ci-store.ts";
import type { BackupCiActionSourceV1 } from "./backup-ci-actions.ts";
import {
  type BackupCiIngestDepsV1,
  type BackupCiIngestItemV1,
  ingestBackupCi,
} from "./backup-ci-ingest.ts";
import type { BackupCiLegReadsV1 } from "./backup-ci-ingest-reads.ts";
import {
  type BackupCiBareRepo,
  packBackupCiBare,
} from "./backup-ci-materialize.ts";
import {
  backupCiCandidates,
  backupCiFairSelect,
  backupCiFreeSlots,
  backupCiRecords,
} from "./backup-ci-plan.ts";
import type { BackupCiTargetReadsV1 } from "./backup-ci-plan-reads.ts";
import {
  type BackupCiPlannedUnitV1,
  planBackupCiCommit,
} from "./backup-ci-pass-commit.ts";

type Repo = { owner: string; name: string; id: number };

/** One commit file's changes, as `mergeBackupCiFile` takes them. */
export interface BackupCiPassFileChangesV1 {
  repository: Repo;
  commit: GitSha;
  coverage: BackupCiWorkflowCoverageV1[];
  results: BackupCiResultEntryV1[];
  noEvidence: BackupCiNoEvidenceEventV1[];
}
export interface BackupCiPassUnitV1 {
  slot: number;
  repository: Repo;
  unit: BackupCiUnitV1;
  unitDigest: string;
  treeSha256: string;
}
/** `$RUNNER_TEMP/backup-ci/pass.json`. */
export interface BackupCiPassFileV1 {
  version: 1;
  kind: "sentinel_backup_ci_pass";
  runId: number;
  launcherSha: GitSha;
  mode: "shadow" | "on";
  runnerId: string | null;
  createdAt: number;
  files: BackupCiPassFileChangesV1[];
  comparisons: { repository: Repo; comparisons: BackupCiComparisonV1[] }[];
  units: BackupCiPassUnitV1[];
}

/** What the pass reads the store through (a `BackupCiStoreView`). */
export interface BackupCiStoreReadV1 {
  read(path: string): Promise<unknown | null>;
  pathsContaining(fixed: string, prefix: string): Promise<string[]>;
}

export interface BackupCiPassDepsV1 {
  runId: number;
  launcherSha: GitSha;
  mode: "shadow" | "on";
  /** null: the act pin is not filled; ingest only, nothing is planned. */
  runnerId: string | null;
  now(): number;
  targets: readonly BackupCiTargetV1[];
  calibrationCommits(repository: string): readonly GitSha[];
  snapshot: RepairStateSnapshotV1 | null;
  store: BackupCiStoreReadV1;
  legs: BackupCiLegReadsV1;
  sentinelId: number;
  targetReads(owner: string, name: string): BackupCiTargetReadsV1;
  /** A fresh bare repository of `commits` at `dir`, or null. */
  materialize(
    owner: string,
    name: string,
    commits: readonly GitSha[],
    dir: string,
  ): Promise<BackupCiBareRepo | null>;
  actionSource(local: BackupCiActionSourceV1["local"]): BackupCiActionSourceV1;
  /** `$RUNNER_TEMP/backup-ci`. */
  workDir: string;
  tokenNeedles: readonly string[];
  log(line: string): void;
  sleep(ms: number): Promise<void>;
}

/** Accumulates per-commit changes of the pass. */
export class BackupCiPassChanges {
  readonly files = new Map<string, BackupCiPassFileChangesV1>();
  readonly comparisons = new Map<
    string,
    { repository: Repo; comparisons: BackupCiComparisonV1[] }
  >();

  of(repository: Repo, commit: GitSha): BackupCiPassFileChangesV1 {
    const id = `${repository.owner}/${repository.name}@${commit}`;
    let file = this.files.get(id);
    if (file === undefined) {
      file = { repository, commit, coverage: [], results: [], noEvidence: [] };
      this.files.set(id, file);
    }
    return file;
  }

  refuse(
    repository: Repo,
    commit: GitSha,
    key: BackupCiEntryKeyV1,
    mode: "shadow" | "on",
    runnerId: string,
    reason: BackupCiNoEvidenceReasonV1,
    at: number,
  ): void {
    this.of(repository, commit).noEvidence.push({
      key,
      mode: mode === "on" ? "evidence" : "shadow",
      runnerId,
      reason,
      at,
      unitDigest: null,
    });
  }

  compare(repository: Repo, comparison: BackupCiComparisonV1): void {
    const id = `${repository.owner}/${repository.name}`;
    const row = this.comparisons.get(id) ?? { repository, comparisons: [] };
    row.comparisons.push(comparison);
    this.comparisons.set(id, row);
  }
}

function repoOf(target: BackupCiTargetV1): Repo {
  const [owner, name] = target.repository.split("/");
  return { owner, name, id: target.id };
}

/** Reads one store commit file, bound to its target and commit. */
async function readFile(
  store: BackupCiStoreReadV1,
  repo: Repo,
  commit: GitSha,
): Promise<BackupCiCommitFileV1 | null> {
  const value = await store.read(
    backupCiCommitPath(repo.owner, repo.name, commit),
  );
  if (value === null) return null;
  const file = parseBackupCiCommitFile(value);
  if (
    file.repository.owner !== repo.owner ||
    file.repository.name !== repo.name ||
    file.repository.id !== repo.id || file.commit !== commit
  ) throw new Error("backup CI store file does not bind its path");
  return file;
}

async function ingest(
  deps: BackupCiPassDepsV1,
  changes: BackupCiPassChanges,
): Promise<void> {
  const items: BackupCiIngestItemV1[] = [];
  for (const target of deps.targets) {
    const repo = repoOf(target);
    try {
      const paths = await deps.store.pathsContaining(
        '"state":"dispatched"',
        `v1/${repo.owner}/${repo.name}/`,
      );
      for (const path of paths) {
        const match = /\/([0-9a-f]{40})\.json$/.exec(path);
        if (match === null) continue;
        const file = await readFile(deps.store, repo, match[1] as GitSha);
        for (const entry of file?.entries ?? []) {
          if (entry.state === "dispatched") {
            items.push({ repository: repo, commit: file!.commit, entry });
          }
        }
      }
    } catch {
      // An unreadable store file stops this target's ingest only.
      deps.log(`backup-ci:${target.repository}:ingest_refused`);
    }
  }
  const ingestDeps: BackupCiIngestDepsV1 = {
    legs: deps.legs,
    sentinelId: deps.sentinelId,
    targetReads: (owner, name) => deps.targetReads(owner, name),
    now: deps.now,
    sleep: deps.sleep,
    log: deps.log,
  };
  for (const { item, outcome } of await ingestBackupCi(ingestDeps, items)) {
    if (outcome.kind === "pending") continue;
    const file = changes.of(item.repository, item.commit);
    if (outcome.kind === "result") {
      file.results.push(outcome.entry);
      if (outcome.comparison !== null) {
        changes.compare(item.repository, outcome.comparison);
      }
      deps.log(
        `backup-ci:ingest:${item.entry.unit.unitId}:${outcome.entry.conclusion}`,
      );
    } else {
      file.noEvidence.push(outcome.event);
      deps.log(
        `backup-ci:ingest:${item.entry.unit.unitId}:no_evidence:${outcome.event.reason}`,
      );
    }
  }
}

/** The units one target could start this pass, in priority order. */
async function planTarget(
  deps: BackupCiPassDepsV1,
  target: BackupCiTargetV1,
  changes: BackupCiPassChanges,
  want: number,
): Promise<BackupCiPlannedUnitV1[]> {
  const repo = repoOf(target);
  const runnerId = deps.runnerId!;
  const reads = deps.targetReads(repo.owner, repo.name);
  const info = await reads.repository();
  if (info === null) {
    deps.log(`backup-ci:${target.repository}:repository_unavailable`);
    return [];
  }
  if (info.id !== target.id) {
    deps.log(`backup-ci:${target.repository}:unsupported:repository_id`);
    return [];
  }
  const records = backupCiRecords(deps.snapshot!, target.repository);
  const baseTip = await reads.branchTip(info.defaultBranch);
  const commits = new Set<GitSha>([
    ...(baseTip === null ? [] : [baseTip]),
    ...records.flatMap((r) => [r.target.head!, r.target.base]),
    ...deps.calibrationCommits(target.repository),
  ]);
  const files = new Map<string, BackupCiCommitFileV1 | null>();
  for (const commit of commits) {
    let file = await readFile(deps.store, repo, commit);
    const pending = changes.files.get(`${repo.owner}/${repo.name}@${commit}`);
    if (pending !== undefined) {
      file = mergeBackupCiFile(file, { ...pending, now: deps.now() }).file;
    }
    files.set(commit, file);
  }
  const calibrationValue = await deps.store.read(
    backupCiCalibrationPath(repo.owner, repo.name),
  );
  const calibration = calibrationValue === null
    ? null
    : parseBackupCiCalibration(calibrationValue);
  const candidates = backupCiCandidates({
    records,
    baseTip,
    defaultBranch: info.defaultBranch,
    calibrationCommits: deps.calibrationCommits(target.repository),
    calibrated: isBackupCiCalibrated(calibration, runnerId),
    files,
    mode: deps.mode,
    runnerId,
    runId: deps.runId,
  });
  const out: BackupCiPlannedUnitV1[] = [];
  let read = 0;
  for (const candidate of candidates) {
    if (read >= BACKUP_CI_MAX_COMMITS_READ_PER_TARGET || out.length >= want) {
      break;
    }
    read++;
    try {
      out.push(
        ...await planBackupCiCommit({
          deps,
          repo,
          info,
          reads,
          candidate,
          file: files.get(candidate.commit) ?? null,
          files,
          changes,
        }),
      );
    } catch {
      deps.log(
        `backup-ci:${target.repository}@${
          candidate.commit.slice(0, 12)
        }:plan_error`,
      );
    }
  }
  return out;
}

/** The whole pass; trees[k] is slot k's tar (`<workDir>/trees/<k>.tar`). */
export async function runBackupCiPass(
  deps: BackupCiPassDepsV1,
): Promise<BackupCiPassFileV1> {
  const changes = new BackupCiPassChanges();
  await ingest(deps, changes);
  const units: BackupCiPassUnitV1[] = [];
  if (deps.runnerId === null || deps.snapshot === null) {
    deps.log("backup-ci:plan:skipped");
  } else {
    const [inflight, cells] = await Promise.all([
      deps.legs.inflight(),
      deps.legs.cellsActive(),
    ]);
    const { p, free } = inflight === null || cells === null
      ? { p: 0, free: 0 }
      : backupCiFreeSlots(inflight, cells);
    deps.log(`backup-ci:plan:p=${p}:free=${free}`);
    if (free > 0) {
      const perTarget = new Map<string, BackupCiPlannedUnitV1[]>();
      for (
        const target of [...deps.targets].sort((a, b) =>
          a.repository < b.repository ? -1 : 1
        )
      ) {
        // One target's unreadable store file or read failure plans nothing
        // for that target only.
        const units = await planTarget(deps, target, changes, 2 * free)
          .catch(() => {
            deps.log(`backup-ci:${target.repository}:plan_refused`);
            return [];
          });
        perTarget.set(target.repository, units);
      }
      const selected = backupCiFairSelect(perTarget, deps.runId, free, p);
      await Deno.mkdir(`${deps.workDir}/trees`, { recursive: true });
      for (const planned of selected) {
        const slot = units.length;
        const ok = await planned.bare.setExec(planned.unit.exec.commit);
        if (!ok) continue;
        await planned.bare.writeUnit(planned.unit);
        const packed = await packBackupCiBare(
          planned.bare,
          `${deps.workDir}/trees/${slot}.tar`,
          deps.tokenNeedles,
        );
        if (!packed.ok) {
          deps.log(`backup-ci:pack:${planned.unit.unitId}:${packed.reason}`);
          if (packed.reason === "tree_too_large") {
            changes.refuse(
              planned.repository,
              planned.unit.commit,
              planned.unit.key,
              deps.mode,
              deps.runnerId,
              "unsupported:tree_too_large",
              deps.now(),
            );
          }
          continue;
        }
        units.push({
          slot,
          repository: planned.repository,
          unit: parseBackupCiUnit(JSON.parse(JSON.stringify(planned.unit))),
          unitDigest: backupCiUnitDigest(planned.unit),
          treeSha256: packed.sha256,
        });
        deps.log(`backup-ci:plan:${planned.unit.unitId}:slot=${slot}`);
      }
    }
  }
  return {
    version: 1,
    kind: "sentinel_backup_ci_pass",
    runId: deps.runId,
    launcherSha: deps.launcherSha,
    mode: deps.mode,
    runnerId: deps.runnerId,
    createdAt: deps.now(),
    files: [...changes.files.values()].filter((f) =>
      f.coverage.length + f.results.length + f.noEvidence.length > 0
    ),
    comparisons: [...changes.comparisons.values()],
    units,
  };
}
