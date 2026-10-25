/**
 * Pure merge rules of the backup CI receipt store (docs/backup-ci-spec.md §7).
 *
 * The only writer (the trusted `backup_ci` job, WP3) reads the store tip,
 * applies these rules to every file it touches and pushes one fast-forward
 * commit; on a rejected push it re-reads and re-applies them. Every rule is
 * therefore idempotent: re-applying the same changes to a tip that already
 * holds them changes nothing.
 *
 * - A `result` is final per (key, mode, runnerId); a later, different result
 *   for the same triple is dropped and logged `sentinel_backup_ci_conflict`.
 * - A `result` replaces the `dispatched` and non-final `no_evidence` entries
 *   of the same key and mode.
 * - A `no_evidence` event resolves the `dispatched` entry of its unit digest
 *   (none: it was already applied and is ignored), counts a leg only when one
 *   ran, and backs off (`BACKUP_CI_BACKOFF_MS` by legs run, else
 *   `BACKUP_CI_RETRY_MS`); `unsupported:*` is final with `nextAt: null`.
 * - Mode `evidence` entries are never satisfied by `shadow` entries: every
 *   rule matches on the mode class.
 * - Over the entry bound the oldest `no_evidence` entries go first, then the
 *   oldest `dispatched`; results are never evicted (a new result that does
 *   not fit is dropped and logged).
 */
import type { GitSha } from "../contracts/brands.ts";
import {
  BACKUP_CI_BACKOFF_MS,
  BACKUP_CI_CALIBRATION,
  BACKUP_CI_RETRY_MS,
  type BackupCiCalibrationSampleV1,
  type BackupCiCalibrationV1,
  type BackupCiCommitFileV1,
  type BackupCiDispatchedEntryV1,
  type BackupCiEntryKeyV1,
  backupCiEntrySortKey,
  type BackupCiEntryV1,
  backupCiModeClass,
  type BackupCiNoEvidenceEntryV1,
  type BackupCiNoEvidenceReasonV1,
  type BackupCiResultEntryV1,
  type BackupCiSuspensionV1,
  type BackupCiWorkflowCoverageV1,
  noEvidenceLegRan,
  parseBackupCiCalibration,
  parseBackupCiCommitFile,
  parseBackupCiSuspension,
  sameBackupCiKey,
} from "../contracts/backup-ci.ts";

export const BACKUP_CI_MAX_ENTRIES = 128;
export const BACKUP_CI_MAX_WORKFLOWS = 16;
export const BACKUP_CI_MAX_RUNNERS = 16;
export const BACKUP_CI_MAX_SAMPLES = 64;

type Repository = { owner: string; name: string; id: number };
type ModeClass = "shadow" | "evidence";

/** A no-evidence outcome to record (§9.2 step 8, §9.3 refusals, §12). */
export interface BackupCiNoEvidenceEventV1 {
  key: BackupCiEntryKeyV1;
  mode: ModeClass;
  runnerId: string;
  reason: BackupCiNoEvidenceReasonV1;
  at: number;
  /** The dispatched unit this resolves; null when nothing was dispatched. */
  unitDigest: string | null;
}

/** Everything one pass changes in one commit file. */
export interface BackupCiFileChangesV1 {
  repository: Repository;
  commit: GitSha;
  now: number;
  coverage?: readonly BackupCiWorkflowCoverageV1[];
  results?: readonly BackupCiResultEntryV1[];
  noEvidence?: readonly BackupCiNoEvidenceEventV1[];
  dispatched?: readonly BackupCiDispatchedEntryV1[];
}

const sameRepository = (a: Repository, b: Repository) =>
  a.owner === b.owner && a.name === b.name && a.id === b.id;

const ofClass = (
  entry: BackupCiEntryV1,
  key: BackupCiEntryKeyV1,
  m: ModeClass,
) => sameBackupCiKey(entry.key, key) && backupCiModeClass(entry.mode) === m;

function logLine(kind: string, fields: Record<string, unknown>): string {
  return `${kind} ${JSON.stringify(fields)}`;
}

