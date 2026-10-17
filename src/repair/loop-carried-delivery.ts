/**
 * Repair loop internals: spent records on a moved base (owner decision
 * 2026-10-16 (2), "the 3 rounds are spent with no unresolved P0/P1, the PR
 * merges"; the coordinator's option (b), docs/DECISIONS.md).
 *
 * A record whose review rounds are spent and whose latest completed review
 * authorizes head H0 on base B0 (no unresolved P0/P1, nothing uncounted, the
 * live task accepted) gets ONE mechanical refresh when the base moved to tip
 * T: the existing deterministic base refresh (the runtime merges T into H0; no
 * model, no reservation, never a review round or a CI fix attempt). The
 * refreshed head H1 carries H0's review only while the pull request's own
 * patch is byte-identical (`proveCarriedPatch`: the merge-base patch of H0
 * against B0 equals that of H1 against T, binary-safe, by SHA-256), re-derived
 * from git on every step and again by the port at the merge itself; H1 merges
 * only once its OWN required CI is green, so every merged tree is CI-tested
 * and the merged patch is exactly the reviewed one.
 *
 * Bounds: one refresh per record per base tip (the refresh intent key binds
 * PR, head and observed tip, and the target advances), serialised per
 * repository by the delivery line (`deliveryQueueAhead`); every wait (CI,
 * proof, refused merge) keeps its `since` and parks after
 * `CARRIED_WAIT_BOUND_MS` with a precise blocker. A refresh conflict keeps
 * the refresh's own terminal `base refresh has conflicts at <T>` block; a
 * differing patch, a red H1 or a stalled wait parks under the ceiling prefix.
 * Nothing is ever charged here.
 *
 * Rollback (R79): every write is a shape R79 writes and parses itself (the
 * base-refresh intent, `ci_pending`/`backoff`/`unavailable` waits at `work`, an
 * `other` blocker, a release request beside a record in `delivery`). No merge
 * intent is written for a carried merge: under R79 a refreshed head at `work`
 * is published and reviewed as R79 does with every refreshed head, and a
 * merged pull request without bookkeeping is adopted here only from the same
 * gates the merge itself passes.
 */
import type { GitSha } from "../contracts/brands.ts";
import { parseMergeRequestV1 } from "../contracts/merge-request.ts";
import {
  carriedPatchHolds,
  type CarriedPatchProofV1,
  type CarriedPatchRequestV1,
  type GitHubCheckV1,
} from "../contracts/ports.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1, WorkWaitV1 } from "../contracts/work-record.ts";
import {
  cleanReview,
  latestPullReview,
  reviewedIdentity,
} from "./carried-review.ts";
import { ciCheckLabels, failedChecks, latestChecks } from "./ci-rejection.ts";
import { ensureBaseRefreshIntent } from "./loop-base-refresh.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { decideCiGate } from "./loop-checks.ts";
import {
  observeHeadFailure,
  RED_BASE_RECHECK_MS,
} from "./loop-ci-correction.ts";
import { deliveryQueueDeferral } from "./loop-delivery-queue.ts";
import { buildReleaseRequest } from "./loop-merge.ts";
import { parkAtReviewRoundCeiling } from "./loop-review-round-cap.ts";
import { persistTransition, persistWork } from "./loop-state.ts";
import {
  readDeliveryTaskContext,
  semanticRefusalKind,
} from "./loop-task-context.ts";
import type {
  LoopContextV1,
  RepairCycleDepsV1,
  StepResultV1,
} from "./loop-types.ts";
import { reviewAuthorizesMerge, taskAcceptanceRefusal } from "./review-gate.ts";
import {
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX,
  REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX,
} from "./review-round-cap.ts";
import { RETIRED_MERGED_MESSAGE } from "./selection.ts";
import { advanceToDelivery, markBlocked, setWait } from "./transitions.ts";

/** Bound on every carried-delivery wait (CI, proof, refused merge): 6 hours. */
export const CARRIED_WAIT_BOUND_MS = 6 * 60 * 60_000;

/**
 * Keep `since` across consecutive waits of the same reason, and park with
 * `park` once `CARRIED_WAIT_BOUND_MS` has passed.
 */
function boundedWait(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  reason: WorkWaitV1["reason"],
  recheckMs: number,
  park: string,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const since = record.wait?.reason === reason && record.wait.since < now
    ? record.wait.since
    : now;
  if (now - since >= CARRIED_WAIT_BOUND_MS) {
    return persistWork(
      deps,
      context,
      markBlocked(record, "other", park, now),
    );
  }
  return persistWork(
    deps,
    context,
    setWait(record, { reason, since, until: now + recheckMs }, now),
  );
}

