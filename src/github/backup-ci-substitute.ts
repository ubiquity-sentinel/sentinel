/**
 * The shared stand-in rule (docs/backup-ci-spec.md §6.3, §11.1): which
 * never-started GitHub Actions observations of one commit a verified backup
 * receipt stands in for, and which started check names carry a backup peer
 * for attribution. Pure; the runtime check read and the launcher (WP2) feed it
 * one commit's observations and one `ok` store read, and apply its result.
 *
 * For each group G = (workflow path P, check name N):
 * 1. Mode `on` (with `shadow` the stand-ins are computed into `shadow` and
 *    nothing is applied); the file binds the target and commit; an entry
 *    counts only from a calibrated runner no suspension covers.
 * 2. Across every attempt, every observation of N is app `github-actions`,
 *    maps to P through a known suite and never started (`notStarted` true;
 *    null is unknown and treated as started). Anything else makes N
 *    ineligible under every path.
 * 3. No commit status has context N.
 * 4. Coverage: for each event of G's observations the file has a supported
 *    coverage row for (P, event), and every expected name of it has an
 *    observation under P.
 * 5. Each latest observation with event e resolves over `evidence` results of
 *    (P, N) whose context is e, or `pull_request` for a push observation:
 *    per (context, base) attempt 1 success is success, attempt 1 red takes
 *    attempt 2's conclusion, otherwise unresolved; any resolved red wins,
 *    then any success.
 * 6. All or nothing: one unresolved latest observation means no stand-in for
 *    G (its never-started observations stay never started and keep waiting).
 * 7. A stand-in keeps the original's name, head and timestamps.
 */
import type { GitSha } from "../contracts/brands.ts";
import {
  type BackupCiCalibrationV1,
  type BackupCiCommitFileV1,
  type BackupCiConclusionV1,
  type BackupCiEntryV1,
  type BackupCiModeV1,
  backupCiReceiptId,
  type BackupCiResultEntryV1,
  type BackupCiSuspensionV1,
  type BackupCiTargetV1,
  isBackupCiCalibrated,
} from "../contracts/backup-ci.ts";
import type {
  GitHubCheckBackupV1,
  GitHubCheckV1,
} from "../contracts/ports-github-requests.ts";
import { trustedCheckName } from "../repair/ci-rejection.ts";
import { ACTIONS_APP_SLUG } from "./never-started-job.ts";
import { isBackupCiSuspended } from "./backup-ci-store.ts";

export interface BackupCiObservationV1 {
  checkRunId: number;
  name: string;
  app: string | null;
  suiteId: number | null;
  status: string;
  conclusion: string | null;
  startedAt: number | null;
  completedAt: number | null;
  /** null = unknown, treated as started (fail closed). */
  notStarted: boolean | null;
}
export interface BackupCiSuiteV1 {
  suiteId: number;
  workflowPath: string;
  event: string;
}
export interface BackupCiSelectInputV1 {
  target: BackupCiTargetV1;
  commit: GitSha;
  mode: BackupCiModeV1;
  /** The listing the caller will return (default filter). */
  latest: BackupCiObservationV1[];
  /** `filter=all`: every attempt. */
  all: BackupCiObservationV1[];
  /** `GET /actions/runs?head_sha`: suite → workflow path and event. */
  suites: BackupCiSuiteV1[];
  statusContexts: ReadonlySet<string>;
  file: BackupCiCommitFileV1 | null;
  suspensions: BackupCiSuspensionV1[];
  calibration: BackupCiCalibrationV1 | null;
}
export interface BackupCiStandInV1 {
  checkRunId: number;
  name: string;
  conclusion: BackupCiConclusionV1;
  backup: GitHubCheckBackupV1;
}
export interface BackupCiPeerV1 {
  conclusion: BackupCiConclusionV1;
  receipt: string;
}
export interface BackupCiSelectionV1 {
  /** Keyed by the latest observation's check run id. */
  standIns: Map<number, BackupCiStandInV1>;
  /** By check name. */
  peers: Map<string, BackupCiPeerV1>;
  /** Computed but not applied (mode shadow). */
  shadow: BackupCiStandInV1[];
  /** `<reason>:<trusted name>` for logs. */
  refusals: string[];
}

