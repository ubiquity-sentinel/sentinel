/**
 * Repair loop internals: pure CI attribution for a reviewed candidate head.
 *
 * A failed check on the candidate is attributed by the SAME-named check on the
 * base the head was reviewed against. Only a real failure on the head (failure
 * or timed_out) can be the candidate's: passed on the base means the candidate
 * broke it (a correction can fix it); failure, timed_out or action_required on
 * the base means the base itself is red (no correction can fix it, so no round
 * is spent); still running on the base means the attribution must wait; and a
 * base that never ran the check, or ended it skipped/neutral/cancelled/stale,
 * proves nothing. Skipped/cancelled/neutral head conclusions are secondary:
 * they never open a charged round and never block a deferral on their own.
 * A GitHub Actions run whose job never started (`neverStarted`, a billing or
 * spending-limit stop) is no evidence on either side: it is pending on the
 * head (`checkPending`, never in `failedChecks`) and attributes nothing on the
 * base (neither red nor green there). A transport read with
 * `{ events: true }` may carry the proven workflow event, but the loop always
 * reads plain checks (`readCiChecks`) and attribution stays by same-named base
 * check: an event mismatch alone never reclassifies a failure.
 *
 * Nothing here is persisted. The generation-76 rollback contract forbids any
 * new state shape, so every consumer re-derives the attribution from live
 * check runs and carries it only in memory (and in the trusted planner's own
 * digest-bound correction request).
 */
import type { GitSha } from "../contracts/brands.ts";
import type { GitHubCheckV1, GitHubPort } from "../contracts/ports.ts";
import { MAX_REVIEW_ROUNDS } from "./review-round-cap.ts";
import {
  CI_UNATTRIBUTED_DETAIL,
  ciLabels,
  preReviewPendingDetail,
} from "./ci-correction-policy.ts";

export * from "./ci-correction-policy.ts";

/**
 * the hard review-round ceiling itself (`MAX_REVIEW_ROUNDS`), since once every
 * round is spent a correction can never become a reviewed verdict (the
 * one-time legacy final review aside, see `reviewRoundAvailable`). The
 * launcher's CI re-admission reads this same value (through `ciCorrectable`),
 * and a test pins it equal to `HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS`.
 */
export const CI_CORRECTION_REVIEW_ROUNDS = MAX_REVIEW_ROUNDS;

/**
 * Whether a HOSTED run may open a CI correction. A hosted correction runs as a
 * matrix cell, and a cell planned in one run may be consumed only by a later
 * run, which after a failed generation's rollback runs the rollback target's
 * code. Generation 76 (41bb853a1) refused a CI correction of a head reviewed
 * clean as a generic provenance refusal that failed every later repair run,
 * so generation 77 kept this route closed. Generation 77 (R77 ab3613e02), the
 * rollback target of generation 78, carries this tree's consumer
 * (`matrix-artifact-wave.ts`): it accepts the planned cell (a head reviewed
 * clean against the record's exact base, the planner's CI finding first) and
 * isolates it as an authenticated runtime mismatch, which blocks the record
 * with its charge retained and never refunded
 * (tests/host/matrix-ci-correction-gen77_test.ts). Every other state the open
 * route writes is inert under R77 except a reviewed head returned to `work`
 * to await its correction: R77's closed route re-publishes that same head and
 * requests one more review, a bounded charged cost of one review round per
 * such record, never a model start, a refund or a merge without review
 * (tests/repair/ci-correction-rollback-gen77_test.ts). In-process runs never
 * plan a cell.
 */
export const HOSTED_CI_CORRECTIONS = true;

/**
 * The CI correction route is open for this run: always in process, and in a
 * hosted (matrix) run only once `HOSTED_CI_CORRECTIONS` is set.
 */
export function ciCorrectionRouteOpen(
  deps: { externalImplementations?: boolean },
): boolean {
  return deps.externalImplementations !== true || HOSTED_CI_CORRECTIONS;
}

/**
 * Whether a HOSTED run may give a base-repair task's CI fix its own opening
 * (`CI_BASE_REPAIR_FINDING_PREFIX`). A hosted fix runs as a matrix cell that
 * a later run may consume under the rollback target's code, and a consumer
 * (`matrix-artifact-wave.ts`) that does not recognise a cell's CI finding
 * refuses it generically, failing every later repair run (the R79 precedent,
 * tests/host/matrix-ci-first-gen79_test.ts). Runtimes before the 2026-10-25
 * base-repair rework recognise only `CI_CORRECTION_FINDING_PREFIX`, so hosted
 * runs keep that opening until the installed rollback target recognises both
 * (a runtime at or after this change); in process the own opening is always
 * used.
 */
