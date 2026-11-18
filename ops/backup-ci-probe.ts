/**
 * Diagnosis of a false-green suspension (2026-11-17 review). Runner
 * `916ad9eaff49fe9d` was suspended for a false green on Passport `1cfa6ad6`
 * (a pull_request peer leg that passed every planned step, against native
 * check run 125012919402 that failed). The comparison then bound neither
 * the native run's event nor the base its merge used, and the native run is
 * readable only with the target token. While the current runner is
 * excluded, the trusted pass re-reads that native run once per pass and
 * logs closed facts only: its event, whether its job started, its
 * conclusion, the number of its first failing step, and for pull_request
 * the merge base its own checkout logged against the leg's base. A
 * different base or event means the false green compared different code (a
 * Sentinel-side comparison defect, now refused by `backup-ci-compare.ts`);
 * the same base and event leave the leg's fidelity in question. The leg
 * revision is bumped only on that evidence, never by this probe.
 */
import {
  type BackupCiCommitFileV1,
  backupCiCommitPath,
  backupCiReceiptId,
  backupCiSuspensionPath,
  type BackupCiSuspensionV1,
  parseBackupCiCommitFile,
  parseBackupCiSuspension,
} from "../src/contracts/backup-ci.ts";
import { completedJobNeverStarted } from "../src/github/never-started-job.ts";
import { backupCiNativeMergeParents } from "./backup-ci-compare.ts";
import type { BackupCiTargetReadsV1 } from "./backup-ci-plan-reads.ts";

type Obj = Record<string, unknown>;
const row = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : null;

/** One closed probe line for the suspension's evidence, or null. */
export async function probeBackupCiFalseGreen(input: {
  repository: string;
  suspension: BackupCiSuspensionV1;
  /** The store file of the evidence commit (the leg's own key). */
  file: BackupCiCommitFileV1 | null;
  reads: BackupCiTargetReadsV1;
}): Promise<string | null> {
  const evidence = input.suspension.evidence;
  if (input.suspension.reason !== "false_green" || evidence === null) {
    return null;
  }
  const leg = input.file?.entries.find((e) =>
    e.state === "result" &&
    backupCiReceiptId(input.repository, evidence.commit, e.key) ===
      evidence.receipt
  );
  const [runs, suites, job] = await Promise.all([
    input.reads.checkRuns(evidence.commit, "all"),
    input.reads.suites(evidence.commit),
    input.reads.job(evidence.nativeCheckRunId),
  ]);
  const native = runs?.find((r) => r.id === evidence.nativeCheckRunId);
  const suite = suites?.find((s) => s.suiteId === row(native?.check_suite)?.id);
  const body = row(job);
  const started = job === null
    ? null
    : completedJobNeverStarted(job, evidence.nativeCheckRunId, evidence.commit);
  const steps = Array.isArray(body?.steps) ? body.steps.map(row) : [];
  const failing = steps.find((s) => s?.conclusion === "failure")?.number;
  let nativeBase: string | null = null;
  if (suite?.event === "pull_request" && input.reads.jobLogPrefix) {
    const log = await input.reads.jobLogPrefix(evidence.nativeCheckRunId);
    const merge = log === null ? "unbound" : backupCiNativeMergeParents(log);
    nativeBase = merge === "unbound" || merge.head !== evidence.commit
      ? null
      : merge.base;
  }
  const legBase = leg?.key.base ?? null;
  return `sentinel_backup_ci_false_green_probe ${
    JSON.stringify({
      receipt: evidence.receipt,
      legContext: leg?.key.context ?? null,
      nativeEvent: suite?.event ?? null,
      nativeStarted: started === null ? null : !started,
      nativeConclusion: typeof body?.conclusion === "string"
        ? body.conclusion
        : null,
      nativeFailingStep: typeof failing === "number" ? failing : null,
      legBase12: legBase?.slice(0, 12) ?? null,
      nativeBase12: nativeBase?.slice(0, 12) ?? null,
      sameBase: legBase === null || nativeBase === null
        ? null
        : legBase === nativeBase,
    })
  }`;
}

/**
 * The first false-green suspension of `runnerId` among the targets' own
 * suspension files (local store reads), probed once: at most one probe line
 * per pass, and only while that runner is excluded.
 */
export async function probeExcludedBackupCiRunner(input: {
  runnerId: string;
  targets: readonly { repository: string }[];
  store: { read(path: string): Promise<unknown | null> };
  targetReads(owner: string, name: string): BackupCiTargetReadsV1;
  log(line: string): void;
}): Promise<void> {
  for (const target of input.targets) {
    const [owner, name] = target.repository.split("/");
    const value = await input.store.read(backupCiSuspensionPath(owner, name));
    if (value === null) continue;
    const suspension = parseBackupCiSuspension(value);
    if (
      suspension.reason !== "false_green" || suspension.evidence === null ||
      (suspension.runnerIds !== "all" &&
        !suspension.runnerIds.includes(input.runnerId))
    ) continue;
    const file = await input.store.read(
      backupCiCommitPath(owner, name, suspension.evidence.commit),
    );
    const line = await probeBackupCiFalseGreen({
      repository: target.repository,
      suspension,
      file: file === null ? null : parseBackupCiCommitFile(file),
      reads: input.targetReads(owner, name),
    });
    if (line !== null) {
      input.log(line);
      return;
    }
  }
}
