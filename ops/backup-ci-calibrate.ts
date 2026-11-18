/**
 * Automatic calibration per demanded check (2026-11-17; review MUST 2,
 * MUST 3, MUST 4). Calibration means running the backup leg on commits whose
 * job ran natively and concluded, and comparing (`backup-ci-compare.ts`,
 * per-check ledger `checks.json`). A runner may stand in for a check only
 * after agreeing on THAT check and event context, so sampling is per check:
 *
 * - Demand: a check (context, workflow path, name) a stand-in was planned
 *   for (any runner) on a demand head and not finally refused there.
 * - History: completed runs of that one workflow file and event, newest
 *   first, at most `pages` pages. `push` runs must be on the default branch;
 *   `pull_request` runs must have a head in the same repository (never a
 *   fork). Every field is re-checked client-side.
 * - A failed run shorter than `quickFailMs` never started (a billing stop
 *   fills the newest pages with them): skipped without a read or a leg, so
 *   sampling pages back to runs that did start.
 * - The run's own job of that name must have started (steps, a runner) and
 *   concluded `success` or `failure`.
 * - `pull_request`: the job's own log binds the merge it tested (its first
 *   step must be the checkout; exactly one `Merge <head> into <base>` and
 *   one `refs/remotes/pull/<n>/merge`), and that base must be an ancestor
 *   of the head, so the leg's merge tree (the head's tree) is the tree the
 *   native job tested. Otherwise the run is skipped (`unbound`).
 * - A commit this runner already has an entry for (settled or in flight)
 *   is skipped; another runner's entries never skip it (P6: a new runner
 *   after a leg revision recalibrates on the same history).
 *
 * A check without a native red (or green) in reach cannot be calibrated and
 * so cannot be stood in for; the reason is logged as a closed code.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  type BackupCiCommitFileV1,
  type BackupCiContextV1,
  backupCiModeClass,
  noEvidenceLegRan,
} from "../src/contracts/backup-ci.ts";
import {
  BACKUP_CI_CHECK_CALIBRATION,
  type BackupCiCheckCalibrationV1,
  isBackupCiCheckCalibrated,
} from "../src/contracts/backup-ci-trust.ts";
import { completedJobNeverStarted } from "../src/github/never-started-job.ts";
import { trustedCheckName } from "../src/repair/ci-rejection.ts";
import {
  backupCiNativeMergeParents,
  backupCiNativePullNumber,
} from "./backup-ci-compare.ts";
import type { BackupCiTargetReadsV1 } from "./backup-ci-plan-reads.ts";

export const BACKUP_CI_CALIBRATION_SAMPLING = {
  pages: 3,
  /** Per target and pass: run job listings, native log prefixes, compares. */
  jobReads: 6,
  logReads: 4,
  compares: 4,
  quickFailMs: 30_000,
} as const;

/** Closed per-check calibration state of one pass (log only). */
export type BackupCiCalibrationReasonV1 =
  | "calibrated"
  | "unusable"
  | "daily_cap"
  | "unreadable"
  | "no_native_history"
  | "no_native_red"
  | "no_native_green"
  | "unbound"
  | "budget"
  | "sampling";

export interface BackupCiCheckKeyV1 {
  context: BackupCiContextV1;
  workflowPath: string;
  checkName: string;
}

/** One sampled native run to calibrate on. */
export interface BackupCiCalibrationCandidateV1 {
  commit: GitSha;
  key: BackupCiCheckKeyV1 & { base: GitSha | null };
  pullRequest: number | null;
  nativeCheckRunId: number;
  red: boolean;
}

const same = (a: BackupCiCheckKeyV1, b: BackupCiCheckKeyV1) =>
  a.context === b.context && a.workflowPath === b.workflowPath &&
  a.checkName === b.checkName;

/**
 * The demanded checks of a target: keys a stand-in was planned for (a
 * dispatched unit, a result, or a leg that ran) on a demand head, minus the
 * keys finally refused on that head (`unsupported:*`). A refusal-only head
 * demands nothing (probe P3).
 */
export function backupCiDemandKeys(
  heads: readonly (BackupCiCommitFileV1 | null)[],
  mode: "shadow" | "on",
): BackupCiCheckKeyV1[] {
  const cls = backupCiModeClass(mode);
  const out: BackupCiCheckKeyV1[] = [];
  for (const file of heads) {
    const entries = (file?.entries ?? []).filter((e) =>
      backupCiModeClass(e.mode) === cls
    );
    const refused = entries.filter((e) =>
      e.state === "no_evidence" && e.final &&
      e.reason.startsWith("unsupported:")
    ).map((e) => e.key);
    for (const e of entries) {
      const planned = (e.state === "dispatched" &&
        (e.unit.purpose === "stand_in" || e.unit.purpose === "confirm")) ||
        (e.state === "result" &&
          (e.purpose === "stand_in" || e.purpose === "confirm")) ||
        (e.state === "no_evidence" && noEvidenceLegRan(e.reason));
      if (!planned || refused.some((k) => same(k, e.key))) continue;
      if (!out.some((k) => same(k, e.key))) {
        out.push({
          context: e.key.context,
          workflowPath: e.key.workflowPath,
          checkName: e.key.checkName,
        });
      }
    }
  }
  return out;
}

