/**
 * The one adapter between GitHub's listings and the backup CI stand-in rule
 * (docs/backup-ci-spec.md §6.3, §11, §19), shared by the runtime check read
 * (`client-backup-ci.ts`) and the launcher (`ops/hosted-autonomy-backup-ci-read.ts`)
 * so both layers judge identical evidence.
 *
 * - WP0's never-started rule (`never-started-job.ts`: a failed GitHub
 *   Actions run whose exact job reports no step and no runner) is adapted to
 *   the observation's `notStarted: boolean | null`. Only a failed Actions run
 *   needs its job read; every other run started (or is still going) and is
 *   `false`; an unreadable job, or one past the read bound, is `null`
 *   (unknown, which the rule treats as started: fail closed).
 * - A workflow run listing (`GET /actions/runs?head_sha`) maps each check
 *   suite to its workflow path and event; a run of another commit maps
 *   nothing, so its observations read as an unknown suite.
 * - The store read is bounded in time: a read that does not settle within
 *   `BACKUP_CI_READ_BUDGET_MS` is `unavailable`, so a slow store never holds
 *   a gate, and any non-`ok` read substitutes nothing.
 */
import type { GitSha } from "../contracts/brands.ts";
import type {
  BackupCiCommitFileV1,
  BackupCiModeV1,
  BackupCiTargetV1,
} from "../contracts/backup-ci.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import type { BackupCiReaderV1, BackupCiReadV1 } from "./backup-ci-reader.ts";
import {
  type BackupCiObservationV1,
  type BackupCiSelectionV1,
  type BackupCiSuiteV1,
  selectBackupStandIns,
} from "./backup-ci-substitute.ts";
import { trustedCheckName } from "../repair/ci-rejection.ts";
import {
  ACTIONS_APP_SLUG,
  type ActionsJobReadV1,
  completedJobNeverStarted,
  failedActionsJobId,
} from "./never-started-job.ts";

/** The consumer configuration both layers are composed with (§11.8). */
export interface BackupCiConsumerV1 {
  readonly reader: BackupCiReaderV1;
  readonly mode: BackupCiModeV1;
  /** Per-process reuse of supporting listings; absent, each read lists. */
  readonly listings?: BackupCiListingCache;
  /** Advisory sink; the process log (`BACKUP_CI_PROCESS_LOG`) by default. */
  readonly log?: BackupCiLogV1;
}

/** Job reads one backup classification may spend (verdicts are cached). */
export const BACKUP_CI_MAX_JOB_READS = 32;

/** Whole-read bound on one store read before it counts as unavailable. */
export const BACKUP_CI_READ_BUDGET_MS = 30_000;

/**
 * How long one commit's `filter=all` and workflow-run listings are reused.
 * Reuse can only refuse: an attempt or suite newer than the cached listing
 * shows up in the caller's fresh listing under an id the cache lacks (the
 * rule's `listing` / `unknown_suite` refusals), a name the cache lacks only
 * fails coverage, and a completed run's suite, path, event and start verdict
 * never change. Commit statuses are never reused: a new status could only
 * add a refusal, so it is always read fresh.
 */
export const BACKUP_CI_LISTING_TTL_MS = 60_000;

/** Commits one listing cache holds. */
const LISTING_CACHE_MAX = 256;

/** Per-process reuse of one commit's supporting listings (see the TTL). */
export class BackupCiListingCache {
  private readonly entries = new Map<
    string,
    { at: number; value: readonly unknown[] }
  >();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs: number = BACKUP_CI_LISTING_TTL_MS,
  ) {}

  async read(
    key: string,
    load: () => Promise<readonly unknown[] | null>,
  ): Promise<readonly unknown[] | null> {
    const at = this.now();
    const hit = this.entries.get(key);
    if (hit !== undefined && at >= hit.at && at - hit.at < this.ttlMs) {
      return hit.value;
    }
    const value = await load();
    if (value === null) return null;
    this.entries.delete(key);
    if (this.entries.size >= LISTING_CACHE_MAX) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { at, value });
    return value;
  }
}

/** Completed-job verdicts one cache keeps (the never-started rule's bound). */
const VERDICT_CACHE_MAX = 256;

/** Distinct log lines one process prints at most. */
const LOGGED_MAX = 4_096;

const RED = new Set(["failure", "timed_out"]);

