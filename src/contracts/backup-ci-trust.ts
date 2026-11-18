/**
 * Who may be trusted to stand in (2026-11-17 review of automatic backup CI
 * enrolment). A false green is the one disagreement backup CI can never be
 * allowed to repeat silently: while a target has no Actions minutes, no
 * native run exists to catch it. So a runner with any unexplained false
 * green, on any target, is excluded everywhere: it neither calibrates nor
 * stands in for any target until its id changes (a leg revision or act pin
 * bump makes a new runner id, which starts uncalibrated).
 */
import type {
  BackupCiCalibrationV1,
  BackupCiSuspensionV1,
} from "./backup-ci.ts";

/** Runners a false green excludes from every target (`all`: every runner). */
export interface BackupCiExcludedRunnersV1 {
  all: boolean;
  runnerIds: string[];
}

export const BACKUP_CI_NOTHING_EXCLUDED: BackupCiExcludedRunnersV1 = {
  all: false,
  runnerIds: [],
};

/**
 * Every `false_green` suspension, whatever its scope, and every calibration
 * row with `falseGreens > 0`, of any target. False-red and operator
 * suspensions keep their own scope (`isBackupCiSuspended`).
 */
export function backupCiExcludedRunners(
  suspensions: readonly BackupCiSuspensionV1[],
  calibrations: readonly BackupCiCalibrationV1[],
): BackupCiExcludedRunnersV1 {
  const ids = new Set<string>();
  let all = false;
  for (const suspension of suspensions) {
    if (suspension.reason !== "false_green") continue;
    if (suspension.runnerIds === "all") all = true;
    else suspension.runnerIds.forEach((id) => ids.add(id));
  }
  for (const calibration of calibrations) {
    for (const row of calibration.runners) {
      if (row.falseGreens > 0) ids.add(row.runnerId);
    }
  }
  return { all, runnerIds: [...ids].sort() };
}

export function isBackupCiRunnerExcluded(
  excluded: BackupCiExcludedRunnersV1,
  runnerId: string,
): boolean {
  return excluded.all || excluded.runnerIds.includes(runnerId);
}

/** Store paths whose files feed the exclusion (every target's). */
export const BACKUP_CI_TRUST_FILE_RE =
  /^v1\/(?:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/)?(?:suspended|calibration)\.json$/;