function applyResult(
  entries: BackupCiEntryV1[],
  result: BackupCiResultEntryV1,
  log: string[],
): BackupCiEntryV1[] {
  const mode = backupCiModeClass(result.mode);
  const existing = entries.find((e) =>
    e.state === "result" && ofClass(e, result.key, mode) &&
    e.runnerId === result.runnerId
  ) as BackupCiResultEntryV1 | undefined;
  if (existing !== undefined) {
    if (
      existing.resultDigest !== result.resultDigest ||
      existing.unitDigest !== result.unitDigest
    ) {
      log.push(logLine("sentinel_backup_ci_conflict", {
        runnerId: result.runnerId,
        kept: existing.resultDigest,
        dropped: result.resultDigest,
      }));
    }
    return entries;
  }
  return [
    ...entries.filter((e) =>
      !(ofClass(e, result.key, mode) &&
        (e.state === "dispatched" || (e.state === "no_evidence" && !e.final)))
    ),
    result,
  ];
}

/** The next attempt time of a no-evidence entry (§7). */
export function backupCiNextAt(
  reason: BackupCiNoEvidenceReasonV1,
  legRuns: number,
  lastAt: number,
): number | null {
  if (reason.startsWith("unsupported:")) return null;
  if (!noEvidenceLegRan(reason)) return lastAt + BACKUP_CI_RETRY_MS;
  const step = Math.min(
    Math.max(legRuns - 1, 0),
    BACKUP_CI_BACKOFF_MS.length - 1,
  );
  return lastAt + BACKUP_CI_BACKOFF_MS[step];
}

function applyNoEvidence(
  entries: BackupCiEntryV1[],
  event: BackupCiNoEvidenceEventV1,
): BackupCiEntryV1[] {
  let next = entries;
  if (event.unitDigest !== null) {
    const dispatched = next.find((e) =>
      e.state === "dispatched" && e.unitDigest === event.unitDigest &&
      ofClass(e, event.key, event.mode) && e.runnerId === event.runnerId
    );
    // Already resolved (a re-applied event): counting it again would double
    // the leg count and the backoff.
    if (dispatched === undefined) return next;
    next = next.filter((e) => e !== dispatched);
  }
  if (
    next.some((e) => e.state === "result" && ofClass(e, event.key, event.mode))
  ) {
    return next;
  }
  const previous = next.find((e) =>
    e.state === "no_evidence" && ofClass(e, event.key, event.mode) &&
    e.runnerId === event.runnerId
  ) as BackupCiNoEvidenceEntryV1 | undefined;
  if (previous?.final === true) return next;
  const legRuns = (previous?.legRuns ?? 0) +
    (noEvidenceLegRan(event.reason) ? 1 : 0);
  const lastAt = Math.max(previous?.lastAt ?? event.at, event.at);
  const nextAt = backupCiNextAt(event.reason, legRuns, lastAt);
  const entry: BackupCiNoEvidenceEntryV1 = {
    state: "no_evidence",
    key: event.key,
    mode: event.mode,
    runnerId: event.runnerId,
    reason: event.reason,
    legRuns,
    firstAt: Math.min(previous?.firstAt ?? event.at, event.at),
    lastAt,
    nextAt,
    final: nextAt === null,
  };
  return [...next.filter((e) => e !== previous), entry];
}

function applyDispatched(
  entries: BackupCiEntryV1[],
  dispatched: BackupCiDispatchedEntryV1,
  log: string[],
): BackupCiEntryV1[] {
  const mode = backupCiModeClass(dispatched.mode);
  const blocked = entries.some((e) =>
    ofClass(e, dispatched.key, mode) &&
    ((e.state === "result" && e.runnerId === dispatched.runnerId) ||
      (e.state === "no_evidence" && e.final))
  );
  if (blocked) {
    log.push(logLine("sentinel_backup_ci_dispatch_ignored", {
      unitId: dispatched.unit.unitId,
    }));
    return entries;
  }
  return [
    ...entries.filter((e) =>
      !(e.state === "dispatched" && ofClass(e, dispatched.key, mode) &&
        e.runnerId === dispatched.runnerId)
    ),
    dispatched,
  ];
}

