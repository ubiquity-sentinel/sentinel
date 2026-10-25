/**
 * Backup CI in the launcher (docs/backup-ci-spec.md §11.4): the one point the
 * maintenance launcher and the runtime's queue custody read a commit's check
 * runs through (`readCompleteCheckRuns`), so `hasAllChecksGreen`,
 * `failedChecks`, delivery `headIsGreen` (the base tip included), closure, the
 * retry pass, the CI re-run pass's `baseGreen`, base repair and the
 * original-candidate pass see the same evidence as the runtime gates.
 *
 * After the complete, head-bound listing is validated, a raw run the shared
 * rule (`selectBackupStandIns`) selects is replaced by `standInRawRun`
 * (completed, the backup conclusion and `sentinel_backup`; `name`,
 * `head_sha`, `check_suite` and every other field kept, so coverage is
 * unchanged). It applies only with mode `on`; `shadow` logs what it would
 * apply and changes nothing; `off`, an unlisted repository or a listing
 * without a never-started run makes no request at all. The never-started
 * verdicts are WP0's own rule over each failed Actions run's job.
 *
 * Invariant (spec §11.1, B6), asserted here rather than left to WP0: with mode
 * `on`, every never-started run no stand-in covers is marked
 * `sentinel_never_started`, and `hasAllChecksGreen` reads a listing holding
 * one as no evidence (null), never as red.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  BACKUP_CI_PROCESS_LOG,
  type BackupCiConsumerV1,
  classifyNeverStarted,
  rawCheckRunId,
  readBackupCiStore,
  reportBackupCiSelection,
  selectBackupCiForCommit,
} from "../src/github/backup-ci-observations.ts";
import { standInRawRun } from "../src/github/backup-ci-substitute.ts";

/** The raw field `standInRawRun` writes on a substituted run. */
export const SENTINEL_BACKUP_FIELD = "sentinel_backup";

/** The raw field marking a never-started run no stand-in covers (`on`). */
export const SENTINEL_NEVER_STARTED_FIELD = "sentinel_never_started";

const COMMIT_SHA = /^[0-9a-f]{40}$/;
const RED = new Set(["failure", "timed_out"]);

type Run = Record<string, unknown>;

/** What one repository surface lends its backup CI hook (reads only). */
export interface HostedBackupCiReadContextV1 {
  readonly backupCi: BackupCiConsumerV1;
  readonly repository: RepositoryIdentityV1;
  /** Complete `filter=all` check-run listing of `head`, or null. */
  listAll(head: string): Promise<Run[] | null>;
  /** Complete workflow-run listing of `head`, or null. */
  listRuns(head: string): Promise<Run[] | null>;
  /** Complete commit-status listing of `head`, or null. */
  listStatuses(head: string): Promise<Run[] | null>;
  /** One Actions job body, or null. */
  readJob(jobId: number): Promise<unknown>;
  /** The surface's never-started verdict cache (`<jobId>:<head>`). */
  readonly verdicts: Map<string, boolean>;
}

/**
 * `runs` (the validated listing of `head`) with every selected stand-in
 * substituted (mode `on`), and every never-started run left over marked.
 */
export async function substituteBackupRuns(
  ctx: HostedBackupCiReadContextV1,
  head: string,
  runs: Run[],
): Promise<Run[]> {
  const { mode, reader } = ctx.backupCi;
  if (mode === "off" || !COMMIT_SHA.test(head)) return runs;
  const target = reader.target(ctx.repository);
  if (target === null) return runs;
  const names = new Set(runs.map((run) => String(run["name"])));
  const verdicts = await classifyNeverStarted(
    runs,
    head,
    names,
    (jobId) => ctx.readJob(jobId),
    ctx.verdicts,
  );
  const neverStarted = new Set<number>();
  for (const run of runs) {
    const id = rawCheckRunId(run);
    if (id !== null && verdicts.get(id) === true) neverStarted.add(id);
  }
  if (neverStarted.size === 0) return runs;
  const marked = (run: Run): Run => {
    const id = rawCheckRunId(run);
    return mode === "on" && id !== null && neverStarted.has(id)
      ? { ...run, [SENTINEL_NEVER_STARTED_FIELD]: true }
      : run;
  };
  const log = ctx.backupCi.log ?? BACKUP_CI_PROCESS_LOG;
  const sha = head as GitSha;
  const store = await readBackupCiStore(reader, ctx.repository, sha);
  if (store.kind !== "ok") {
    log.once("sentinel_backup_ci_unavailable", `${target.repository}:${sha}`, {
      repo: target.repository,
      commit12: sha.slice(0, 12),
      read: store.kind,
    });
    return runs.map(marked);
  }
  const reuse = (kind: string, load: () => Promise<Run[] | null>) =>
    ctx.backupCi.listings === undefined
      ? load()
      : ctx.backupCi.listings.read(`${target.repository}@${sha}:${kind}`, load);
  const chosen = await selectBackupCiForCommit({
    mode,
    target,
    sha,
    store,
    latest: runs,
    listAll: () => reuse("all", () => ctx.listAll(head)),
    listRuns: () => reuse("runs", () => ctx.listRuns(head)),
    statusContexts: async () => {
      const statuses = await ctx.listStatuses(head);
      if (statuses === null) return null;
      return new Set(
        statuses.map((status) => status["context"]).filter((context) =>
          typeof context === "string"
        ) as string[],
      );
    },
    readJob: (jobId) => ctx.readJob(jobId),
    verdicts: ctx.verdicts,
  });
  if (chosen === null) return runs.map(marked);
  reportBackupCiSelection(log, target, sha, chosen, mode);
  if (mode !== "on") return runs;
  return runs.map((run) => {
    const id = rawCheckRunId(run);
    const standIn = id === null ? undefined : chosen.selection.standIns.get(id);
    return standIn !== undefined && standIn.name === run["name"]
      ? standInRawRun(run, standIn)
      : marked(run);
  });
}

/** Whether a never-started run no stand-in covers remains (null evidence). */
export function backupNeverStartedRemains(runs: readonly Run[]): boolean {
  return runs.some((run) => run[SENTINEL_NEVER_STARTED_FIELD] === true);
}

/**
 * The base-repair failed names (§11.5): the native rule over every native
 * run (`failedCheckNames`: a never-started job is no failure), plus each name
 * whose substituted backup result is red. A substituted name is backup on
 * every run of the listing (the rule is all or nothing per name).
 */
export async function failedNamesWithBackup(
  head: string,
  runs: readonly Run[],
  failedCheckNames: (head: string, runs: Run[]) => Promise<string[]>,
  /** The failing conclusions the caller asks for (default: every red one). */
  conclusions?: readonly string[],
): Promise<string[]> {
  const red: ReadonlySet<string> = conclusions === undefined
    ? RED
    : new Set(conclusions);
  const backed = runs.filter((run) => run[SENTINEL_BACKUP_FIELD] !== undefined);
  const native = await failedCheckNames(
    head,
    runs.filter((run) => run[SENTINEL_BACKUP_FIELD] === undefined),
  );
  const names = [...native];
  for (const run of backed) {
    const name = String(run["name"]);
    if (red.has(String(run["conclusion"])) && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}
