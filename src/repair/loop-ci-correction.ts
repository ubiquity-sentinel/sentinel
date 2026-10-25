/**
 * Repair loop internals: routing a reviewed candidate's failed checks.
 *
 * A reviewed issue head whose checks fail is attributed against the base it
 * was reviewed against (see `ci-rejection.ts`). A candidate-caused failure
 * with a review round left returns the record to `work`: the next
 * implementation runs under the ordinary charged, monotonic admission, and only
 * after the attribution is re-derived from live check runs at that moment. A
 * red base never spends a round on a head that can still be corrected: the
 * record re-observes in a bounded wait (a later base move refreshes it as
 * usual). A head that can never be corrected (spent rounds, an undescribed
 * candidate, no exact publication) keeps the exact generation-76 terminal block
 * whatever the base shows, so a red development branch can never park it at
 * delivery and turn every base move into another charged review round.
 * Unproven attribution keeps a terminal block too.
 *
 * Rollback contract: nothing here writes a field, key or enum value the
 * generation-76 parsers do not already read. The CI evidence lives only in
 * memory and in the correction request; the durable record holds the ordinary
 * lifecycle step, wait or blocker message.
 */
import { ownBaseRed } from "./base-repair.ts";
import type { GitHubCheckV1 } from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  attributeFailedChecks,
  baseRepairFindingOpen,
  ciCorrectable,
  ciCorrectionFinding,
  ciCorrectionRouteOpen,
  type CiDispositionV1,
  ciFixExhaustedDetail,
  failedChecks,
  unattributedDetail,
} from "./ci-rejection.ts";
import { ciFixesLeft, RED_BASE_RECHECK_MS } from "./ci-first-policy.ts";
import { CHECK_POLL_MS } from "./loop-bounds.ts";
import {
  headAcceptedByReview,
  headTaskAcceptanceMissing,
} from "./loop-review-records.ts";
import { legacyCutoff } from "./loop-review-round-cap.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  advanceToCorrection,
  advanceToDelivery,
  advanceToReview,
  markBlocked,
  setWait,
} from "./transitions.ts";

/**
 * Re-observation interval while the reviewed base itself is red (defined with
 * the pure red-base hold, `isRedBaseHold`, which the delivery line reads).
 */
export { RED_BASE_RECHECK_MS };

const UNAVAILABLE: StepResultV1 = {
  kind: "deferred",
  detail: "CI check observation unavailable",
};

/**
 * Attribute the failed head checks through one base observation. The base read
 * is an ordinary GitHub read under the caller's cooldown gate; a failed read
 * attributes nothing (null), and so does an unavailable base-repair
 * recognition or tip read (`ownBaseRed`).
 */
async function attributeAgainstBase(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  failed: readonly GitHubCheckV1[],
): Promise<CiDispositionV1 | null> {
  // Only the failed names are read on the base (see `gateReviewOnCi`).
  const base = await deps.github.readChecks(
    record.target.base,
    new Set(failed.map((check) => check.name)),
  );
  if (!base.ok) return null;
  return ownBaseRed(
    deps,
    record,
    attributeFailedChecks(failed, base.value.checks),
  );
}

/**
 * Live re-derivation over the record's CURRENT head: null when either read is
 * unavailable, `clean` when no check on the head failed.
 */
export async function observeHeadFailure(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
): Promise<CiDispositionV1 | { kind: "clean" } | null> {
  const head = record.target.head;
  if (head === null) return { kind: "clean" };
  const observed = await deps.github.readChecks(head);
  if (!observed.ok) return null;
  const failed = failedChecks(observed.value.checks);
  if (failed.length === 0) return { kind: "clean" };
  return attributeAgainstBase(deps, record, failed);
}

function persistBlocked(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  detail: string,
  now: number,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    markBlocked(record, "other", detail, now),
  );
}

/** Keep `since` across consecutive waits of the same reason. */
export function waitSince(
  record: WorkRecordV1,
  reason: "ci_pending" | "backoff",
  now: number,
): number {
  return record.wait?.reason === reason && record.wait.since < now
    ? record.wait.since
    : now;
}

/**
 * The pre-merge gate's failed-check disposition for a reviewed head. A record
 * that can never be corrected (not an issue task, no exact publication, every
 * review round spent by its counter or its durable ledger, an undescribed
 * candidate or an operation in flight)
 * keeps the exact legacy terminal block without a base read: a red or pending
 * base must never hold it at delivery, where each base move would refresh it
 * into another charged review round. The launcher never re-admits that block
 * (`ciRedeliveryEligible` refuses the same shapes).
 */
