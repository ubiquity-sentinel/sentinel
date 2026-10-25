/**
 * The `commit` step of `backup_ci` (docs/backup-ci-spec.md §9.5): apply one
 * pass's changes in one store CAS commit and dispatch its legs.
 *
 * 1. `pass.json` must hash to the digest the `pass` step reported.
 * 2. The legs ref is fast-forwarded to the launcher SHA (`force: false`, so
 *    only a descendant is accepted, and the native token is refused for a
 *    range that changes workflow files). A refused or diverged ref records
 *    `legs_ref_behind` for every new unit and dispatches nothing.
 * 3. One store commit holds the ingest results, coverage, calibration and
 *    suspensions, plus a `dispatched` entry per unit with its tree artifact.
 * 4. One `workflow_dispatch` per unit at `sentinel-backup-legs`; a failed
 *    dispatch shows up in the next pass as `leg_missing`.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  BACKUP_CI_LEG_WORKFLOW_PATH,
  BACKUP_CI_LEGS_REF,
  backupCiCalibrationPath,
  type BackupCiCalibrationV1,
  type BackupCiCommitFileV1,
  backupCiCommitPath,
  type BackupCiDispatchedEntryV1,
  backupCiSuspensionPath,
  type BackupCiSuspensionV1,
  parseBackupCiCalibration,
  parseBackupCiCommitFile,
  parseBackupCiSuspension,
  parseBackupCiUnit,
} from "../src/contracts/backup-ci.ts";
import {
  type BackupCiNoEvidenceEventV1,
  mergeBackupCiFile,
  mergeCalibration,
  mergeSuspension,
} from "../src/github/backup-ci-store.ts";
import type { BackupCiPassFileV1 } from "./backup-ci-pass.ts";
import type { BackupCiApiV1 } from "./backup-ci-plan-reads.ts";
import { backupCiBytesDigest } from "../src/contracts/backup-ci.ts";
import type {
  BackupCiStoreChangesV1,
  BackupCiStoreView,
  BackupCiStoreWriteV1,
} from "./backup-ci-store-writer.ts";

const LEGS_BRANCH = BACKUP_CI_LEGS_REF.slice("refs/heads/".length);
const LEG_WORKFLOW = BACKUP_CI_LEG_WORKFLOW_PATH.slice(
  BACKUP_CI_LEG_WORKFLOW_PATH.lastIndexOf("/") + 1,
);

export interface BackupCiCommitDepsV1 {
  passBytes: Uint8Array;
  expectedDigest: string;
  /** Tree artifact ids by slot (`SENTINEL_BACKUP_TREE<k>`). */
  trees: readonly (string | undefined)[];
  githubSha: GitSha;
  runId: number;
  now(): number;
  /** Sentinel repository REST (native token). */
  api: BackupCiApiV1;
  repository: string;
  writeStore(
    mutate: (view: BackupCiStoreView) => Promise<BackupCiStoreChangesV1>,
  ): Promise<BackupCiStoreWriteV1>;
  log(line: string): void;
}

export interface BackupCiCommitResultV1 {
  code: number;
  counts: Record<string, number>;
}

/** Fast-forwards the legs ref to `sha`; false when refused or diverged. */
export async function advanceBackupCiLegs(
  api: BackupCiApiV1,
  repository: string,
  sha: GitSha,
): Promise<boolean> {
  const ref = await api.get(
    `/repos/${repository}/git/ref/heads/${LEGS_BRANCH}`,
  );
  const current = (ref as { object?: { sha?: unknown } } | null)?.object?.sha;
  if (typeof current !== "string" || !/^[0-9a-f]{40}$/.test(current)) {
    return false;
  }
  if (current === sha) return true;
  const compare = await api.get(
    `/repos/${repository}/compare/${current}...${sha}?per_page=1`,
    8 * 2 ** 20,
  ) as { status?: unknown; behind_by?: unknown } | null;
  if (compare?.status !== "ahead" || compare.behind_by !== 0) return false;
  const moved = await api.send(
    "PATCH",
    `/repos/${repository}/git/refs/heads/${LEGS_BRANCH}`,
    { sha, force: false },
  );
  return moved !== null && moved.status === 200;
}

