import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { attemptEquivalenceRefusalForRecordV1 } from "../src/repair/attempt-policy.ts";
import { baseReviewOrigin } from "../src/repair/base-satisfaction-marker.ts";
import {
  CONFLICT_PROTECTED_DETAIL,
  conflictMarkerBase,
} from "../src/repair/conflict-resolution.ts";
import { type GitSha, isGitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { candidateBranch, reviewOperationKey } from "../src/repair/keys.ts";
import {
  HOSTED_AUTONOMY_RETRYABLE,
  hostedIssueKey,
  hostedRepositoryKey,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import { evidenceExpired } from "./hosted-autonomy-evidence-expiry.ts";
import {
  ordinaryReviewRoundsSpent,
  reviewRoundsLeft,
} from "../src/repair/review-round-cap.ts";
import { planRaisedCeilingReadmission } from "./hosted-autonomy-raised-ceiling.ts";
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import {
  ciCorrectionRuntimeProven,
  ciGreenHeadKey,
  ciGreenRedeliveryEligible,
  ciRedeliveryEligible,
} from "./hosted-autonomy-ci-retries.ts";
import {
  ciFirstFixRuntimeProven,
  ciFirstFixSelfInstalledRuntimeProven,
  ciFirstRuntimeProven,
  ciFirstSelfInstalledRuntimeProven,
  HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES,
  HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
  launcherLegacyCutoff,
  LEGACY_ROUND_REQUIRES_CI_FIRST,
  legacyFinalRoundAdmissible,
  preReviewCiParked,
  preReviewFixEligible,
  preReviewGateParked,
} from "./hosted-autonomy-ci-first.ts";
import {
  ciFixMarker,
  reviewRoundAvailable,
} from "../src/repair/ci-first-policy.ts";
import {
  type RepeatFailureContextV1,
  type RepeatFailureParkPlanV1,
  repeatFailureVerdict,
  repeatFailureWithheld,
} from "./hosted-autonomy-repeat-failure.ts";

/**
 * Durable reservations charged to one task, across every purpose and outcome
 * (including one still `reserved`). This is the automatic-retry bound's unit:
 * this pass no longer increments the preserved `retries` counter, and a
 * reservation is the charge the runtime always persists before a model start,
 * so the bound cannot be reset or evaded by an uncharged retry cycle.
 */
export function taskReservationCount(
  snapshot: RepairStateSnapshotV1,
  taskId: string,
): number {
  let count = 0;
  for (const reservation of snapshot.reservations) {
    if (reservation.taskId === taskId) count++;
  }
  return count;
}

/** Attempt numbers already occupied at one base for one purpose. */
export function usedAttempts(
  snapshot: RepairStateSnapshotV1,
  taskId: string,
  base: string,
  purpose: string,
): Set<number> {
  const used = new Set<number>();
  for (const reservation of snapshot.reservations) {
    if (reservation.taskId !== taskId) continue;
    if (reservation.head !== base) continue;
    if (reservation.purpose !== purpose) continue;
    // The runtime refuses a duplicate (repository, task, base, attempt,
    // purpose) identity instead of starting a second session, so a reserved
    // implementation/retry identity is already occupied and must never be
    // planned again. A reserved review_request is the one exception: the
    // review step reconciles that pending request through its own existing
    // semantics, so it stays eligible here exactly as before.
    if (reservation.outcome === "reserved" && purpose === "review_request") {
      continue;
    }
    used.add(reservation.attempt);
  }
  return used;
}

/** The runtime's own settled-intent safety rule for a blocked record. */
export function intentClosable(
  record: RepairStateSnapshotV1["work"][number],
  reservations: RepairStateSnapshotV1["reservations"],
): boolean {
  if (record.intent === null) return true;
  const requestId = record.intent.requestId;
  if (requestId === null || requestId === "") return false;
  if (record.intent.kind === "implementation") {
    return reservations.some((reservation) =>
      reservation.id === requestId && reservation.outcome !== "reserved"
    );
  }
  // A review intent may be cleared only when BOTH sides of its identity are
  // proven: the intent itself must be bound to the record's exact current
  // publication (same head, PR, deterministic candidate branch and the non-null
  // base that publication was reviewed against), and the settled reservation
  // must be the exact review charge of the round the intent's canonical
  // operation key names. A still-`reserved`, unknown or mismatched reservation
  // — or a stale intent for another publication, key, round or base — leaves
  // everything protected for the runtime's own reconciliation.
  if (record.intent.kind !== "review_request") return false;
  const intent = record.intent;
  const head = record.target.head;
  const pullRequest = record.target.pr;
  if (head === null || pullRequest === null) return false;
  if (intent.expectedHead !== head) return false;
  if (intent.pr !== pullRequest) return false;
  if (intent.branch !== candidateBranch(record.id)) return false;
  if (record.target.branch !== intent.branch) return false;
  // A review admission binds the head, not the base, so the base the intent
  // itself observed is the only proof this charge belongs to the record's
  // current publication; a null record base or a moved intent base refuses.
  const base = record.target.base;
  if (base === null) return false;
  if (intent.observedBase !== base) return false;
  return reservations.some((reservation) =>
    reservation.id === requestId &&
    reservation.outcome !== "reserved" &&
    reservation.taskId === record.id &&
    reservation.purpose === "review_request" &&
    reservation.head === head &&
    sameRepository(reservation.repository, record.repository) &&
    intent.key === reviewOperationKey(pullRequest, head, reservation.attempt)
  );
}

/**
 * Review identities already charged and SETTLED at one record's current
 * candidate head. The runtime's review identity is (repository, task, head,
 * attempt, purpose), and a duplicate of a settled identity is the terminal
 * "review admission already settled without an intent" contradiction, so these
 * attempts are occupied and must never be planned again. A reservation still
 * `reserved` is an in-flight admission the review step reconciles through its
 * own semantics, so it stays out of this set exactly as it does for the
 * attempt identities above.
 */
export function settledReviewAttempts(
  snapshot: RepairStateSnapshotV1,
  record: RepairStateSnapshotV1["work"][number],
): Set<number> {
  const settled = new Set<number>();
  const head = record.target.head;
  if (head === null) return settled;
  for (const reservation of snapshot.reservations) {
    if (reservation.taskId !== record.id) continue;
    if (reservation.purpose !== "review_request") continue;
    if (reservation.head !== head) continue;
    if (reservation.outcome === "reserved") continue;
    if (!sameRepository(reservation.repository, record.repository)) continue;
    settled.add(reservation.attempt);
  }
  return settled;
}

/**
 * The review-round counter a review-returning grant must persist: the record's
 * current counter raised to the first review identity at its current head that
 * no settled admission occupies. A charged counter is history and is only ever
 * raised — never zeroed, never lowered and never reused, so the next admission
 * the runtime charges is an identity nothing has charged yet.
 */
export function plannedReviewRounds(
  record: RepairStateSnapshotV1["work"][number],
  settled: ReadonlySet<number>,
): number {
  let rounds = record.counters.reviewRounds;
  for (const attempt of settled) {
    if (attempt > rounds) rounds = attempt;
  }
  while (settled.has(rounds + 1)) rounds++;
  return rounds;
}

/** Existing charges bound this finite monotonic implementation-index scan. */
function implementationAttemptFloor(
  snapshot: RepairStateSnapshotV1,
  record: RepairStateSnapshotV1["work"][number],
): number {
  let floor = record.counters.attempts;
  for (const reservation of snapshot.reservations) {
    if (
      reservation.taskId !== record.id ||
      !sameRepository(reservation.repository, record.repository)
    ) continue;
    if (
      reservation.purpose !== "implementation" &&
      reservation.purpose !== "retry"
    ) continue;
    floor = Math.max(floor, reservation.attempt);
  }
  return floor;
}

/**
 * The retry table's verdict on a blocked record whose retained intent carries
 * the conflict marker of base tip `marked` (`conflict-resolution.ts`). The one
 * charge per (task, base tip) is the reservation the intent names:
 *
 * - `class`: no SETTLED charge of this task is named (missing or still
 *   `reserved`, a refresh intent that names none, or refunded by the
 *   runtime's own `confirmed_not_submitted` path), so the record's own
 *   blocker class decides; its settled-intent rule (`intentClosable`)
 *   refuses an unsettled implementation charge, so nothing is planned or
 *   refunded for an in-flight or isolated admission;
 * - `deny`: the settled charge is bound to another task, repository or
 *   purpose (`conflict_resolution_unbound`), or it is charged (`submitted` or
 *   `ambiguous`, never refunded) while the base tip is unreadable or still
 *   the marked tip (`conflict_resolution_spent`), or the moved tip has no
 *   publication to refresh onto it or is the record's own base
 *   (`conflict_resolution_unpublished`);
 * - `rebase`: the charge is spent and the target moved past the marked tip,
 *   so the record returns to a plain refresh at `observedBase` (no marker,
 *   the PR and charges kept); a renewed conflict there costs at most one
 *   charge at that new tip. Age or generation alone never qualifies, and the
 *   caller re-pends only a blocker class this table already retries: a
 *   protected-path resolution, or any other class the table never retries,
 *   has no attempt-memory brake and stays owner-terminal at every tip
 *   (`conflict_resolution_protected`, `conflict_resolution_terminal`).
 */
export function conflictMarkerVerdict(
  snapshot: RepairStateSnapshotV1,
  record: RepairStateSnapshotV1["work"][number],
  marked: string,
  tip: string | null,
):
  | { kind: "class" }
  | { kind: "deny"; reason: string }
  | { kind: "rebase"; observedBase: string } {
  const intent = record.intent;
  const requestId = intent?.requestId ?? null;
  if (intent === null || requestId === null || requestId === "") {
    return { kind: "class" };
  }
  const charge = snapshot.reservations.find((row) => row.id === requestId);
  if (charge === undefined || charge.outcome === "reserved") {
    return { kind: "class" };
  }
  if (
    charge.taskId !== record.id ||
    !sameRepository(charge.repository, record.repository) ||
    (charge.purpose !== "implementation" && charge.purpose !== "retry")
  ) return { kind: "deny", reason: "conflict_resolution_unbound" };
  if (charge.outcome === "confirmed_not_submitted") return { kind: "class" };
  if (tip === null || !isGitSha(tip) || tip === marked) {
    return { kind: "deny", reason: "conflict_resolution_spent" };
  }
  const { pr, head, branch, base } = record.target;
  if (pr === null || head === null || branch === null || tip === base) {
    return { kind: "deny", reason: "conflict_resolution_unpublished" };
  }
  return { kind: "rebase", observedBase: tip };
}

/** Detail suffix of a moved-tip re-pend of a spent conflict resolution. */
export const CONFLICT_BASE_ADVANCE_SUFFIX = ":conflict_resolution:base-advance";

/**
 * A plan returning a spent conflict resolution to a refresh at a moved tip,
 * where the installed runtime may charge one more resolution (counted by the
 * retry pass against `HOSTED_AUTONOMY_CONFLICT_RESOLUTIONS_PER_PASS`).
 */
export function conflictBaseAdvancePlan(plan: RetryPlanV1): boolean {
  return plan.advanceBase === true &&
    plan.detail.endsWith(CONFLICT_BASE_ADVANCE_SUFFIX);
}

export interface RetryPlanV1 {
  id: string;
  /** The exact repository scope this plan belongs to. */
  repository: RepositoryIdentityV1;
  /** Retained API shape; implementation retries use zero and never lower history. */
  grant: number;
  /** `delivery` re-gates a reviewed head; it charges and refreshes nothing. */
  nextStep: "work" | "review" | "delivery";
  /**
   * The exact review-round counter a review-returning plan persists, or null
   * when the counter is preserved. It is the computed floor — the highest
   * settled `review_request` attempt at the record's current head raised past
   * every occupied identity — and never below the record's current value: a
   * charged counter is history, so it is never zeroed or lowered. Work plans
   * carry null.
   */
  reviewRounds: number | null;
  /**
   * A verified newer target base is reconciled through the existing refresh
   * intent. Review-returning plans still require this once their current-head
   * review identities are exhausted; implementation indices stay monotonic.
   */
  advanceBase: boolean;
  /** Exact base observed for an advancing plan. */
  observedBase: string | null;
  detail: string;
  /**
   * A work-returning CI-first plan that returns a red, never-reviewed head
   * with the runtime's CI fix marker (a zero-length `backoff` wait). Only an
   * allowlisted fix runtime activates it; it charges nothing itself.
   */
  ciFixMarker?: true;
}

/** Detail suffix of a CI re-admission whose head is green again. */
const CI_GREEN_DETAIL_SUFFIX = ":green";

/** Detail suffix of a pre-review park returned for its moved-base refresh. */
const CI_BASE_MOVED_DETAIL_SUFFIX = ":base-moved";

/**
 * Denial of the green CI rule for a head whose ordinary review rounds are
 * spent: the delivery pass's spent-round rule merges it (or refuses) itself.
 */
export const GREEN_SPENT_LEFT_TO_DELIVERY = "green_spent_left_to_delivery";

/**
 * True for a CI correction re-admission: a delivery-returning plan whose
 * head is not green again. Only these count against
 * `HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS`, which the retry pass applies
 * after it has verified each plan's pull request, so a plan it drops there
 * (pull request not open or unreadable) never holds a slot.
 */
export function ciCorrectionPlan(plan: RetryPlanV1): boolean {
  return (plan.nextStep === "delivery" &&
    !plan.detail.endsWith(CI_GREEN_DETAIL_SUFFIX)) ||
    plan.ciFixMarker === true;
}

/**
 * The CI-first re-admission of a head the runtime's pre-review gate parked
 * (`hosted-autonomy-ci-first.ts`), each back at `work` with nothing charged:
 *
 * - green: green again on its unchanged base, under any runtime (the
 *   exhausted park of a never-reviewed head included): the runtime's gate
 *   then requests the review;
 * - moved base: a red or pending park (never the exhausted one) whose base
 *   moved, under a proven CI-first runtime only: the runtime refreshes it
 *   deterministically and uncharged (its freshness gate reads the tip) and
 *   gates the refreshed head's CI before any review. Under any other runtime
 *   (R79 reviews before CI) it stays parked;
 * - fix: still red, once its re-run can no longer act, with the CI fix marker
 *   only under a fix runtime (a moved base takes the refresh first, unless
 *   only a CI fix can open the record's round: a legacy final round).
 *
 * The green and moved-base returns lead straight to a review request (or to
 * the refresh before it), so they need a review round left by the ceiling's
 * own count (`reviewRoundsLeft`; the runtime's ceiling gate would park the
 * record before any refresh otherwise, and an open legacy final round is a CI
 * fix's to arm); a fix needs one available (`reviewRoundAvailable`). A record
 * whose next review is a legacy final round under a runtime not proven
 * CI-first (`legacyFinalRoundAdmissible`) stays parked: R79 would review it
 * past the cap, or before its CI. Null when no CI-first rule applies.
 */
function planCiFirstReadmission(
  snapshot: RepairStateSnapshotV1,
  record: RepairStateSnapshotV1["work"][number],
  baseTips: ReadonlyMap<string, string | null>,
  ciGreenHeads: ReadonlySet<string>,
  ciRerunSettled: ReadonlySet<string>,
  ciFixRuntime: boolean,
  ciFirst: boolean,
  cutoff: number | null,
): RetryPlanV1 | null {
  const blocker = record.blocker;
  const head = record.target.head;
  if (
    blocker === null || head === null ||
    !preReviewGateParked(snapshot, record) ||
    !reviewRoundAvailable(snapshot, record, cutoff) ||
    !legacyFinalRoundAdmissible(snapshot, record, ciFirst)
  ) return null;
  const key = ciGreenHeadKey(record.repository, head);
  const tip = baseTips.get(hostedRepositoryKey(record.repository)) ?? null;
  const roundLeft = reviewRoundsLeft(snapshot, record, cutoff) > 0;
  const green = tip === record.target.base && ciGreenHeads.has(key) &&
    roundLeft;
  const moved = !green && ciFirst && tip !== null &&
    tip !== record.target.base && roundLeft &&
    preReviewCiParked(snapshot, record);
  const fix = !green && !moved && ciFixRuntime && ciRerunSettled.has(key) &&
    preReviewFixEligible(snapshot, record, cutoff);
  if (!green && !moved && !fix) return null;
  const prefix = blocker.message.slice(0, blocker.message.indexOf(":") + 1);
  return {
    id: record.id,
    repository: record.repository,
    grant: 0,
    nextStep: "work",
    reviewRounds: null,
    advanceBase: false,
    observedBase: null,
    detail: `${blocker.kind}:${prefix}${
      green ? CI_GREEN_DETAIL_SUFFIX : moved ? CI_BASE_MOVED_DETAIL_SUFFIX : ""
    }`,
    ...(fix ? { ciFixMarker: true as const } : {}),
  };
}

/**
 * Bounded, closed retry planning for one snapshot. Every returned plan has an
 * unused next-attempt identity and respects memory/review limits. Prior
 * reservation count never stops a new otherwise-admissible grant.
 *
 * `baseTips` is keyed by `hostedRepositoryKey`: each record is planned against
 * its OWN repository's base tip, so a foreign repository can never advance a
 * sentinel record's base or vice versa. `closedIssues` holds
 * `hostedIssueKey` values, so two repositories may both carry issue 120.
 */
/**
 * One blocked record whose equivalent-retry grant was refused by durable
 * attempt memory. Reported by the caller; never a silent no-op.
 */
export interface RetryDenialV1 {
  id: string;
  repository: RepositoryIdentityV1;
  reason: string;
}

export function planHostedRetries(
  snapshot: RepairStateSnapshotV1,
  now: number,
  /** Authenticated installed runtime from the authoritative release snapshot. */
  runtimeSha: GitSha,
  baseTips: ReadonlyMap<string, string | null> = new Map(),
  closedIssues: ReadonlySet<string> = new Set(),
  onDenied?: (denial: RetryDenialV1) => void,
  /**
   * The authenticated installed runtime record. The CI re-admission is
   * planned only when it is an allowlisted generation-78+ CI-correction
   * runtime holding its own healthy proof (`ciCorrectionRuntimeProven`);
   * `ciAllowlist` replaces the pinned allowlist for tests only.
   *
   * `ciRerunSettled` holds `ciGreenHeadKey` values for CI-parked heads whose
   * once-per-head flake re-run can no longer act (`readCiRerunSettled`). A
   * correction is re-admitted only for such a head, so a flake is re-run
   * before any correction round is spent; absent means none is settled.
   * Every correction candidate is planned (`ciCorrectionPlan`): only the
   * retry pass knows which pull requests are still open, so it applies
   * `HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS` to the plans it verified.
   *
   * `ciGreenHeads` holds `ciGreenHeadKey` values for heads whose CI the
   * caller read as all green on their own repository surface. A CI-parked
   * head in it returns to delivery under any runtime when its base tip is
   * still exactly the reviewed base (`ciGreenRedeliveryEligible`).
   */
  options: {
    ciRuntime?: HostedRuntimeRecordV1 | null;
    ciAllowlist?: ReadonlySet<string>;
    ciRerunSettled?: ReadonlySet<string>;
    ciGreenHeads?: ReadonlySet<string>;
    /**
     * CI-first allowlists (`hosted-autonomy-ci-first.ts`), replaced for tests
     * only: the legacy final-review re-admission needs a CI-first runtime,
     * the pre-review fix re-admission a fix runtime.
     */
    ciFirstAllowlist?: ReadonlySet<string>;
    ciFirstFixAllowlist?: ReadonlySet<string>;
    /**
     * `ciGreenHeadKey` values of the heads whose CI the caller actually read
     * (green or not). A head whose ordinary review rounds are spent is never
     * planned as a CI correction unless its CI was read and is not green: a
     * green spent head merges through the spent-round rule at its exact base
     * or returns to `delivery` for the carried refresh on a moved base.
     */
    ciReadHeads?: ReadonlySet<string>;
    /**
     * `ciGreenHeadKey` values of the heads whose CI listing the caller tried
     * to read and could not (rate limited, failing, incomplete or holding no
     * check run: `hasAllChecksGreen` null). That is no evidence of a failure,
     * so no CI correction and no CI fix is planned for such a head this pass
     * (it takes no slot); the next pass reads it again.
     */
    ciUnreadHeads?: ReadonlySet<string>;
    /**
     * The legacy review cutoff (`launcherLegacyCutoff`), replaced for tests
     * only; by default the installed runtime's pinned cutoff, under a proven
     * CI-first runtime.
     */
    legacyReviewCutoff?: number | null;
    /**
     * Launcher facts of the repeat-failure bound
     * (`hosted-autonomy-repeat-failure.ts`). Absent, nothing can be verified:
     * a due record is withheld without a park and a parked one never re-arms.
     */
    repeatFailure?: RepeatFailureContextV1;
    /** Receives each park the bound decided; the caller writes it. */
    onRepeatFailurePark?: (park: RepeatFailureParkPlanV1) => void;
  } = {},
): RetryPlanV1[] {
  if (!isGitSha(runtimeSha)) return [];
  const ciRuntime = options.ciRuntime ?? null;
  const ciCorrection = ciRuntime !== null &&
    ciRuntime.activeRevision === runtimeSha &&
    ciCorrectionRuntimeProven(ciRuntime, options.ciAllowlist);
  const ciFirst = ciRuntime !== null &&
    ciRuntime.activeRevision === runtimeSha &&
    (ciFirstRuntimeProven(
      ciRuntime,
      options.ciFirstAllowlist ?? HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
    ) || ciFirstSelfInstalledRuntimeProven(ciRuntime));
  const ciFixRuntime = ciRuntime !== null &&
    ciRuntime.activeRevision === runtimeSha &&
    (ciFirstFixRuntimeProven(
      ciRuntime,
      options.ciFirstFixAllowlist ?? HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES,
      options.ciFirstAllowlist ?? HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
    ) || ciFirstFixSelfInstalledRuntimeProven(ciRuntime));
  const ciUnreadHeads = options.ciUnreadHeads ?? new Set<string>();
  // Every CI correction and CI fix plan needs its head's re-run settled; an
  // unread head is never settled for this pass (sentinel issue #154).
  const ciRerunSettled = new Set(
    [...(options.ciRerunSettled ?? [])].filter((key) =>
      !ciUnreadHeads.has(key)
    ),
  );
  const ciGreenHeads = options.ciGreenHeads ?? new Set<string>();
  const ciReadHeads = options.ciReadHeads ?? ciGreenHeads;
  const cutoff = options.legacyReviewCutoff !== undefined
    ? options.legacyReviewCutoff
    : launcherLegacyCutoff(ciRuntime, ciFirst);
  const plans: RetryPlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep !== "blocked") continue;
    // The runtime reviews a trusted unchanged-base outcome against the issue.
    // Keep its original charged admission, including a historical repeat park:
    // an ordinary retry/re-arm would erase that evidence before runtime runs.
    // This only withholds launcher writes, so it is safe while R80 is installed.
    if (baseReviewOrigin(record, snapshot) !== null) continue;
    // A task whose source issue is closed or gone is not repairable: retrying
    // it can only spend a model session on work that no longer exists. The
    // identity is the pair (repository, issue number): a closed issue in
    // another repository never stops this record's retry.
    if (
      record.related.issueNumber !== null &&
      closedIssues.has(
        hostedIssueKey(record.repository, record.related.issueNumber),
      )
    ) {
      continue;
    }
    const blocker = record.blocker;
    if (blocker === null) continue;
    // A repeat-failure park is named every pass; an edited issue or a changed
    // model route re-arms it once as an ordinary work grant.
    const repeat = repeatFailureVerdict(
      snapshot,
      record,
      options.repeatFailure,
    );
    if (repeatFailureWithheld(repeat, record, false, onDenied)) continue;
    const rearm = repeat.kind === "rearm" ? repeat.trigger : null;
    const rule: (typeof HOSTED_AUTONOMY_RETRYABLE)[number] | undefined =
      rearm !== null
        ? { prefix: `repeat_failure_rearmed:${rearm}`, nextStep: "work" }
        : HOSTED_AUTONOMY_RETRYABLE.find((item) =>
          blocker.message.startsWith(item.prefix)
        );
    if (!Number.isSafeInteger(now)) continue;
    // A conflict resolution that was charged and did not publish keeps the
    // conflict marker on its retained intent: one charge per (task, base tip).
    const marked = conflictMarkerBase(record.intent);
    if (marked !== null) {
      const tip = baseTips.get(hostedRepositoryKey(record.repository)) ?? null;
      const verdict = conflictMarkerVerdict(snapshot, record, marked, tip);
      if (verdict.kind === "deny") {
        onDenied?.({
          id: record.id,
          repository: record.repository,
          reason: verdict.reason,
        });
        continue;
      }
      if (verdict.kind === "rebase") {
        // Only a class this table already retries returns at a moved tip: a
        // resolution blocked for a protected path (or any other class the
        // table never retries) records no attempt memory, so re-pending it
        // would charge one more resolution per base move. It stays
        // owner-terminal like the same block without a marker.
        if (rule === undefined) {
          onDenied?.({
            id: record.id,
            repository: record.repository,
            reason: blocker.message === CONFLICT_PROTECTED_DETAIL
              ? "conflict_resolution_protected"
              : "conflict_resolution_terminal",
          });
          continue;
        }
        // The class's own evidence-expiry wait still applies.
        if (
          rule.minBlockedMs !== undefined &&
          !evidenceExpired(
            record,
            snapshot.reservations,
            now,
            rule.minBlockedMs,
          )
        ) continue;
        // A resolved merge needs a review round of its own, counted as the
        // runtime's conflict shape counts it (`reviewRoundsLeft`); a legacy
        // record's final round (armed by its CI fix) only under a CI-first
        // runtime.
        if (reviewRoundsLeft(snapshot, record, cutoff) === 0) {
          onDenied?.({
            id: record.id,
            repository: record.repository,
            reason: "conflict_resolution_rounds_spent",
          });
          continue;
        }
        if (!legacyFinalRoundAdmissible(snapshot, record, ciFirst)) {
          onDenied?.({
            id: record.id,
            repository: record.repository,
            reason: LEGACY_ROUND_REQUIRES_CI_FIRST,
          });
          continue;
        }
        if (
          !Number.isSafeInteger(
            implementationAttemptFloor(snapshot, record) + 1,
          )
        ) continue;
        plans.push({
          id: record.id,
          repository: record.repository,
          grant: 0,
          nextStep: "work",
          reviewRounds: null,
          advanceBase: true,
          observedBase: verdict.observedBase,
          detail: `${blocker.kind}${CONFLICT_BASE_ADVANCE_SUFFIX}`,
        });
        continue;
      }
    }
    if (rule === undefined) {
      const ciFirstPlan = planCiFirstReadmission(
        snapshot,
        record,
        baseTips,
        ciGreenHeads,
        ciRerunSettled,
        ciFixRuntime,
        ciFirst,
        cutoff,
      );
      if (ciFirstPlan !== null) {
        plans.push(ciFirstPlan);
        continue;
      }
      const raised = planRaisedCeilingReadmission(snapshot, record, cutoff);
      if (raised !== null) plans.push(raised);
      continue;
    }
    if (
      rule.minBlockedMs !== undefined &&
      !evidenceExpired(record, snapshot.reservations, now, rule.minBlockedMs)
    ) continue;
    if (!intentClosable(record, snapshot.reservations)) continue;
    // A delivery-returning grant re-gates the exact reviewed head under the
    // installed runtime's CI attribution: no charge, no base advance and no
    // counter movement here; the runtime decides correction or deferral.
    if (rule.nextStep === "delivery") {
      const head = record.target.head;
      const key = head === null
        ? null
        : ciGreenHeadKey(record.repository, head);
      const exactBase = record.target.base !== null &&
        baseTips.get(hostedRepositoryKey(record.repository)) ===
          record.target.base;
      const spent = ordinaryReviewRoundsSpent(snapshot, record);
      const headGreen = key !== null && ciGreenHeads.has(key) &&
        ciGreenRedeliveryEligible(snapshot, record);
      // A head that is green again on its exact reviewed base (a re-run
      // flake) passes any runtime's merge gate, so it needs no correction
      // route and no review round, and never counts against the per-pass
      // correction cap.
      let green = headGreen && exactBase;
      // A green head whose ordinary review rounds are spent (a legacy record
      // included) is the spent-round rule's: the delivery pass, later in
      // this same maintenance pass, re-reads the tip and merges that exact
      // head at its exact reviewed base or refuses. Handed to the runtime's
      // `delivery` step instead, this write would settle the record for the
      // rest of the pass, and a base that moved before the runtime's step
      // would make R79 refresh it and review it a fourth time.
      if (green && spent) {
        onDenied?.({
          id: record.id,
          repository: record.repository,
          reason: GREEN_SPENT_LEFT_TO_DELIVERY,
        });
        continue;
      }
      // A spent head green on a MOVED base returns to `delivery` only under a
      // proven CI-first runtime, whose delivery step refreshes it
      // mechanically and merges it under its carried review once the
      // refreshed head is green (no review round, no CI fix, never a
      // correction slot). Under any other runtime it would be refreshed and
      // reviewed a fourth time, so it stays parked.
      if (headGreen && !exactBase && spent && ciFirst) green = true;
      // A correction only once the head's flake re-run can no longer act. A
      // record correctable only through its one-time legacy final round
      // (every ordinary round spent) needs the CI-first runtime: under any
      // other its refreshed head would be reviewed while still red. A spent
      // head is planned as a correction only when its CI was read and is not
      // green, so a green legacy head is never handed over as a correction.
      const corrected = !green && !headGreen && ciCorrection &&
        key !== null && ciRerunSettled.has(key) &&
        (!spent || ciReadHeads.has(key)) &&
        ciRedeliveryEligible(snapshot, record, cutoff) &&
        legacyFinalRoundAdmissible(snapshot, record, ciFirst);
      if (!corrected && !green) continue;
      plans.push({
        id: record.id,
        repository: record.repository,
        grant: 0,
        nextStep: "delivery",
        reviewRounds: null,
        advanceBase: false,
        observedBase: null,
        detail: `${blocker.kind}:${rule.prefix.trimEnd()}${
          green ? CI_GREEN_DETAIL_SUFFIX : ""
        }`,
      });
      continue;
    }
    // A work-returning grant only exists to buy another implementation run.
    // Once every review round is spent (counted from the durable ledger as
    // well as the counter, `reviewRoundsLeft`), that run cannot become a
    // reviewed verdict, so the grant is provably futile and is refused: the
    // delivery pass owns the record's receipt instead. A review-returning
    // grant has its own gate below.
    if (
      rule.nextStep === "work" &&
      reviewRoundsLeft(snapshot, record, cutoff) === 0
    ) {
      onDenied?.({
        id: record.id,
        repository: record.repository,
        reason: "review_rounds_spent",
      });
      continue;
    }
    // A legacy record's one final round is spent only on a green head, so a
    // work grant that leads to it waits for a proven CI-first runtime.
    if (
      rule.nextStep === "work" &&
      !legacyFinalRoundAdmissible(snapshot, record, ciFirst)
    ) {
      onDenied?.({
        id: record.id,
        repository: record.repository,
        reason: LEGACY_ROUND_REQUIRES_CI_FIRST,
      });
      continue;
    }
    const base = record.target.base;
    if (base === null) continue;
    const baseTip = baseTips.get(hostedRepositoryKey(record.repository)) ??
      null;
    // The repeat-failure bound: the same failure signature repeated across
    // bases parks the record for the owner instead of buying another charge.
    if (
      rule.nextStep === "work" &&
      repeatFailureWithheld(
        repeat,
        record,
        true,
        onDenied,
        options.onRepeatFailurePark,
      )
    ) continue;
    // Durable attempt memory gate: refuse a work-returning grant whose
    // attempt would be equivalent to failures already recorded at this base
    // and runtime revision. A base advance is genuinely changed evidence, so
    // that path is exempt, and so is a repeat-failure re-arm (an edited issue
    // or a changed model route); a review-returning grant has its own
    // identity space and is untouched. Refusals are reported, never silent.
    if (rule.nextStep === "work") {
      const advancing = baseTip !== null && baseTip !== base;
      if (!advancing && rearm === null) {
        const equivalence = attemptEquivalenceRefusalForRecordV1({
          record,
          snapshot,
          now,
          runtimeSha,
        });
        if (equivalence.refuse) {
          onDenied?.({
            id: record.id,
            repository: record.repository,
            reason: `equivalent_attempt_refused:${
              equivalence.entry?.detail ?? "unknown"
            }`,
          });
          continue;
        }
      }
    }
    // A review-returning grant has its OWN identity space: the runtime admits
    // a review with attempt = reviewRounds + 1 at the record's current head, so
    // the grant must persist the floor its durable charges prove, an identity
    // nothing has charged. Once the task's hard round allowance is spent
    // (`reviewRoundsLeft`, owner decision 2026-10-16) the grant is refused
    // outright: a base advance would only buy a refreshed head that needs one
    // more round, the churn that took ai.ubq.fi 684 / PR 1059 to 50 rounds.
    // Within the allowance (below three, or a legacy record's one
    // final round) the review is of the record's current head.
    if (rule.nextStep === "review") {
      const head = record.target.head;
      const pr = record.target.pr;
      const branch = record.target.branch;
      // A review can only continue on the record's exact published identity:
      // without it there is nothing the runtime could rehydrate or review, so
      // nothing is planned rather than clearing the blocker into a state error.
      if (head === null || pr === null || branch === null) continue;
      const settled = settledReviewAttempts(snapshot, record);
      const rounds = plannedReviewRounds(record, settled);
      // The raised floor never counts fewer rounds than the record's own.
      const planned = {
        ...record,
        counters: { ...record.counters, reviewRounds: rounds },
      };
      if (reviewRoundsLeft(snapshot, planned, cutoff) === 0) {
        onDenied?.({
          id: record.id,
          repository: record.repository,
          reason: "review_rounds_spent",
        });
        continue;
      }
      // Under R79 the legacy final review would judge the head before CI.
      if (!legacyFinalRoundAdmissible(snapshot, planned, ciFirst)) {
        onDenied?.({
          id: record.id,
          repository: record.repository,
          reason: LEGACY_ROUND_REQUIRES_CI_FIRST,
        });
        continue;
      }
      plans.push({
        id: record.id,
        repository: record.repository,
        grant: 0,
        nextStep: "review",
        reviewRounds: rounds,
        advanceBase: false,
        observedBase: null,
        detail: `${blocker.kind}:${rule.prefix}`,
      });
      continue;
    }
    // The runtime retired the four-attempt ceiling. Do not lower history or
    // search its old indices: the next start uses an unused monotonic index.
    const floor = implementationAttemptFloor(snapshot, record);
    if (!Number.isSafeInteger(floor + 1)) continue;
    const advancing = baseTip !== null && baseTip !== base;
    plans.push({
      id: record.id,
      repository: record.repository,
      grant: 0,
      nextStep: "work",
      reviewRounds: null,
      advanceBase: advancing,
      observedBase: advancing ? baseTip : null,
      detail: `${blocker.kind}:${rule.prefix}${
        advancing ? ":base-advance" : ""
      }`,
    });
  }
  return plans;
}

