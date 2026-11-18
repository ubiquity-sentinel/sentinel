/**
 * Whether a backup result and a native run may be compared for calibration,
 * and how (review MUST 2, 2026-11-17).
 *
 * Before, a peer or calibration result was compared with whichever native
 * run of the (workflow path, check name) group came last, across `push` and
 * `pull_request`, and a `pull_request` run was never checked to have merged
 * against the unit's base. Now a comparison binds:
 *
 * - the native run's event to the unit's context (suite event);
 * - for `pull_request`, the native run's merge parents, read from its own
 *   job log: the FIRST step must be `actions/checkout` (no target code runs
 *   before it), and its section must hold exactly one `HEAD is now at <sha>
 *   Merge <head> into <base>` line naming the unit's head and base;
 * - the native job itself: it started (steps, a runner), and for a red its
 *   failing step maps onto the unit's workflow steps (same count).
 *
 * The policy is asymmetric on purpose. An agreement must be proven: a green
 * needs both sides green; a red needs both sides to fail genuinely at the
 * SAME workflow step (native `failure`, not `timed_out`; backup `failure`
 * whose excerpt is no missing-tool error; setup-action failures are already
 * `setup_action_failed` and never reach here). A false green counts unless
 * disproven: a native red of a started job against a backup green suspends
 * unless the event or the merge base provably differs. Anything else is
 * incomparable with a closed reason and changes no calibration.
 */
import type { GitSha } from "../src/contracts/brands.ts";
import type {
  BackupCiConclusionV1,
  BackupCiPlannedStepV1,
  BackupCiUnitV1,
} from "../src/contracts/backup-ci.ts";
import { completedJobNeverStarted } from "../src/github/never-started-job.ts";
import type { BackupCiTargetReadsV1 } from "./backup-ci-plan-reads.ts";

export type BackupCiComparisonClassV1 =
  | "green"
  | "red"
  | "false_green"
  | "false_red";

export type BackupCiIncomparableV1 =
  | "native_missing"
  | "native_event"
  | "native_base"
  | "native_unbound"
  | "native_not_started"
  | "native_not_genuine"
  | "backup_not_genuine"
  | "step_mismatch";

type Obj = Record<string, unknown>;
const row = (v: unknown): Obj | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Obj : null;

/** Facts of one native job, read through the target token. */
export interface BackupCiNativeJobV1 {
  conclusion: string;
  neverStarted: boolean;
  /** The workflow step index of the first failing main step, or null. */
  failingStep: number | null;
}

/**
 * The facts of a raw Actions job bound to `jobId` and `head`, or null. A
 * failing step maps only when the job lists exactly the unit's main steps
 * (after `Set up job`, `Pre `/`Post ` steps and `Complete job`); a failing
 * step marked `continue-on-error` in the unit is skipped, as the leg does.
 */
export function backupCiNativeJob(
  job: unknown,
  jobId: number,
  head: GitSha,
  steps: readonly BackupCiPlannedStepV1[],
): BackupCiNativeJobV1 | null {
  const body = row(job);
  const verdict = completedJobNeverStarted(job, jobId, head);
  if (body === null || verdict === null) return null;
  const conclusion = typeof body.conclusion === "string" ? body.conclusion : "";
  if (verdict) return { conclusion, neverStarted: true, failingStep: null };
  const listed = Array.isArray(body.steps) ? body.steps.map(row) : [];
  if (listed.some((s) => s === null)) return null;
  const main = (listed as Obj[]).filter((s) => {
    const name = typeof s.name === "string" ? s.name : "";
    return name !== "Set up job" && name !== "Complete job" &&
      !name.startsWith("Pre ") && !name.startsWith("Post ");
  }).sort((a, b) => Number(a.number) - Number(b.number));
  let failingStep: number | null = null;
  if (main.length === steps.length) {
    const index = main.findIndex((s, i) =>
      s.conclusion === "failure" && !steps[i].continueOnError
    );
    failingStep = index < 0 ? null : steps[index].index;
  }
  return { conclusion, neverStarted: false, failingStep };
}

const MERGE_LINE =
  /HEAD is now at [0-9a-f]{7,40} Merge ([0-9a-f]{40}) into ([0-9a-f]{40})/;