const isRed = (c: BackupCiConclusionV1) => c !== "success";

/**
 * The deciding entry of `entries` (already filtered to one (P, N) and to
 * usable runners): per (context, base), attempt 1 all success is success,
 * attempt 1 red takes attempt 2's conclusion (a red there first), anything
 * else is unresolved; across (context, base) any red wins, then any success.
 */
function decide(
  entries: readonly BackupCiEntryV1[],
): BackupCiResultEntryV1 | null {
  const groups = new Map<string, BackupCiResultEntryV1[]>();
  for (const entry of entries) {
    if (entry.state !== "result" || entry.mode !== "evidence") continue;
    const id = `${entry.key.context}:${entry.key.base ?? ""}`;
    groups.set(id, [...(groups.get(id) ?? []), entry]);
  }
  const resolved: BackupCiResultEntryV1[] = [];
  for (const group of [...groups.keys()].sort().map((id) => groups.get(id)!)) {
    const first = group.filter((e) => e.key.attempt === 1);
    const second = group.filter((e) => e.key.attempt === 2);
    if (first.length === 0) continue;
    if (first.every((e) => e.conclusion === "success")) {
      resolved.push(first[0]);
      continue;
    }
    if (second.length === 0) continue;
    resolved.push(second.find((e) => isRed(e.conclusion)) ?? second[0]);
  }
  return resolved.find((e) => isRed(e.conclusion)) ?? resolved[0] ?? null;
}

/** The resolved conclusion of `entries` (see `decide`), or null. */
export function resolveBackupEntries(
  entries: readonly BackupCiEntryV1[],
): BackupCiConclusionV1 | null {
  return decide(entries)?.conclusion ?? null;
}

function emptySelection(): BackupCiSelectionV1 {
  return { standIns: new Map(), peers: new Map(), shadow: [], refusals: [] };
}

