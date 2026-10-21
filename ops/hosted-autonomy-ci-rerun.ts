/**
 * Launcher-only flake path for a reviewed head parked on the runtime's
 * merge-gate CI failure ("CI checks failed: ...", or the CI-correction
 * runtime's "CI checks failed without base evidence: ..."), and for a head
 * the CI-first gate parked before its review (red, pending, or with its CI
 * fixes exhausted on a head no review has completed on: a flake there returns
 * through the green rule, never through a fourth fix). When the exact
 * head holds a clean review against a base that is still the base tip and is
 * itself all green, the failed workflow run on that head is re-run ONCE.
 * Nothing is written: GitHub's own `run_attempt` is the durable once-per-head
 * record, so a head with any run past attempt 1 is never re-run again,
 * whoever re-ran it and whatever it concluded. A head that turns green is
 * re-admitted to delivery by the retry pass (`ciGreenRedeliveryEligible`); a
 * head that fails again stays parked until a CI-correction runtime may
 * correct it (`readCiRerunSettled`).
 *
 * GitHub refuses a re-run more than 30 days after the run's first attempt and
 * records nothing for the refusal (the run stays at attempt 1), so a head
 * whose failed run is that old is never re-run and counts as settled at once:
 * its age (GitHub's own `created_at`) is the stateless proof that the re-run
 * can no longer act. An unknown age never settles a head.
 *
 * The pass charges, refunds and decides nothing about the failure: it only
 * asks GitHub to repeat the repository's own deterministic check on the exact
 * reviewed head. There is no per-pass count throttle.
 */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  ciGreenHeadKey,
  ciGreenRedeliveryEligible,
  ciRedeliveryEligible,
} from "./hosted-autonomy-ci-retries.ts";
import {
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedIssueKey,
} from "./hosted-autonomy-policy.ts";
import {
  preReviewFixEligible,
  preReviewGateParked,
} from "./hosted-autonomy-ci-first.ts";
import {
  type HostedAutonomyPassContextV1,
  hostedPassDeadlineReached,
} from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyHeadRunV1 } from "./hosted-autonomy-types.ts";

/** Retired count throttle; keep the numeric policy surface compatible. */
export const HOSTED_AUTONOMY_CI_RERUNS_PER_PASS = Number.MAX_SAFE_INTEGER;

/** GitHub refuses a re-run more than 30 days after the run's first attempt. */
export const HOSTED_AUTONOMY_CI_RERUN_WINDOW_MS = 30 * 86_400_000;
/**
 * The launcher stops this far inside GitHub's window (clock skew and the time
 * between passes), so it never spends a request GitHub is about to refuse.
 */
export const HOSTED_AUTONOMY_CI_RERUN_WINDOW_MARGIN_MS = 3_600_000;

/** Run conclusions that can be a flake worth one more attempt. */
const RERUNNABLE: readonly string[] = ["failure", "timed_out"];

type WorkRow = RepairStateSnapshotV1["work"][number];

/**
 * True only when the run's known first-attempt creation time is at least the
 * re-run window (less the margin) before `now`. An unknown age or an invalid
 * clock is never expired.
 */
export function ciRerunExpired(
  run: HostedAutonomyHeadRunV1,
  now: number,
): boolean {
  return Number.isSafeInteger(now) && run.createdAt !== null &&
    now - run.createdAt >=
      HOSTED_AUTONOMY_CI_RERUN_WINDOW_MS -
        HOSTED_AUTONOMY_CI_RERUN_WINDOW_MARGIN_MS;
}

/**
 * The runs to re-run on one exact head: every completed run that ended
 * `failure` or `timed_out`, and none at all once any run on the head is past
 * its first attempt (or the listing is unprovable), or once any of those
 * failed runs is past GitHub's re-run window: the head is re-run whole or not
 * at all, and GitHub would refuse that run.
 */
export function ciRerunRuns(
  runs: readonly HostedAutonomyHeadRunV1[] | null,
  head: string,
  now: number,
): number[] {
  if (runs === null) return [];
  const bound = runs.filter((run) => run.headSha === head);
  if (bound.some((run) => run.runAttempt > 1)) return [];
  const failed = bound.filter((run) =>
    run.status === "completed" && run.conclusion !== null &&
    RERUNNABLE.includes(run.conclusion)
  );
  if (failed.some((run) => ciRerunExpired(run, now))) return [];
  return failed.map((run) => run.id);
}

