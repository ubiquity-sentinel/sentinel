/** Repair loop internals: review recovery. */
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { settleReviewCharge } from "./loop-accounting.ts";
import { checkGithubCooldown } from "./loop-bounds.ts";
import {
  legacyDependenciesDone,
  retireClosedPublication,
} from "./loop-records.ts";
import { observeStandingReview } from "./loop-review-observation.ts";
import { applyObservedReview } from "./loop-review-result.ts";
import { loadSnapshot, persistWork } from "./loop-state.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL,
  TASK_ACCEPTANCE_MISSING_DETAIL,
} from "./review-gate.ts";
import { clearIntent, clearWait } from "./transitions.ts";

// ---------------------------------------------------------------------------
// Work phase: deterministic evidence, reproduction, implementation, replay.
// ---------------------------------------------------------------------------

/**
 * Recovery for a review wait parked on a closed-unmerged PR. A closed PR can
 * never produce a review verdict, so a `review_pending` wait paired with a
 * `review_request` intent that names a closed-unmerged PR is dead: the wait
 * and the intent are cleared in ONE transition and the record returns to
 * work, where the ordinary lifecycle republishes the preserved candidate.
 * Any other PR state (open, merged, unreadable, or no PR named) changes
 * nothing, so the ordinary lifecycle keeps the record. This runs before any
 * intent dispatch in the work phase because the parked wait otherwise pins
 * the record ahead of the publish reconciliation that could clear it (the
 * issue-140 stall, where the wait outlived its PR by a week). A cooling
 * installation defers the recovery instead of issuing GitHub reads.
 */
export async function recoverClosedReviewWait(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  if (record.wait?.reason !== "review_pending") return null;
  const intent = record.intent;
  if (intent === null || intent.kind !== "review_request") return null;
  const prNumber = intent.pr;
  if (prNumber === null) return null;
  // A cooling installation performs no GitHub calls: the recovery defers
  // instead of issuing a PR read during cooldown.
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
  const now = deps.clock.now();
  const observed = await deps.github.readPullRequest(prNumber);
  if (!observed.ok || observed.value === null) return null;
  if (observed.value.state !== "closed" || observed.value.mergeSha !== null) {
    return null;
  }
  // The PR is dead: preserve the admission charge as ambiguous (the review
  // request may have been submitted). Settlement advances the repair-state
  // head, so the cleared record is persisted against the RELOADED snapshot:
  // persisting against the pre-settlement context would trip the transition
  // conflict check and leave the dead wait parked.
  let freshContext = context;
  let fresh = record;
  if (intent.requestId !== null) {
    const settled = await settleReviewCharge(
      deps,
      context,
      intent.requestId,
      "ambiguous",
    );
    if (settled.kind !== "progress") return settled;
    const afterSettlement = await loadSnapshot(deps, context.bounds);
    if (afterSettlement === null) {
      return { kind: "state_error", detail: "repair state unavailable" };
    }
    const current = afterSettlement.snapshot.work.find(
      (work) => work.id === record.id,
    );
    if (current === undefined) {
      return {
        kind: "state_error",
        detail: "work record missing after review reconciliation",
      };
    }
    freshContext = afterSettlement;
    fresh = current;
  }
  // The dead wait and the dead intent are cleared in ONE transition and the
  // record returns to work, where the ordinary lifecycle republishes the
  // preserved candidate.
  const cleared = clearWait(
    clearIntent(retireClosedPublication(fresh, now, "work"), now),
    now,
  );
  return persistWork(deps, freshContext, cleared);
}

/** Re-observe only the exact legacy missing-acceptance blocker, once per run. */
export async function recoverBlockedMissingTaskReview(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  attempted: Set<string>,
  deferred: Set<string>,
): Promise<StepResultV1 | null> {
  for (const record of context.snapshot.work) {
    if (
      record.nextStep !== "blocked" ||
      record.blocker?.message !== TASK_ACCEPTANCE_MISSING_DETAIL ||
      record.source.kind !== "issue" || record.intent !== null ||
      record.wait !== null || record.target.pr === null ||
      record.target.head === null ||
      record.counters.reviewRounds < 1 ||
      !legacyDependenciesDone(context.snapshot, record) ||
      attempted.has(record.id)
    ) continue;
    attempted.add(record.id);
    const cooling = await checkGithubCooldown(
      deps,
      record.repository,
      context.bounds,
    );
    if (cooling.kind === "state_error") return cooling;
    if (cooling.kind === "deferred") continue;
    const observed = await observeStandingReview(
      deps,
      record,
      record.target.pr,
      record.target.head,
    );
    if (
      !observed.ok || observed.value.observation.status !== "completed" ||
      (observed.value.observation.taskAcceptance ?? null) !== null ||
      observed.value.observation.findings.some((finding) => !finding?.resolved)
    ) continue;
    const result = await applyObservedReview(
      deps,
      context,
      record,
      observed.value.observation,
      observed.value.operationKey,
    );
    if (result.kind === "deferred") {
      deferred.add(record.id);
      continue;
    }
    return result;
  }
  return null;
}

/**
 * One run-local re-observation for the historical already-satisfied block: the
 * pre-terminal code could only park an already_satisfied_at_base verdict as a
 * terminal block, so the record is skipped by every lifecycle phase forever.
 * The bridge consumes the EXACT standing review journal for the record's own
 * published head -- the same bot-journal consumer the review stage uses -- and
 * requires the fresh observation to still be a completed, resolved,
 * already_satisfied_at_base verdict on that exact head before the ordinary
 * review disposition runs. With the terminal forward path installed that
 * disposition stages the guarded closure intent; a missing, unreadable,
 * differently-headed, unresolved-finding-bearing or changed verdict leaves the
 * record exactly as it was. Never a merge, release, receipt rewrite or manual
 * state edit.
 */
export async function recoverBlockedAlreadySatisfied(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  attempted: Set<string>,
  deferred: Set<string>,
): Promise<StepResultV1 | null> {
  for (const record of context.snapshot.work) {
    if (
      record.nextStep !== "blocked" ||
      record.blocker?.kind !== "other" ||
      record.blocker.message !== TASK_ACCEPTANCE_ALREADY_SATISFIED_DETAIL ||
      record.source.kind !== "issue" || record.intent !== null ||
      record.wait !== null || record.target.pr === null ||
      record.target.head === null || record.target.branch === null ||
      record.counters.reviewRounds < 1 ||
      !legacyDependenciesDone(context.snapshot, record) ||
      attempted.has(record.id)
    ) continue;
    attempted.add(record.id);
    const cooling = await checkGithubCooldown(
      deps,
      record.repository,
      context.bounds,
    );
    if (cooling.kind === "state_error") return cooling;
    if (cooling.kind === "deferred") continue;
    const observed = await observeStandingReview(
      deps,
      record,
      record.target.pr,
      record.target.head,
    );
    if (!observed.ok) continue;
    const observation = observed.value.observation;
    if (
      observation.status !== "completed" ||
      observation.observedHead !== record.target.head ||
      (observation.taskAcceptance?.verdict ?? null) !==
        "already_satisfied_at_base" ||
      observation.findings.some((finding) => !finding?.resolved)
    ) continue;
    const result = await applyObservedReview(
      deps,
      context,
      record,
      observation,
      observed.value.operationKey,
    );
    if (result.kind === "deferred") {
      deferred.add(record.id);
      continue;
    }
    return result;
  }
  return null;
}