async function current<T>(
  view: BackupCiStoreView,
  path: string,
  parse: (value: unknown) => T,
): Promise<T | null> {
  const value = await view.read(path);
  return value === null ? null : parse(value);
}

/** The store changes of a pass against the tip in `view` (pure in `view`). */
export async function backupCiStoreChanges(
  pass: BackupCiPassFileV1,
  dispatched: readonly {
    repository: BackupCiPassFileV1["files"][number]["repository"];
    entry: BackupCiDispatchedEntryV1;
  }[],
  refused: readonly {
    repository: BackupCiPassFileV1["files"][number]["repository"];
    commit: GitSha;
    event: BackupCiNoEvidenceEventV1;
  }[],
  view: BackupCiStoreView,
  now: number,
  log: (line: string) => void,
): Promise<BackupCiStoreChangesV1> {
  const changes: BackupCiStoreChangesV1 = new Map();
  const files = new Map<string, {
    repository: BackupCiPassFileV1["files"][number]["repository"];
    commit: GitSha;
    coverage: BackupCiPassFileV1["files"][number]["coverage"];
    results: BackupCiPassFileV1["files"][number]["results"];
    noEvidence: BackupCiNoEvidenceEventV1[];
    dispatched: BackupCiDispatchedEntryV1[];
  }>();
  const of = (
    repository: typeof dispatched[number]["repository"],
    commit: GitSha,
  ) => {
    const path = backupCiCommitPath(repository.owner, repository.name, commit);
    let row = files.get(path);
    if (row === undefined) {
      row = {
        repository,
        commit,
        coverage: [],
        results: [],
        noEvidence: [],
        dispatched: [],
      };
      files.set(path, row);
    }
    return row;
  };
  for (const file of pass.files) {
    const row = of(file.repository, file.commit);
    row.coverage.push(...file.coverage);
    row.results.push(...file.results);
    row.noEvidence.push(...file.noEvidence);
  }
  for (const d of dispatched) {
    of(d.repository, d.entry.unit.commit).dispatched.push(d.entry);
  }
  for (const r of refused) of(r.repository, r.commit).noEvidence.push(r.event);
  for (const [path, row] of files) {
    const existing = await current(view, path, parseBackupCiCommitFile);
    const merged = mergeBackupCiFile(existing as BackupCiCommitFileV1 | null, {
      repository: row.repository,
      commit: row.commit,
      now,
      coverage: row.coverage,
      results: row.results,
      noEvidence: row.noEvidence,
      dispatched: row.dispatched,
    });
    merged.log.forEach(log);
    changes.set(path, merged.file);
  }
  for (const { repository, comparisons } of pass.comparisons) {
    const path = backupCiCalibrationPath(repository.owner, repository.name);
    const existing = await current(view, path, parseBackupCiCalibration);
    const merged = mergeCalibration(
      existing as BackupCiCalibrationV1 | null,
      repository,
      comparisons,
      now,
    );
    changes.set(path, merged.calibration);
    if (merged.disagreements.length === 0) continue;
    const scope = `${repository.owner}/${repository.name}` as const;
    const suspensionPath = backupCiSuspensionPath(
      repository.owner,
      repository.name,
    );
    let suspension = await current(
      view,
      suspensionPath,
      parseBackupCiSuspension,
    ) as
      | BackupCiSuspensionV1
      | null;
    for (const disagreement of merged.disagreements) {
      const { comparison } = disagreement;
      suspension = mergeSuspension(suspension, {
        scope,
        runnerIds: [comparison.runnerId],
        reason: disagreement.kind,
        since: now,
        evidence: {
          commit: comparison.sample.commit,
          checkName: comparison.sample.checkName,
          nativeCheckRunId: comparison.nativeCheckRunId,
          receipt: comparison.receipt,
        },
      });
      log(`sentinel_backup_ci_suspension ${
        JSON.stringify({
          scope,
          runnerId: comparison.runnerId,
          reason: disagreement.kind,
        })
      }`);
    }
    changes.set(suspensionPath, suspension);
  }
  return changes;
}