/** Evicts to the entry bound: oldest no-evidence, then oldest dispatched. */
function bound(
  entries: BackupCiEntryV1[],
  kept: ReadonlySet<string>,
  log: string[],
): BackupCiEntryV1[] {
  let next = entries;
  const evict = (state: "no_evidence" | "dispatched") => {
    const victims = next.filter((e) => e.state === state).sort((a, b) =>
      at(a) - at(b) ||
      backupCiEntrySortKey(a).localeCompare(backupCiEntrySortKey(b))
    );
    while (next.length > BACKUP_CI_MAX_ENTRIES && victims.length > 0) {
      const victim = victims.shift();
      next = next.filter((e) => e !== victim);
    }
  };
  evict("no_evidence");
  evict("dispatched");
  if (next.length > BACKUP_CI_MAX_ENTRIES) {
    // Only results remain: the ones this pass added and that do not fit are
    // dropped (an existing result is never evicted).
    const added = next.filter((e) => !kept.has(backupCiEntrySortKey(e)));
    while (next.length > BACKUP_CI_MAX_ENTRIES && added.length > 0) {
      const dropped = added.pop();
      next = next.filter((e) => e !== dropped);
      log.push(logLine("sentinel_backup_ci_dropped", {
        state: dropped?.state ?? null,
      }));
    }
  }
  return next;
}

function at(entry: BackupCiEntryV1): number {
  return entry.state === "no_evidence"
    ? entry.lastAt
    : entry.state === "dispatched"
    ? entry.dispatchedAt
    : entry.ingestedAt;
}

/**
 * Applies one pass's changes to one commit file (null: a new file). Throws
 * when the changes name another repository or commit than the file, and
 * re-parses the merged file so an invalid change never reaches a commit.
 */
export function mergeBackupCiFile(
  current: BackupCiCommitFileV1 | null,
  changes: BackupCiFileChangesV1,
): { file: BackupCiCommitFileV1; log: string[] } {
  if (
    current !== null &&
    (!sameRepository(current.repository, changes.repository) ||
      current.commit !== changes.commit)
  ) throw new Error("backup CI changes name another repository or commit");
  const log: string[] = [];
  let workflows = [...(current?.workflows ?? [])];
  for (const coverage of changes.coverage ?? []) {
    workflows = [
      ...workflows.filter((w) =>
        !(w.path === coverage.path && w.event === coverage.event)
      ),
      coverage,
    ];
  }
  workflows.sort((a, b) => b.observedAt - a.observedAt);
  workflows = workflows.slice(0, BACKUP_CI_MAX_WORKFLOWS).sort((a, b) =>
    a.path.localeCompare(b.path) || a.event.localeCompare(b.event)
  );
  let entries = [...(current?.entries ?? [])];
  const kept = new Set(entries.map(backupCiEntrySortKey));
  for (const result of changes.results ?? []) {
    entries = applyResult(entries, result, log);
  }
  for (const event of changes.noEvidence ?? []) {
    entries = applyNoEvidence(entries, event);
  }
  for (const dispatched of changes.dispatched ?? []) {
    entries = applyDispatched(entries, dispatched, log);
  }
  entries = bound(entries, kept, log);
  const file = parseBackupCiCommitFile({
    version: 1,
    kind: "sentinel_backup_ci_commit",
    repository: { ...changes.repository },
    commit: changes.commit,
    workflows,
    entries: entries.sort((a, b) => {
      const ka = backupCiEntrySortKey(a);
      const kb = backupCiEntrySortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    }),
    updatedAt: changes.now,
  });
  return { file, log };
}

/** One native/backup comparison of a final backup conclusion (§9.2 step 7). */
export interface BackupCiComparisonV1 {
  runnerId: string;
  sample: BackupCiCalibrationSampleV1;
  nativeCheckRunId: number;
  receipt: string;
}

/** A comparison that requires a suspension of its runner. */
export interface BackupCiDisagreementV1 {
  kind: "false_green" | "false_red";
  comparison: BackupCiComparisonV1;
}

function nativeClass(native: string): "success" | "red" | null {
  return native === "success"
    ? "success"
    : native === "failure" || native === "timed_out"
    ? "red"
    : null;
}

