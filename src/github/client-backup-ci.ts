/**
 * Backup CI in the runtime check read (docs/backup-ci-spec.md §11.2): the one
 * point every runtime gate reads CI through (`GitHubClientReads.readChecks`),
 * so CI-first, CI correction, delivery, carried delivery, the queue delivery
 * reader and the merge port all see identical evidence.
 *
 * After the head's check runs are parsed and WP0 has marked never-started
 * runs, and before the commit statuses are folded in, a verified backup
 * result stands in for exactly the never-started runs the shared rule
 * (`selectBackupStandIns`) selects; a natively started name may carry a
 * `backupPeer` for attribution only. Everything else is the list unchanged:
 *
 * - nothing is composed, the mode is `off`, or the repository is not a listed
 *   target: no read of any kind;
 * - no observation never started and none is a peer candidate (a red Actions
 *   run on the head read; any completed Actions run on a name-filtered base
 *   read): no read of any kind;
 * - a peer candidate only: one store read (anonymous git, no GitHub request)
 *   and GitHub listings only when the store holds a result for its name;
 * - any store or listing failure: the list unchanged, never an error, so a
 *   store outage never makes CI unreadable and missing evidence never passes.
 *
 * With `shadow` the stand-ins are computed and logged, never applied. A
 * never-started run no stand-in covers stays never started (the gates keep
 * waiting on it).
 */
import type { GitSha } from "../contracts/brands.ts";
import type { BackupCiCommitFileV1 } from "../contracts/backup-ci.ts";
import type { GitHubCheckV1, PortResultV1 } from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  BACKUP_CI_PROCESS_LOG,
  type BackupCiCommitSelectionV1,
  type BackupCiConsumerV1,
  isCompletedActionsRun,
  isRedActionsRun,
  rawCheckRunId,
  readBackupCiStore,
  reportBackupCiSelection,
  selectBackupCiForCommit,
} from "./backup-ci-observations.ts";
import { standInCheck } from "./backup-ci-substitute.ts";
import type { ActionsJobReadV1 } from "./never-started-job.ts";

/**
 * One complete paged listing under this client's repository (`path` after
 * `/repos/{owner}/{name}`); `key` names the list field of an object page, or
 * null for a top-level array.
 */
export type BackupCiPagesV1 = (
  path: string,
  query: Record<string, string>,
  key: string | null,
) => Promise<PortResultV1<unknown[]>>;

/** What the runtime client lends its backup CI consumer (never a write). */
export interface BackupCiClientReadsV1 extends BackupCiConsumerV1 {
  readonly repository: RepositoryIdentityV1;
  readonly pages: BackupCiPagesV1;
  readonly readJob: ActionsJobReadV1;
  /** The client's own never-started verdict cache (`<jobId>:<head>`). */
  readonly verdicts: Map<string, boolean>;
}

const listing = async (
  ctx: BackupCiClientReadsV1,
  path: string,
  query: Record<string, string>,
  key: string | null,
): Promise<unknown[] | null> => {
  try {
    const read = await ctx.pages(path, query, key);
    return read.ok ? read.value : null;
  } catch {
    return null;
  }
};

function hasEvidence(
  file: BackupCiCommitFileV1 | null,
  names: ReadonlySet<string>,
): boolean {
  return file !== null &&
    file.entries.some((entry) =>
      entry.state === "result" && entry.mode === "evidence" &&
      names.has(entry.key.checkName)
    );
}

/**
 * The selection for `sha` from the latest raw listing `latest` and the
 * commit's status contexts, or null for no substitution (not composed, not a
 * target, mode `off`, an unavailable store or listing, no file). `wanted`
 * returns false to skip every GitHub request once the store read shows
 * nothing could apply.
 */
export async function backupCiSelectionFor(
  ctx: BackupCiClientReadsV1 | null,
  sha: GitSha,
  latest: readonly unknown[],
  statusContexts: () => Promise<ReadonlySet<string> | null>,
  wanted: (file: BackupCiCommitFileV1 | null) => boolean = () => true,
): Promise<BackupCiCommitSelectionV1 | null> {
  if (ctx === null || ctx.mode === "off") return null;
  const target = ctx.reader.target(ctx.repository);
  if (target === null) return null;
  const log = ctx.log ?? BACKUP_CI_PROCESS_LOG;
  const store = await readBackupCiStore(ctx.reader, ctx.repository, sha);
  if (store.kind !== "ok") {
    log.once("sentinel_backup_ci_unavailable", `${target.repository}:${sha}`, {
      repo: target.repository,
      commit12: sha.slice(0, 12),
      read: store.kind,
    });
    return null;
  }
  if (store.file === null || !wanted(store.file)) return null;
  const reuse = (
    kind: string,
    load: () => Promise<readonly unknown[] | null>,
  ) =>
    ctx.listings === undefined
      ? load()
      : ctx.listings.read(`${target.repository}@${sha}:${kind}`, load);
  const chosen = await selectBackupCiForCommit({
    mode: ctx.mode,
    target,
    sha,
    store,
    latest,
    listAll: () =>
      reuse("all", () =>
        listing(
          ctx,
          `/commits/${sha}/check-runs`,
          { filter: "all" },
          "check_runs",
        )),
    listRuns: () =>
      reuse(
        "runs",
        () => listing(ctx, "/actions/runs", { head_sha: sha }, "workflow_runs"),
      ),
    statusContexts,
    readJob: ctx.readJob,
    verdicts: ctx.verdicts,
  });
  if (chosen !== null) {
    reportBackupCiSelection(log, target, sha, chosen, ctx.mode);
  }
  return chosen;
}

/**
 * The parsed check runs `checks` of `sha` (index-aligned with their raw runs
 * `raws`) with every selected stand-in applied and every backup peer
 * attached; `statuses` are the parsed commit statuses of the same read and
 * `filtered` says whether it was name-filtered (the base attribution read).
 */
export async function applyBackupCiToChecks(
  ctx: BackupCiClientReadsV1 | null,
  sha: GitSha,
  raws: readonly unknown[],
  checks: readonly GitHubCheckV1[],
  statuses: readonly GitHubCheckV1[],
  filtered: boolean,
): Promise<GitHubCheckV1[]> {
  const unchanged = [...checks];
  if (ctx === null || ctx.mode === "off" || raws.length !== checks.length) {
    return unchanged;
  }
  const standIns = checks.some((check) => check.neverStarted === true);
  const peers = new Set<string>();
  if (ctx.mode === "on") {
    raws.forEach((raw, index) => {
      if (checks[index].neverStarted === true) return;
      if (filtered ? isCompletedActionsRun(raw) : isRedActionsRun(raw)) {
        peers.add(checks[index].name);
      }
    });
  }
  if (!standIns && peers.size === 0) return unchanged;
  const chosen = await backupCiSelectionFor(
    ctx,
    sha,
    raws,
    () => Promise.resolve(new Set(statuses.map((status) => status.name))),
    (file) => standIns || hasEvidence(file, peers),
  );
  if (chosen === null || ctx.mode !== "on") return unchanged;
  const { selection } = chosen;
  return checks.map((check, index) => {
    const id = rawCheckRunId(raws[index]);
    const standIn = id === null ? undefined : selection.standIns.get(id);
    if (standIn !== undefined && standIn.name === check.name) {
      return standInCheck(check, standIn);
    }
    const peer = selection.peers.get(check.name);
    return peer === undefined || check.neverStarted === true
      ? check
      : { ...check, backupPeer: { ...peer } };
  });
}
