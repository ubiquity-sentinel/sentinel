/**
 * Ingest of finished backup CI legs (docs/backup-ci-spec.md §9.2). Every
 * `dispatched` entry is resolved from the UNTRUSTED leg's run only through
 * checks a target cannot satisfy from inside the leg:
 *
 * 1. exactly one leg run with the trusted display title
 *    `sentinel-backup-ci-leg <unitId>`, of the leg workflow at the planned
 *    launcher SHA on `sentinel-backup-legs`, dispatched by
 *    `github-actions[bot]`, read through attempt 1;
 * 2. exactly one `leg` job, completed `success`, on a GitHub-hosted runner
 *    with exactly the unit's label, its four steps in order, completed
 *    `success`, inside the job window;
 * 3. exactly one marker line, inside the "Report the backup result" window,
 *    naming the stored unit and digest;
 * 4. the artifact the marker names (by id only), of that run, SHA and
 *    repository, named `backup-result-<unitId>`, unexpired and bounded, with
 *    one `result.json` whose sha256 is the marker's;
 * 5. a strict parse; the observed binding equals the unit's exec binding,
 *    the runner id the plan's, the timestamps the "Run the target job"
 *    window, and the outcome agrees with the steps (§10.4).
 *
 * A red keeps a sanitized excerpt of its failing step. A final conclusion is
 * compared with a native started run of the same group, if one exists, for
 * calibration. Each entry is ingested in its own try/catch, oldest first, at
 * most 32 per pass and 60 s per target.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  BACKUP_CI_LEG_MISSING_MS,
  BACKUP_CI_MAX_INGEST_PER_PASS,
  BACKUP_CI_TARGET_BUDGET_MS,
  type BackupCiDispatchedEntryV1,
  backupCiModeClass,
  type BackupCiNoEvidenceReasonV1,
  backupCiReceiptId,
  type BackupCiResultEntryV1,
} from "../src/contracts/backup-ci.ts";
import type {
  BackupCiComparisonV1,
  BackupCiNoEvidenceEventV1,
} from "../src/github/backup-ci-store.ts";
import {
  type BackupCiComparisonClassV1,
  type BackupCiNativeEvidenceV1,
  classifyBackupCiComparison,
  readBackupCiNativeEvidence,
} from "./backup-ci-compare.ts";
import {
  type BackupCiLegReadsV1,
  unzipBackupCiResult,
} from "./backup-ci-ingest-reads.ts";
import {
  artifactBinds,
  backupCiFailureExcerpt,
  backupCiLogLines,
  findBackupCiMarker,
  legRunBinds,
  verifyBackupCiResult,
  verifyLegJob,
} from "./backup-ci-ingest-verify.ts";
import type { BackupCiTargetReadsV1 } from "./backup-ci-plan-reads.ts";

export const BACKUP_CI_STUCK_EXTRA_MS = 30 * 60_000;
export const BACKUP_CI_LOG_RETRIES = 2;

type Reason = BackupCiNoEvidenceReasonV1;
const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
export type BackupCiIngestOutcomeV1 =
  | { kind: "pending" }
  | {
    kind: "result";
    entry: BackupCiResultEntryV1;
    comparison: BackupCiComparisonV1 | null;
  }
  | { kind: "no_evidence"; event: BackupCiNoEvidenceEventV1 };

export interface BackupCiIngestItemV1 {
  repository: { owner: string; name: string; id: number };
  commit: GitSha;
  entry: BackupCiDispatchedEntryV1;
}

export interface BackupCiIngestDepsV1 {
  legs: BackupCiLegReadsV1;
  sentinelId: number;
  targetReads(owner: string, name: string): BackupCiTargetReadsV1 | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  log(line: string): void;
}

/**
 * The native run a result of `item` binds to (event, merge base, job), or
 * null; any read failure is null (no comparison).
 */
async function nativeEvidence(
  deps: BackupCiIngestDepsV1,
  item: BackupCiIngestItemV1,
): Promise<BackupCiNativeEvidenceV1 | null> {
  const reads = deps.targetReads(item.repository.owner, item.repository.name);
  if (reads === null) return null;
  return await readBackupCiNativeEvidence(reads, item.entry.unit);
}