/** Pending checks named for a park (or "no check runs"). */
function pendingLabels(checks: readonly GitHubCheckV1[]): string {
  const pending = latestChecks([...checks]).filter((check) =>
    check.status !== "completed"
  );
  return pending.length === 0 ? "no check runs" : ciCheckLabels(pending);
}

/**
 * The delivery step of a spent record whose base moved to `observedBase`
 * (nothing written yet). The reviewed head's own CI is read first: red parks
 * with the merge gate's own `CI checks failed: ...` blocker (the owner's
 * legacy class keeps it), pending waits at `delivery` and parks after
 * `CARRIED_WAIT_BOUND_MS`. A green head whose latest completed review
 * authorizes it on its base, on a port that can prove the carried patch,
 * waits its turn in the repository's delivery line and then returns null:
 * the caller writes the one refresh intent of this tip. Anything else parks
 * BASE_MOVED as before.
 */
export async function spentOnMovedBase(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  observedBase: GitSha,
): Promise<StepResultV1 | null> {
  const head = record.target.head;
  if (head === null) return null;
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
  const observed = await deps.github.readChecks(head);
  if (!observed.ok) {
    return { kind: "deferred", detail: "CI check observation unavailable" };
  }
  const decision = decideCiGate(observed.value.checks);
  if (decision === "wait") {
    return boundedWait(
      deps,
      context,
      record,
      "ci_pending",
      CHECK_POLL_MS,
      `${REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX}${
        pendingLabels(observed.value.checks)
      }`,
    );
  }
  if (decision !== "proceed") {
    // A red reviewed head keeps the merge gate's own `CI checks failed: ...`
    // blocker (no base read, nothing charged): the caller already offered an
    // open legacy final round its CI fix (`correctFailedHeadBeforeRefresh`),
    // and a spent head is never refreshed or re-armed on a red base.
    return persistWork(
      deps,
      context,
      markBlocked(record, "other", decision.blocked, deps.clock.now()),
    );
  }
  const reviewer = deps.github.reviewerIdentity;
  const receipt = latestPullReview(context.snapshot, record, reviewer);
  if (
    deps.github.proveCarriedPatch === undefined || receipt === null ||
    receipt.pullRequest.head !== head ||
    receipt.pullRequest.base !== record.target.base
  ) {
    return parkAtReviewRoundCeiling(
      deps,
      context,
      record,
      REVIEW_ROUND_CEILING_BASE_MOVED,
    );
  }
  const task = await readDeliveryTaskContext(deps, record);
  if (task === "unavailable") {
    return { kind: "deferred", detail: "merge task context is unavailable" };
  }
  if (!reviewAuthorizesMerge(receipt, record, reviewer, task)) {
    return parkAtReviewRoundCeiling(
      deps,
      context,
      record,
      REVIEW_ROUND_CEILING_BASE_MOVED,
    );
  }
  return deliveryQueueDeferral(deps, context, record, observedBase);
}

/** The proof request of `record` (refreshed) against `receipt` (reviewed). */
function proofRequest(
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
): CarriedPatchRequestV1 | null {
  const { head, base } = record.target;
  if (head === null) return null;
  return {
    reviewedBase: receipt.pullRequest.base,
    reviewedHead: receipt.pullRequest.head,
    base,
    head,
  };
}

/** The precise park of a refreshed head that no longer carries the patch. */
function patchChangedDetail(
  request: CarriedPatchRequestV1,
  proof: CarriedPatchProofV1,
): string {
  return `${REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX}reviewed ${request.reviewedHead} on ${request.reviewedBase} sha256:${proof.reviewedPatch}, refreshed ${request.head} on ${request.base} (merge base ${proof.refreshedMergeBase}) sha256:${proof.refreshedPatch}`;
}

/**
 * The proof and every check name of the green head, as plain merge commit
 * evidence (no mention, no reference, no control character).
 */
export function carriedEvidence(
  receipt: ReviewReceiptV1,
  request: CarriedPatchRequestV1,
  proof: CarriedPatchProofV1,
  checks: readonly GitHubCheckV1[],
): string {
  const green = latestChecks([...checks]).map((check) =>
    `${check.name}=${check.conclusion ?? "none"}@${
      check.completedAt === null
        ? "pending"
        : new Date(check.completedAt).toISOString()
    }`
  ).sort().join(", ");
  return [
    "Sentinel carried review (owner decision 2026-10-16, option b):",
    `reviewed head ${request.reviewedHead} on base ${request.reviewedBase}, review receipt ${receipt.id}`,
    `refreshed head ${request.head} on base ${request.base}`,
    `merge-base patch sha256 reviewed ${proof.reviewedPatch} (merge base ${proof.reviewedMergeBase})`,
    `merge-base patch sha256 refreshed ${proof.refreshedPatch} (merge base ${proof.refreshedMergeBase})`,
    `required CI on ${request.head}: ${green}`,
  ].join("\n");
}

