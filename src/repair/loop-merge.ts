import { queueDeliveryProvenanceRef } from "../github/queue-delivery-provenance.ts";
import { hasTakeoverCustody } from "../github/existing-pr-takeover-provenance.ts";
import { prepareExistingPrEffect } from "./loop-existing-pr.ts";
import {
  holdQueueRecord,
  queueEffectRefused,
  queueRefusalIsTransient,
} from "./loop-queue-guard.ts";
import { guardQueueDelivery } from "./loop-queue-guard.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
/** Repair loop internals: merge. */
import type { GitSha } from "../contracts/brands.ts";
import { parseMergeRequestV1 } from "../contracts/merge-request.ts";
import { selfMergeExecution } from "./loop-self-merge.ts";
import { isSelfScopeZero } from "./loop-legacy-loss.ts";
import type { MergeOutcomeV1, PortErrorV1 } from "../contracts/ports.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
} from "../contracts/release.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import {
  candidateBranch,
  mergeIntentKey,
  releaseRequestId,
  reviewOperationKey,
  reviewReceiptId,
} from "./keys.ts";
import { ensureBaseRefreshIntent } from "./loop-base-refresh.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { gateDeliveryOnChecks } from "./loop-checks.ts";
import { waitSince } from "./loop-ci-correction.ts";
import { configFor, sameRepositoryIdentity } from "./loop-records.ts";
import { waitRelease } from "./loop-release.ts";
import { standingReviewAttempt } from "./loop-review-records.ts";
import { reviewRoundsSpentOut } from "./loop-review-round-cap.ts";
import { deliveryQueueDeferral } from "./loop-delivery-queue.ts";
import { spentOnMovedBase } from "./loop-carried-delivery.ts";
import { persistTransition, persistWork } from "./loop-state.ts";
import {
  deliveryTaskRefusal,
  mergeIntentReceipt,
  readDeliveryTaskContext,
  semanticRefusalKind,
} from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import {
  authorizingReceipt,
  MERGE_WITHOUT_REVIEW_DETAIL,
  taskAcceptanceRefusal,
} from "./review-gate.ts";
import {
  clearIntent,
  markBlocked,
  markTerminalBlocked,
  setIntent,
  setWait,
} from "./transitions.ts";

/**
 * Closed operational emission for one failed delivery port call: the PR
 * number, the closed port error kind and an allow-listed code for the
 * adapter's own static details. It never carries a message, body, URL, path
 * or credential, and the line can never change the wait, intent or outcome.
 */
const MERGE_DETAIL_CODES: readonly (readonly [string, string])[] = [
  ["candidate restore has no exact durable binding", "candidate_binding"],
  ["candidate restore remote identity is not exact", "candidate_remote"],
  ["candidate restore fetch did not verify", "candidate_fetch"],
  ["ancestry check failed", "ancestry_unavailable"],
];

/** Source-CAS self merge has a distinct closing protocol; takeover never widens it. */
async function holdAdoptedSelfMerge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  if (
    !hasTakeoverCustody(record) ||
    record.repository.owner !== "ubiquity-sentinel" ||
    record.repository.name !== "sentinel"
  ) return null;
  const detail = "existing PR hold: self_merge_requires_owner";
  return record.blocker?.message === detail
    ? { kind: "deferred", detail }
    : await persistWork(
      deps,
      context,
      markBlocked(record, "other", detail, deps.clock.now()),
    );
}

function emitMergePortError(
  event: "merge_port_error" | "merge_reconcile_read_error",
  prNumber: number,
  error: PortErrorV1,
): void {
  let detailCode: string | null = null;
  for (const [detail, code] of MERGE_DETAIL_CODES) {
    if (error.detail === detail) {
      detailCode = code;
      break;
    }
  }
  console.log(JSON.stringify({
    version: "v1",
    kind: "sentinel_merge_event",
    event,
    prNumber,
    errorKind: error.kind,
    detailCode,
  }));
}

/**
 * Self-merge refusals of the trusted port's content checks: the base and the
 * tested commit disagree on the CI pipeline identity, the preserved CI binding
 * or the tested tree. Waiting never clears them (only a new base or a new
 * candidate can), so they park for the owner instead of re-arming a five-minute
 * wait on every cycle for the life of the base. A failed git read is
 * `unavailable`, never one of these (issue #196); a refusal after the remote
 * writes began keeps the proof (`parkSelfMergeRefusal`).
 */
