/**
 * Automatic backup CI enrolment (2026-11-17; owner: "regarding actions
 * minutes it should be able to fallback to its own org i thought").
 *
 * A row of `sentinel.backup-ci-targets.json` may carry `id: null`: the
 * trusted pass then resolves the repository id from the target's own
 * repository read (the target read token it already holds) and binds it to
 * the store's calibration file, the record that a runner agreed with that
 * repository's native CI. A calibration file that names another id (the slug
 * now names a different repository) refuses the target, exactly as a
 * committed id that disagrees does. Nothing here is written: the calibration
 * file is created by the existing comparison ingest, with the resolved id.
 * Only closed codes are logged.
 */
import {
  backupCiCalibrationPath,
  type BackupCiCalibrationV1,
  type BackupCiSuspensionV1,
  type BackupCiTargetV1,
  parseBackupCiCalibration,
  parseBackupCiSuspension,
} from "../src/contracts/backup-ci.ts";
import {
  BACKUP_CI_TRUST_FILE_RE,
  backupCiExcludedRunners,
  type BackupCiExcludedRunnersV1,
} from "../src/contracts/backup-ci-trust.ts";
import type { BackupCiTargetReadsV1 } from "./backup-ci-plan-reads.ts";

/**
 * The runners a false green excludes everywhere, from every suspension and
 * calibration file of the store (local reads only). Throws on an unreadable
 * or invalid file: the caller then plans nothing.
 */
export async function readBackupCiExclusion(store: {
  read(path: string): Promise<unknown | null>;
  pathsContaining(fixed: string, prefix: string): Promise<string[]>;
}): Promise<BackupCiExcludedRunnersV1> {
  const suspensions: BackupCiSuspensionV1[] = [];
  const calibrations: BackupCiCalibrationV1[] = [];
  const kinds = [
    ["sentinel_backup_ci_suspension", suspensions, parseBackupCiSuspension],
    ["sentinel_backup_ci_calibration", calibrations, parseBackupCiCalibration],
  ] as const;
  for (const [kind, out, parse] of kinds) {
    for (
      const path of await store.pathsContaining(`"kind":"${kind}"`, "v1/")
    ) {
      if (!BACKUP_CI_TRUST_FILE_RE.test(path)) continue;
      const value = await store.read(path);
      if (value !== null) (out as unknown[]).push(parse(value as never));
    }
  }
  return backupCiExcludedRunners(suspensions, calibrations);
}

/** A target whose repository id is known for this pass. */
export type BackupCiResolvedTargetV1 = BackupCiTargetV1 & { id: number };

export interface BackupCiEnrolDepsV1 {
  targets: readonly BackupCiTargetV1[];
  store: { read(path: string): Promise<unknown | null> };
  targetReads(owner: string, name: string): BackupCiTargetReadsV1;
  log(line: string): void;
}

/**
 * Every target with its id: a committed id as is; an enrolled row's id from
 * the target's repository read, refused when unreadable or when the store's
 * calibration file pinned another id. One target's failure skips only it.
 */
export async function resolveBackupCiTargets(
  deps: BackupCiEnrolDepsV1,
): Promise<BackupCiResolvedTargetV1[]> {
  const out: BackupCiResolvedTargetV1[] = [];
  for (const target of deps.targets) {
    if (target.id !== null) {
      out.push({ ...target, id: target.id });
      continue;
    }
    const [owner, name] = target.repository.split("/");
    try {
      const info = await deps.targetReads(owner, name).repository();
      if (info === null) {
        deps.log(`backup-ci:${target.repository}:enrol:repository_unavailable`);
        continue;
      }
      const value = await deps.store.read(backupCiCalibrationPath(owner, name));
      const pinned = value === null
        ? null
        : parseBackupCiCalibration(value).repository;
      if (
        pinned !== null &&
        (pinned.id !== info.id || pinned.owner !== owner ||
          pinned.name !== name)
      ) {
        deps.log(`backup-ci:${target.repository}:unsupported:repository_id`);
        continue;
      }
      out.push({ repository: target.repository, id: info.id });
    } catch {
      deps.log(`backup-ci:${target.repository}:enrol:refused`);
    }
  }
  return out;
}
