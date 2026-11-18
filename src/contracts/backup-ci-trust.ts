/**
 * Who may be trusted to stand in (2026-11-17 review of automatic backup CI
 * enrolment). A false green is the one disagreement backup CI can never be
 * allowed to repeat silently: while a target has no Actions minutes, no
 * native run exists to catch it. So a runner with any unexplained false
 * green, on any target, is excluded everywhere: it neither calibrates nor
 * stands in for any target until its id changes (a leg revision or act pin
 * bump makes a new runner id, which starts uncalibrated).
 */
import type { GitSha } from "./brands.ts";
import {
  BACKUP_CI_CALIBRATION,
  type BackupCiCalibrationV1,
  type BackupCiContextV1,
  type BackupCiSuspensionV1,
} from "./backup-ci.ts";
import { canonicalStringify } from "./canonical.ts";
import {
  expectArray,
  expectEnum,
  expectExactKeys,
  expectGitSha,
  expectRecord,
  expectString,
  fail,
} from "./validation.ts";

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
  checks: readonly BackupCiCheckCalibrationV1[] = [],
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
  for (const file of checks) {
    for (const row of file.rows) {
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
  /^v1\/(?:[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/)?(?:suspended|calibration|checks)\.json$/;

/**
 * Per-check calibration (review MUST 2): a runner may stand in for a
 * (context, workflow path, check name) only after agreeing with native CI on
 * THAT check, in THAT event context, on at least `commits` distinct commits,
 * at least one of them green and one red, with no false green and at most
 * `maxFalseReds` false reds. Not pooled across jobs, events or commits: five
 * job names of one red commit are five rows of one commit each.
 */
export const BACKUP_CI_CHECK_CALIBRATION = {
  commits: BACKUP_CI_CALIBRATION.agreements,
  greens: 1,
  reds: BACKUP_CI_CALIBRATION.failureAgreements,
  maxFalseReds: BACKUP_CI_CALIBRATION.maxFalseReds,
  maxCommits: 64,
  maxRows: 256,
} as const;

export interface BackupCiCheckRowV1 {
  runnerId: string;
  context: BackupCiContextV1;
  workflowPath: string;
  checkName: string;
  /** Distinct commits of proven agreements (each at most `maxCommits`). */
  greens: GitSha[];
  reds: GitSha[];
  /** Monotonic: never decreases, whatever the commit lists keep. */
  falseGreens: number;
  falseReds: number;
  /** Commits already counted as a disagreement (deduplication only). */
  disputed: GitSha[];
}

/** v1/<owner>/<repo>/checks.json (2026-11-17; older readers never read it). */
export interface BackupCiCheckCalibrationV1 {
  version: 1;
  kind: "sentinel_backup_ci_check_calibration";
  repository: { owner: string; name: string; id: number };
  rows: BackupCiCheckRowV1[];
  updatedAt: number;
}

export function backupCiCheckCalibrationPath(
  owner: string,
  repo: string,
): string {
  return `v1/${owner}/${repo}/checks.json`;
}

/** Whether `runnerId` is calibrated for exactly this check and context. */
export function isBackupCiCheckCalibrated(
  checks: BackupCiCheckCalibrationV1 | null,
  runnerId: string,
  key: { context: BackupCiContextV1; workflowPath: string; checkName: string },
): boolean {
  const row = checks?.rows.find((r) =>
    r.runnerId === runnerId && r.context === key.context &&
    r.workflowPath === key.workflowPath && r.checkName === key.checkName
  );
  const rule = BACKUP_CI_CHECK_CALIBRATION;
  return row !== undefined &&
    new Set([...row.greens, ...row.reds]).size >= rule.commits &&
    row.greens.length >= rule.greens && row.reds.length >= rule.reds &&
    row.falseGreens === 0 && row.falseReds <= rule.maxFalseReds;
}

const RUNNER_RE = /^[0-9a-f]{16}$/;
const REPO_PART_RE = /^[A-Za-z0-9._-]{1,100}$/;
const PATH_RE = /^\.github\/workflows\/[A-Za-z0-9._-]{1,100}\.ya?ml$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/()[\],+#@-]{0,63}$/;

function bad(path: string, expected: string): never {
  return fail(path, "invalid_pattern", `expected ${expected}`);
}

function count(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    bad(path, "a non-negative integer");
  }
  return value as number;
}

function commits(value: unknown, path: string): GitSha[] {
  const list = expectArray(
    value,
    path,
    BACKUP_CI_CHECK_CALIBRATION.maxCommits,
    (v, at) => expectGitSha(v, at),
  );
  if (new Set(list).size !== list.length) bad(path, "unique commits");
  return list;
}

/** Strict parse of a `checks.json` file. */
export function parseBackupCiCheckCalibration(
  input: unknown,
): BackupCiCheckCalibrationV1 {
  const o = expectRecord(input, "$");
  expectExactKeys(
    o,
    ["version", "kind", "repository", "rows", "updatedAt"],
    "$",
  );
  if (o.version !== 1) bad("$.version", "1");
  if (o.kind !== "sentinel_backup_ci_check_calibration") bad("$.kind", "kind");
  const r = expectRecord(o.repository, "$.repository");
  expectExactKeys(r, ["owner", "name", "id"], "$.repository");
  const owner = expectString(r.owner, "$.repository.owner", 100);
  const name = expectString(r.name, "$.repository.name", 100);
  if (!REPO_PART_RE.test(owner) || !REPO_PART_RE.test(name)) {
    bad("$.repository", "an owner/name");
  }
  const id = count(r.id, "$.repository.id");
  if (id === 0) bad("$.repository.id", "a positive id");
  const rows = expectArray(
    o.rows,
    "$.rows",
    BACKUP_CI_CHECK_CALIBRATION.maxRows,
    (v, at) => {
      const row = expectRecord(v, at);
      expectExactKeys(row, [
        "runnerId",
        "context",
        "workflowPath",
        "checkName",
        "greens",
        "reds",
        "falseGreens",
        "falseReds",
        "disputed",
      ], at);
      const runnerId = expectString(row.runnerId, `${at}.runnerId`, 16);
      const workflowPath = expectString(row.workflowPath, `${at}.path`, 140);
      const checkName = expectString(row.checkName, `${at}.checkName`, 64);
      if (
        !RUNNER_RE.test(runnerId) || !PATH_RE.test(workflowPath) ||
        !NAME_RE.test(checkName)
      ) bad(at, "a runner, workflow path and check name");
      const greens = commits(row.greens, `${at}.greens`);
      const reds = commits(row.reds, `${at}.reds`);
      if (greens.some((c) => reds.includes(c))) {
        bad(at, "one class per commit");
      }
      return {
        runnerId,
        context: expectEnum(row.context, ["push", "pull_request"], at),
        workflowPath,
        checkName,
        greens,
        reds,
        falseGreens: count(row.falseGreens, `${at}.falseGreens`),
        falseReds: count(row.falseReds, `${at}.falseReds`),
        disputed: commits(row.disputed, `${at}.disputed`),
      } as BackupCiCheckRowV1;
    },
  );
  const ids = rows.map((row) =>
    canonicalStringify([
      row.runnerId,
      row.context,
      row.workflowPath,
      row.checkName,
    ])
  );
  if (new Set(ids).size !== ids.length) bad("$.rows", "unique rows");
  return {
    version: 1,
    kind: "sentinel_backup_ci_check_calibration",
    repository: { owner, name, id },
    rows,
    updatedAt: count(o.updatedAt, "$.updatedAt"),
  };
}