const STEP_HEADER = /##\[group\]Run (.*)$/;
/**
 * The first step must be the real `actions/checkout` at a ref form the leg
 * reproduces (its checkout is short-circuited onto the synthetic merge): a
 * release tag `v<major>[.<minor>[.<patch>]]` or a full commit SHA. A branch
 * or any other ref names code the leg never ran, so the run stays unbound.
 */
const PINNED_CHECKOUT =
  /^actions\/checkout@(?:v[0-9]{1,3}(?:\.[0-9]{1,4}){0,2}|[0-9a-f]{40})$/i;

/** Whether a native job log's first step header is a pinned checkout. */
export function backupCiPinnedCheckout(step: string): boolean {
  return PINNED_CHECKOUT.test(step.trim());
}

/**
 * The merge parents a native `pull_request` job checked out, from the first
 * step's section of its log, or `unbound` (first step not a checkout, the
 * section not complete within the read prefix, or not exactly one merge
 * line). Only 40-hex values leave this function.
 */
export function backupCiNativeMergeParents(
  log: string,
): { head: GitSha; base: GitSha } | "unbound" {
  const lines = log.split(/\r?\n/);
  const headers = lines.flatMap((line, i) => {
    const match = STEP_HEADER.exec(line);
    return match === null ? [] : [{ i, step: match[1] }];
  });
  if (headers.length < 2) return "unbound";
  if (!backupCiPinnedCheckout(headers[0].step)) return "unbound";
  const section = lines.slice(headers[0].i + 1, headers[1].i);
  const merges = section.flatMap((line) => {
    const match = MERGE_LINE.exec(line);
    return match === null ? [] : [match];
  });
  if (merges.length !== 1) return "unbound";
  return { head: merges[0][1] as GitSha, base: merges[0][2] as GitSha };
}

/**
 * The pull request number a native `pull_request` job checked out
 * (`refs/remotes/pull/<n>/merge` in its first-step checkout section), or
 * null unless exactly one number appears there.
 */
export function backupCiNativePullNumber(log: string): number | null {
  const lines = log.split(/\r?\n/);
  const headers = lines.flatMap((line, i) =>
    STEP_HEADER.test(line) ? [{ i, step: STEP_HEADER.exec(line)![1] }] : []
  );
  if (headers.length < 2 || !backupCiPinnedCheckout(headers[0].step)) {
    return null;
  }
  const numbers = new Set<number>();
  for (const line of lines.slice(headers[0].i + 1, headers[1].i)) {
    for (
      const match of line.matchAll(/refs\/remotes\/pull\/([0-9]{1,9})\/merge/g)
    ) {
      numbers.add(Number(match[1]));
    }
  }
  return numbers.size === 1 ? [...numbers][0] : null;
}

/** A backup red whose own excerpt shows a missing tool (not genuine). */
export function backupCiInfraExcerpt(excerpt: string | null): boolean {
  return excerpt !== null &&
    /command not found|exit code 127|executable file not found/i.test(excerpt);
}

export interface BackupCiCompareInputV1 {
  /** The native run's event (its suite), or null when unknown. */
  nativeEvent: string | null;
  native: BackupCiNativeJobV1 | null;
  /** pull_request: the native merge parents, or `unbound` (unreadable). */
  nativeMerge: { head: GitSha; base: GitSha } | "unbound" | null;
  context: "push" | "pull_request";
  commit: GitSha;
  base: GitSha | null;
  backup: {
    conclusion: BackupCiConclusionV1;
    failingStep: number | null;
    excerpt: string | null;
  };
}