const SELF_MERGE_REFUSALS: ReadonlySet<string> = new Set([
  "self merge trusted CI pipeline changed",
  "self merge preserved CI binding mismatch",
  "self merge tested tree or trusted source mismatch",
]);
function selfMergeRefusal(
  record: WorkRecordV1,
  error: PortErrorV1,
): string | null {
  return isSelfScopeZero(record.repository) && error.kind === "invalid" &&
      SELF_MERGE_REFUSALS.has(error.detail)
    ? `self merge refused by trusted validation; owner action required: ${error.detail}`
    : null;
}

const SELF_MERGE_TARGET_MOVED = "self merge target moved without exact merge";

/**
 * Issue #203: a self-merge conflict never clears by waiting. When the target
 * moved without this proof's merge while the proof is still at `prepared` or
 * `preserved` (no source write yet; the fresh-store ancestry check proved the
 * target does not contain the merge), the proof is dropped and the plain
 * merge intent is reconciled. Any other conflict (closure, native merge or
 * issue identity, a moved preservation ref) parks for the owner with the
 * proof kept from `preserved` on. Other errors stay a bounded wait.
 */
export function selfMergeConflict(
  record: WorkRecordV1,
  error: PortErrorV1,
):
  | { kind: "reconcile"; record: WorkRecordV1 }
  | { kind: "park"; refusal: string }
  | null {
  if (error.kind !== "conflict" || record.intent?.kind !== "merge") {
    return null;
  }
  const stage = record.intent.selfMerge?.stage;
  if (stage === undefined) return null;
  if (
    error.detail === SELF_MERGE_TARGET_MOVED &&
    (stage === "prepared" || stage === "preserved")
  ) {
    const { selfMerge: _dropped, ...intent } = record.intent;
    return { kind: "reconcile", record: { ...record, intent } };
  }
  return {
    kind: "park",
    refusal: `self merge conflict; owner action required: ${error.detail}`,
  };
}

/**
 * Park a refused self merge for the owner. Before any remote write (no proof,
 * or a proof still at stage `prepared`) the merge intent is cleared as before.
 * From stage `preserved` on, the operation ref is pushed and `development` may
 * already carry the merge, so the durable proof is the only record binding
 * that write to its task and review: the record parks with the intent kept
 * for reconciliation (issue #197; `clearIntent` clears only reconciled
 * effects). A blocked record is idle, so nothing re-runs the merge.
 */
export function parkSelfMergeRefusal(
  record: WorkRecordV1,
  refusal: string,
  at: number,
): WorkRecordV1 {
  const stage = record.intent?.selfMerge?.stage;
  return stage === undefined || stage === "prepared"
    ? markBlocked(clearIntent(record, at), "other", refusal, at)
    : markBlocked(
      record,
      "other",
      `${refusal}; self merge proof kept at stage ${stage}`,
      at,
    );
}