/**
 * The sampled calibration of one target for this pass, within `legsLeft`
 * (the per-pass and daily caps the caller computed from the leg ledger),
 * logging one closed line per demanded check.
 */
export async function planBackupCiCalibration(input: {
  repository: string;
  defaultBranch: string;
  runnerId: string;
  mode: "shadow" | "on";
  /** Store files of the target's demand heads. */
  heads: readonly (BackupCiCommitFileV1 | null)[];
  checks: BackupCiCheckCalibrationV1 | null;
  reads: BackupCiTargetReadsV1;
  file(commit: GitSha): Promise<BackupCiCommitFileV1 | null>;
  legsLeft: number;
  log(line: string): void;
}): Promise<BackupCiCalibrationCandidateV1[]> {
  const out: BackupCiCalibrationCandidateV1[] = [];
  const budget = backupCiSamplingBudget();
  for (const key of backupCiDemandKeys(input.heads, input.mode)) {
    const left = input.legsLeft - out.length;
    const sampled = left <= 0
      ? {
        candidates: [],
        reason: isBackupCiCheckCalibrated(input.checks, input.runnerId, key)
          ? "calibrated" as const
          : "daily_cap" as const,
      }
      : await sampleBackupCiCheck({
        key,
        repository: input.repository,
        defaultBranch: input.defaultBranch,
        runnerId: input.runnerId,
        checks: input.checks,
        reads: input.reads,
        file: input.file,
        budget,
        want: left,
      }).catch(() => ({
        candidates: [] as BackupCiCalibrationCandidateV1[],
        reason: "unreadable" as const,
      }));
    const row = input.checks?.rows.find((r) =>
      r.runnerId === input.runnerId && same(r, key)
    );
    input.log(`sentinel_backup_ci_calibration ${
      JSON.stringify({
        repository: input.repository,
        check: trustedCheckName(key.checkName),
        context: key.context,
        greens: row?.greens.length ?? 0,
        reds: row?.reds.length ?? 0,
        of: BACKUP_CI_CHECK_CALIBRATION.commits,
        reason: sampled.reason,
        sampled: sampled.candidates.length,
      })
    }`);
    out.push(...sampled.candidates);
  }
  return out;
}

/** Shared per-target read budget of one pass. */
export interface BackupCiSamplingBudgetV1 {
  jobReads: number;
  logReads: number;
  compares: number;
}

export function backupCiSamplingBudget(): BackupCiSamplingBudgetV1 {
  const { jobReads, logReads, compares } = BACKUP_CI_CALIBRATION_SAMPLING;
  return { jobReads, logReads, compares };
}

export interface BackupCiSampleInputV1 {
  key: BackupCiCheckKeyV1;
  /** `owner/name`. */
  repository: string;
  defaultBranch: string;
  runnerId: string;
  checks: BackupCiCheckCalibrationV1 | null;
  reads: BackupCiTargetReadsV1;
  /** The store file of a commit (pending changes merged), or null. */
  file(commit: GitSha): Promise<BackupCiCommitFileV1 | null>;
  budget: BackupCiSamplingBudgetV1;
  /** Candidates wanted (the pass's free calibration legs for the target). */
  want: number;
}