/** The class of one comparison, or why it is incomparable. */
export function classifyBackupCiComparison(
  input: BackupCiCompareInputV1,
):
  | { kind: "comparable"; class: BackupCiComparisonClassV1 }
  | { kind: "incomparable"; reason: BackupCiIncomparableV1 } {
  const no = (reason: BackupCiIncomparableV1) => ({
    kind: "incomparable" as const,
    reason,
  });
  const is = (cls: BackupCiComparisonClassV1) => ({
    kind: "comparable" as const,
    class: cls,
  });
  const { native, backup } = input;
  if (native === null) return no("native_missing");
  if (native.neverStarted) return no("native_not_started");
  // Provably different code: never compared, in either direction.
  if (input.nativeEvent !== null && input.nativeEvent !== input.context) {
    return no("native_event");
  }
  const merge = input.nativeMerge;
  if (
    input.context === "pull_request" && merge !== null && merge !== "unbound" &&
    (merge.head !== input.commit || merge.base !== input.base)
  ) return no("native_base");
  const proven = input.nativeEvent === input.context &&
    (input.context === "push" ||
      (merge !== null && merge !== "unbound"));
  const nativeGreen = native.conclusion === "success";
  const nativeRed = native.conclusion === "failure" ||
    native.conclusion === "timed_out";
  const backupGreen = backup.conclusion === "success";
  // A false green counts unless disproven (above).
  if (nativeRed && backupGreen) return is("false_green");
  // Agreements (and false reds) need a proven binding.
  if (!proven) return no("native_unbound");
  if (nativeGreen && backupGreen) return is("green");
  if (nativeGreen && !backupGreen) return is("false_red");
  if (!nativeRed) return no("native_not_genuine");
  if (native.conclusion !== "failure" || native.failingStep === null) {
    return no("native_not_genuine");
  }
  if (
    backup.conclusion !== "failure" || backup.failingStep === null ||
    backupCiInfraExcerpt(backup.excerpt)
  ) return no("backup_not_genuine");
  return native.failingStep === backup.failingStep
    ? is("red")
    : no("step_mismatch");
}

/** The native run one comparison binds to, as the target token reads it. */
export interface BackupCiNativeEvidenceV1 {
  checkRunId: number;
  conclusion: string;
  event: string | null;
  job: BackupCiNativeJobV1 | null;
  merge: { head: GitSha; base: GitSha } | "unbound" | null;
}

const NATIVE = new Set(["success", "failure", "timed_out"]);
const ACTIONS = "github-actions";
const posInt = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
const time = (v: unknown) =>
  typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0;

/**
 * The native run of the unit's (workflow path, check name): the planned one
 * (`unit.native`, peers and calibration) or else the newest started run of
 * the unit's own event. Null when nothing is readable or none exists.
 */
export async function readBackupCiNativeEvidence(
  reads: BackupCiTargetReadsV1,
  unit: BackupCiUnitV1,
): Promise<BackupCiNativeEvidenceV1 | null> {
  const [runs, suites] = await Promise.all([
    reads.checkRuns(unit.commit, "all"),
    reads.suites(unit.commit),
  ]);
  if (runs === null || suites === null) return null;
  const suiteOf = new Map(suites.map((s) => [s.suiteId, s]));
  const candidates = runs.flatMap((run) => {
    const id = posInt(run.id);
    const suite = suiteOf.get(posInt(row(run.check_suite)?.id) ?? 0);
    return id !== null && run.name === unit.key.checkName &&
        row(run.app)?.slug === ACTIONS && suite !== undefined &&
        suite.workflowPath === unit.key.workflowPath &&
        run.status === "completed" && NATIVE.has(String(run.conclusion))
      ? [{ id, run, event: suite.event }]
      : [];
  }).sort((a, b) => time(b.run.started_at) - time(a.run.started_at));
  const chosen = unit.native !== null
    ? candidates.filter((c) => c.id === unit.native!.checkRunId)
    : candidates.filter((c) => c.event === unit.key.context);
  for (const candidate of chosen) {
    const job = backupCiNativeJob(
      await reads.job(candidate.id),
      candidate.id,
      unit.commit,
      unit.steps,
    );
    if (unit.native === null && job?.neverStarted !== false) continue;
    const merge = unit.key.context !== "pull_request" ||
        candidate.event !== "pull_request"
      ? null
      : reads.jobLogPrefix === undefined
      ? "unbound" as const
      : await reads.jobLogPrefix(candidate.id).then((log) =>
        log === null ? "unbound" as const : backupCiNativeMergeParents(log)
      );
    return {
      checkRunId: candidate.id,
      conclusion: String(candidate.run.conclusion),
      event: candidate.event,
      job,
      merge,
    };
  }
  return null;
}
