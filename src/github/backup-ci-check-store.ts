/**
 * The per-check calibration file `v1/<owner>/<repo>/checks.json`
 * (`backup-ci-trust.ts`): classified comparisons (`backup-ci-compare.ts`)
 * counted per (runner, context, workflow path, check name), each commit at
 * most once per row. A false green or false red is monotonic and also
 * returned for the caller's suspension, exactly like the pooled
 * `calibration.json` (which the same comparisons still feed, so older
 * readers keep their meaning).
 */
import {
  BACKUP_CI_CHECK_CALIBRATION,
  type BackupCiCheckCalibrationV1,
  type BackupCiCheckRowV1,
  parseBackupCiCheckCalibration,
} from "../contracts/backup-ci-trust.ts";
import type {
  BackupCiComparisonV1,
  BackupCiDisagreementV1,
} from "./backup-ci-store.ts";

type Repository = { owner: string; name: string; id: number };

/**
 * The merged file, or null when no comparison carries a key and class (no
 * write: an older launcher's pass, or nothing comparable). Throws when the
 * current file names another repository.
 */
export function mergeCheckCalibration(
  current: BackupCiCheckCalibrationV1 | null,
  repository: Repository,
  comparisons: readonly BackupCiComparisonV1[],
  now: number,
): {
  checks: BackupCiCheckCalibrationV1;
  disagreements: BackupCiDisagreementV1[];
} | null {
  const keyed = comparisons.filter((c) =>
    c.key !== undefined && c.class !== undefined
  );
  if (keyed.length === 0) return null;
  if (
    current !== null &&
    (current.repository.owner !== repository.owner ||
      current.repository.name !== repository.name ||
      current.repository.id !== repository.id)
  ) throw new Error("backup CI check calibration names another repository");
  const rule = BACKUP_CI_CHECK_CALIBRATION;
  let rows: BackupCiCheckRowV1[] = (current?.rows ?? []).map((row) => ({
    ...row,
    greens: [...row.greens],
    reds: [...row.reds],
    disputed: [...row.disputed],
  }));
  const disagreements: BackupCiDisagreementV1[] = [];
  const keep = (list: string[]) => list.slice(-rule.maxCommits);
  for (const comparison of keyed) {
    const key = comparison.key!;
    let row = rows.find((r) =>
      r.runnerId === comparison.runnerId && r.context === key.context &&
      r.workflowPath === key.workflowPath && r.checkName === key.checkName
    );
    if (row === undefined) {
      row = {
        runnerId: comparison.runnerId,
        context: key.context,
        workflowPath: key.workflowPath,
        checkName: key.checkName,
        greens: [],
        reds: [],
        falseGreens: 0,
        falseReds: 0,
        disputed: [],
      };
      rows.push(row);
    }
    const commit = comparison.sample.commit;
    const cls = comparison.class!;
    if (row.disputed.includes(commit)) continue;
    if (cls === "green" || cls === "red") {
      // An agreement counts once per commit and never over a dispute.
      if (row.greens.includes(commit) || row.reds.includes(commit)) continue;
      if (cls === "green") {
        row.greens = keep([...row.greens, commit]) as typeof row.greens;
      } else row.reds = keep([...row.reds, commit]) as typeof row.reds;
      continue;
    }
    // A disagreement is never swallowed by an earlier agreement on the same
    // commit (another base, another attempt): it revokes that agreement.
    row.greens = row.greens.filter((c) => c !== commit);
    row.reds = row.reds.filter((c) => c !== commit);
    row.disputed = keep([...row.disputed, commit]) as typeof row.disputed;
    if (cls === "false_green") {
      row.falseGreens++;
      disagreements.push({ kind: "false_green", comparison });
    } else {
      row.falseReds++;
      if (row.falseReds > rule.maxFalseReds) {
        disagreements.push({ kind: "false_red", comparison });
      }
    }
  }
  // Bound: rows of runners this pass did not compare go first, oldest first.
  const active = new Set(keyed.map((c) => c.runnerId));
  while (rows.length > rule.maxRows) {
    const index = rows.findIndex((r) => !active.has(r.runnerId));
    rows = rows.filter((_, i) => i !== (index < 0 ? 0 : index));
  }
  return {
    checks: parseBackupCiCheckCalibration({
      version: 1,
      kind: "sentinel_backup_ci_check_calibration",
      repository: { ...repository },
      rows,
      updatedAt: now,
    }),
    disagreements,
  };
}