export const HOSTED_BASE_REPAIR_FINDING = false;

/** The base-repair CI fix opening may be used by this run. */
export function baseRepairFindingOpen(
  deps: { externalImplementations?: boolean },
): boolean {
  return deps.externalImplementations !== true || HOSTED_BASE_REPAIR_FINDING;
}

/**
 * Head conclusions that can be the candidate's own failure (and the only
 * head failures a red base holds, `base_red`).
 */
export const CANDIDATE_CONCLUSIONS: readonly string[] = [
  "failure",
  "timed_out",
];
/** Base conclusions that make the reviewed base itself red. */
export const RED_BASE_CONCLUSIONS: readonly string[] = [
  "failure",
  "timed_out",
  "action_required",
];

/**
 * A check as observed for attribution. The transport may carry a workflow
 * `event` (`GitHubChecksReadOptionsV1`), but the repair loop never asks for
 * that enrichment: `event` stays optional and absent here.
 */
export type CiObservedCheckV1 = GitHubCheckV1;

/**
 * The attribution read: the plain strict read, without the optional
 * workflow-event enrichment. Proving an event costs one bounded extra
 * `GET /actions/runs/{id}` per distinct workflow run of a head (and again for
 * the base); no consumer attributes by event (see `attributeFailedChecks`), so
 * the hot path must not pay for it. The port keeps the capability
 * (`GitHubChecksReadOptionsV1`) for a future consumer that needs it.
 */
export function readCiChecks(
  github: Pick<GitHubPort, "readChecks">,
  head: GitSha,
  names?: ReadonlySet<string>,
): ReturnType<GitHubPort["readChecks"]> {
  return github.readChecks(head, names);
}

/**
 * Latest observation per key, recency by start time (else completion time):
 * a newer in-progress rerun overrides an older completed run (exactly the
 * merge gate's dedupe).
 */
function latestBy(
  checks: readonly CiObservedCheckV1[],
  key: (check: CiObservedCheckV1) => string,
): Map<string, CiObservedCheckV1> {
  const latest = new Map<string, CiObservedCheckV1>();
  const time = (check: CiObservedCheckV1) =>
    check.startedAt ?? check.completedAt ?? -1;
  for (const check of checks) {
    const prev = latest.get(key(check));
    if (prev === undefined || time(check) > time(prev)) {
      latest.set(key(check), check);
    }
  }
  return latest;
}

/** Latest observation per check name. */
export function latestChecks(
  checks: readonly CiObservedCheckV1[],
): CiObservedCheckV1[] {
  return [...latestBy(checks, (check) => check.name).values()];
}

/**
 * Conclusions that are not failures: `success`, and the jobs a workflow
 * itself chose not to run (`skipped`) or marked informational (`neutral`).
 */
export const GREEN_CONCLUSIONS: readonly string[] = [
  "success",
  "skipped",
  "neutral",
];

export function isGreenConclusion(conclusion: string | null): boolean {
  return conclusion !== null && GREEN_CONCLUSIONS.includes(conclusion);
}

/**
 * A check that has not produced evidence yet: still queued or running, or a
 * GitHub Actions run whose job never started (completed `failure` without a
 * step or a runner) while backup CI may still supply evidence. Nothing of
 * the repository ran, so it is awaited, never judged.
 */
export function checkPending(check: GitHubCheckV1): boolean {
  return check.status !== "completed" || check.neverStarted === true;
}

/**
 * Deduped checks that completed with a non-green conclusion. A run whose job
 * never started is not one: it is pending (`checkPending`).
 */
export function failedChecks(
  checks: readonly GitHubCheckV1[],
): CiObservedCheckV1[] {
  return latestChecks(checks).filter((check) =>
    !checkPending(check) && !isGreenConclusion(check.conclusion)
  );
}

/** Failed head checks partitioned by the base observation of the same name. */
export interface CiAttributionV1 {
  /** Head failure/timed_out, passed on the base: broken by the candidate. */
  candidate: CiObservedCheckV1[];
  /** Head failure/timed_out, failure/timed_out/action_required on the base. */
  baseRed: CiObservedCheckV1[];
  /** Head failure/timed_out, still running on the base. */
  basePending: CiObservedCheckV1[];
  /**
   * Head failure/timed_out with no usable base evidence (the base never ran
   * the check, ended it skipped/neutral/cancelled/stale, or its job never
   * started).
   */
  unattributed: CiObservedCheckV1[];
  /** Head cancelled/action_required (or never started): never attributed. */
  secondary: CiObservedCheckV1[];
}

