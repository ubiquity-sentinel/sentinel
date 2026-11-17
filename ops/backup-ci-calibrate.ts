/**
 * Automatic calibration commits (2026-11-17). Calibration means running the
 * backup leg on commits whose job ran natively and concluded, and comparing
 * (`isBackupCiCalibrated`: at least five agreements, at least one on a red,
 * zero false greens). The commits used to be owner-picked in
 * `ops/backup-ci-calibration.json`; for an uncalibrated runner on a target
 * whose checks already needed a stand-in, the pass now samples them from the
 * target's own history: its newest completed `push` runs on the default
 * branch (one read per target per pass). A sample needs a red; without one,
 * calibration cannot finish, so nothing is run and the reason says so.
 *
 * The planner keeps its per-commit rule (`targetGroups`: only natively
 * started, settled groups are calibration groups), so a never-started red in
 * the run listing plans nothing; its commit file is then an empty visited
 * row and is not sampled again, nor is a commit this runner already settled,
 * so sampling walks down the listing pass by pass. Bounds: one listing read, at most
 * `BACKUP_CI_MAX_CALIBRATION_PER_PASS` candidates per pass (planner), at most
 * `legsPerDay` calibration legs per target per runner in 24 hours, and the
 * global leg slots. Idle when no record of the target needed a stand-in.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  BACKUP_CI_CALIBRATION,
  type BackupCiCalibrationV1,
  type BackupCiCommitFileV1,
  isBackupCiCalibrated,
} from "../src/contracts/backup-ci.ts";

export const BACKUP_CI_CALIBRATION_DISCOVERY = {
  reds: 2,
  greens: 6,
  legsPerDay: 8,
} as const;

/** Closed per-target calibration state of one pass (log only). */
export type BackupCiCalibrationReasonV1 =
  | "calibrated"
  | "unusable"
  | "idle"
  | "daily_cap"
  | "unreadable"
  | "no_native_history"
  | "no_native_red"
  | "sampling";

/**
 * Native reds and greens, newest first, interleaved so a red comes early.
 * `dropped` commits (visited without a settled native group) are skipped
 * before choosing, so a never-started red at the top cannot block progress.
 */
export function selectBackupCiCalibrationCommits(
  runs: readonly { headSha: GitSha; conclusion: string }[],
  dropped: (commit: GitSha) => boolean = () => false,
): { commits: GitSha[]; reason: "no_native_history" | "no_native_red" | null } {
  const seen = new Set<string>();
  const reds: GitSha[] = [];
  const greens: GitSha[] = [];
  for (const run of runs) {
    if (seen.has(run.headSha)) continue;
    if (run.conclusion !== "success" && run.conclusion !== "failure") continue;
    seen.add(run.headSha);
    if (dropped(run.headSha)) continue;
    (run.conclusion === "failure" ? reds : greens).push(run.headSha);
  }
  if (reds.length === 0 && greens.length === 0) {
    return { commits: [], reason: "no_native_history" };
  }
  if (reds.length === 0) return { commits: [], reason: "no_native_red" };
  const r = reds.slice(0, BACKUP_CI_CALIBRATION_DISCOVERY.reds);
  const g = greens.slice(0, BACKUP_CI_CALIBRATION_DISCOVERY.greens);
  return {
    commits: [r[0], ...g.slice(0, 3), ...r.slice(1), ...g.slice(3)],
    reason: null,
  };
}

/** Calibration legs of `runnerId` dispatched or settled within 24 hours. */
export function backupCiCalibrationLegsToday(
  files: Iterable<BackupCiCommitFileV1 | null>,
  runnerId: string,
  now: number,
): number {
  const since = now - 24 * 3_600_000;
  let n = 0;
  for (const file of files) {
    for (const entry of file?.entries ?? []) {
      if (entry.runnerId !== runnerId) continue;
      if (
        (entry.state === "dispatched" && entry.unit.purpose === "calibration" &&
          entry.dispatchedAt >= since) ||
        (entry.state === "result" && entry.purpose === "calibration" &&
          entry.completedAt >= since)
      ) n++;
    }
  }
  return n;
}

/** Whether a runner's row can still reach the calibration gate. */
function reachable(
  calibration: BackupCiCalibrationV1 | null,
  runnerId: string,
): boolean {
  const row = calibration?.runners.find((r) => r.runnerId === runnerId);
  return row === undefined ||
    (row.falseGreens === 0 &&
      row.falseReds <= BACKUP_CI_CALIBRATION.maxFalseReds);
}

export interface BackupCiCalibrationSampleInputV1 {
  calibration: BackupCiCalibrationV1 | null;
  runnerId: string;
  /** Some record of the target already needed a stand-in (an engaged file). */
  demand: boolean;
  defaultBranch: string;
  pushRuns?: (
    branch: string,
  ) => Promise<{ headSha: GitSha; conclusion: string }[] | null>;
  /** The store file of a commit (pending changes merged), or null. */
  file(commit: GitSha): Promise<BackupCiCommitFileV1 | null>;
  now: number;
}

/**
 * The sampled calibration commits of one target for this pass, and why.
 * A sampled commit already visited without an entry of this runner (it had
 * no natively settled group) is dropped; committed commits are unaffected.
 */
export async function sampleBackupCiCalibration(
  input: BackupCiCalibrationSampleInputV1,
): Promise<{ commits: GitSha[]; reason: BackupCiCalibrationReasonV1 }> {
  if (isBackupCiCalibrated(input.calibration, input.runnerId)) {
    return { commits: [], reason: "calibrated" };
  }
  if (!reachable(input.calibration, input.runnerId)) {
    return { commits: [], reason: "unusable" };
  }
  if (!input.demand || input.pushRuns === undefined) {
    return { commits: [], reason: "idle" };
  }
  const runs = await input.pushRuns(input.defaultBranch);
  if (runs === null) return { commits: [], reason: "unreadable" };
  const files = new Map<GitSha, BackupCiCommitFileV1 | null>();
  for (const run of runs) {
    if (!files.has(run.headSha)) {
      files.set(run.headSha, await input.file(run.headSha));
    }
  }
  if (
    backupCiCalibrationLegsToday(files.values(), input.runnerId, input.now) >=
      BACKUP_CI_CALIBRATION_DISCOVERY.legsPerDay
  ) return { commits: [], reason: "daily_cap" };
  // Kept: unvisited commits and this runner's in-flight or retryable ones.
  // Dropped: visited without a unit (no settled native group) or settled.
  const picked = selectBackupCiCalibrationCommits(runs, (commit) => {
    const file = files.get(commit) ?? null;
    return file !== null &&
      !file.entries.some((e) =>
        e.runnerId === input.runnerId &&
        (e.state === "dispatched" || (e.state === "no_evidence" && !e.final))
      );
  });
  if (picked.reason !== null) return { commits: [], reason: picked.reason };
  return { commits: picked.commits, reason: "sampling" };
}
