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
 *   step must be `actions/checkout` at a release tag or full SHA, a form the
 *   leg reproduces; exactly one `Merge <head> into <base>` and one
 *   `refs/remotes/pull/<n>/merge`), and that base must be an ancestor of the
 *   head, so the leg's merge tree (the head's tree) is the tree the native
 *   job tested. Otherwise the run is skipped (`unbound`). The pull request
 *   must be merged or authored by the owner or the Sentinel App (2026-11-18
 *   review; `untrusted_pull` otherwise), read at most `pullReads` times.
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
  type BackupCiCheckDefinitionsV1,
  backupCiJobDefinition,
  isBackupCiCheckCalibrated,
  isBackupCiDefinitionCalibrated,
} from "../src/contracts/backup-ci-trust.ts";
import { completedJobNeverStarted } from "../src/github/never-started-job.ts";
import { SENTINEL_APP_SLUG } from "../src/host/hosted-app-grant.ts";
import { trustedCheckName } from "../src/repair/ci-rejection.ts";
import { BACKUP_CI_SELF_APP_BOT_ID } from "./backup-ci-ingest-verify.ts";
import {
  backupCiNativeMergeParents,
  backupCiNativePullNumber,
} from "./backup-ci-compare.ts";
import type {
  BackupCiPullV1,
  BackupCiTargetReadsV1,
} from "./backup-ci-plan-reads.ts";

export const BACKUP_CI_CALIBRATION_SAMPLING = {
  pages: 3,
  /** Per target and pass: run job listings, native log prefixes, compares. */
  jobReads: 6,
  logReads: 4,
  compares: 4,
  /** Per target and pass: pull request reads (author and merge state). */
  pullReads: 4,
  quickFailMs: 30_000,
} as const;

/**
 * Who may have authored an unmerged pull request a calibration sample comes
 * from (2026-11-18 review): the owner account and the Sentinel App, each
 * bound by login AND numeric id (a login can be renamed and re-registered).
 * Any other same-repository author's run counts only once the pull request
 * was merged.
 */
export const BACKUP_CI_CALIBRATION_AUTHORS = {
  owner: { login: "0x4007", id: 4975670 },
  app: { login: `${SENTINEL_APP_SLUG}[bot]`, id: BACKUP_CI_SELF_APP_BOT_ID },
} as const;

/** Whether a sampled pull request's run may calibrate (merged or trusted). */
export function backupCiTrustedSamplePull(
  pull: BackupCiPullV1 | null,
  repository: string,
  number: number,
): boolean {
  const { owner, app } = BACKUP_CI_CALIBRATION_AUTHORS;
  const by = (who: { login: string; id: number }) =>
    pull?.user === who.login && pull.userId === who.id;
  return pull !== null && pull.number === number &&
    pull.head.repo.full_name === repository &&
    pull.base.repo.full_name === repository &&
    (pull.merged === true || by(owner) || by(app));
}

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
  | "untrusted_pull"
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
 * The job definitions (`backupCiJobDefinition`) demanded for `key` on the
 * demand heads: of planned units and results; a leg without evidence names
 * none (2026-11-18).
 */
export function backupCiDemandDefinitions(
  heads: readonly (BackupCiCommitFileV1 | null)[],
  mode: "shadow" | "on",
  key: BackupCiCheckKeyV1,
): string[] {
  const cls = backupCiModeClass(mode);
  const out = new Set<string>();
  for (const e of heads.flatMap((f) => f?.entries ?? [])) {
    if (backupCiModeClass(e.mode) !== cls || !same(e.key, key)) continue;
    if (e.state === "dispatched") {
      out.add(backupCiJobDefinition({
        workflowBlob: e.unit.workflow.blob,
        jobKey: e.unit.job.key,
        matrix: e.unit.job.matrix,
      }));
    } else if (e.state === "result") out.add(backupCiJobDefinition(e.binding));
  }
  return [...out].sort();
}

/**
 * Whether `runnerId` may stand in for `key` under every demanded definition:
 * the per-check gate and, for each demanded definition, its own agreements.
 * No demanded definition (only legs without evidence) is not calibrated.
 */