export async function executeMerge(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(deps, context, record, "merge");
  if (queueGuard !== null) return queueGuard;
  const takeoverSelf = await holdAdoptedSelfMerge(deps, context, record);
  if (takeoverSelf !== null) return takeoverSelf;
  const now = deps.clock.now();
  // Merge is a GitHub write: gate before any preparation or intent write (a
  // cooling installation never writes a merge intent it cannot act on; the
  // concrete adapter separately rechecks the gate at the call).
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
  const config = configFor(deps, record.repository);
  // HARD INVARIANT: nothing merges without a passing review. Find a durable
  // completed receipt for this exact PR/head, then require the strict
  // authorization predicate (exact repository/PR/head/base, trusted reviewer,
  // zero uncounted findings, no unresolved P0). A completed-but-unclean
  // receipt is authoritative disposition, never a blind resubmission.
  const currentRound = standingReviewAttempt(record);
  const currentReviewId = await reviewReceiptId(
    reviewOperationKey(
      record.target.pr!,
      record.target.head!,
      currentRound,
    ),
    record.target.head!,
  );
  const currentReview = context.snapshot.reviews.find((review) =>
    review.id === currentReviewId
  );
  const legacyReviewId = await reviewReceiptId(
    reviewOperationKey(record.target.pr!, record.target.head!),
    record.target.head!,
  );
  const attemptedReviews = context.snapshot.reservations.filter((charge) =>
    sameRepositoryIdentity(charge.repository, record.repository) &&
    charge.taskId === record.id && charge.head === record.target.head &&
    charge.purpose === "review_request" &&
    charge.outcome !== "confirmed_not_submitted"
  );
  if (
    record.intent?.kind === "review_request" ||
    attemptedReviews.some((charge) => charge.attempt > currentRound)
  ) {
    return { kind: "state_error", detail: MERGE_WITHOUT_REVIEW_DETAIL };
  }
  if (
    currentReview === undefined &&
    context.snapshot.reviews.some((review) =>
      review.id !== legacyReviewId &&
      sameRepositoryIdentity(review.repository, record.repository) &&
      review.pullRequest.number === record.target.pr &&
      review.pullRequest.head === record.target.head &&
      review.pullRequest.base === record.target.base
    )
  ) {
    // A modern receipt without the exact current receipt cannot prove absence
    // of newer work. Inspect actual history, never an arbitrary round ceiling.
    return { kind: "state_error", detail: MERGE_WITHOUT_REVIEW_DETAIL };
  }
  // A retained legacy verdict cannot shadow the exact new attempt. A present
  // current-round refusal never falls back to an older completed receipt.
  const completed = currentReview === undefined &&
      !attemptedReviews.some((charge) => charge.attempt >= currentRound)
    ? context.snapshot.reviews.find((review) =>
      review.id === legacyReviewId &&
      review.pullRequest.number === record.target.pr &&
      review.pullRequest.head === record.target.head &&
      review.outcome === "completed"
    )
    : currentReview?.outcome === "completed"
    ? currentReview
    : undefined;
  if (config === null || completed === undefined) {
    return { kind: "state_error", detail: MERGE_WITHOUT_REVIEW_DETAIL };
  }
  // The merge authorization additionally binds the receipt's task acceptance
  // to the TRUSTED live source-issue context, independently re-read here (the
  // adapter re-reads it again immediately before the mutation). A transient
  // read failure defers without a merge intent; different or unreadable
  // context fails the strict authorization below.
  const mergeTask = await readDeliveryTaskContext(deps, record);
  if (mergeTask === "unavailable") {
    return { kind: "deferred", detail: "merge task context is unavailable" };
  }
  // Surface the exact static semantic refusal (missing acceptance, changed
  // digest, wrong issue, non-fulfilled verdict) instead of the generic
  // contradiction detail: the owner sees why this candidate must not merge.
  const semanticDetail = taskAcceptanceRefusal(completed, record, mergeTask);
  if (semanticDetail !== null) {
    return { kind: "state_error", detail: semanticDetail };
  }
  const receipt = authorizingReceipt(
    [completed],
    record,
    deps.github.reviewerIdentity,
    mergeTask,
  );
  if (receipt === null) {
    // A durable completed verdict exists but does not authorize this exact
    // merge (base drift, unresolved P0, uncounted findings, untrusted
    // reviewer). Never resubmit or merge: surface the state contradiction.
    return { kind: "state_error", detail: MERGE_WITHOUT_REVIEW_DETAIL };
  }
  // CI gate (async, non-blocking): after review authorization, verify all
  // checks on the exact candidate head are green. Still-running checks park
  // the record in a bounded `ci_pending` wait and the turn completes; the
  // next turn re-observes. Failed checks are attributed against the reviewed
  // base: a candidate-caused failure opens a correction round while rounds
  // remain, a red base defers, anything else terminally blocks. This matches
  // the `review_pending` turn-based pattern: no blocking wait inside a turn.
  const ciGate = await gateDeliveryOnChecks(
    deps,
    context,
    record,
    now,
    "attribute",
  );
  if (ciGate !== null) return ciGate;
  let mergeRequest;
  try {
    mergeRequest = parseMergeRequestV1({
      pullRequestNumber: record.target.pr!,
      expectedHead: record.target.head!,
      expectedBase: record.target.base,
      review: receipt,
    }, {
      repository: record.repository,
      expectedReviewer: deps.github.reviewerIdentity,
    });
  } catch {
    // A receipt that no longer authorizes (identity/cleanliness mismatch)
    // requires authoritative disposition, not a blind re-submission.
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "review_pending", since: now, until: null },
        now,
      ),
    );
  }
  const intent = {
    kind: "merge" as const,
    key: mergeIntentKey(record.target.pr!, record.target.head!),
    startedAt: now,
    branch: hasTakeoverCustody(record)
      ? record.target.branch
      : candidateBranch(record.id),
    expectedHead: record.target.head,
    observedBase: record.target.base,
    pr: record.target.pr,
    requestId: receipt.requestId,
    resultId: receipt.resultId,
  };
  const withIntent = setIntent(record, intent, now);
  const persisted = await persistWork(deps, context, withIntent);
  if (persisted.kind !== "progress") return persisted;

  // The merge intent write is awaited wall-clock time: no merge mutation may
  // start at/after the total deadline. The merge intent stays durable, so the
  // next run re-reads the exact PR gate and merges exactly once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "merge crossed the total run deadline",
    };
  }

  const self = selfMergeExecution(deps, context, withIntent);
  const custody = await prepareExistingPrEffect(deps, context, withIntent, {
    operation: "merge",
  });
  if (!custody.ok) {
    return {
      kind: "deferred",
      detail: "existing PR merge custody unavailable",
    };
  }
  const merged = await deps.github.mergePullRequest(
    mergeRequest,
    self.execution,
    custody.value,
  );
  if (self.failure !== null) return self.failure;
  if (!merged.ok) {
    if (queueEffectRefused(merged.error)) {
      return holdQueueRecord(
        deps,
        context,
        self.record,
        queueRefusalIsTransient(merged.error),
      );
    }
    emitMergePortError(
      "merge_port_error",
      mergeRequest.pullRequestNumber,
      merged.error,
    );
    const refusal = selfMergeRefusal(self.record, merged.error);
    if (refusal !== null) {
      return persistWork(
        deps,
        context,
        parkSelfMergeRefusal(self.record, refusal, now),
      );
    }
    // The saved merge intent must stay durable: the response may have been
    // lost after the write, and the next run reconciles the exact remote PR
    // state before repeating rather than blindly retrying an ambiguous write.
    return persistWork(
      deps,
      context,
      setWait(
        self.record,
        { reason: "unavailable", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  return handleMergeOutcome(deps, context, self.record, merged.value, receipt);
}

/**
 * `receipt` is the EXACT review receipt that authorized this merge: the one the
 * caller just validated with the strict predicate (the fresh merge) or the one
 * the durable merge intent references by its review request/result identity
 * (reconciliation). A receipt that merely shares PR/head never carries the
 * delivery proof, and the release request published below must reference this
 * exact record so a later acceptance can revalidate the same proof.
 */
export async function handleMergeOutcome(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  outcome: MergeOutcomeV1,
  receipt: ReviewReceiptV1 | null,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  if (outcome.outcome === "merged") {
    const queueGuard = await guardQueueDelivery(
      deps,
      context,
      record,
      receipt,
      outcome.mergeSha,
      (proof) => {
        if (proof.status !== "verified" || proof.delivery.kind !== "queue") {
          return true;
        }
        if (context.head === null) return false;
        const ref = queueDeliveryProvenanceRef(
          proof.delivery,
          record,
          context.head,
        );
        if (ref === null) return false;
        if (
          !record.evidence.some((item) =>
            item.kind === ref.kind && item.ref === ref.ref
          )
        ) {
          record = { ...record, evidence: [...record.evidence, ref] };
        }
        return true;
      },
    );
    if (queueGuard !== null) return queueGuard;
    const cleared = clearIntent(
      outcome.selfMerge === undefined ? record : {
        ...record,
        target: { ...record.target, selfMerge: outcome.selfMerge },
      },
      now,
    );
    // GitHub may already have auto-closed the issue through the published
    // "Resolves #N" link. The trusted read-only context still yields the same
    // canonical title/body digest, so a successful merge is never left
    // unreleasable; a changed digest or a non-positive verdict is an honest
    // no-delivery: no release request is published and the task is never
    // counted as a newly delivered repair.
    const semantic = await deliveryTaskRefusal(deps, record, receipt);
    if (semantic === "wait") {
      return waitRelease(deps, context, record, now);
    }
    if (semantic !== null) {
      return persistWork(
        deps,
        context,
        markBlocked(cleared, semanticRefusalKind(semantic), semantic, now),
      );
    }
    const request = await buildReleaseRequest(deps, record, outcome, receipt);
    if (request === null) {
      return persistWork(
        deps,
        context,
        markTerminalBlocked(
          cleared,
          "other",
          "release request identity invalid",
          now,
        ),
      );
    }
    return persistTransition(deps, context, (draft) => {
      const index = draft.work.findIndex((work) => work.id === record.id);
      draft.work[index] = { ...cleared, updatedAt: now };
      if (!draft.releaseRequests.some((item) => item.id === request.id)) {
        draft.releaseRequests.push(request);
      }
    });
  }
  if (outcome.outcome === "ambiguous") {
    return { kind: "progress" }; // reconciled via readPullRequest next run
  }
  const reason = outcome.reason;
  if (
    reason === "checks_pending" && record.intent?.kind === "merge" &&
    record.intent.selfMerge === undefined
  ) {
    // Issue #189: the port refuses `checks_pending` only for an open,
    // unmerged pull request, so the intent binds no write. Clearing it into a
    // bounded `ci_pending` wait lets the pre-merge CI dispatcher (which
    // selects intent-free `ci_pending` records) start CI the target never
    // starts itself; the next turn's CI gate re-observes the head.
    return persistWork(
      deps,
      context,
      setWait(
        clearIntent(record, now),
        {
          reason: "ci_pending",
          since: waitSince(record, "ci_pending", now),
          until: now + CHECK_POLL_MS,
        },
        now,
      ),
    );
  }
  if (
    reason === "checks_pending" || reason === "conflict" ||
    reason === "review_required"
  ) {
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "backoff", since: now, until: now + CHECK_POLL_MS },
        now,
      ),
    );
  }
  return persistWork(
    deps,
    context,
    setWait(
      record,
      { reason: "backoff", since: now, until: now + CHECK_POLL_MS },
      now,
    ),
  );
}

