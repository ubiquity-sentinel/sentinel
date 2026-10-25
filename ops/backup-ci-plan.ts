/**
 * The backup CI planner's pure rules (docs/backup-ci-spec.md §9.3, §5
 * observations). The I/O side (`backup-ci-plan-reads.ts`) reads GitHub and
 * the store; this module decides which records and commits qualify, in which
 * priority, which observation groups a unit may stand in for, what is
 * deduplicated, how many legs may start and which units each target gets.
 *
 * Priorities (lower first): 0 a red attempt 1 without its confirmation;
 * 1 calibration commits while the runner is uncalibrated (at most 2 per
 * pass); 2 the live base tip; 3 record bases a backed-up head needs for
 * attribution; 4 peers; 5-8 heads at delivery, review, work and blocked
 * re-admission candidates (ties by `wait.since`, then record id).
 */
import type { GitSha } from "../src/contracts/brands.ts";
import {
  BACKUP_CI_MAX_PARALLEL,
  type BackupCiCommitFileV1,
  type BackupCiContextV1,
  type BackupCiEntryKeyV1,
  type BackupCiEntryV1,
  backupCiModeClass,
  type BackupCiPurposeV1,
  backupCiUnitId,
  type BackupCiUnitV1,
  type BackupCiUnsupportedV1,
  sameBackupCiKey,
} from "../src/contracts/backup-ci.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import { ACTIONS_APP_SLUG } from "../src/github/never-started-job.ts";
import { greenReadmissionCandidate } from "./hosted-autonomy-green-readmission.ts";

/** The billing stop annotation of a job that never started (§5, A4). */
export const BACKUP_CI_BILLING_ANNOTATION =
  /recent account payments have failed or your spending limit needs to be increased|account is locked due to a billing issue/;
export const BACKUP_CI_MAX_CALIBRATION_PER_PASS = 2;

export type BackupCiPriorityV1 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

/** One commit to read, with what a unit planned on it would be for. */
export interface BackupCiCandidateV1 {
  priority: BackupCiPriorityV1;
  commit: GitSha;
  purpose: BackupCiPurposeV1;
  /** The record whose head or base this is (null: tip or calibration). */
  recordId: string | null;
  /** The open pull request of a head, when the record has one. */
  pullRequest: number | null;
  /** The reviewed base B of a pull_request unit. */
  base: GitSha | null;
  /** The branch the commit was pushed to (push context `ref`). */
  branch: string;
  /** Confirm/peer units: the exact key family (null: every group). */
  key: Omit<BackupCiEntryKeyV1, "attempt"> | null;
  attempt: 1 | 2;
}

type Work = RepairStateSnapshotV1["work"][number];

/** §9.3 record set of one target: published heads that may need evidence. */
export function backupCiRecords(
  snapshot: RepairStateSnapshotV1,
  repository: string,
): Work[] {
  return snapshot.work.filter((record) => {
    if (`${record.repository.owner}/${record.repository.name}` !== repository) {
      return false;
    }
    if (record.target.head === null) return false;
    if (["work", "review", "delivery"].includes(record.nextStep)) return true;
    return record.nextStep === "blocked" &&
      greenReadmissionCandidate(snapshot, record);
  });
}

const STEP_PRIORITY: Record<string, BackupCiPriorityV1> = {
  delivery: 5,
  review: 6,
  work: 7,
  blocked: 8,
};

/** Whether a file holds any entry of the mode class (backup engaged there). */
function engaged(
  file: BackupCiCommitFileV1 | null | undefined,
  mode: "shadow" | "on",
): boolean {
  const cls = backupCiModeClass(mode);
  return file?.entries.some((e) => backupCiModeClass(e.mode) === cls) ?? false;
}

/** Attempt-1 reds of the mode class and runner that lack an attempt 2. */
export function unconfirmedReds(
  file: BackupCiCommitFileV1,
  mode: "shadow" | "on",
  runnerId: string,
): BackupCiEntryKeyV1[] {
  const cls = backupCiModeClass(mode);
  const mine = file.entries.filter((e) =>
    backupCiModeClass(e.mode) === cls && e.runnerId === runnerId
  );
  return mine.filter((e) =>
    e.state === "result" && e.key.attempt === 1 && e.conclusion !== "success"
  ).map((e) => ({ ...e.key, attempt: 2 as const })).filter((k) =>
    !mine.some((e) => sameBackupCiKey(e.key, k))
  );
}

export interface BackupCiCandidateInputV1 {
  records: readonly Work[];
  baseTip: GitSha | null;
  defaultBranch: string;
  calibrationCommits: readonly GitSha[];
  calibrated: boolean;
  /** Store files already read for the commits of interest. */
  files: ReadonlyMap<string, BackupCiCommitFileV1 | null>;
  mode: "shadow" | "on";
  runnerId: string;
  /** `GITHUB_RUN_ID`: rotates the head classes so none starves. */
  runId: number;
}