/**
 * The work step of a spent record at its ceiling whose current head is a
 * refresh of an earlier reviewed head. Null when the record is no carried
 * candidate (the caller parks it as before). Otherwise, in order: the pull
 * request (merged at this exact head: the same gates, then the bookkeeping),
 * the patch proof, the tip (moved again: one more refresh through the line),
 * the head's own CI, the live task acceptance of the reviewed identity, and
 * the carried merge.
 */
export async function executeCarriedDelivery(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  const { pr, head } = record.target;
  const prove = deps.github.proveCarriedPatch?.bind(deps.github);
  if (
    record.source.kind !== "issue" || pr === null || head === null ||
    record.target.branch === null || prove === undefined
  ) return null;
  const reviewer = deps.github.reviewerIdentity;
  const receipt = latestPullReview(context.snapshot, record, reviewer);
  if (
    receipt === null || receipt.pullRequest.head === head ||
    !cleanReview(receipt)
  ) return null;
  const request = proofRequest(record, receipt);
  if (request === null) return null;
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
  const pull = await deps.github.readPullRequest(pr);
  if (!pull.ok) {
    return { kind: "deferred", detail: "carried pull request unavailable" };
  }
  if (
    pull.value === null || pull.value.head !== head ||
    pull.value.headRef !== record.target.branch ||
    (pull.value.state !== "open" &&
      !(pull.value.state === "merged" && pull.value.mergeSha !== null))
  ) return null;
  const merged = pull.value.state === "merged" ? pull.value.mergeSha : null;
  const proof = await prove(request);
  if (!proof.ok) {
    return boundedWait(
      deps,
      context,
      record,
      "unavailable",
      CHECK_POLL_MS,
      `${REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX}patch proof ${proof.error.kind}`,
    );
  }
  if (!carriedPatchHolds(request, proof.value)) {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "other",
        patchChangedDetail(request, proof.value),
        deps.clock.now(),
      ),
    );
  }
  if (merged === null) {
    // The base moved again: one more refresh of this tip, in its turn.
    const refresh = await ensureBaseRefreshIntent(
      deps,
      context,
      record,
      (observed) =>
        Promise.resolve(
          deliveryQueueDeferral(deps, context, record, observed),
        ),
    );
    if (refresh !== null) return refresh;
  }
  const checks = await deps.github.readChecks(head);
  if (!checks.ok) {
    return { kind: "deferred", detail: "CI check observation unavailable" };
  }
  const decision = decideCiGate(checks.value.checks);
  if (decision !== "proceed") {
    const parked = merged !== null ? null : await gateCarriedChecks(
      deps,
      context,
      record,
      checks.value.checks,
      decision,
    );
    if (parked !== null) return parked;
    return retireMerged(deps, context, record);
  }
  const task = await readDeliveryTaskContext(deps, record);
  if (task === "unavailable") {
    return { kind: "deferred", detail: "merge task context is unavailable" };
  }
  const reviewed = reviewedIdentity(record, receipt);
  const refusal = taskAcceptanceRefusal(receipt, reviewed, task);
  if (
    refusal !== null ||
    !reviewAuthorizesMerge(receipt, reviewed, reviewer, task)
  ) {
    if (merged !== null) return retireMerged(deps, context, record);
    const detail = refusal ?? "merge requires a review that authorizes it";
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        refusal === null ? "other" : semanticRefusalKind(refusal),
        detail,
        deps.clock.now(),
      ),
    );
  }
  if (merged !== null) {
    return recordCarriedDelivery(deps, context, record, receipt, merged);
  }
  return mergeCarried(
    deps,
    context,
    record,
    receipt,
    request,
    carriedEvidence(receipt, request, proof.value, checks.value.checks),
  );
}

/**
 * The refreshed head's own CI is not green: pending waits (bounded), a red
 * base backs off (bounded, nothing charged), any other failure parks with the
 * precise blocker. No CI fix is admitted: a fix would change the patch the
 * review authorized.
 */