export function backupCiDemandCalibrated(input: {
  checks: BackupCiCheckCalibrationV1 | null;
  definitions: BackupCiCheckDefinitionsV1 | null;
  demanded: readonly string[];
  runnerId: string;
  key: BackupCiCheckKeyV1;
}): boolean {
  return isBackupCiCheckCalibrated(input.checks, input.runnerId, input.key) &&
    input.demanded.length > 0 &&
    input.demanded.every((d) =>
      isBackupCiDefinitionCalibrated(
        input.definitions,
        input.runnerId,
        input.key,
        d,
      )
    );
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
  /** The target's `check-defs.json` (2026-11-18), or null. */
  definitions?: BackupCiCheckDefinitionsV1 | null;
  reads: BackupCiTargetReadsV1;
  file(commit: GitSha): Promise<BackupCiCommitFileV1 | null>;
  legsLeft: number;
  log(line: string): void;
}): Promise<BackupCiCalibrationCandidateV1[]> {
  const out: BackupCiCalibrationCandidateV1[] = [];
  const budget = backupCiSamplingBudget();
  for (const key of backupCiDemandKeys(input.heads, input.mode)) {
    const left = input.legsLeft - out.length;
    const definitions = {
      file: input.definitions ?? null,
      demanded: backupCiDemandDefinitions(input.heads, input.mode, key),
    };
    const sampled = left <= 0
      ? {
        candidates: [],
        reason: backupCiDemandCalibrated({
            checks: input.checks,
            definitions: definitions.file,
            demanded: definitions.demanded,
            runnerId: input.runnerId,
            key,
          })
          ? "calibrated" as const
          : "daily_cap" as const,
      }
      : await sampleBackupCiCheck({
        key,
        repository: input.repository,
        defaultBranch: input.defaultBranch,
        runnerId: input.runnerId,
        checks: input.checks,
        definitions,
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
  pullReads: number;
}

export function backupCiSamplingBudget(): BackupCiSamplingBudgetV1 {
  const { jobReads, logReads, compares, pullReads } =
    BACKUP_CI_CALIBRATION_SAMPLING;
  return { jobReads, logReads, compares, pullReads };
}

export interface BackupCiSampleInputV1 {
  key: BackupCiCheckKeyV1;
  /** `owner/name`. */
  repository: string;
  defaultBranch: string;
  runnerId: string;
  checks: BackupCiCheckCalibrationV1 | null;
  /**
   * The definitions file and the demanded definitions (2026-11-18): given,
   * the check counts as calibrated only under every demanded definition,
   * and the green and red still needed are those of the first definition
   * not yet calibrated. Absent: the per-check row alone (older callers).
   */
  definitions?: {
    file: BackupCiCheckDefinitionsV1 | null;
    demanded: readonly string[];
  };
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
  const defs = input.definitions;
  if (
    defs === undefined
      ? isBackupCiCheckCalibrated(input.checks, input.runnerId, key)
      : backupCiDemandCalibrated({
        checks: input.checks,
        definitions: defs.file,
        demanded: defs.demanded,
        runnerId: input.runnerId,
        key,
      })
  ) return done("calibrated");
  const row = input.checks?.rows.find((r) =>
    r.runnerId === input.runnerId && same(r, key)
  );
  // What the first demanded definition not yet calibrated still needs.
  const open = defs?.demanded.find((d) =>
    !isBackupCiDefinitionCalibrated(defs.file, input.runnerId, key, d)
  );
  const counted = open === undefined
    ? row
    : defs?.file?.rows.find((r) =>
      r.runnerId === input.runnerId && same(r, key) && r.definition === open
    );
  if (
    row !== undefined &&
    (row.falseGreens > 0 ||
      row.falseReds > BACKUP_CI_CHECK_CALIBRATION.maxFalseReds)
  ) return done("unusable");
  if (reads.workflowRuns === undefined || reads.runJobs === undefined) {
    return done("unreadable");
  }
  const needRed = (counted?.reds.length ?? 0) <
    BACKUP_CI_CHECK_CALIBRATION.reds;
  const needGreen = (counted?.greens.length ?? 0) <
    BACKUP_CI_CHECK_CALIBRATION.greens;
  const found: BackupCiCalibrationCandidateV1[] = [];
  const seen = new Set<string>();
  /** Pull request reads of this check's sampling, by number. */
  const pulls = new Map<number, BackupCiPullV1 | null>();
  let natives = { green: 0, red: 0, unbound: 0, untrusted: 0 };
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
      if (!pulls.has(number)) {
        if (budget.pullReads <= 0) {
          exhausted = "budget";
          break pages;
        }
        budget.pullReads--;
        pulls.set(number, await reads.pull(number));
      }
      if (
        !backupCiTrustedSamplePull(
          pulls.get(number) ?? null,
          input.repository,
          number,
        )
      ) {
        natives = { ...natives, untrusted: natives.untrusted + 1 };
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
  // Runs that bound but came from an untrusted pull request, when no run was
  // unbound, are named as such; any unbound run keeps the older code.
  const refused = natives.unbound === 0 && natives.untrusted > 0
    ? "untrusted_pull" as const
    : "unbound" as const;
  if (natives.red + natives.green === 0) return done("no_native_history");
  if (needRed && !boundRed) {
    return done(natives.red > 0 ? refused : "no_native_red");
  }
  if (needGreen && !boundGreen) {
    return done(natives.green > 0 ? refused : "no_native_green");
  }
  return done(
    natives.unbound + natives.untrusted > 0 ? refused : "no_native_history",
  );
}