export function selectBackupStandIns(
  input: BackupCiSelectInputV1,
): BackupCiSelectionV1 {
  const selection = emptySelection();
  const { file, target } = input;
  if (input.mode === "off" || file === null) return selection;
  const [owner, name] = target.repository.split("/");
  if (
    file.repository.owner !== owner || file.repository.name !== name ||
    file.repository.id !== target.id || file.commit !== input.commit
  ) {
    selection.refusals.push("binding:file");
    return selection;
  }
  const calibration = input.calibration?.repository.id === target.id
    ? input.calibration
    : null;
  const usable = (entry: BackupCiEntryV1) =>
    isBackupCiCalibrated(calibration, entry.runnerId) &&
    !isBackupCiSuspended(input.suspensions, target.repository, entry.runnerId);
  const suites = new Map(input.suites.map((s) => [s.suiteId, s]));
  const allIds = new Set(input.all.map((o) => o.checkRunId));
  const byPath = new Map<string, Set<string>>();
  for (const o of input.all) {
    const suite = o.suiteId === null ? undefined : suites.get(o.suiteId);
    if (suite === undefined) continue;
    const names = byPath.get(suite.workflowPath) ?? new Set<string>();
    byPath.set(suite.workflowPath, names.add(o.name));
  }
  const names = [...new Set(input.latest.map((o) => o.name))].sort();
  for (const checkName of names) {
    const observations = [
      ...input.all.filter((o) => o.name === checkName),
      ...input.latest.filter((o) => o.name === checkName),
    ];
    const latest = input.latest.filter((o) => o.name === checkName);
    const refuse = (reason: string) =>
      selection.refusals.push(`${reason}:${trustedCheckName(checkName)}`);
    const paths = new Set<string>();
    let shape: string | null = null;
    for (const o of observations) {
      const suite = o.suiteId === null ? undefined : suites.get(o.suiteId);
      if (o.app !== ACTIONS_APP_SLUG) shape ??= "other_app";
      else if (suite === undefined) shape ??= "unknown_suite";
      else paths.add(suite.workflowPath);
    }
    if (latest.some((o) => !allIds.has(o.checkRunId))) shape ??= "listing";
    if (paths.size > 1) shape ??= "mixed_paths";
    const neverStarted = observations.every((o) => o.notStarted === true);
    const started = observations.every((o) => o.notStarted === false);
    const anyNeverStarted = observations.some((o) => o.notStarted === true);
    if (shape !== null || paths.size !== 1) {
      if (anyNeverStarted) refuse(shape ?? "unknown_suite");
      continue;
    }
    const path = [...paths][0];
    const rows = file.workflows.filter((w) => w.path === path && w.supported);
    const fromPath = (entry: BackupCiEntryV1, blobs: readonly string[]) =>
      entry.state === "result" && entry.key.workflowPath === path &&
      entry.key.checkName === checkName && usable(entry) &&
      blobs.includes(entry.binding.workflowBlob);
    if (started) {
      const blobs = [...new Set(rows.map((w) => w.blob))];
      const peer = blobs.length === 1
        ? decide(file.entries.filter((e) => fromPath(e, blobs)))
        : null;
      if (peer !== null && input.mode === "on") {
        selection.peers.set(checkName, {
          conclusion: peer.conclusion,
          receipt: backupCiReceiptId(target.repository, input.commit, peer.key),
        });
      }
      continue;
    }
    if (!neverStarted) {
      refuse("started");
      continue;
    }
    if (input.statusContexts.has(checkName)) {
      refuse("status_context");
      continue;
    }
    const eventOf = (o: BackupCiObservationV1) =>
      suites.get(o.suiteId as number)!.event;
    const coverage = new Map<string, string>();
    for (const event of new Set(observations.map(eventOf))) {
      const row = rows.find((w) => w.event === event);
      const seen = byPath.get(path) ?? new Set<string>();
      if (row !== undefined && row.expected.every((n) => seen.has(n))) {
        coverage.set(event, row.blob);
      }
    }
    if (coverage.size !== new Set(observations.map(eventOf)).size) {
      refuse("coverage");
      continue;
    }
    const standIns: BackupCiStandInV1[] = [];
    for (const o of latest) {
      const event = eventOf(o);
      const blob = coverage.get(event) as string;
      const decided = decide(file.entries.filter((e) =>
        fromPath(e, [blob]) &&
        (e.key.context === event ||
          (event === "push" && e.key.context === "pull_request"))
      ));
      if (decided === null) break;
      standIns.push({
        checkRunId: o.checkRunId,
        name: checkName,
        conclusion: decided.conclusion,
        backup: {
          receipt: backupCiReceiptId(
            target.repository,
            input.commit,
            decided.key,
          ),
          context: decided.key.context,
          runnerId: decided.runnerId,
          legRunId: decided.leg.runId,
          legJobId: decided.leg.jobId,
        },
      });
    }
    if (standIns.length !== latest.length) {
      refuse("unresolved");
      continue;
    }
    for (const standIn of standIns) {
      if (input.mode === "on") {
        selection.standIns.set(standIn.checkRunId, standIn);
      } else selection.shadow.push(standIn);
    }
  }
  return selection;
}

/**
 * The runtime check a stand-in replaces a never-started one with: completed
 * with the backup conclusion and its `backup` receipt, no longer never
 * started; name, head and timestamps are the original's.
 */
export function standInCheck(
  original: GitHubCheckV1,
  standIn: BackupCiStandInV1,
): GitHubCheckV1 {
  const { neverStarted: _neverStarted, ...rest } = original;
  return {
    ...rest,
    status: "completed",
    conclusion: standIn.conclusion,
    backup: { ...standIn.backup },
  };
}

/**
 * The launcher's raw check run for a stand-in: completed with the backup
 * conclusion and `sentinel_backup`; `name`, `head_sha`, `check_suite` and
 * every other field are the original's.
 */
export function standInRawRun(
  raw: Record<string, unknown>,
  standIn: BackupCiStandInV1,
): Record<string, unknown> {
  return {
    ...raw,
    status: "completed",
    conclusion: standIn.conclusion,
    sentinel_backup: {
      receipt: standIn.backup.receipt,
      runnerId: standIn.backup.runnerId,
    },
  };
}
