/**
 * Launcher-only flake path for a reviewed head parked on the runtime's
 * merge-gate CI failure ("CI checks failed: ...", or the CI-correction
 * runtime's "CI checks failed without base evidence: ..."). When the exact
 * head holds a clean review against a base that is still the base tip and is
 * itself all green, the failed workflow run on that head is re-run ONCE.
 * Nothing is written: GitHub's own `run_attempt` is the durable once-per-head
 * record, so a head with any run past attempt 1 is never re-run again,
 * whoever re-ran it and whatever it concluded. A head that turns green is
 * re-admitted to delivery by the retry pass (`ciGreenRedeliveryEligible`); a
 * head that fails again stays parked until a CI-correction runtime may
 * correct it (`readCiRerunSettled`).
 *
 * The pass charges, refunds and decides nothing about the failure: it only
 * asks GitHub to repeat the repository's own deterministic check on the exact
 * reviewed head, at most `HOSTED_AUTONOMY_CI_RERUNS_PER_PASS` runs per pass.
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
import type { HostedAutonomyPassContextV1 } from "./hosted-autonomy-scopes.ts";
import type { HostedAutonomyHeadRunV1 } from "./hosted-autonomy-types.ts";

/** Bound on workflow runs one maintenance pass re-runs. */
export const HOSTED_AUTONOMY_CI_RERUNS_PER_PASS = 3;

/** Run conclusions that can be a flake worth one more attempt. */
const RERUNNABLE: readonly string[] = ["failure", "timed_out"];

type WorkRow = RepairStateSnapshotV1["work"][number];

/**
 * The runs to re-run on one exact head: every completed run that ended
 * `failure` or `timed_out`, and none at all once any run on the head is past
 * its first attempt (or the listing is unprovable).
 */
export function ciRerunRuns(
  runs: readonly HostedAutonomyHeadRunV1[] | null,
  head: string,
): number[] {
  if (runs === null) return [];
  const bound = runs.filter((run) => run.headSha === head);
  if (bound.some((run) => run.runAttempt > 1)) return [];
  return bound
    .filter((run) =>
      run.status === "completed" && run.conclusion !== null &&
      RERUNNABLE.includes(run.conclusion)
    )
    .map((run) => run.id);
}

/**
 * Local gates: the CI-parked, clean-reviewed, unreleased shape with no
 * operation in flight, on a published head whose candidate is durably
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
    ciGreenRedeliveryEligible(snapshot, record) &&
    !closedIssues.has(
      hostedIssueKey(record.repository, record.related.issueNumber!),
    );
}

/**
 * Heads (`ciGreenHeadKey`) of CI-parked records a correction may re-admit
 * because this pass can no longer re-run them: the head is outside the re-run
 * shape (for example a legacy record without candidate state), its surface
 * cannot list or re-run runs, the base tip moved off the reviewed base, the
 * head's run listing shows a run past attempt 1 or nothing re-runnable, or it
 * holds more failed runs than one pass may re-run. An unreadable surface, base
 * tip or run listing is never settled: the correction waits for the flake.
 * `tips` holds the base tips the caller read, keyed by scope. Reads one run
 * listing per correction-eligible head whose tip is still its reviewed base.
 */
export async function readCiRerunSettled(
  context: HostedAutonomyPassContextV1,
  tips: ReadonlyMap<string, string | null>,
): Promise<Set<string>> {
  const { snapshot, scopeFor, closedIssues } = context;
  const settled = new Set<string>();
  for (const record of snapshot.work) {
    const head = record.target.head;
    if (
      record.nextStep !== "blocked" || head === null ||
      !ciRedeliveryEligible(snapshot, record) ||
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
    const ids = ciRerunRuns(runs, head);
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
  let budget = HOSTED_AUTONOMY_CI_RERUNS_PER_PASS;
  const tips = new Map<string, string | null>();
  for (const record of snapshot.work) {
    if (budget <= 0) break;
    if (!rerunShape(snapshot, record, context.closedIssues)) continue;
    const head = record.target.head!;
    const scope = await scopeFor(record.repository);
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
    const ids = ciRerunRuns(runs, head);
    // A head is re-run whole or not at all: a partial re-run would end the
    // once-per-head path with a failed run never repeated.
    if (ids.length === 0 || ids.length > budget) continue;
    let open: boolean | null;
    try {
      open = await surface.readIssueOpen(record.related.issueNumber!);
    } catch {
      open = null;
    }
    if (open !== true) continue;
    const pull = await readPull(scope, record.target.pr!);
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
    // A red base can fail the head on its own; only a green base makes the
    // head's own failure worth one more attempt.
    let baseGreen: boolean;
    try {
      baseGreen = await surface.hasAllChecksGreen(tip);
    } catch {
      baseGreen = false;
    }
    if (!baseGreen) continue;
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