/**
 * Backup CI attribution (docs/backup-ci-spec.md §11.3), or null when neither
 * side is a backup stand-in and the native rules apply. Like is compared with
 * like: a backup head red against the base's own stand-in or the base's
 * backup peer, and a native head red against a backup base only through the
 * head's backup peer. Without that evidence it is unattributed (never
 * `baseRed`), and the backup planner schedules the missing unit.
 */
function backupAttribution(
  head: CiObservedCheckV1,
  base: CiObservedCheckV1 | undefined,
): "candidate" | "baseRed" | "unattributed" | null {
  const red = (conclusion: string | null | undefined) =>
    RED_BASE_CONCLUSIONS.includes(conclusion ?? "");
  if (head.backup !== undefined) {
    const observed = base?.backup !== undefined
      ? base.conclusion
      : base?.backupPeer?.conclusion;
    if (observed === "success") return "candidate";
    return red(observed) ? "baseRed" : "unattributed";
  }
  if (base?.backup === undefined) return null;
  if (!red(head.backupPeer?.conclusion)) return "unattributed";
  if (base.conclusion === "success") return "candidate";
  return red(base.conclusion) ? "baseRed" : "unattributed";
}

/**
 * Attribute failed head checks against the same-named base observations.
 * A head job that never started is not a failure (`checkPending` keeps it out
 * of `failedChecks`); if one is passed here it is never attributed. A proven
 * workflow event is carried as evidence only: attribution is by check name,
 * so an event mismatch alone never moves a failure out of `candidate`.
 */
export function attributeFailedChecks(
  failed: readonly CiObservedCheckV1[],
  baseChecks: readonly CiObservedCheckV1[],
): CiAttributionV1 {
  const base = latestBy(baseChecks, (check) => check.name);
  const attribution: CiAttributionV1 = {
    candidate: [],
    baseRed: [],
    basePending: [],
    unattributed: [],
    secondary: [],
  };
  for (const check of failed) {
    if (
      check.neverStarted === true ||
      !CANDIDATE_CONCLUSIONS.includes(check.conclusion ?? "")
    ) {
      attribution.secondary.push(check);
      continue;
    }
    const observed = base.get(check.name);
    const backed = backupAttribution(check, observed);
    if (backed !== null) {
      attribution[backed].push(check);
    } else if (observed === undefined || observed.neverStarted === true) {
      attribution.unattributed.push(check);
    } else if (observed.status !== "completed") {
      attribution.basePending.push(check);
    } else if (observed.conclusion === "success") {
      attribution.candidate.push(check);
    } else if (RED_BASE_CONCLUSIONS.includes(observed.conclusion ?? "")) {
      attribution.baseRed.push(check);
    } else attribution.unattributed.push(check);
  }
  return attribution;
}

/**
 * What the failed head checks prove, in precedence order. `redBase` marks a
 * base-repair task's own `base_red` (`ownBaseRed`): its checks are red on the
 * base too, and its CI fix finding says so.
 */
export type CiDispositionV1 =
  | { kind: "candidate"; checks: CiObservedCheckV1[]; redBase?: true }
  | { kind: "base_pending" }
  | { kind: "base_red" }
  | { kind: "unattributed"; checks: CiObservedCheckV1[] };

/**
 * A candidate-caused failure decides first (the correction re-runs every
 * check); a running base check is awaited; a red base defers only when every
 * real head failure is red there too; anything else proves nothing. Secondary
 * conclusions alone are unattributed.
 */
export function decideCiDisposition(
  attribution: CiAttributionV1,
): CiDispositionV1 {
  if (attribution.candidate.length > 0) {
    return { kind: "candidate", checks: attribution.candidate };
  }
  if (attribution.basePending.length > 0) return { kind: "base_pending" };
  if (attribution.baseRed.length > 0 && attribution.unattributed.length === 0) {
    return { kind: "base_red" };
  }
  return {
    kind: "unattributed",
    checks: attribution.unattributed.length > 0
      ? attribution.unattributed
      : attribution.secondary,
  };
}

/** Terminal blocker detail of a failure no base observation attributes. */
export function unattributedDetail(
  checks: readonly CiObservedCheckV1[],
): string {
  return `${CI_UNATTRIBUTED_DETAIL}: ${
    ciLabels(checks, (name, conclusion) => `${name}(${conclusion})`)
  }`;
}

/**
 * Park detail of a head whose failure no base evidence attributed within the
 * bound.
 */
export function preReviewUnattributedDetail(
  checks: readonly CiObservedCheckV1[],
): string {
  return `${preReviewPendingDetail(checks)} without base evidence`;
}