/** The `commit` step. */
export async function commitBackupCiPass(
  deps: BackupCiCommitDepsV1,
): Promise<BackupCiCommitResultV1> {
  const counts: Record<string, number> = {};
  const count = (key: string) => counts[key] = (counts[key] ?? 0) + 1;
  if (backupCiBytesDigest(deps.passBytes) !== deps.expectedDigest) {
    deps.log("backup-ci:commit:pass_digest_mismatch");
    return { code: 1, counts };
  }
  const pass = JSON.parse(
    new TextDecoder().decode(deps.passBytes),
  ) as BackupCiPassFileV1;
  if (
    pass.kind !== "sentinel_backup_ci_pass" || pass.runId !== deps.runId ||
    pass.launcherSha !== deps.githubSha
  ) {
    deps.log("backup-ci:commit:pass_binding_mismatch");
    return { code: 1, counts };
  }
  const now = deps.now();
  const legsReady = pass.units.length === 0 ||
    await advanceBackupCiLegs(deps.api, deps.repository, deps.githubSha);
  if (!legsReady) deps.log("backup-ci:legs_ref_needs_manual_advance");
  const dispatched: {
    repository: BackupCiPassFileV1["units"][number]["repository"];
    entry: BackupCiDispatchedEntryV1;
  }[] = [];
  const refused: {
    repository: BackupCiPassFileV1["units"][number]["repository"];
    commit: GitSha;
    event: BackupCiNoEvidenceEventV1;
  }[] = [];
  for (const planned of pass.units) {
    const unit = parseBackupCiUnit(planned.unit);
    const artifact = Number(deps.trees[planned.slot] ?? "");
    const reason = !legsReady
      ? "legs_ref_behind" as const
      : !Number.isSafeInteger(artifact) || artifact <= 0
      ? "dispatch_failed" as const
      : null;
    if (reason !== null) {
      count(reason);
      refused.push({
        repository: planned.repository,
        commit: unit.commit,
        event: {
          key: unit.key,
          mode: unit.plan.mode === "on" ? "evidence" : "shadow",
          runnerId: unit.plan.runnerId,
          reason,
          at: now,
          unitDigest: null,
        },
      });
      continue;
    }
    dispatched.push({
      repository: planned.repository,
      entry: {
        state: "dispatched",
        key: unit.key,
        mode: unit.plan.mode,
        runnerId: unit.plan.runnerId,
        unit,
        unitDigest: planned.unitDigest,
        tree: { artifactId: artifact, sha256: planned.treeSha256 },
        dispatchedAt: now,
      },
    });
  }
  for (const file of pass.files) {
    for (const r of file.results) count(`result:${r.conclusion}`);
    for (const e of file.noEvidence) count(e.reason);
  }
  const written = await deps.writeStore((view) =>
    backupCiStoreChanges(pass, dispatched, refused, view, now, deps.log)
  );
  if (written.kind === "failed") {
    deps.log(
      `backup-ci:commit:store_failed:${written.detail.replace(/[^a-z ]/g, "")}`,
    );
    return { code: 1, counts };
  }
  for (const { entry } of dispatched) {
    const sent = await deps.api.send(
      "POST",
      `/repos/${deps.repository}/actions/workflows/${LEG_WORKFLOW}/dispatches`,
      {
        ref: LEGS_BRANCH,
        inputs: {
          unit: entry.unit.unitId,
          unit_digest: entry.unitDigest,
          plan_run: String(deps.runId),
          tree_artifact: String(entry.tree.artifactId),
          tree_sha256: entry.tree.sha256,
          runs_on: entry.unit.job.runsOn,
          job_minutes: String(entry.unit.job.capMinutes + 10),
        },
      },
    );
    count(
      sent !== null && sent.status === 204 ? "dispatched" : "dispatch_failed",
    );
  }
  return { code: 0, counts };
}