/** Resolves one dispatched entry (§9.2 steps 1-8). */
export async function ingestBackupCiEntry(
  deps: BackupCiIngestDepsV1,
  item: BackupCiIngestItemV1,
): Promise<BackupCiIngestOutcomeV1> {
  const { entry } = item;
  const unit = entry.unit;
  const now = deps.now();
  const none = (reason: Reason): BackupCiIngestOutcomeV1 => ({
    kind: "no_evidence",
    event: {
      key: entry.key,
      mode: backupCiModeClass(entry.mode),
      runnerId: entry.runnerId,
      reason,
      at: now,
      unitDigest: entry.unitDigest,
    },
  });
  const listed = await deps.legs.legRuns(entry.dispatchedAt - 60_000);
  if (listed === null) return { kind: "pending" };
  const titled = listed.filter((r) =>
    r.display_title === `sentinel-backup-ci-leg ${unit.unitId}`
  );
  if (titled.length > 1) {
    deps.log(
      `sentinel_backup_ci_security ${
        JSON.stringify({ unitId: unit.unitId, runs: titled.length })
      }`,
    );
    return none("binding_mismatch");
  }
  if (titled.length === 0) {
    return now - entry.dispatchedAt >= BACKUP_CI_LEG_MISSING_MS
      ? none("leg_missing")
      : { kind: "pending" };
  }
  if (!legRunBinds(titled[0], unit)) return none("binding_mismatch");
  const runId = posInt(titled[0].id)!;
  const attempt = await deps.legs.attempt(runId);
  if (attempt === null) return { kind: "pending" };
  if (
    !legRunBinds(attempt, unit) || attempt.id !== runId ||
    attempt.run_attempt !== 1
  ) {
    return none("binding_mismatch");
  }
  if (attempt.status !== "completed") {
    const limit = entry.dispatchedAt +
      (unit.job.capMinutes + 10) * 60_000 + BACKUP_CI_STUCK_EXTRA_MS;
    if (now < limit) return { kind: "pending" };
    await deps.legs.cancel(runId);
    return none("leg_stuck");
  }
  const jobs = await deps.legs.jobs(runId);
  if (jobs === null) return { kind: "pending" };
  const job = verifyLegJob(jobs, unit);
  if (!job.ok) return none(job.reason);
  let text: string | null = null;
  for (let i = 0; i <= BACKUP_CI_LOG_RETRIES && text === null; i++) {
    if (i > 0) await deps.sleep(2_000);
    const read = await deps.legs.log(job.jobId);
    // "unserved" is GitHub's 404 for a log not stored yet, not a log.
    text = read === "unserved" ? null : read;
  }
  if (text === null) return none("log_unserved");
  const lines = backupCiLogLines(text);
  const marker = findBackupCiMarker(
    lines,
    unit,
    entry.unitDigest,
    job.steps["Report the backup result"],
  );
  if (typeof marker === "string") return none(marker);
  const meta = await deps.legs.artifact(marker.artifactId);
  if (meta === null) return none("artifact_missing");
  if (!artifactBinds(meta, marker, runId, unit, deps.sentinelId)) {
    return none("artifact_invalid");
  }
  const zip = await deps.legs.artifactZip(marker.artifactId);
  if (zip === null) return none("artifact_missing");
  const bytes = await unzipBackupCiResult(zip);
  if (bytes === null) return none("artifact_invalid");
  const runWindow = job.steps["Run the target job"];
  const result = verifyBackupCiResult(bytes, marker, unit, runWindow);
  if (typeof result === "string") return none(result);
  if (result.outcome === "no_evidence") return none(result.reason!);
  const red = result.outcome !== "success";
  const evidence = await nativeEvidence(deps, item).catch(() => null);
  const native = evidence === null
    ? null
    : { checkRunId: evidence.checkRunId, conclusion: evidence.conclusion };
  const resultEntry: BackupCiResultEntryV1 = {
    state: "result",
    key: entry.key,
    mode: backupCiModeClass(entry.mode),
    runnerId: entry.runnerId,
    purpose: unit.purpose,
    conclusion: result.outcome,
    unitDigest: entry.unitDigest,
    resultDigest: marker.resultDigest,
    startedAt: result.startedAt,
    completedAt: result.completedAt,
    binding: {
      execCommit: unit.exec.commit,
      parents: [...unit.exec.parents],
      tree: unit.exec.tree,
      workflowBlob: unit.workflow.blob,
      jobKey: unit.job.key,
      matrix: unit.job.matrix,
    },
    leg: {
      runId,
      jobId: job.jobId,
      artifactId: marker.artifactId,
      launcherSha: unit.plan.launcherSha,
    },
    native,
    failure: red && result.failingStep !== null
      ? {
        stepIndex: result.failingStep,
        excerpt: backupCiFailureExcerpt(lines, result.failingStep, runWindow),
      }
      : null,
    ingestedAt: now,
  };
  const final = entry.key.attempt === 2 || !red;
  const repo = `${item.repository.owner}/${item.repository.name}`;
  const receipt = backupCiReceiptId(repo, unit.commit, entry.key);
  let comparison: BackupCiComparisonV1 | null = null;
  if (evidence !== null && final) {
    // A planned native run (peers, calibration) was read as started when it
    // was planned; an unreadable job then still counts for a false green.
    const job = evidence.job ?? (unit.native === null ? null : {
      conclusion: evidence.conclusion,
      neverStarted: false,
      failingStep: null,
    });
    const verdict = classifyBackupCiComparison({
      nativeEvent: evidence.event,
      native: job === null ? null : { ...job, conclusion: evidence.conclusion },
      nativeMerge: evidence.merge,
      context: entry.key.context,
      commit: unit.commit,
      base: entry.key.base,
      backup: {
        conclusion: result.outcome,
        failingStep: result.failingStep,
        excerpt: resultEntry.failure?.excerpt ?? null,
      },
    });
    if (verdict.kind === "incomparable") {
      deps.log(
        `sentinel_backup_ci_incomparable ${
          JSON.stringify({ receipt, reason: verdict.reason })
        }`,
      );
    } else {
      comparison = backupCiComparison(
        verdict.class,
        entry,
        evidence,
        result.outcome,
        receipt,
      );
      if (verdict.class === "false_green" || verdict.class === "false_red") {
        deps.log(`sentinel_backup_ci_disagreement ${
          JSON.stringify({
            receipt,
            native: evidence.conclusion,
            backup: result.outcome,
          })
        }`);
      }
    }
  }
  return { kind: "result", entry: resultEntry, comparison };
}