async function gateCarriedChecks(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  checks: readonly GitHubCheckV1[],
  decision: "wait" | { blocked: string },
): Promise<StepResultV1> {
  if (decision === "wait") {
    return boundedWait(
      deps,
      context,
      record,
      "ci_pending",
      CHECK_POLL_MS,
      `${REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX}${
        pendingLabels(checks)
      }`,
    );
  }
  const observed = await observeHeadFailure(deps, record);
  if (observed === null) {
    return { kind: "deferred", detail: "CI check observation unavailable" };
  }
  if (observed.kind === "base_red") {
    return boundedWait(
      deps,
      context,
      record,
      "backoff",
      RED_BASE_RECHECK_MS,
      `${REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX}${
        decision.blocked.replace(/^CI checks failed: /, "")
      } (the base is red)`,
    );
  }
  if (observed.kind === "base_pending" || observed.kind === "unattributed") {
    return boundedWait(
      deps,
      context,
      record,
      "ci_pending",
      CHECK_POLL_MS,
      `${REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX}${
        ciCheckLabels(failedChecks(checks))
      } without base evidence`,
    );
  }
  return persistWork(
    deps,
    context,
    markBlocked(
      record,
      "other",
      `${REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX}${
        decision.blocked.replace(/^CI checks failed: /, "")
      }`,
      deps.clock.now(),
    ),
  );
}

/** A merged pull request the gates refuse: merged outside the trusted path. */
function retireMerged(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1> {
  return persistWork(
    deps,
    context,
    markBlocked(record, "other", RETIRED_MERGED_MESSAGE, deps.clock.now()),
  );
}

/**
 * The carried merge through the port (which re-proves the patch from git and
 * re-checks the review, protections, CI, ancestry and task), with the proof
 * as merge commit evidence. No merge intent is written (see the module). A
 * refused or failed call waits, bounded.
 */
async function mergeCarried(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  request: CarriedPatchRequestV1,
  evidence: string,
): Promise<StepResultV1> {
  let merge;
  try {
    merge = parseMergeRequestV1({
      pullRequestNumber: record.target.pr!,
      expectedHead: request.reviewedHead,
      expectedBase: request.reviewedBase,
      review: receipt,
    }, {
      repository: record.repository,
      expectedReviewer: deps.github.reviewerIdentity,
    });
  } catch {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "other",
        `${REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX}the reviewed receipt is no merge authorization`,
        deps.clock.now(),
      ),
    );
  }
  if (deps.clock.now() >= context.bounds.runDeadline) {
    return { kind: "margin", detail: "merge crossed the total run deadline" };
  }
  const merged = await deps.github.mergePullRequest(merge, undefined, {
    head: request.head,
    base: request.base,
    evidence,
  });
  if (merged.ok && merged.value.outcome === "merged") {
    const mergeSha = merged.value.mergeSha;
    if (merged.value.head !== request.head || mergeSha === null) {
      return persistWork(
        deps,
        context,
        markBlocked(
          record,
          "other",
          "observed merged head identity mismatch",
          deps.clock.now(),
        ),
      );
    }
    return recordCarriedDelivery(deps, context, record, receipt, mergeSha);
  }
  if (merged.ok && merged.value.outcome === "ambiguous") {
    // The next step re-reads the pull request and adopts the exact merge.
    return { kind: "progress" };
  }
  const reason = merged.ok
    ? merged.value.outcome === "blocked" ? merged.value.reason : "refused"
    : `port ${merged.error.kind}`;
  return boundedWait(
    deps,
    context,
    record,
    "backoff",
    CHECK_POLL_MS,
    `${REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX}merge ${reason}`,
  );
}

/**
 * The bookkeeping of one carried merge (fresh or adopted): the record moves
 * to `delivery` beside one open production release request for the merged
 * revision that names the carried receipt (the merged head and base are the
 * refreshed ones, the receipt binds the reviewed ones).
 */
async function recordCarriedDelivery(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  mergeSha: GitSha,
): Promise<StepResultV1> {
  const now = deps.clock.now();
  const request = await buildReleaseRequest(
    deps,
    record,
    { head: record.target.head, mergeSha },
    receipt,
  );
  if (request === null) {
    return persistWork(
      deps,
      context,
      markBlocked(record, "other", "release request identity invalid", now),
    );
  }
  const delivered = advanceToDelivery(record, now);
  return persistTransition(deps, context, (draft) => {
    const index = draft.work.findIndex((work) => work.id === record.id);
    draft.work[index] = delivered;
    if (!draft.releaseRequests.some((item) => item.id === request.id)) {
      draft.releaseRequests.push(request);
    }
  });
}