/**
 * Local gates: the CI-parked, clean-reviewed, unreleased shape with no
 * operation in flight (or a head the CI-first gate parked before its review,
 * its exhausted park included), on a published head whose candidate is durably
 * preserved, for a source issue not already known closed.
 */
function rerunShape(
  snapshot: RepairStateSnapshotV1,
  record: WorkRow,
  closedIssues: ReadonlySet<string>,
): boolean {
  const head = record.target.head;
  const candidate = record.target.candidateState;
  return record.nextStep === "blocked" && head !== null &&
    candidate !== undefined && candidate.preserved !== null &&
    candidate.publishedHead === head &&
    (ciGreenRedeliveryEligible(snapshot, record) ||
      preReviewGateParked(snapshot, record)) &&
    !closedIssues.has(
      hostedIssueKey(record.repository, record.related.issueNumber!),
    );
}

/**
 * Heads (`ciGreenHeadKey`) of CI-parked records a correction may re-admit
 * because this pass can no longer re-run them: the head is outside the re-run
 * shape (for example a legacy record without candidate state), its surface
 * cannot list or re-run runs, the base tip moved off the reviewed base, the
 * head's run listing shows a run past attempt 1 or nothing re-runnable (which
 * includes a failed run past GitHub's re-run window), or it holds more failed
 * runs than one pass may re-run. An unreadable surface, base tip or run
 * listing is never settled: the correction waits for the flake.
 * `tips` holds the base tips the caller read, keyed by scope. Reads one run
 * listing per correction-eligible head whose tip is still its reviewed base.
 */
export async function readCiRerunSettled(
  context: HostedAutonomyPassContextV1,
  tips: ReadonlyMap<string, string | null>,
  /**
   * Also read the pre-review parks a CI fix may be admitted for: only under a
   * runtime whose hosted pre-review fix route is open, the only one the fix
   * rule activates for.
   */
  preReviewFixes = false,
  /**
   * The launcher's legacy review cutoff (`launcherLegacyCutoff`), the same one
   * the planner counts rounds under: a legacy record's open final round is a
   * review round available to its CI fix, so its re-run is read and settled
   * here exactly as the planner's correction rule expects (round-2 recheck
   * P1: read without it, no legacy record ever got its CI fix).
   */
  cutoff: number | null = null,
): Promise<Set<string>> {
  const { snapshot, scopeFor, closedIssues } = context;
  const now = context.deps.clock.now();
  const settled = new Set<string>();
  for (const record of snapshot.work) {
    const head = record.target.head;
    if (
      record.nextStep !== "blocked" || head === null ||
      !(ciRedeliveryEligible(snapshot, record, cutoff) ||
        (preReviewFixes && preReviewFixEligible(snapshot, record, cutoff))) ||
      closedIssues.has(
        hostedIssueKey(record.repository, record.related.issueNumber!),
      )
    ) continue;
    const key = ciGreenHeadKey(record.repository, head);
    if (!rerunShape(snapshot, record, closedIssues)) {
      settled.add(key);
      continue;
    }
    const scope = await scopeFor(record.repository);
    const surface = scope.surface;
    if (surface === null) continue;
    if (
      scope.baseBranch === null || surface.listHeadRuns === undefined ||
      surface.rerunFailedJobs === undefined
    ) {
      settled.add(key);
      continue;
    }
    const tip = tips.get(scope.key) ?? null;
    if (tip === null) continue;
    if (tip !== record.target.base) {
      settled.add(key);
      continue;
    }
    let runs: readonly HostedAutonomyHeadRunV1[] | null;
    try {
      runs = await surface.listHeadRuns(head);
    } catch {
      runs = null;
    }
    if (runs === null) continue;
    const ids = ciRerunRuns(runs, head, now);
    if (ids.length === 0 || ids.length > HOSTED_AUTONOMY_CI_RERUNS_PER_PASS) {
      settled.add(key);
    }
  }
  return settled;
}

