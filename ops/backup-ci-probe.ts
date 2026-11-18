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
 *
 * The native run is completed and immutable, so a complete answer is read
 * once and remembered (2026-11-18 review): the commit step stores it in
 * `v1/<owner>/<repo>/probe.json` (a new file older code never reads), and
 * later passes log the stored facts without any target read.
 *
 * Version 2 (2026-11-18 review): the leg's synthetic merge carries the
 * head's own tree, so the push run and the leg tested the same tree; the
 * probe therefore also reports the native `pull_request`-event runs of the
 * same check on that commit (at most three, oldest first: started,
 * conclusion, failing step number, the merge base their checkout logged).
 * A stored version 1 answer is read once more and replaced, then replayed.
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
import { canonicalStringify } from "../src/contracts/canonical.ts";
import { completedJobNeverStarted } from "../src/github/never-started-job.ts";
import { backupCiNativeMergeParents } from "./backup-ci-compare.ts";
import type { BackupCiTargetReadsV1 } from "./backup-ci-plan-reads.ts";

type Obj = Record<string, unknown>;
const row = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : null;

/** One native pull_request-event run of the evidence's check (closed). */
export interface BackupCiProbePullRunV2 {
  started: boolean | null;
  conclusion: string | null;
  failingStep: number | null;
  base12: string | null;
}

/** At most this many pull_request runs are read (a job and a log each). */
export const BACKUP_CI_PROBE_MAX_PULL_RUNS = 3;
/** The record version this code writes (and replays without a read). */
export const BACKUP_CI_PROBE_VERSION = 2;

/** The closed facts of one probe (hex, enum, integer and boolean only). */
export interface BackupCiProbeFactsV1 {
  receipt: string;
  legContext: "push" | "pull_request" | null;
  nativeEvent: string | null;
  nativeStarted: boolean | null;
  nativeConclusion: string | null;
  nativeFailingStep: number | null;
  legBase12: string | null;
  nativeBase12: string | null;
  sameBase: boolean | null;
  /**
   * Version 2: the native pull_request-event runs of the same check on the
   * commit (empty: none); null when the listings were unreadable. Absent in
   * a version 1 record.
   */
  pullRequestRuns?: BackupCiProbePullRunV2[] | null;
}

/** v1/<owner>/<repo>/probe.json: the remembered answer of one suspension. */
export interface BackupCiProbeRecordV1 {
  version: 1 | 2;
  kind: "sentinel_backup_ci_probe";
  nativeCheckRunId: number;
  facts: BackupCiProbeFactsV1;
  probedAt: number;
}

export function backupCiProbePath(owner: string, repo: string): string {
  return `v1/${owner}/${repo}/probe.json`;
}