/** Every candidate commit of one target, in priority order. */
export function backupCiCandidates(
  input: BackupCiCandidateInputV1,
): BackupCiCandidateV1[] {
  const out: BackupCiCandidateV1[] = [];
  const base = (
    priority: BackupCiPriorityV1,
    commit: GitSha,
    purpose: BackupCiPurposeV1,
    over: Partial<BackupCiCandidateV1> = {},
  ): BackupCiCandidateV1 => ({
    priority,
    commit,
    purpose,
    recordId: null,
    pullRequest: null,
    base: null,
    branch: input.defaultBranch,
    key: null,
    attempt: 1,
    ...over,
  });
  const recordFor = (commit: string) =>
    input.records.find((r) => r.target.head === commit);
  for (
    const [commit, file] of [...input.files].sort(([a], [b]) => a < b ? -1 : 1)
  ) {
    if (file === null) continue;
    for (const key of unconfirmedReds(file, input.mode, input.runnerId)) {
      const record = recordFor(commit);
      out.push(base(0, commit as GitSha, "confirm", {
        recordId: record?.id ?? null,
        pullRequest: key.context === "pull_request"
          ? record?.target.pr ?? null
          : null,
        base: key.base,
        branch: record?.target.branch ?? input.defaultBranch,
        key: {
          context: key.context,
          workflowPath: key.workflowPath,
          checkName: key.checkName,
          base: key.base,
        },
        attempt: 2,
      }));
    }
  }
  if (!input.calibrated) {
    for (
      const commit of input.calibrationCommits.slice(
        0,
        BACKUP_CI_MAX_CALIBRATION_PER_PASS,
      )
    ) out.push(base(1, commit, "calibration"));
  }
  if (input.baseTip !== null) out.push(base(2, input.baseTip, "stand_in"));
  const bases = new Set<string>();
  for (const record of input.records) {
    const b = record.target.base;
    if (b === input.baseTip || bases.has(b)) continue;
    if (!engaged(input.files.get(record.target.head!), input.mode)) continue;
    bases.add(b);
    out.push(base(3, b, "stand_in"));
  }
  for (const record of input.records) {
    // Peers: one side has backup evidence, the other native evidence.
    const head = record.target.head!;
    const headFile = input.files.get(head);
    const baseFile = input.files.get(record.target.base);
    if (engaged(headFile, input.mode) || engaged(baseFile, input.mode)) {
      out.push(base(4, record.target.base, "peer", { recordId: record.id }));
      out.push(base(4, head, "peer", {
        recordId: record.id,
        pullRequest: record.target.pr,
        base: record.target.pr === null ? null : record.target.base,
        branch: record.target.branch ?? input.defaultBranch,
      }));
    }
  }
  const heads = input.records.map((record) => ({
    record,
    priority: STEP_PRIORITY[record.nextStep] ?? 8,
  })).sort((a, b) =>
    a.priority - b.priority ||
    (a.record.wait?.since ?? 0) - (b.record.wait?.since ?? 0) ||
    (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0)
  );
  const rotated = heads.length === 0 ? heads : [
    ...heads.slice(input.runId % heads.length),
    ...heads.slice(0, input.runId % heads.length),
  ].sort((a, b) => a.priority - b.priority);
  for (const { record, priority } of rotated) {
    out.push(base(priority, record.target.head!, "stand_in", {
      recordId: record.id,
      pullRequest: record.target.pr,
      base: record.target.pr === null ? null : record.target.base,
      branch: record.target.branch ?? input.defaultBranch,
    }));
  }
  const seen = new Set<string>();
  return out.filter((c) => {
    const id = `${c.commit}:${c.purpose}:${c.attempt}:${JSON.stringify(c.key)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/** One observation as the planner reads it (raw check run plus job verdict). */
export interface BackupCiPlanObservationV1 {
  checkRunId: number;
  name: string;
  app: string | null;
  suiteId: number | null;
  status: string;
  conclusion: string | null;
  /** null = unknown, treated as started. */
  notStarted: boolean | null;
}
export interface BackupCiPlanSuiteV1 {
  suiteId: number;
  runId: number;
  workflowPath: string;
  event: string;
}
export interface BackupCiGroupV1 {
  checkName: string;
  workflowPath: string;
  /** Events of every observation of the name. */
  events: BackupCiContextV1[];
  latest: BackupCiPlanObservationV1[];
  all: BackupCiPlanObservationV1[];
  /** Every observation never started (a stand-in group). */
  neverStarted: boolean;
  /** Every observation started (a native group: peers, calibration). */
  started: boolean;
  runIds: number[];
}
export type BackupCiGroupVerdictV1 =
  | { ok: true; group: BackupCiGroupV1 }
  | { ok: false; checkName: string; reason: BackupCiUnsupportedV1 | "unknown" };

/**
 * §5 observation rules per check name: one app (`github-actions`), one path
 * per name through a known suite, no commit status of the same context.
 * Unknown suites (an incomplete read) are `unknown`: retried, never final.
 */
export function backupCiGroups(input: {
  latest: readonly BackupCiPlanObservationV1[];
  all: readonly BackupCiPlanObservationV1[];
  suites: readonly BackupCiPlanSuiteV1[];
  statusContexts: ReadonlySet<string>;
}): BackupCiGroupVerdictV1[] {
  const suites = new Map(input.suites.map((s) => [s.suiteId, s]));
  const names = [...new Set(input.all.map((o) => o.name))].sort();
  const verdicts: BackupCiGroupVerdictV1[] = [];
  for (const checkName of names) {
    const all = input.all.filter((o) => o.name === checkName);
    const latest = input.latest.filter((o) => o.name === checkName);
    const refuse = (reason: BackupCiUnsupportedV1 | "unknown") =>
      verdicts.push({ ok: false, checkName, reason });
    if (all.some((o) => o.app !== ACTIONS_APP_SLUG)) {
      refuse("other_app");
      continue;
    }
    const mapped = all.map((o) =>
      o.suiteId === null ? undefined : suites.get(o.suiteId)
    );
    if (mapped.some((s) => s === undefined)) {
      refuse("unknown");
      continue;
    }
    const paths = new Set(mapped.map((s) => s!.workflowPath));
    if (paths.size !== 1) {
      refuse("mixed_paths");
      continue;
    }
    if (input.statusContexts.has(checkName)) {
      refuse("status_context");
      continue;
    }
    const events = [...new Set(mapped.map((s) => s!.event))];
    if (events.some((e) => e !== "push" && e !== "pull_request")) {
      refuse("unknown");
      continue;
    }
    verdicts.push({
      ok: true,
      group: {
        checkName,
        workflowPath: [...paths][0],
        events: events.sort() as BackupCiContextV1[],
        latest,
        all,
        neverStarted: all.every((o) => o.notStarted === true),
        started: all.every((o) => o.notStarted === false),
        runIds: [...new Set(mapped.map((s) => s!.runId))].sort((a, b) => a - b),
      },
    });
  }
  return verdicts;
}

/** Why a key is not planned this pass, or null when it may be planned. */
export function backupCiDedupe(
  file: BackupCiCommitFileV1 | null,
  key: BackupCiEntryKeyV1,
  mode: "shadow" | "on",
  runnerId: string,
  now: number,
): "final" | "in_flight" | "backoff" | "unsupported" | null {
  const cls = backupCiModeClass(mode);
  const entries: BackupCiEntryV1[] = (file?.entries ?? []).filter((e) =>
    sameBackupCiKey(e.key, key) && backupCiModeClass(e.mode) === cls
  );
  for (const e of entries) {
    if (e.state === "result" && e.runnerId === runnerId) return "final";
    if (e.state === "no_evidence" && e.final) return "unsupported";
  }
  for (const e of entries) {
    // The ingest runs first: a dispatched entry it left in place is a leg
    // still queued or running, or one not yet found: never planned twice.
    if (e.state === "dispatched") return "in_flight";
    if (
      e.state === "no_evidence" && e.runnerId === runnerId &&
      e.nextAt !== null && e.nextAt > now
    ) return "backoff";
  }
  return null;
}

/** Legs that may start now: p minus queued and running leg runs. */
export function backupCiFreeSlots(inflight: number, cellsActive: boolean): {
  p: number;
  free: number;
} {
  const p = cellsActive ? 1 : BACKUP_CI_MAX_PARALLEL;
  return { p, free: Math.max(0, p - Math.max(0, inflight)) };
}

/**
 * Round-robin over targets sorted by name, starting at `runId mod n`: one
 * unit per target per round in each target's priority order, at most `p`
 * per target, `free` in total.
 */
export function backupCiFairSelect<T>(
  perTarget: ReadonlyMap<string, readonly T[]>,
  runId: number,
  free: number,
  p: number,
): T[] {
  const names = [...perTarget.keys()].sort();
  if (names.length === 0 || free <= 0) return [];
  const start = runId % names.length;
  const order = [...names.slice(start), ...names.slice(0, start)];
  const taken = new Map(order.map((n) => [n, 0]));
  const chosen: T[] = [];
  for (let round = 0; chosen.length < free; round++) {
    let progressed = false;
    for (const name of order) {
      if (chosen.length >= free) break;
      const units = perTarget.get(name) ?? [];
      const count = taken.get(name)!;
      if (count >= p || round >= units.length) continue;
      chosen.push(units[round]);
      taken.set(name, count + 1);
      progressed = true;
    }
    if (!progressed) break;
  }
  return chosen;
}

/** A unit with its id computed (`backupCiUnitId`) from its fields. */
export function buildBackupCiUnit(
  body: Omit<BackupCiUnitV1, "unitId" | "plan" | "version" | "kind">,
  plan: BackupCiUnitV1["plan"],
): BackupCiUnitV1 {
  const content: Omit<BackupCiUnitV1, "unitId" | "plan"> = {
    version: 1,
    kind: "sentinel_backup_ci_unit",
    ...body,
  };
  return { ...content, unitId: backupCiUnitId(content), plan };
}
