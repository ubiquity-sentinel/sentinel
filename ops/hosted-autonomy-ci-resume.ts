/**
 * CI resume pass: re-run the CI GitHub never started, so a target's CI resumes
 * by itself once its Actions billing or spending limit is restored.
 *
 * While an account's Actions payments fail, GitHub completes every job of
 * every workflow run within a second as `failure` without a step or a runner
 * (`src/github/never-started-job.ts`). The runtime then waits on those heads
 * uncharged (`ci_pending`), but nothing re-runs a run GitHub never started,
 * so CI would stay stopped after billing came back. Once per maintenance pass,
 * for each foreign target with a published head Sentinel waits on for CI (a
 * live `ci_pending` or `backoff` wait, or a pre-review CI park, which a long
 * stop reaches after six hours), this pass looks at the base branch tip and
 * at those heads, and asks GitHub to re-run the
 * failed jobs of a run whose failed jobs all never started (the existing
 * `rerunFailedJobs` request of the flake re-run pass,
 * `hosted-autonomy-ci-rerun.ts`).
 *
 * Bounds, all stateless:
 * - one run per workflow per head: the newest run of that workflow (its other
 *   runs test the same commit and are superseded by the re-run);
 * - at most once per run per `HOSTED_CI_RESUME_INTERVAL_MS`: the run's own
 *   `updated_at` (for a completed run, the completion of its latest attempt)
 *   must be at least that old, so a re-run that never starts again waits a
 *   full interval before the next request;
 * - only a run whose latest attempt took at most
 *   `HOSTED_CI_RESUME_MAX_ATTEMPT_MS` (a never-started attempt ends within
 *   seconds) costs a job listing read, and its failed jobs must all have no
 *   step and no runner (`runNeverStarted`);
 * - at most `HOSTED_CI_RESUME_JOB_READS_PER_PASS` job listings and
 *   `HOSTED_CI_RESUME_RERUNS_PER_PASS` re-run requests per pass, inside
 *   `HOSTED_CI_RESUME_PASS_BUDGET_MS` and the pass deadline;
 * - never past GitHub's re-run window (`ciRerunExpired`), and an unknown
 *   time, an unreadable listing or a missing capability re-runs nothing.
 *
 * It writes no state and charges, refunds and decides nothing: it only asks
 * GitHub to repeat the repository's own check on the same commit. A run it
 * re-runs is past attempt 1, which the once-per-head flake re-run reads as
 * already re-run, whoever re-ran it. The self scope is left out, like the
 * base-repair pass, and so is a record in merge queue custody.
 */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { preReviewGateParked } from "./hosted-autonomy-ci-first.ts";
import { ciRerunExpired } from "./hosted-autonomy-ci-rerun.ts";
import { isHostedSelf } from "./hosted-autonomy-policy.ts";
import { queueRecordProtected } from "./hosted-autonomy-queue-context.ts";
import { createHostedAutonomyScopes } from "./hosted-autonomy-scopes.ts";
import { readRepairSafely } from "./hosted-autonomy-state.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyHeadRunV1,
} from "./hosted-autonomy-types.ts";

/** A run is asked again at most this often (its latest attempt's age). */
export const HOSTED_CI_RESUME_INTERVAL_MS = 30 * 60_000;
/** Latest attempts longer than this ran something and are not read. */
export const HOSTED_CI_RESUME_MAX_ATTEMPT_MS = 60_000;
/** Job listings one pass may read. */
export const HOSTED_CI_RESUME_JOB_READS_PER_PASS = 24;
/** Re-run requests one pass may send. */
export const HOSTED_CI_RESUME_RERUNS_PER_PASS = 8;
/** Wall-clock budget of the pass inside the maintenance pass. */
export const HOSTED_CI_RESUME_PASS_BUDGET_MS = 60_000;

type WorkRow = RepairStateSnapshotV1["work"][number];

/**
 * True when `run` may be asked again at `now`: it completed `failure`, its
 * latest attempt ended at least `HOSTED_CI_RESUME_INTERVAL_MS` ago after at
 * most `HOSTED_CI_RESUME_MAX_ATTEMPT_MS`, and GitHub's re-run window is still
 * open. Any unknown time is never due.
 */
export function ciResumeDue(
  run: HostedAutonomyHeadRunV1,
  now: number,
): boolean {
  const ended = run.updatedAt;
  const started = run.attemptStartedAt;
  return Number.isSafeInteger(now) && run.status === "completed" &&
    run.conclusion === "failure" &&
    typeof ended === "number" && Number.isSafeInteger(ended) &&
    typeof started === "number" && Number.isSafeInteger(started) &&
    ended >= started && ended - started <= HOSTED_CI_RESUME_MAX_ATTEMPT_MS &&
    now - ended >= HOSTED_CI_RESUME_INTERVAL_MS && !ciRerunExpired(run, now);
}

/**
 * The runs of `head` this pass may resume: of each workflow (a run without a
 * known workflow stands alone), the newest run, when it is due.
 */
export function ciResumeRuns(
  runs: readonly HostedAutonomyHeadRunV1[],
  head: string,
  now: number,
): HostedAutonomyHeadRunV1[] {
  const newest = new Map<string, HostedAutonomyHeadRunV1>();
  for (const run of runs) {
    if (run.headSha !== head) continue;
    const key = typeof run.workflowId === "number"
      ? `workflow:${run.workflowId}`
      : `run:${run.id}`;
    const previous = newest.get(key);
    if (previous === undefined || run.id > previous.id) newest.set(key, run);
  }
  return [...newest.values()].filter((run) => ciResumeDue(run, now));
}