/**
 * Counts each comparison once per runner and (commit, check name): an
 * agreement within the same success or red class, a false green (backup
 * success, native red) or a false red (backup red, native success). Native
 * conclusions outside those classes are not comparable and are skipped. A
 * false green, and a false red once above `maxFalseReds`, is returned as a
 * disagreement for the caller's suspension. Pass only final conclusions
 * (attempt 1 success, or attempt 2).
 */
export function mergeCalibration(
  current: BackupCiCalibrationV1 | null,
  repository: Repository,
  comparisons: readonly BackupCiComparisonV1[],
  now: number,
): {
  calibration: BackupCiCalibrationV1;
  disagreements: BackupCiDisagreementV1[];
} {
  if (current !== null && !sameRepository(current.repository, repository)) {
    throw new Error("backup CI calibration names another repository");
  }
  const runners = (current?.runners ?? []).map((row) => ({
    ...row,
    samples: [...row.samples],
  }));
  const disagreements: BackupCiDisagreementV1[] = [];
  for (const comparison of comparisons) {
    const { sample } = comparison;
    const native = nativeClass(sample.native);
    if (native === null) continue;
    let row = runners.find((r) => r.runnerId === comparison.runnerId);
    if (row === undefined) {
      row = {
        runnerId: comparison.runnerId,
        agreements: 0,
        failureAgreements: 0,
        falseGreens: 0,
        falseReds: 0,
        samples: [],
      };
      runners.push(row);
    }
    if (
      row.samples.some((s) =>
        s.commit === sample.commit && s.checkName === sample.checkName
      )
    ) continue;
    const backup = sample.backup === "success" ? "success" : "red";
    if (backup === native) {
      row.agreements++;
      if (native === "red") row.failureAgreements++;
    } else if (backup === "success") {
      row.falseGreens++;
      disagreements.push({ kind: "false_green", comparison });
    } else {
      row.falseReds++;
      if (row.falseReds > BACKUP_CI_CALIBRATION.maxFalseReds) {
        disagreements.push({ kind: "false_red", comparison });
      }
    }
    row.samples = [...row.samples, { ...sample }].slice(-BACKUP_CI_MAX_SAMPLES);
  }
  const calibration = parseBackupCiCalibration({
    version: 1,
    kind: "sentinel_backup_ci_calibration",
    repository: { ...repository },
    runners: runners.slice(-BACKUP_CI_MAX_RUNNERS),
    updatedAt: now,
  });
  return { calibration, disagreements };
}

const REASON_RANK = { operator: 0, false_red: 1, false_green: 2 } as const;

/**
 * Adds a suspension: runner ids are unioned (`all` absorbs), `since` is the
 * earliest, and the more severe reason (false green, then false red, then
 * operator) keeps its evidence. Throws on a scope mismatch.
 */
export function mergeSuspension(
  current: BackupCiSuspensionV1 | null,
  change: Omit<BackupCiSuspensionV1, "version" | "kind">,
): BackupCiSuspensionV1 {
  if (current !== null && current.scope !== change.scope) {
    throw new Error("backup CI suspension names another scope");
  }
  const union = (a: string[] | "all", b: string[] | "all") =>
    a === "all" || b === "all" ? "all" : [...new Set([...a, ...b])].sort();
  const lead = current !== null &&
      REASON_RANK[change.reason] <= REASON_RANK[current.reason]
    ? current
    : change;
  return parseBackupCiSuspension({
    version: 1,
    kind: "sentinel_backup_ci_suspension",
    scope: change.scope,
    runnerIds: union(current?.runnerIds ?? [], change.runnerIds),
    reason: lead.reason,
    since: Math.min(current?.since ?? change.since, change.since),
    evidence: lead.evidence,
  });
}

/** Whether a suspension covers this target's runner (`o/n`, runner id). */
export function isBackupCiSuspended(
  suspensions: readonly BackupCiSuspensionV1[],
  repository: string,
  runnerId: string,
): boolean {
  return suspensions.some((s) =>
    (s.scope === "all" || s.scope === repository) &&
    (s.runnerIds === "all" || s.runnerIds.includes(runnerId))
  );
}