const FACT_KEYS = [
  "receipt",
  "legContext",
  "nativeEvent",
  "nativeStarted",
  "nativeConclusion",
  "nativeFailingStep",
  "legBase12",
  "nativeBase12",
  "sameBase",
] as const;
const WORD_RE = /^[a-z_]{1,32}$/;
const HEX12_RE = /^[0-9a-f]{12}$/;
const RECEIPT_RE = /^bci1:[A-Za-z0-9._\/@#:-]{1,400}$/;

/** Strict parse of `probe.json` (throws on any other shape). */
export function parseBackupCiProbeRecord(
  input: unknown,
): BackupCiProbeRecordV1 {
  const fail = (what: string): never => {
    throw new Error(`invalid backup CI probe record: ${what}`);
  };
  const o = row(input) ?? fail("record");
  const keys = Object.keys(o).sort().join();
  if (keys !== "facts,kind,nativeCheckRunId,probedAt,version") fail("keys");
  if (
    (o.version !== 1 && o.version !== 2) ||
    o.kind !== "sentinel_backup_ci_probe"
  ) fail("kind");
  const version = o.version as 1 | 2;
  const id = o.nativeCheckRunId;
  const at = o.probedAt;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    fail("nativeCheckRunId");
  }
  if (typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) {
    fail("probedAt");
  }
  const f = row(o.facts) ?? fail("facts");
  const factKeys = version === 1
    ? [...FACT_KEYS]
    : [...FACT_KEYS, "pullRequestRuns"];
  if (Object.keys(f).sort().join() !== factKeys.sort().join()) {
    fail("fact keys");
  }
  const nullable = <T>(v: unknown, ok: (x: unknown) => boolean): T | null =>
    v === null ? null : ok(v) ? v as T : fail("fact");
  const word = (v: unknown) => typeof v === "string" && WORD_RE.test(v);
  const hex = (v: unknown) => typeof v === "string" && HEX12_RE.test(v);
  const bool = (v: unknown) => typeof v === "boolean";
  if (typeof f.receipt !== "string" || !RECEIPT_RE.test(f.receipt)) {
    fail("receipt");
  }
  const facts: BackupCiProbeFactsV1 = {
    receipt: f.receipt as string,
    legContext: nullable(
      f.legContext,
      (v) => v === "push" || v === "pull_request",
    ),
    nativeEvent: nullable(f.nativeEvent, word),
    nativeStarted: nullable(f.nativeStarted, bool),
    nativeConclusion: nullable(f.nativeConclusion, word),
    nativeFailingStep: nullable(
      f.nativeFailingStep,
      (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
    ),
    legBase12: nullable(f.legBase12, hex),
    nativeBase12: nullable(f.nativeBase12, hex),
    sameBase: nullable(f.sameBase, bool),
  };
  if (version === 2) {
    const runs = f.pullRequestRuns;
    if (runs !== null) {
      if (!Array.isArray(runs) || runs.length > BACKUP_CI_PROBE_MAX_PULL_RUNS) {
        fail("pullRequestRuns");
      }
      facts.pullRequestRuns = (runs as unknown[]).map((v) => {
        const r = row(v) ?? fail("pull request run");
        if (
          Object.keys(r).sort().join() !==
            "base12,conclusion,failingStep,started"
        ) fail("pull request run keys");
        return {
          started: nullable(r.started, bool),
          conclusion: nullable(r.conclusion, word),
          failingStep: nullable(
            r.failingStep,
            (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0,
          ),
          base12: nullable(r.base12, hex),
        };
      });
    } else facts.pullRequestRuns = null;
  }
  return {
    version,
    kind: "sentinel_backup_ci_probe",
    nativeCheckRunId: id as number,
    facts,
    probedAt: at as number,
  };
}

/** The log line of a probe's facts (the same line, read or remembered). */
export function backupCiProbeLine(facts: BackupCiProbeFactsV1): string {
  const ordered: Record<string, unknown> = Object.fromEntries(
    FACT_KEYS.map((k) => [k, facts[k]]),
  );
  if (facts.pullRequestRuns !== undefined) {
    ordered.pullRequestRuns = facts.pullRequestRuns === null
      ? null
      : facts.pullRequestRuns.map((r) => ({
        started: r.started,
        conclusion: r.conclusion,
        failingStep: r.failingStep,
        base12: r.base12,
      }));
  }
  return `sentinel_backup_ci_false_green_probe ${JSON.stringify(ordered)}`;
}

/** One closed probe line for the suspension's evidence, or null. */
export async function probeBackupCiFalseGreen(input: {
  repository: string;
  suspension: BackupCiSuspensionV1;
  /** The store file of the evidence commit (the leg's own key). */
  file: BackupCiCommitFileV1 | null;
  reads: BackupCiTargetReadsV1;
}): Promise<string | null> {
  const facts = await probeBackupCiFalseGreenFacts(input);
  return facts === null ? null : backupCiProbeLine(facts);
}

/** The closed facts of the suspension's evidence, or null. */
export async function probeBackupCiFalseGreenFacts(input: {
  repository: string;
  suspension: BackupCiSuspensionV1;
  file: BackupCiCommitFileV1 | null;
  reads: BackupCiTargetReadsV1;
}): Promise<BackupCiProbeFactsV1 | null> {
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
  const word = (v: unknown) =>
    typeof v === "string" && WORD_RE.test(v) ? v : null;
  // Version 2: the native pull_request-event runs of the same check on the
  // same commit, oldest first, at most three (a job and a log read each).
  const suiteEvent = (r: Record<string, unknown> | undefined) =>
    suites?.find((s) => s.suiteId === row(r?.check_suite)?.id)?.event;
  const pullIds = runs === null || suites === null ? null : runs
    .filter((r) =>
      r.name === evidence.checkName && r.id !== evidence.nativeCheckRunId &&
      typeof r.id === "number" && Number.isSafeInteger(r.id) && r.id > 0 &&
      suiteEvent(r) === "pull_request"
    )
    .map((r) => r.id as number)
    .sort((a, b) => a - b)
    .slice(-BACKUP_CI_PROBE_MAX_PULL_RUNS);
  const pullRequestRuns = pullIds === null ? null : await Promise.all(
    pullIds.map(async (id): Promise<BackupCiProbePullRunV2> => {
      const pullJob = await input.reads.job(id);
      const pullBody = row(pullJob);
      const never = pullJob === null
        ? null
        : completedJobNeverStarted(pullJob, id, evidence.commit);
      const pullSteps = Array.isArray(pullBody?.steps)
        ? pullBody.steps.map(row)
        : [];
      const step = pullSteps.find((s) => s?.conclusion === "failure")?.number;
      const log = input.reads.jobLogPrefix === undefined || never !== false
        ? null
        : await input.reads.jobLogPrefix(id);
      const merge = log === null ? "unbound" : backupCiNativeMergeParents(log);
      return {
        started: never === null ? null : !never,
        conclusion: word(pullBody?.conclusion),
        failingStep: typeof step === "number" && Number.isSafeInteger(step) &&
            step > 0
          ? step
          : null,
        base12: merge === "unbound" || merge.head !== evidence.commit
          ? null
          : merge.base.slice(0, 12),
      };
    }),
  );
  return {
    receipt: evidence.receipt,
    legContext: leg?.key.context ?? null,
    nativeEvent: word(suite?.event),
    nativeStarted: started === null ? null : !started,
    nativeConclusion: word(body?.conclusion),
    nativeFailingStep: typeof failing === "number" ? failing : null,
    legBase12: legBase?.slice(0, 12) ?? null,
    nativeBase12: nativeBase?.slice(0, 12) ?? null,
    sameBase: legBase === null || nativeBase === null
      ? null
      : legBase === nativeBase,
    pullRequestRuns,
  };
}

/**
 * A complete answer is worth remembering: the run was found, its job read
 * and its conclusion final. A missing merge base (an expired or unreadable
 * log) never improves later, so it does not keep the probe re-reading.
 */
function complete(facts: BackupCiProbeFactsV1): boolean {
  return facts.nativeEvent !== null && facts.nativeStarted !== null &&
    facts.nativeConclusion !== null &&
    Array.isArray(facts.pullRequestRuns) &&
    facts.pullRequestRuns.every((r) =>
      r.started !== null && r.conclusion !== null
    );
}

/**
 * The first false-green suspension of `runnerId` among the targets' own
 * suspension files (local store reads), probed once: at most one probe line
 * per pass, and only while that runner is excluded. A remembered answer for
 * the same evidence is logged again without a target read; a fresh complete
 * answer is returned for the commit step to remember.
 */
export async function probeExcludedBackupCiRunner(input: {
  runnerId: string;
  targets: readonly { repository: string }[];
  store: { read(path: string): Promise<unknown | null> };
  targetReads(owner: string, name: string): BackupCiTargetReadsV1;
  log(line: string): void;
  now?(): number;
}): Promise<{ repository: string; record: BackupCiProbeRecordV1 } | null> {
  for (const target of input.targets) {
    const [owner, name] = target.repository.split("/");
    const value = await input.store.read(backupCiSuspensionPath(owner, name));
    if (value === null) continue;
    const suspension = parseBackupCiSuspension(value);
    const evidence = suspension.evidence;
    if (
      suspension.reason !== "false_green" || evidence === null ||
      (suspension.runnerIds !== "all" &&
        !suspension.runnerIds.includes(input.runnerId))
    ) continue;
    const stored = await input.store.read(backupCiProbePath(owner, name))
      .then((v) => v === null ? null : parseBackupCiProbeRecord(v))
      .catch(() => null);
    // A version 1 answer lacks the pull_request runs: read once more.
    if (
      stored !== null && stored.version === BACKUP_CI_PROBE_VERSION &&
      stored.facts.receipt === evidence.receipt &&
      stored.nativeCheckRunId === evidence.nativeCheckRunId
    ) {
      input.log(backupCiProbeLine(stored.facts));
      input.log("backup-ci:probe:remembered");
      return null;
    }
    const file = await input.store.read(
      backupCiCommitPath(owner, name, evidence.commit),
    );
    const facts = await probeBackupCiFalseGreenFacts({
      repository: target.repository,
      suspension,
      file: file === null ? null : parseBackupCiCommitFile(file),
      reads: input.targetReads(owner, name),
    });
    if (facts === null) continue;
    input.log(backupCiProbeLine(facts));
    if (!complete(facts)) return null;
    return {
      repository: target.repository,
      record: parseBackupCiProbeRecord(JSON.parse(canonicalStringify({
        version: BACKUP_CI_PROBE_VERSION,
        kind: "sentinel_backup_ci_probe",
        nativeCheckRunId: evidence.nativeCheckRunId,
        facts,
        probedAt: input.now?.() ?? 0,
      }))),
    };
  }
  return null;
}