function repositoryKey(repository: RepositoryIdentityV1): string {
  return `${repository.installationId}/${repository.owner}/${repository.name}`;
}

/**
 * A foreign record whose published head Sentinel waits on for CI: a live
 * `ci_pending` or `backoff` wait, or a pre-review CI park.
 */
function waitsOnCi(snapshot: RepairStateSnapshotV1, record: WorkRow): boolean {
  if (record.target.head === null || isHostedSelf(record.repository)) {
    return false;
  }
  const live = record.blocker === null && record.nextStep !== "done" &&
    record.nextStep !== "blocked" &&
    (record.wait?.reason === "ci_pending" || record.wait?.reason === "backoff");
  return live || preReviewGateParked(snapshot, record);
}

/**
 * The foreign repositories with a head waiting on CI, each with those heads
 * in snapshot order (deduplicated).
 */
export function ciResumeTargets(
  snapshot: RepairStateSnapshotV1,
  custody?: HostedAutonomyDepsV1["queueCustody"],
): { repository: RepositoryIdentityV1; heads: string[] }[] {
  const targets = new Map<
    string,
    { repository: RepositoryIdentityV1; heads: Set<string> }
  >();
  for (const record of snapshot.work) {
    // A record in merge queue custody is left to the queue's own passes.
    if (queueRecordProtected(record, custody)) continue;
    if (!waitsOnCi(snapshot, record)) continue;
    const key = repositoryKey(record.repository);
    const target = targets.get(key) ??
      { repository: record.repository, heads: new Set<string>() };
    target.heads.add(record.target.head!);
    targets.set(key, target);
  }
  return [...targets.values()].sort((a, b) =>
    `${a.repository.owner}/${a.repository.name}` <
        `${b.repository.owner}/${b.repository.name}`
      ? -1
      : 1
  ).map((target) => ({
    repository: target.repository,
    heads: [...target.heads],
  }));
}

/** Run the CI resume pass; its actions only, never a state change. */
export async function runHostedCiResumePass(
  deps: HostedAutonomyDepsV1,
  passDeadline: number = Number.POSITIVE_INFINITY,
): Promise<string[]> {
  const actions: string[] = [];
  const started = deps.clock.now();
  if (!Number.isSafeInteger(started)) return actions;
  const deadline = Math.min(
    started + HOSTED_CI_RESUME_PASS_BUDGET_MS,
    passDeadline,
  );
  const inBudget = () => {
    const now = deps.clock.now();
    return Number.isSafeInteger(now) && now < deadline;
  };
  if (!inBudget()) return actions;
  const read = await readRepairSafely(deps.state);
  if (read === null || !read.ok || read.value.status !== "found") {
    return actions;
  }
  const snapshot = read.value.snapshot;
  const { scopeFor } = createHostedAutonomyScopes(deps);
  let jobReads = HOSTED_CI_RESUME_JOB_READS_PER_PASS;
  let reruns = HOSTED_CI_RESUME_RERUNS_PER_PASS;
  const targets = ciResumeTargets(snapshot, deps.queueCustody);
  for (const { repository, heads: waiting } of targets) {
    const tag = `ci-resume:${repository.owner}/${repository.name}`;
    if (jobReads <= 0 || reruns <= 0) break;
    if (!inBudget()) {
      actions.push(`${tag}:deadline`);
      break;
    }
    try {
      // A surface that cannot list, judge or re-run runs costs nothing.
      const capable = deps.githubFor(repository);
      if (
        capable?.listHeadRuns === undefined ||
        capable.runNeverStarted === undefined ||
        capable.rerunFailedJobs === undefined
      ) continue;
      const scope = await scopeFor(repository);
      const surface = scope.surface;
      if (
        surface === null || scope.baseBranch === null ||
        surface.listHeadRuns === undefined ||
        surface.runNeverStarted === undefined ||
        surface.rerunFailedJobs === undefined
      ) continue;
      const tip = await surface.readBaseTip(scope.baseBranch);
      // The base tip first: every waiting head is attributed against it.
      const heads = [...new Set([...(tip === null ? [] : [tip]), ...waiting])];
      for (const head of heads) {
        if (jobReads <= 0 || reruns <= 0) break;
        if (!inBudget()) {
          actions.push(`${tag}:deadline`);
          return actions;
        }
        let runs: readonly HostedAutonomyHeadRunV1[] | null;
        try {
          runs = await surface.listHeadRuns(head);
        } catch {
          runs = null;
        }
        if (runs === null) continue;
        for (const run of ciResumeRuns(runs, head, deps.clock.now())) {
          if (jobReads <= 0 || reruns <= 0 || !inBudget()) break;
          jobReads--;
          let notStarted: boolean | null;
          try {
            notStarted = await surface.runNeverStarted(run.id, head);
          } catch {
            notStarted = null;
          }
          if (notStarted !== true || !inBudget()) continue;
          reruns--;
          let sent: boolean;
          try {
            sent = await surface.rerunFailedJobs(run.id);
          } catch {
            sent = false;
          }
          actions.push(`${tag}:run=${run.id}:${sent ? "sent" : "refused"}`);
        }
      }
    } catch {
      actions.push(`${tag}:unexpected_error`);
    }
  }
  return actions;
}