export async function reconcileMergeIntent(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueOperation(deps, context, record, "merge");
  if (queueGuard !== null) return queueGuard;
  const takeoverSelf = await holdAdoptedSelfMerge(deps, context, record);
  if (takeoverSelf !== null) return takeoverSelf;
  if (record.intent?.selfMerge !== undefined) {
    const receipt = mergeIntentReceipt(context.snapshot.reviews, record);
    if (
      receipt === null || record.target.pr === null ||
      record.target.head === null
    ) {
      return {
        kind: "state_error",
        detail: "self merge recovery binding unavailable",
      };
    }
    const self = selfMergeExecution(deps, context, record);
    const result = await deps.github.mergePullRequest({
      pullRequestNumber: record.target.pr,
      expectedHead: record.target.head,
      expectedBase: record.target.base,
      review: receipt,
    }, self.execution);
    if (self.failure !== null) return self.failure;
    if (result.ok) {
      return handleMergeOutcome(
        deps,
        context,
        self.record,
        result.value,
        receipt,
      );
    }
    const at = deps.clock.now();
    const refusal = selfMergeRefusal(self.record, result.error);
    if (refusal !== null) {
      return persistWork(
        deps,
        context,
        parkSelfMergeRefusal(self.record, refusal, at),
      );
    }
    const conflict = selfMergeConflict(self.record, result.error);
    if (conflict === null) {
      return persistWork(
        deps,
        context,
        setWait(self.record, {
          reason: "unavailable",
          since: at,
          until: at + CHECK_POLL_MS,
        }, at),
      );
    }
    if (conflict.kind === "park") {
      return persistWork(
        deps,
        context,
        parkSelfMergeRefusal(self.record, conflict.refusal, at),
      );
    }
    // The target moved without this proof's merge before any source write:
    // reconcile the plain merge intent like any other (merged, closed, or
    // open on a moved base refreshes) instead of waiting forever.
    record = conflict.record;
  }
  if (record.target.pr === null || record.target.head === null) {
    return { kind: "state_error", detail: "merge intent without identity" };
  }
  // Merge reconciliation observes the exact remote PR state: gate before the
  // read. A cooldown deferral keeps the merge intent durable so the next run
  // reconciles the exact same operation once.
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
  const pr = await deps.github.readPullRequest(record.target.pr);
  if (!pr.ok) {
    emitMergePortError(
      "merge_reconcile_read_error",
      record.target.pr,
      pr.error,
    );
    return persistWork(
      deps,
      context,
      setWait(
        record,
        {
          reason: "unavailable",
          since: deps.clock.now(),
          until: deps.clock.now() + CHECK_POLL_MS,
        },
        deps.clock.now(),
      ),
    );
  }
  const pull = pr.value;
  if (pull === null) {
    // An unobservable pull request is re-read after one poll, never parked.
    const at = deps.clock.now();
    return persistWork(
      deps,
      context,
      setWait(
        record,
        { reason: "unavailable", since: at, until: at + CHECK_POLL_MS },
        at,
      ),
    );
  }
  if (pull.state === "merged" && pull.mergeSha !== null) {
    if (pull.head !== record.target.head) {
      // Reconcile only the head this task reviewed: an observed merged head
      // different from the saved reviewed head is an identity contradiction
      // and must never produce a release request for the wrong revision.
      return persistWork(
        deps,
        context,
        markTerminalBlocked(
          record,
          "other",
          "observed merged head identity mismatch",
          deps.clock.now(),
        ),
      );
    }
    return handleMergeOutcome(deps, context, record, {
      outcome: "merged",
      head: pull.head,
      mergeSha: pull.mergeSha,
    }, mergeIntentReceipt(context.snapshot.reviews, record));
  }
  if (pull.state === "closed") {
    return persistWork(
      deps,
      context,
      markTerminalBlocked(
        record,
        "other",
        "pull request closed before merge",
        deps.clock.now(),
      ),
    );
  }
  // The merge-gate read is awaited wall-clock time: it may have crossed the
  // total deadline, and the merge mutation must not start then. The merge
  // intent stays durable; the next run re-reads the gate and merges once.
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return {
      kind: "margin",
      detail: "merge gate crossed the total run deadline",
    };
  }
  // The pull request was just observed open and unmerged, so this intent's
  // merge never happened. Once the configured base has moved, the reviewed
  // base no longer authorizes the merge and every re-armed attempt is refused
  // again; replace the stale merge intent with the durable base refresh so the
  // candidate is refreshed and re-reviewed instead of looping on backoff.
  // A merge sent within the last poll window may still be landing (an
  // ambiguous response is reconciled immediately), and its own merge would
  // move the base; only an intent at least one poll old is treated as stale.
  // At the hard review-round ceiling the refreshed head could never be
  // reviewed: the reviewed head's CI is read with the stale merge intent
  // cleared, and only a green head its latest review authorizes refreshes
  // mechanically to carry that review (anything else parks, a red one with
  // the merge gate's own CI blocker). Every refresh waits its turn in the
  // repository's delivery line, the merge intent kept until it is replaced.
  if (
    record.source.kind === "issue" &&
    deps.github.prepareBaseRefresh !== undefined &&
    record.intent !== null &&
    deps.clock.now() - record.intent.startedAt >= CHECK_POLL_MS
  ) {
    const refresh = await ensureBaseRefreshIntent(
      deps,
      context,
      record,
      async (observedBase) =>
        reviewRoundsSpentOut(context, record)
          ? await spentOnMovedBase(
            deps,
            context,
            clearIntent(record, deps.clock.now()),
            observedBase,
          )
          : deliveryQueueDeferral(deps, context, record, observedBase),
    );
    if (refresh !== null) return refresh;
  }
  return executeMerge(deps, context, record);
}

export async function buildReleaseRequest(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  outcome: { head: GitSha | null; mergeSha: GitSha | null },
  receipt: ReviewReceiptV1 | null,
): Promise<ReleaseRequestV1 | null> {
  const head = outcome.head ?? record.target.head;
  const revision = outcome.mergeSha ?? head;
  if (record.target.pr === null || head === null || revision === null) {
    return null;
  }
  const id = await releaseRequestId(
    record.repository,
    revision,
    record.target.pr,
  );
  const request: ReleaseRequestV1 = {
    version: "v1",
    kind: "release_request",
    id,
    target: { repository: record.repository, environment: "production" },
    revision,
    source: {
      pullRequest: record.target.pr,
      reviewRequestId: receipt?.requestId ?? "",
      reviewReceiptId: receipt?.id ?? null,
      head,
      base: record.target.base,
    },
    status: "open",
    failureReason: null,
    createdAt: deps.clock.now(),
  };
  try {
    return parseReleaseRequestV1(request);
  } catch {
    return null;
  }
}
