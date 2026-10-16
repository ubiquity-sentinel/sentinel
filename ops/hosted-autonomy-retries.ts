import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import { attemptEquivalenceRefusalForRecordV1 } from "../src/repair/attempt-policy.ts";
import {
  CONFLICT_PROTECTED_DETAIL,
  conflictMarkerBase,
} from "../src/repair/conflict-resolution.ts";
import { type GitSha, isGitSha } from "../src/contracts/brands.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import { candidateBranch, reviewOperationKey } from "../src/repair/keys.ts";
import {
  HOSTED_AUTONOMY_MAX_RETRIES,
  HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS,
  HOSTED_AUTONOMY_RETRYABLE,
  hostedIssueKey,
  hostedRepositoryKey,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import { evidenceExpired } from "./hosted-autonomy-evidence-expiry.ts";
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import {
  ciCorrectionRuntimeProven,
  ciGreenHeadKey,
  ciGreenRedeliveryEligible,
  ciRedeliveryEligible,
} from "./hosted-autonomy-ci-retries.ts";

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
}

/** Detail suffix of a CI re-admission whose head is green again. */
const CI_GREEN_DETAIL_SUFFIX = ":green";

/**
 * True for a CI correction re-admission: a delivery-returning plan whose
 * head is not green again. Only these count against
 * `HOSTED_AUTONOMY_CI_CORRECTIONS_PER_PASS`, which the retry pass applies
 * after it has verified each plan's pull request, so a plan it drops there
 * (pull request not open or unreadable) never holds a slot.
 */
export function ciCorrectionPlan(plan: RetryPlanV1): boolean {
  return plan.nextStep === "delivery" &&
    !plan.detail.endsWith(CI_GREEN_DETAIL_SUFFIX);
}

/**
 * Bounded, closed retry planning for one snapshot. Every returned plan has an
 * unused next-attempt identity, respects memory/review limits and stays inside
 * the per-task automatic-retry budget.
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
  } = {},
): RetryPlanV1[] {
  if (!isGitSha(runtimeSha)) return [];
  const ciRuntime = options.ciRuntime ?? null;
  const ciCorrection = ciRuntime !== null &&
    ciRuntime.activeRevision === runtimeSha &&
    ciCorrectionRuntimeProven(ciRuntime, options.ciAllowlist);
  const ciRerunSettled = options.ciRerunSettled ?? new Set<string>();
  const ciGreenHeads = options.ciGreenHeads ?? new Set<string>();
  const plans: RetryPlanV1[] = [];
  for (const record of snapshot.work) {
    if (record.nextStep !== "blocked") continue;
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
    if (
      taskReservationCount(snapshot, record.id) >= HOSTED_AUTONOMY_MAX_RETRIES
    ) {
      continue;
    }
    if (!Number.isSafeInteger(now)) continue;
    const rule = HOSTED_AUTONOMY_RETRYABLE.find((item) =>
      blocker.message.startsWith(item.prefix)
    );
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
        if (
          record.counters.reviewRounds >= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS
        ) {
          onDenied?.({
            id: record.id,
            repository: record.repository,
            reason: "conflict_resolution_rounds_spent",
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
    if (rule === undefined) continue;
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
      // A head that is green again on its exact reviewed base (a re-run
      // flake) passes any runtime's merge gate, so it needs no correction
      // route and no review round, and never counts against the per-pass
      // correction cap.
      const green = head !== null && record.target.base !== null &&
        baseTips.get(hostedRepositoryKey(record.repository)) ===
          record.target.base &&
        ciGreenHeads.has(ciGreenHeadKey(record.repository, head)) &&
        ciGreenRedeliveryEligible(snapshot, record);
      // A correction only once the head's flake re-run can no longer act.
      const corrected = !green && ciCorrection && head !== null &&
        ciRerunSettled.has(ciGreenHeadKey(record.repository, head)) &&
        ciRedeliveryEligible(snapshot, record);
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
    // Once every review round is spent, that run cannot become a reviewed
    // verdict, so the grant is provably futile and is never planned: the
    // delivery pass owns the record's receipt instead. A review-returning
    // grant is untouched by this gate.
    if (
      rule.nextStep === "work" &&
      record.counters.reviewRounds >= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS
    ) {
      continue;
    }
    const base = record.target.base;
    if (base === null) continue;
    const baseTip = baseTips.get(hostedRepositoryKey(record.repository)) ??
      null;
    // Durable attempt memory gate: refuse a work-returning grant whose
    // attempt would be equivalent to failures already recorded at this base
    // and runtime revision. A base advance is genuinely changed evidence, so
    // that path is exempt; a review-returning grant has its own identity
    // space and is untouched. Refusals are reported, never silent.
    if (rule.nextStep === "work") {
      const advancing = baseTip !== null && baseTip !== base;
      if (!advancing) {
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
    // the grant must persist the floor its durable charges prove. While the
    // runtime's round allowance remains, that floor is an identity nothing has
    // charged; once the allowance is spent at this head, only the runtime's own
    // base refresh (a new head, therefore a new identity) can continue the
    // task, and without a newer base this pass fails closed rather than
    // re-using a charged identity or zeroing a charged counter.
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
      if (rounds >= HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS) {
        if (baseTip === null || baseTip === base) continue;
        plans.push({
          id: record.id,
          repository: record.repository,
          grant: 0,
          nextStep: "review",
          reviewRounds: rounds,
          advanceBase: true,
          observedBase: baseTip,
          detail: `${blocker.kind}:${rule.prefix}:base-advance`,
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
        wait: null,
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
