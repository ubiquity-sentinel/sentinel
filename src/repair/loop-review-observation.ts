/** Repair loop internals: review observation. */
import type { GitSha } from "../contracts/brands.ts";
import {
  portOk,
  type PortResultV1,
  type ReviewObservationV1,
} from "../contracts/ports.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { reviewOperationKey } from "./keys.ts";
import { executeBaseRefreshIntent } from "./loop-base-refresh.ts";
import { checkGithubCooldown, REVIEW_POLL_MS } from "./loop-bounds.ts";
import { retireClosedPublication } from "./loop-records.ts";
import {
  isUnboundReviewObservation,
  reviewWaitSince,
  standingReviewAttempt,
} from "./loop-review-records.ts";
import { recoverFromNoVerdictReview } from "./loop-review-request.ts";
import { applyObservedReview } from "./loop-review-result.ts";
import { persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { RETIRED_MERGED_MESSAGE } from "./selection.ts";
import {
  clearIntent,
  countReviewRound,
  markTerminalBlocked,
  setWait,
} from "./transitions.ts";

// ---------------------------------------------------------------------------
// Review phase.
// ---------------------------------------------------------------------------

export async function observeReview(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const pr = record.target.pr;
  const head = record.target.head;
  if (pr === null || head === null) {
    return { kind: "state_error", detail: "review without PR/head identity" };
  }
  // A saved candidate-base refresh is reconciled WHEREVER it is observed — the
  // work and delivery steps already do — and the review step is where that
  // intent is created: the freshness gate persists it instead of spending a
  // review on a stale base. Without this reconciliation the record would wait
  // at `review` on a request the gate must keep refusing, so the refresh is
  // completed first and the refreshed candidate is reviewed afterwards.
  if (record.intent !== null && record.intent.kind === "base_refresh") {
    return executeBaseRefreshIntent(deps, context, record);
  }
  // Review observation is a GitHub read: gate before the external call. A
  // cooldown deferral mutates nothing (the pending wait and review intent stay
  // durable) so the next run observes the exact remote state once.
  const cooling = await checkGithubCooldown(
    deps,
    record.repository,
    context.bounds,
  );
  if (cooling.kind === "state_error") {
    return { kind: "state_error", detail: cooling.detail };
  }
  if (cooling.kind === "deferred") {
    return { kind: "deferred", detail: cooling.detail };
  }
  // The record's own pull request is observed BEFORE the review: a closed
  // unmerged pull request can never produce another verdict, and a pull
  // request merged outside the trusted review path is a human disposition the
  // runtime must never treat as its own delivery. Foreign or unreadable
  // observations change nothing and fall through to the standing review.
  const pull = await deps.github.readPullRequest(pr);
  if (!pull.ok) {
    return { kind: "deferred", detail: "review PR observation unavailable" };
  }
  if (pull.value !== null && pull.value.headRef === record.target.branch) {
    if (pull.value.state === "closed" && pull.value.mergeSha === null) {
      // The review phase has no pull request to review: the record returns to
      // work so the next publish step creates the replacement for the same
      // preserved candidate. The dead review intent is cleared IN THE SAME
      // transition: without it, intent.pr would resurrect the closed PR on the
      // next run and the reconcile -> review -> retire cycle would spin (the
      // issue-140 livelock).
      return persistWork(
        deps,
        context,
        clearIntent(retireClosedPublication(record, now, "work"), now),
      );
    }
    if (pull.value.state === "merged") {
      return persistWork(
        deps,
        context,
        markTerminalBlocked(record, "other", RETIRED_MERGED_MESSAGE, now),
      );
    }
  }
  const observed = await observeStandingReview(deps, record, pr, head);
  if (!observed.ok) {
    // A failed observation is TRANSIENT review unavailability (transport
    // hiccup, rate limit, quota), never a terminal failure: it re-arms the
    // explicit review-quota wait and is retroactively drained later. Only a
    // bound terminal disposition WITHOUT an accepted verdict (below) may
    // terminally block.
    const since = reviewWaitSince(record, now);
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "review_quota", since, until: now + REVIEW_POLL_MS },
        now,
      ),
    );
  }
  const value = observed.value.observation;
  const intent = record.intent;
  if (
    record.counters.reviewRounds >= 1 &&
    intent?.kind === "review_request" &&
    intent.key === observed.value.operationKey &&
    intent.key ===
      reviewOperationKey(pr, head, record.counters.reviewRounds + 1)
  ) {
    if (
      isUnboundReviewObservation(value) || value.observedHead !== head ||
      value.observedBase !== record.target.base
    ) {
      return {
        kind: "deferred",
        detail: "review intent has no exact bound journal",
      };
    }
    // The separately charged journal binds the ambiguous submission. Count it
    // once before ordinary observation; never submit or settle another charge.
    return persistWork(
      deps,
      context,
      countReviewRound(clearIntent(record, now), now),
    );
  }
  if (value.status === "pending") {
    // A healthy review that simply has not posted yet stays on the ordinary
    // bounded poll; it is transient and never blocks by itself.
    const since = reviewWaitSince(record, now);
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "review_pending",
          since,
          until: Math.max(now, since) + REVIEW_POLL_MS,
        },
        now,
      ),
    );
  }
  if (value.status === "unavailable") {
    // A bound terminal record is an attempt that concluded WITHOUT an accepted
    // verdict; only a non-terminal one is a pending wait. The two were
    // previously indistinguishable here, so a terminal disposition was polled
    // forever and the task could never move again.
    if (value.completedAt === null) {
      // Non-terminal unavailability is transient: keep the explicit
      // review-quota state and let the drain pass retry it when quota returns.
      const since = reviewWaitSince(record, now);
      return persistWork(
        deps,
        context,
        setWait(
          record,
          {
            reason: "review_quota",
            since,
            until: Math.max(now, since) + REVIEW_POLL_MS,
          },
          now,
        ),
      );
    }
    return await recoverFromNoVerdictReview(deps, context, record, pr, value);
  }
  // The receipt of an accepted verdict is derived from the identity the record
  // was actually READ under, so two attempts of the same head can never share
  // one receipt identity.
  return applyObservedReview(
    deps,
    context,
    record,
    value,
    observed.value.operationKey,
  );
}