function row(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function instant(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A raw check run's id, or null when it has no usable one. */
export function rawCheckRunId(raw: unknown): number | null {
  return positiveId(row(raw)?.id);
}

/** A raw check run's app slug, or null. */
function appSlug(raw: Record<string, unknown>): string | null {
  const slug = row(raw.app)?.slug;
  return typeof slug === "string" ? slug : null;
}

/** A completed GitHub Actions run (any conclusion). */
export function isCompletedActionsRun(raw: unknown): boolean {
  const run = row(raw);
  return run !== null && appSlug(run) === ACTIONS_APP_SLUG &&
    run.status === "completed";
}

/** A completed GitHub Actions run that ended `failure` or `timed_out`. */
export function isRedActionsRun(raw: unknown): boolean {
  return isCompletedActionsRun(raw) &&
    RED.has(String((raw as Record<string, unknown>).conclusion));
}

/**
 * The rule's observation of one raw check run of `head`, or null when the run
 * is malformed or bound to another commit (the caller then substitutes
 * nothing for the whole commit).
 */
export function backupCiObservation(
  raw: unknown,
  head: string,
  notStarted: boolean | null,
): BackupCiObservationV1 | null {
  const run = row(raw);
  const checkRunId = positiveId(run?.id);
  if (
    run === null || checkRunId === null || run.head_sha !== head ||
    typeof run.name !== "string" || run.name.length === 0 ||
    typeof run.status !== "string"
  ) return null;
  const suite = row(run.check_suite);
  return {
    checkRunId,
    name: run.name,
    app: appSlug(run),
    suiteId: positiveId(suite?.id),
    status: run.status,
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    startedAt: instant(run.started_at),
    completedAt: instant(run.completed_at),
    notStarted,
  };
}

/** Check suite → workflow path and event, from the head's workflow runs. */
export function backupCiSuites(
  runs: readonly unknown[],
  head: string,
): BackupCiSuiteV1[] {
  const suites = new Map<number, BackupCiSuiteV1 | null>();
  for (const value of runs) {
    const run = row(value);
    const suiteId = positiveId(run?.check_suite_id);
    if (run === null || suiteId === null || run.head_sha !== head) continue;
    const workflowPath = run.path;
    const event = run.event;
    if (typeof workflowPath !== "string" || typeof event !== "string") {
      continue;
    }
    const previous = suites.get(suiteId);
    // One suite naming two workflows or events is contradictory: unmapped.
    suites.set(
      suiteId,
      previous === undefined ||
        (previous !== null && previous.workflowPath === workflowPath &&
          previous.event === event)
        ? { suiteId, workflowPath, event }
        : null,
    );
  }
  return [...suites.values()].filter((suite) => suite !== null);
}

/**
 * `notStarted` for each raw check run of `head` whose name is in `names`, by
 * check run id. A failed Actions run costs one job read unless `cache` (keyed
 * `<jobId>:<head>` like the never-started rule's own) already holds its
 * verdict; at most `maxReads` jobs are read, and a job past the bound, an
 * unreadable job and a mismatched job are `null` (only a definite verdict is
 * cached).
 */
export async function classifyNeverStarted(
  raws: readonly unknown[],
  head: string,
  names: ReadonlySet<string>,
  readJob: ActionsJobReadV1,
  cache: Map<string, boolean>,
  maxReads: number = BACKUP_CI_MAX_JOB_READS,
): Promise<Map<number, boolean | null>> {
  const verdicts = new Map<number, boolean | null>();
  let reads = 0;
  for (const raw of raws) {
    const run = row(raw);
    const id = positiveId(run?.id);
    if (
      run === null || id === null || verdicts.has(id) ||
      !names.has(String(run.name))
    ) continue;
    const jobId = failedActionsJobId(run);
    if (jobId === null) {
      verdicts.set(id, false);
      continue;
    }
    const key = `${jobId}:${head}`;
    let verdict: boolean | null = cache.get(key) ?? null;
    if (verdict === null && reads < maxReads) {
      reads++;
      let body: unknown = null;
      try {
        body = await readJob(jobId);
      } catch {
        body = null;
      }
      verdict = completedJobNeverStarted(body, jobId, head);
      if (verdict !== null && cache.size < VERDICT_CACHE_MAX) {
        cache.set(key, verdict);
      }
    }
    verdicts.set(id, verdict);
  }
  return verdicts;
}

/**
 * One store read for `sha`, bounded by `budgetMs`: anything that does not
 * settle in time, or throws, is `unavailable`.
 */
export async function readBackupCiStore(
  reader: BackupCiReaderV1,
  repository: RepositoryIdentityV1,
  sha: GitSha,
  budgetMs: number = BACKUP_CI_READ_BUDGET_MS,
): Promise<BackupCiReadV1> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<BackupCiReadV1>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ kind: "unavailable", detail: "backup CI store read late" }),
      budgetMs,
    );
  });
  try {
    return await Promise.race([reader.read(repository, sha), late]);
  } catch {
    return { kind: "unavailable", detail: "backup CI store read failed" };
  } finally {
    clearTimeout(timer);
  }
}

/** One commit's listings and its `ok` store read, as both layers supply them. */
export interface BackupCiCommitInputV1 {
  mode: BackupCiModeV1;
  target: BackupCiTargetV1;
  sha: GitSha;
  store: Extract<BackupCiReadV1, { kind: "ok" }>;
  /** The listing the caller returns (default filter, possibly name-filtered). */
  latest: readonly unknown[];
  /** `filter=all` check runs: every attempt; null when unreadable. */
  listAll(): Promise<readonly unknown[] | null>;
  /** `GET /actions/runs?head_sha`; null when unreadable. */
  listRuns(): Promise<readonly unknown[] | null>;
  /** Every commit status context of the commit; null when unreadable. */
  statusContexts(): Promise<ReadonlySet<string> | null>;
  readJob: ActionsJobReadV1;
  verdicts: Map<string, boolean>;
}

