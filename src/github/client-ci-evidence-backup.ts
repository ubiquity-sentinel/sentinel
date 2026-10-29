/**
 * CI correction evidence from a backup CI receipt (docs/backup-ci-spec.md
 * §11.7). When a failing check of the candidate head never started on the
 * target and a red backup result stands in for it, the job log GitHub has for
 * that run is empty; the correction is shown the receipt instead: the backup
 * app, the target's workflow path, the job key, the failing planned step,
 * the receipt's sanitized excerpt and one fixed notice that says where the
 * evidence comes from. Native evidence is never changed, and anything that
 * cannot be selected (not composed, mode not `on`, no file, an unavailable
 * read, the collection's deadline) leaves the evidence as collected.
 */
import type { GitSha } from "../contracts/brands.ts";
import { backupCiReceiptId } from "../contracts/backup-ci.ts";
import { sanitizeEvidenceText } from "../repair/ci-evidence-sanitize.ts";
import { ciExcerptShare } from "../repair/ci-evidence-render.ts";
import type {
  CiCheckEvidenceV1,
  CiEvidenceV1,
} from "../repair/ci-evidence-types.ts";
import type { BackupCiCommitSelectionV1 } from "./backup-ci-observations.ts";
import {
  type BackupCiClientReadsV1,
  backupCiSelectionFor,
} from "./client-backup-ci.ts";
import { baseCheck, evidenceText } from "./client-ci-evidence-shape.ts";
import type { DeadlineV1 } from "./http.ts";
import { ACTIONS_APP_SLUG } from "./never-started-job.ts";

/** The producing app the evidence names for a backup receipt. */
export const BACKUP_CI_EVIDENCE_APP = "sentinel-backup-ci";

/** The fixed, trusted notice every backup receipt's evidence carries. */
export const BACKUP_CI_EVIDENCE_NOTICE =
  "This check did not start on the target (account billing). Sentinel's " +
  "backup CI ran the target's own workflow job on the exact tree; the " +
  "excerpt is from that run.";

/** One failing check run as the evidence collector lists it. */
export interface BackupCiFailingRunV1 {
  id: number;
  name: string;
  app: string | null;
  conclusion: string | null;
}

/**
 * The receipt evidence for `failingRun` of `commit`, or null unless a red
 * stand-in of exactly that run was selected and its result entry is found.
 * `count` is the number of checks the evidence shows (the excerpt's share).
 */
export function backupEvidenceFor(
  failingRun: BackupCiFailingRunV1,
  chosen: BackupCiCommitSelectionV1,
  repository: string,
  commit: GitSha,
  count: number,
): CiCheckEvidenceV1 | null {
  const standIn = chosen.selection.standIns.get(failingRun.id);
  if (
    standIn === undefined || standIn.name !== failingRun.name ||
    standIn.conclusion === "success"
  ) return null;
  const entry = chosen.file.entries.find((candidate) =>
    candidate.state === "result" && candidate.mode === "evidence" &&
    candidate.runnerId === standIn.backup.runnerId &&
    candidate.leg.runId === standIn.backup.legRunId &&
    backupCiReceiptId(repository, commit, candidate.key) ===
      standIn.backup.receipt
  );
  if (entry === undefined || entry.state !== "result") return null;
  const check = baseCheck(
    failingRun.name,
    standIn.conclusion,
    BACKUP_CI_EVIDENCE_APP,
  );
  check.workflow = {
    name: "backup CI",
    path: evidenceText(entry.key.workflowPath),
  };
  check.job = { id: entry.leg.jobId, name: evidenceText(entry.binding.jobKey) };
  check.classification = "candidate";
  check.classificationReason = BACKUP_CI_EVIDENCE_NOTICE;
  if (entry.failure !== null) {
    check.failingSteps = [{
      number: entry.failure.stepIndex,
      name: "of the target's own job",
      conclusion: standIn.conclusion,
    }];
    const excerpt = sanitizeEvidenceText(
      entry.failure.excerpt,
      ciExcerptShare(check, Math.max(1, count)),
    );
    if (excerpt.length > 0) {
      const lines = excerpt.split("\n").length;
      check.excerpt = excerpt;
      check.excerptLines = { kept: lines, total: lines };
    }
  }
  return check;
}

/** The commit's selection from its own listings, or null. */
async function selectFor(
  ctx: BackupCiClientReadsV1,
  head: GitSha,
): Promise<BackupCiCommitSelectionV1 | null> {
  const latest = await ctx.pages(
    `/commits/${head}/check-runs`,
    {},
    "check_runs",
  );
  if (!latest.ok) return null;
  return await backupCiSelectionFor(ctx, head, latest.value, async () => {
    const statuses = await ctx.pages(`/commits/${head}/statuses`, {}, null);
    if (!statuses.ok) return null;
    const contexts = new Set<string>();
    for (const status of statuses.value) {
      const context = (status as Record<string, unknown> | null)?.context;
      if (typeof context === "string") contexts.add(context);
    }
    return contexts;
  });
}

/**
 * Replaces, in `evidence`, the entry of each run of `selected` (index-aligned
 * with the first `selected.length` checks the collector pushed) that a red
 * stand-in covers with its receipt evidence. Never throws; a selection that
 * does not settle before `deadline` changes nothing.
 */
export async function applyBackupCiEvidence(
  ctx: BackupCiClientReadsV1 | null,
  head: GitSha,
  selected: readonly BackupCiFailingRunV1[],
  evidence: CiEvidenceV1,
  deadline: DeadlineV1,
): Promise<void> {
  if (
    ctx === null || ctx.mode !== "on" || deadline.fired() ||
    !selected.some((run) =>
      run.app === ACTIONS_APP_SLUG && run.conclusion === "failure"
    )
  ) return;
  const target = ctx.reader.target(ctx.repository);
  if (target === null) return;
  try {
    const chosen = await deadline.race(selectFor(ctx, head));
    if (chosen === null) return;
    const count = evidence.checks.length;
    selected.forEach((run, index) => {
      if (index >= evidence.checks.length) return;
      const backed = backupEvidenceFor(
        run,
        chosen,
        target.repository,
        head,
        count,
      );
      if (backed !== null) evidence.checks[index] = backed;
    });
  } catch {
    // Out of time or unreadable: the native evidence stands.
  }
}