/**
 * The comparison of a classified result: its sample spells the class in
 * the native/backup conclusions `mergeCalibration` counts, and it carries
 * the key and class the per-check calibration counts.
 */
function backupCiComparison(
  cls: BackupCiComparisonClassV1,
  entry: BackupCiDispatchedEntryV1,
  evidence: BackupCiNativeEvidenceV1,
  backup: BackupCiResultEntryV1["conclusion"],
  receipt: string,
): BackupCiComparisonV1 {
  const sample = cls === "green"
    ? { native: "success", backup: "success" as const }
    : cls === "red"
    ? { native: "failure", backup: "failure" as const }
    : cls === "false_green"
    ? { native: evidence.conclusion, backup: "success" as const }
    : { native: "success", backup };
  return {
    runnerId: entry.runnerId,
    sample: {
      commit: entry.unit.commit,
      checkName: entry.key.checkName,
      ...sample,
    },
    nativeCheckRunId: evidence.checkRunId,
    receipt,
    key: {
      context: entry.key.context,
      workflowPath: entry.key.workflowPath,
      checkName: entry.key.checkName,
      base: entry.key.base,
    },
    class: cls,
  };
}

/**
 * Every dispatched entry, oldest first, at most 32 per pass and 60 s per
 * target; one entry's failure is its own `ingest_error` (no leg counted).
 */
export async function ingestBackupCi(
  deps: BackupCiIngestDepsV1,
  items: readonly BackupCiIngestItemV1[],
): Promise<{ item: BackupCiIngestItemV1; outcome: BackupCiIngestOutcomeV1 }[]> {
  const ordered = [...items].sort((a, b) =>
    a.entry.dispatchedAt - b.entry.dispatchedAt ||
    (a.entry.unit.unitId < b.entry.unit.unitId ? -1 : 1)
  ).slice(0, BACKUP_CI_MAX_INGEST_PER_PASS);
  const started = new Map<string, number>();
  const out: {
    item: BackupCiIngestItemV1;
    outcome: BackupCiIngestOutcomeV1;
  }[] = [];
  for (const item of ordered) {
    const target = `${item.repository.owner}/${item.repository.name}`;
    const first = started.get(target) ?? deps.now();
    started.set(target, first);
    if (deps.now() - first > BACKUP_CI_TARGET_BUDGET_MS) {
      out.push({ item, outcome: { kind: "pending" } });
      continue;
    }
    let outcome: BackupCiIngestOutcomeV1;
    try {
      outcome = await ingestBackupCiEntry(deps, item);
    } catch {
      outcome = {
        kind: "no_evidence",
        event: {
          key: item.entry.key,
          mode: backupCiModeClass(item.entry.mode),
          runnerId: item.entry.runnerId,
          reason: "ingest_error",
          at: deps.now(),
          unitDigest: item.entry.unitDigest,
        },
      };
    }
    out.push({ item, outcome });
  }
  return out;
}