/** One standing review observation bound to the identity it was read under. */
export interface StandingReviewObservationV1 {
  observation: ReviewObservationV1;
  /** Exact operation key the observation is bound to; never re-derived. */
  operationKey: string;
}

/**
 * Read the one standing review record for this exact head.
 *
 * The current round's attempt key is authoritative. When it binds no durable
 * record at all, the first-attempt key is read once more: a request created
 * before attempt identities existed is bound only there, and abandoning it
 * would leave that task waiting on a review nobody can observe. A bound record
 * of any phase is final — the legacy key is never consulted over it.
 */
export async function observeStandingReview(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  pr: number,
  head: GitSha,
): Promise<PortResultV1<StandingReviewObservationV1>> {
  const attempt = standingReviewAttempt(record);
  const intent = record.intent;
  const pendingKey = reviewOperationKey(
    pr,
    head,
    record.counters.reviewRounds + 1,
  );
  const savedRequest = record.counters.reviewRounds >= 1 &&
    intent?.kind === "review_request" && intent.pr === pr &&
    intent.expectedHead === head && intent.key === pendingKey;
  const primaryKey = savedRequest
    ? intent.key
    : reviewOperationKey(pr, head, attempt);
  const primary = await deps.github.observeReview({
    operationKey: primaryKey,
    prNumber: pr,
    head,
  });
  if (!primary.ok) return primary;
  if (attempt === 1 || savedRequest) {
    return portOk({ observation: primary.value, operationKey: primaryKey });
  }
  if (!isUnboundReviewObservation(primary.value)) {
    return portOk({ observation: primary.value, operationKey: primaryKey });
  }
  const legacyKey = reviewOperationKey(pr, head);
  const legacy = await deps.github.observeReview({
    operationKey: legacyKey,
    prNumber: pr,
    head,
  });
  if (!legacy.ok || isUnboundReviewObservation(legacy.value)) {
    return portOk({ observation: primary.value, operationKey: primaryKey });
  }
  return portOk({ observation: legacy.value, operationKey: legacyKey });
}
