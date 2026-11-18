/**
 * Automatic backup CI enrolment (2026-11-17; owner: "regarding actions
 * minutes it should be able to fallback to its own org i thought"), and who
 * the trusted pass may plan for.
 *
 * A row of `sentinel.backup-ci-targets.json` may carry `id: null`. Its id is
 * resolved ONCE, on the first pass that has stand-in demand for it, from the
 * target's own repository read, and only when that read returns exactly the
 * configured full name (a renamed or transferred repository answers through
 * a redirect under another name) and a public repository (backup legs
 * publish the target tree and logs in a public repository). No row is
 * exempt (owner decision 2026-11-18, "no private repos"): a committed id is
 * identity only, and every pass re-reads visibility before planning. The id is
 * then pinned in the store (`enrolment.json`, written by the commit step) and
 * every later pass, ingest included, takes it from there without a read. A
 * calibration or check file naming another id refuses the target. Only
 * closed codes are logged.
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
  backupCiCheckCalibrationPath,
  type BackupCiCheckCalibrationV1,
  backupCiEnrolmentPath,
  backupCiExcludedRunners,
  type BackupCiExcludedRunnersV1,
  parseBackupCiCheckCalibration,
  parseBackupCiEnrolment,
} from "../src/contracts/backup-ci-trust.ts";
import type { BackupCiTargetReadsV1 } from "./backup-ci-plan-reads.ts";

type StoreRead = { read(path: string): Promise<unknown | null> };

/**
 * The runners a false green excludes everywhere, from every suspension and
 * calibration file of the store (local reads only). Throws on an unreadable
 * or invalid file: the caller then plans nothing.
 */
export async function readBackupCiExclusion(
  store: StoreRead & {
    pathsContaining(fixed: string, prefix: string): Promise<string[]>;
  },
): Promise<BackupCiExcludedRunnersV1> {
  const suspensions: BackupCiSuspensionV1[] = [];
  const calibrations: BackupCiCalibrationV1[] = [];
  const checks: BackupCiCheckCalibrationV1[] = [];
  const kinds = [
    ["sentinel_backup_ci_suspension", suspensions, parseBackupCiSuspension],
    ["sentinel_backup_ci_calibration", calibrations, parseBackupCiCalibration],
    [
      "sentinel_backup_ci_check_calibration",
      checks,
      parseBackupCiCheckCalibration,
    ],
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
  return backupCiExcludedRunners(suspensions, calibrations, checks);
}

/** A target whose repository id is known for this pass. */
export type BackupCiResolvedTargetV1 = BackupCiTargetV1 & { id: number };

/**
 * Targets with a known id, from local store reads only: a committed id, or
 * an `id: null` row's pin. Unpinned rows have nothing to ingest (a unit is
 * dispatched in the same store commit that pins its target). A pin that
 * does not parse or names another repository skips that row only.
 */
export async function pinnedBackupCiTargets(
  store: StoreRead,
  targets: readonly BackupCiTargetV1[],
  log: (line: string) => void,
): Promise<{
  pinned: BackupCiResolvedTargetV1[];
  unpinned: BackupCiTargetV1[];
}> {
  const pinned: BackupCiResolvedTargetV1[] = [];
  const unpinned: BackupCiTargetV1[] = [];
  for (const target of targets) {
    if (target.id !== null) {
      pinned.push({ ...target, id: target.id });
      continue;
    }
    const [owner, name] = target.repository.split("/");
    try {
      const value = await store.read(backupCiEnrolmentPath(owner, name));
      if (value === null) {
        unpinned.push(target);
        continue;
      }
      const pin = parseBackupCiEnrolment(value).repository;
      if (pin.owner !== owner || pin.name !== name) {
        throw new Error("backup CI enrolment names another repository");
      }
      pinned.push({ repository: target.repository, id: pin.id });
    } catch {
      log(`backup-ci:${target.repository}:enrol:pin_invalid`);
    }
  }
  return { pinned, unpinned };
}

/**
 * The first enrolment of an unpinned row (called only with stand-in demand
 * and a free leg slot): the resolved target and the pin to write, or null
 * with a closed reason logged.
 */
export async function enrolBackupCiTarget(
  target: BackupCiTargetV1,
  reads: BackupCiTargetReadsV1,
  store: StoreRead,
  log: (line: string) => void,
): Promise<BackupCiResolvedTargetV1 | null> {
  const [owner, name] = target.repository.split("/");
  const refuse = (code: string) => {
    log(`backup-ci:${target.repository}:enrol:${code}`);
    return null;
  };
  try {
    const info = await reads.repository();
    if (info === null) return refuse("repository_unavailable");
    if (info.fullName === undefined) return refuse("unverified_name");
    if (info.fullName !== target.repository) return refuse("renamed");
    if (info.private) return refuse("private_repository");
    for (
      const [path, parse] of [
        [backupCiCalibrationPath(owner, name), parseBackupCiCalibration],
        [
          backupCiCheckCalibrationPath(owner, name),
          parseBackupCiCheckCalibration,
        ],
      ] as const
    ) {
      const value = await store.read(path);
      if (value !== null && parse(value as never).repository.id !== info.id) {
        log(`backup-ci:${target.repository}:unsupported:repository_id`);
        return null;
      }
    }
    return { repository: target.repository, id: info.id };
  } catch {
    return refuse("refused");
  }
}