/** The sampled candidates of one demanded check, and why. */
export async function sampleBackupCiCheck(
  input: BackupCiSampleInputV1,
): Promise<{
  candidates: BackupCiCalibrationCandidateV1[];
  reason: BackupCiCalibrationReasonV1;
}> {
  const { key, reads, budget } = input;
  const done = (reason: BackupCiCalibrationReasonV1) => ({
    candidates: [] as BackupCiCalibrationCandidateV1[],
    reason,
  });
  if (isBackupCiCheckCalibrated(input.checks, input.runnerId, key)) {
    return done("calibrated");
  }
  const row = input.checks?.rows.find((r) =>
    r.runnerId === input.runnerId && same(r, key)
  );
  if (
    row !== undefined &&
    (row.falseGreens > 0 ||
      row.falseReds > BACKUP_CI_CHECK_CALIBRATION.maxFalseReds)
  ) return done("unusable");
  if (reads.workflowRuns === undefined || reads.runJobs === undefined) {
    return done("unreadable");
  }
  const needRed = (row?.reds.length ?? 0) < BACKUP_CI_CHECK_CALIBRATION.reds;
  const needGreen = (row?.greens.length ?? 0) <
    BACKUP_CI_CHECK_CALIBRATION.greens;
  const found: BackupCiCalibrationCandidateV1[] = [];
  const seen = new Set<string>();
  let natives = { green: 0, red: 0, unbound: 0 };
  let exhausted: BackupCiCalibrationReasonV1 | null = null;
  // A row still missing its red keeps paging (within the read budget) until
  // one is in hand; greens found meanwhile wait behind it.
  const enough = () =>
    found.length >= input.want && (!needRed || found.some((c) => c.red));
  pages: for (
    let page = 1;
    page <= BACKUP_CI_CALIBRATION_SAMPLING.pages && !enough();
    page++
  ) {
    const runs = await reads.workflowRuns(
      key.workflowPath,
      key.context,
      key.context === "push" ? input.defaultBranch : null,
      page,
    );
    if (runs === null) {
      if (page === 1) return done("unreadable");
      break;
    }
    for (const run of runs) {
      if (enough()) break pages;
      if (
        run.event !== key.context || run.path !== key.workflowPath ||
        run.headRepository !== input.repository ||
        (key.context === "push" && run.headBranch !== input.defaultBranch) ||
        (run.conclusion !== "success" && run.conclusion !== "failure") ||
        seen.has(run.headSha)
      ) continue;
      seen.add(run.headSha);
      if (
        run.conclusion === "failure" && run.startedAt !== null &&
        run.updatedAt !== null &&
        run.updatedAt - run.startedAt <
          BACKUP_CI_CALIBRATION_SAMPLING.quickFailMs
      ) continue;
      const file = await input.file(run.headSha);
      if (
        file?.entries.some((e) =>
          e.runnerId === input.runnerId && same(e.key, key)
        )
      ) continue;
      if (budget.jobReads <= 0) {
        exhausted = "budget";
        break pages;
      }
      budget.jobReads--;
      const jobs = await reads.runJobs(run.id);
      const job = jobs?.find((j) => j.name === key.checkName);
      const jobId = typeof job?.id === "number" ? job.id : null;
      if (
        job === undefined || jobId === null ||
        completedJobNeverStarted(job, jobId, run.headSha) !== false ||
        (job.conclusion !== "success" && job.conclusion !== "failure")
      ) continue;
      const red = job.conclusion === "failure";
      natives = {
        ...natives,
        green: natives.green + (red ? 0 : 1),
        red: natives.red + (red ? 1 : 0),
      };
      if (key.context === "push") {
        found.push({
          commit: run.headSha,
          key: { ...key, base: null },
          pullRequest: null,
          nativeCheckRunId: jobId,
          red,
        });
        continue;
      }
      if (budget.logReads <= 0 || budget.compares <= 0) {
        exhausted = "budget";
        break pages;
      }
      budget.logReads--;
      const log = reads.jobLogPrefix === undefined
        ? null
        : await reads.jobLogPrefix(jobId);
      const merge = log === null ? "unbound" : backupCiNativeMergeParents(log);
      const number = log === null ? null : backupCiNativePullNumber(log);
      if (
        merge === "unbound" || merge.head !== run.headSha || number === null
      ) {
        natives = { ...natives, unbound: natives.unbound + 1 };
        continue;
      }
      budget.compares--;
      const compare = await reads.compare(merge.base, merge.head);
      if (
        compare === null || compare.behindBy !== 0 ||
        (compare.status !== "ahead" && compare.status !== "identical")
      ) {
        natives = { ...natives, unbound: natives.unbound + 1 };
        continue;
      }
      found.push({
        commit: run.headSha,
        key: { ...key, base: merge.base },
        pullRequest: number,
        nativeCheckRunId: jobId,
        red,
      });
    }
  }
  // While the row still needs its red and none is in reach, greens would be
  // legs spent on a check that cannot finish calibrating: plan nothing.
  const reachable = !needRed || found.some((c) => c.red);
  const candidates = reachable
    ? [...found].sort((a, b) => needRed ? Number(b.red) - Number(a.red) : 0)
      .slice(0, Math.max(0, input.want))
    : [];
  if (candidates.length > 0) return { candidates, reason: "sampling" };
  if (exhausted !== null) return done(exhausted);
  const boundRed = found.some((c) => c.red);
  const boundGreen = found.some((c) => !c.red);
  if (natives.red + natives.green === 0) return done("no_native_history");
  if (needRed && !boundRed) {
    return done(natives.red > 0 ? "unbound" : "no_native_red");
  }
  if (needGreen && !boundGreen) {
    return done(natives.green > 0 ? "unbound" : "no_native_green");
  }
  return done(natives.unbound > 0 ? "unbound" : "no_native_history");
}