/** The selection for one commit and the file it was made from. */
export interface BackupCiCommitSelectionV1 {
  selection: BackupCiSelectionV1;
  file: BackupCiCommitFileV1;
}

/**
 * The shared stand-in rule over one commit's live observations: null (no
 * substitution) when the store holds no file for the commit, when any listing
 * is unreadable, or when any observation is malformed or bound elsewhere.
 */
export async function selectBackupCiForCommit(
  input: BackupCiCommitInputV1,
): Promise<BackupCiCommitSelectionV1 | null> {
  const file = input.store.file;
  if (file === null) return null;
  const all = await input.listAll();
  if (all === null) return null;
  const runs = await input.listRuns();
  if (runs === null) return null;
  const statusContexts = await input.statusContexts();
  if (statusContexts === null) return null;
  const names = new Set<string>();
  for (const raw of input.latest) {
    const name = row(raw)?.name;
    if (typeof name === "string") names.add(name);
  }
  const verdicts = await classifyNeverStarted(
    // The listing the caller returns first: its runs decide, older attempts
    // only confirm, so the read bound is spent on them first.
    [...input.latest, ...all],
    input.sha,
    names,
    input.readJob,
    input.verdicts,
  );
  const observe = (raws: readonly unknown[]) => {
    const observations: BackupCiObservationV1[] = [];
    for (const raw of raws) {
      const id = rawCheckRunId(raw);
      const observed = backupCiObservation(
        raw,
        input.sha,
        id === null ? null : verdicts.get(id) ?? null,
      );
      if (observed === null) return null;
      observations.push(observed);
    }
    return observations;
  };
  const latest = observe(input.latest);
  const every = observe(all);
  if (latest === null || every === null) return null;
  return {
    file,
    selection: selectBackupStandIns({
      target: input.target,
      commit: input.sha,
      mode: input.mode,
      latest,
      all: every,
      suites: backupCiSuites(runs, input.sha),
      statusContexts,
      file,
      suspensions: input.store.suspensions,
      calibration: input.store.calibration,
    }),
  };
}

/**
 * The advisory lines of one selection (§11.2): each applied stand-in once
 * per receipt (`on`), each computed one once per receipt (`shadow`), and the
 * refusals of a commit once. Only trusted values are printed: check names
 * through `trustedCheckName`, receipts the store's own fixed format.
 */
export function reportBackupCiSelection(
  log: BackupCiLogV1,
  target: BackupCiTargetV1,
  sha: GitSha,
  chosen: BackupCiCommitSelectionV1,
  mode: BackupCiModeV1,
): void {
  const { selection } = chosen;
  const commit12 = sha.slice(0, 12);
  const applied = mode === "on"
    ? [...selection.standIns.values()]
    : selection.shadow;
  for (const standIn of applied) {
    log.once(
      mode === "on"
        ? "sentinel_backup_ci_standin"
        : "sentinel_backup_ci_shadow",
      standIn.backup.receipt,
      {
        repo: target.repository,
        commit12,
        check: trustedCheckName(standIn.name),
        conclusion: standIn.conclusion,
        receipt: standIn.backup.receipt,
      },
    );
  }
  if (selection.refusals.length > 0) {
    const refusals = [...selection.refusals].sort().slice(0, 16);
    log.once(
      "sentinel_backup_ci_refused",
      `${target.repository}@${sha}:${refusals.join(",")}`,
      { repo: target.repository, commit12, refusals },
    );
  }
}

export type BackupCiLogKindV1 =
  | "sentinel_backup_ci_standin"
  | "sentinel_backup_ci_shadow"
  | "sentinel_backup_ci_refused"
  | "sentinel_backup_ci_unavailable";

/** Advisory backup CI lines, each printed once per log (one per process). */
export interface BackupCiLogV1 {
  once(
    kind: BackupCiLogKindV1,
    key: string,
    fields: Record<string, string | string[]>,
  ): void;
}

/**
 * Prints `{"kind": kind, ...fields}` once for each `key` (the receipt, or the
 * commit and reason). Advisory only: it carries no `status` property, nothing
 * reads it back, and a failing sink is ignored.
 */
export function createBackupCiLog(
  sink: (line: string) => void = (line) => console.log(line),
): BackupCiLogV1 {
  const logged = new Set<string>();
  return {
    once(kind, key, fields) {
      const id = `${kind}\n${key}`;
      if (logged.has(id) || logged.size >= LOGGED_MAX) return;
      logged.add(id);
      try {
        sink(JSON.stringify({ kind, ...fields }));
      } catch {
        // Advisory only.
      }
    },
  };
}

/** The process's own log: each line at most once per process. */
export const BACKUP_CI_PROCESS_LOG: BackupCiLogV1 = createBackupCiLog();
