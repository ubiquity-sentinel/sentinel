/** Repair loop internals: post drain. */
import { canonicalStringify } from "../contracts/canonical.ts";
import { reviewOperationKey } from "./keys.ts";
import { checkGithubCooldown } from "./loop-bounds.ts";
import { retryAlreadySatisfiedClosure, retryClosure } from "./loop-closure.ts";
import { executeMerge, reconcileMergeIntent } from "./loop-merge.ts";
import {
  configFor,
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";
import { observeReleaseAcceptance } from "./loop-release.ts";
import { observeStandingReview } from "./loop-review-observation.ts";
import { standingReviewAttempt } from "./loop-review-records.ts";
import { applyObservedReview } from "./loop-review-result.ts";
import { loadSnapshot } from "./loop-state.ts";
import { refreshMovedBaseBeforeMerge } from "./loop-work.ts";
import type {
  PostDrainReviewContinuationV1,
  RepairCycleDepsV1,
  RepairCycleTrackingV1,
  RunBoundsV1,
  StepResultV1,
} from "./loop-types.ts";
import { isWaiting } from "./selection.ts";

/** Continue only the exact reviews drained by the trusted entrypoint. */
export function createPostDrainContinuation(
  deps: RepairCycleDepsV1,
  bounds: RunBoundsV1,
  stepLimit: number,
  tracking: RepairCycleTrackingV1,
): PostDrainReviewContinuationV1 {
  const { runDeadline } = bounds;
  return async (operationKeys) => {
    if (
      !tracking.postDrainAllowed || tracking.continued ||
      tracking.lastSnapshot === null
    ) return null;
    tracking.continued = true;
    // Reuse the original absolute bounds and remaining transitions. Disabling
    // starts is an additional guard; the narrow dispatcher below never selects
    // intake, implementation, publication, a refresh execution or a review
    // request (a moved base only persists the refresh intent).
    const continuationBounds = {
      ...bounds,
      modelCutoff: Number.NEGATIVE_INFINITY,
    };
    const original = tracking.lastSnapshot;
    let progressed = false;
    for (const key of new Set(operationKeys)) {
      const tracked = original.work.find((record) =>
        configFor(deps, record.repository) !== null &&
        record.nextStep === "review" && record.target.pr !== null &&
        record.target.head !== null &&
        reviewOperationKey(
            record.target.pr,
            record.target.head,
            standingReviewAttempt(record),
          ) === key
      );
      if (tracked === undefined) continue;
      let observed = false;
      for (;;) {
        if (deps.clock.now() >= runDeadline) {
          return {
            status: "margin",
            detail: "repair run deadline reached after review drain",
          };
        }
        if (tracking.steps >= stepLimit) {
          return { status: "step_limit", steps: tracking.steps };
        }
        const context = await loadSnapshot(deps, continuationBounds);
        if (context === null) {
          return { status: "state_error", detail: "repair state unavailable" };
        }
        if (deps.clock.now() >= runDeadline) {
          return {
            status: "margin",
            detail: "repair run deadline reached during post-drain state read",
          };
        }
        const record = context.snapshot.work.find((item) =>
          item.id === tracked.id
        );
        if (
          record === undefined ||
          !sameRepositoryIdentity(record.repository, tracked.repository) ||
          record.target.pr !== tracked.target.pr ||
          record.target.head !== tracked.target.head ||
          record.target.base !== tracked.target.base ||
          record.target.branch !== tracked.target.branch ||
          record.counters.reviewRounds !== tracked.counters.reviewRounds ||
          canonicalStringify(record.source) !==
            canonicalStringify(tracked.source)
        ) break;
        context.executionBaseline = record;
        let result: StepResultV1;
        if (!observed) {
          observed = true;
          if (
            record.nextStep !== "review" || record.intent !== null ||
            configFor(deps, record.repository) === null
          ) break;
          const cooling = await checkGithubCooldown(
            deps,
            record.repository,
            continuationBounds,
          );
          if (cooling.kind === "state_error") {
            return { status: "state_error", detail: cooling.detail };
          }
          if (cooling.kind === "deferred") break;
          if (deps.clock.now() >= runDeadline) {
            return {
              status: "margin",
              detail: "repair run deadline reached during post-drain cooldown",
            };
          }
          const pull = await deps.github.readPullRequest(record.target.pr!);
          if (
            !pull.ok || pull.value === null || pull.value.state !== "open" ||
            pull.value.head !== record.target.head ||
            pull.value.base !== record.target.base ||
            pull.value.headRef !== record.target.branch
          ) break;
          if (deps.clock.now() >= runDeadline) {
            return {
              status: "margin",
              detail: "repair run deadline reached during post-drain PR read",
            };
          }
          const review = await observeStandingReview(
            deps,
            record,
            record.target.pr!,
            record.target.head!,
          );
          if (
            !review.ok || review.value.operationKey !== key ||
            review.value.observation.status !== "completed"
          ) break;
          if (deps.clock.now() >= runDeadline) {
            return {
              status: "margin",
              detail:
                "repair run deadline reached during post-drain review read",
            };
          }
          result = await applyObservedReview(
            deps,
            context,
            record,
            review.value.observation,
            key,
          );
        } else {
          if (
            record.nextStep !== "delivery" ||
            isWaiting(record, deps.clock.now())
          ) break;
          if (record.intent?.kind === "merge") {
            result = await reconcileMergeIntent(deps, context, record);
          } else if (record.intent?.kind === "already_satisfied_closure") {
            result = await retryAlreadySatisfiedClosure(deps, context, record);
          } else if (record.intent?.kind === "issue_closure") {
            result = await retryClosure(deps, context, record);
          } else if (record.intent !== null) {
            break;
          } else {
            const release = context.snapshot.releaseRequests.find((request) =>
              releaseRequestMatchesDelivery(request, record)
            );
            // A fresh merge passes the same moved-base guard as the ordinary
            // delivery step: a base that moved since the review persists the
            // refresh intent (executed by a later run, never here) instead of
            // merging a tree no CI ran on.
            result = release === undefined
              ? await refreshMovedBaseBeforeMerge(deps, context, record) ??
                await executeMerge(deps, context, record)
              : await observeReleaseAcceptance(deps, context, record, release);
          }
        }
        context.executionBaseline = null;
        if (result.kind === "state_error") {
          return { status: "state_error", detail: result.detail };
        }
        if (result.kind === "margin") {
          return { status: "margin", detail: result.detail };
        }
        if (result.kind !== "progress") break;
        progressed = true;
        tracking.steps++;
      }
    }
    return progressed
      ? {
        status: "idle",
        detail: `post-drain delivery continued within ${tracking.steps} steps`,
      }
      : null;
  };
}