/** Apply the retry plans to one snapshot (pure). */
export function applyHostedRetries(
  snapshot: RepairStateSnapshotV1,
  head: GitSha,
  plans: readonly RetryPlanV1[],
  now: number,
): RepairStateSnapshotV1 {
  const byId = new Map(plans.map((plan) => [plan.id, plan]));
  return parseRepairStateSnapshotV1({
    ...snapshot,
    stateHead: head,
    sequence: snapshot.sequence + 1,
    updatedAt: now,
    work: snapshot.work.map((record) => {
      const plan = byId.get(record.id);
      if (plan === undefined) return record;
      if (plan.nextStep === "work" && plan.grant !== 0) {
        throw new TypeError(
          "implementation retry cannot lower charged attempt history",
        );
      }
      const refresh = plan.advanceBase && plan.observedBase !== null &&
          record.target.pr !== null && record.target.head !== null &&
          record.target.branch !== null
        ? {
          kind: "base_refresh" as const,
          key:
            `base_refresh:${record.target.pr}:${record.target.head}:${plan.observedBase}`,
          startedAt: now,
          branch: record.target.branch,
          expectedHead: record.target.head,
          observedBase: plan.observedBase,
          pr: record.target.pr,
          requestId: null,
          resultId: null,
        }
        : null;
      return {
        ...record,
        nextStep: plan.nextStep,
        wait: plan.ciFixMarker === true ? ciFixMarker(now) : null,
        blocker: null,
        intent: refresh,
        counters: {
          // Reconcile a legacy lowered counter to actual charged indices.
          // The next reservation stays counters.attempts + 1, never reused.
          attempts: plan.nextStep === "work"
            ? implementationAttemptFloor(snapshot, record)
            : record.counters.attempts - plan.grant,
          retries: record.counters.retries,
          reviewRounds: plan.reviewRounds ?? record.counters.reviewRounds,
          // A retry is not progress: the consecutive time-bound exhaustions
          // that drive decomposition survive it.
          ...(record.counters.timeouts === undefined
            ? {}
            : { timeouts: record.counters.timeouts }),
        },
        updatedAt: now,
      };
    }),
  });
}