export async function routeFailedDeliveryChecks(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  failed: readonly GitHubCheckV1[],
  legacyDetail: string,
  now: number,
): Promise<StepResultV1> {
  // A run whose correction cell could outlive a rollback to a runtime that
  // refuses it (`ciCorrectionRouteOpen`) keeps the generation-76 block exactly
  // (no base read).
  if (
    !ciCorrectionRouteOpen(deps) ||
    !ciCorrectable(record, context.snapshot, legacyCutoff(context))
  ) {
    // A head the runtime would correct but for its spent CI fixes parks with
    // the exact exhausted detail, which no launcher rule re-admits.
    const exhausted = ciCorrectionRouteOpen(deps) && !ciFixesLeft(record) &&
      ciCorrectable(
        {
          ...record,
          counters: { ...record.counters, retries: 0 },
        },
        context.snapshot,
        legacyCutoff(context),
      );
    return persistBlocked(
      deps,
      context,
      record,
      exhausted ? ciFixExhaustedDetail(failed) : legacyDetail,
      now,
    );
  }
  const disposition = await attributeAgainstBase(deps, record, failed);
  // Transient: mutate nothing; the next turn re-observes both revisions.
  if (disposition === null) return UNAVAILABLE;
  switch (disposition.kind) {
    case "candidate":
      // The correction re-derives this attribution from live checks before
      // anything is charged; nothing about the failure is persisted.
      return persistWork(deps, context, advanceToCorrection(record, now));
    case "base_pending":
      return persistWork(
        deps,
        context,
        setWait(record, {
          reason: "ci_pending",
          since: waitSince(record, "ci_pending", now),
          until: deps.clock.now() + CHECK_POLL_MS,
        }, now),
      );
    case "base_red":
      // The same check is red on the reviewed base: the candidate cannot fix
      // it, so no correction round is spent and nothing is blocked. A moved
      // base is refreshed by the ordinary delivery step after this wait; the
      // refreshed head's review spends a round, so the rounds stay bounded by
      // the correctability check above.
      return persistWork(
        deps,
        context,
        setWait(record, {
          reason: "backoff",
          since: waitSince(record, "backoff", now),
          until: deps.clock.now() + RED_BASE_RECHECK_MS,
        }, now),
      );
    case "unattributed":
      return persistBlocked(
        deps,
        context,
        record,
        unattributedDetail(disposition.checks),
        now,
      );
  }
}

/**
 * Before a reviewed head is refreshed onto a moved base: a head whose checks
 * already failed through its own change is corrected first, so a known-broken
 * candidate never spends a refresh and a review round. Any other observation
 * (green, pending, red base, unavailable) returns null and the refresh
 * proceeds exactly as before.
 */
export async function correctFailedHeadBeforeRefresh(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  if (
    !ciCorrectionRouteOpen(deps) ||
    !ciCorrectable(record, context.snapshot, legacyCutoff(context)) ||
    !headAcceptedByReview(context.snapshot, record)
  ) return null;
  const observed = await observeHeadFailure(deps, record);
  if (observed === null || observed.kind !== "candidate") return null;
  return persistWork(
    deps,
    context,
    advanceToCorrection(record, deps.clock.now()),
  );
}

/**
 * Correction-time re-derivation for a reviewed head awaiting its CI
 * correction (`headAwaitsCiCorrection`). Only a live candidate-caused failure
 * yields the correction finding; an unavailable read defers without mutation,
 * and every other observation (green, base pending, red base, unattributed)
 * returns the head to the delivery gate that owns it — nothing is charged.
 * A head whose clean review carries no task acceptance (the CI-first gate
 * sent its missing-acceptance re-request here) is owned by review instead:
 * delivery would refuse it with a state_error on every run, so it returns to
 * `review`, whose missing-acceptance recovery requests the task-bound review
 * through the CI-first gate (R79 requests the same review from there).
 */
export async function confirmCiCorrection(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<
  | {
    kind: "confirmed";
    finding: { severity: string; path: string | null; message: string };
  }
  | StepResultV1
> {
  const observed = await observeHeadFailure(deps, record);
  if (observed === null) return UNAVAILABLE;
  if (observed.kind === "candidate") {
    return {
      kind: "confirmed",
      finding: ciCorrectionFinding(
        record.target.base,
        observed.checks,
        observed.redBase === true && baseRepairFindingOpen(deps),
      ),
    };
  }
  const now = deps.clock.now();
  if (headTaskAcceptanceMissing(context.snapshot, record)) {
    return persistWork(
      deps,
      context,
      advanceToReview(
        record,
        { pr: record.target.pr!, head: record.target.head! },
        { reason: "review_quota", since: now, until: now },
        now,
      ),
    );
  }
  return persistWork(deps, context, advanceToDelivery(record, now));
}