/** Re-run eligible flaked CI runs; pushes `rerun:` actions, writes nothing. */
export async function runHostedCiRerunPass(
  context: HostedAutonomyPassContextV1,
): Promise<void> {
  const { snapshot, actions, scopeFor, readTip, readPull } = context;
  const now = context.deps.clock.now();
  let budget = HOSTED_AUTONOMY_CI_RERUNS_PER_PASS;
  const tips = new Map<string, string | null>();
  for (const record of snapshot.work) {
    if (hostedPassDeadlineReached(context)) return;
    if (budget <= 0) break;
    // A record an earlier write of this pass touched waits for the next pass.
    if (context.settled?.has(record.id)) continue;
    if (!rerunShape(snapshot, record, context.closedIssues)) continue;
    const head = record.target.head!;
    const scope = await scopeFor(record.repository);
    if (hostedPassDeadlineReached(context)) return;
    const surface = scope.surface;
    if (
      surface === null || scope.baseBranch === null ||
      surface.listHeadRuns === undefined ||
      surface.rerunFailedJobs === undefined
    ) continue;
    // The run listing goes first: once a head is past attempt 1 (the steady
    // state after a re-run) this is the only read the record costs.
    let runs: readonly HostedAutonomyHeadRunV1[] | null;
    try {
      runs = await surface.listHeadRuns(head);
    } catch {
      runs = null;
    }
    const ids = ciRerunRuns(runs, head, now);
    if (hostedPassDeadlineReached(context)) return;
    // A head is re-run whole or not at all: a partial re-run would end the
    // once-per-head path with a failed run never repeated. A head GitHub would
    // refuse (a failed run past its re-run window) has no ids, so it is
    // skipped here, before any other read and before it spends the budget.
    if (ids.length === 0 || ids.length > budget) continue;
    let open: boolean | null;
    try {
      open = await surface.readIssueOpen(record.related.issueNumber!);
    } catch {
      open = null;
    }
    if (open !== true) continue;
    if (hostedPassDeadlineReached(context)) return;
    const pull = await readPull(scope, record.target.pr!);
    if (hostedPassDeadlineReached(context)) return;
    if (
      pull === null || pull.state !== "open" || pull.merged !== false ||
      pull.headSha !== head || pull.baseRef !== scope.baseBranch ||
      typeof pull.author !== "string" ||
      !HOSTED_AUTONOMY_TRUSTED_AUTHORS.includes(pull.author)
    ) continue;
    let tip = tips.get(scope.key);
    if (tip === undefined) {
      tip = await readTip(scope);
      tips.set(scope.key, tip);
    }
    if (tip === null || tip !== record.target.base) continue;
    if (hostedPassDeadlineReached(context)) return;
    // A red base can fail the head on its own; only a green base makes the
    // head's own failure worth one more attempt.
    let baseGreen: boolean;
    try {
      baseGreen = await surface.hasAllChecksGreen(tip) === true;
    } catch {
      baseGreen = false;
    }
    if (!baseGreen) continue;
    if (hostedPassDeadlineReached(context)) return;
    // One admitted head is re-run whole and read back even across the cutoff.
    // Never leave a partial batch or detached effect behind.
    const accepted = new Map<number, boolean>();
    for (const id of ids) {
      let sent: boolean;
      try {
        sent = await surface.rerunFailedJobs(id);
      } catch {
        sent = false;
      }
      accepted.set(id, sent);
      budget--;
    }
    // Read the head back: only GitHub's advanced run_attempt confirms the
    // re-run, whatever the request itself answered.
    let after: readonly HostedAutonomyHeadRunV1[] | null;
    try {
      after = await surface.listHeadRuns(head);
    } catch {
      after = null;
    }
    for (const id of ids) {
      const advanced = after?.some((run) =>
        run.id === id && run.headSha === head && run.runAttempt > 1
      ) ?? false;
      const outcome = advanced
        ? "sent"
        : accepted.get(id) === true
        ? "unconfirmed"
        : "refused";
      actions.push(`rerun:${record.id}:run=${id}:${outcome}`);
    }
  }
}
