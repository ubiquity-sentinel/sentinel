import { guardQueueDelivery } from "./loop-queue-guard.ts";
import { guardQueueOperation } from "./loop-queue-guard.ts";
import { isNativeQueueTarget } from "../github/native-queue-guard.ts";
import { REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX } from "./review-round-cap.ts";
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
 * from git on every step; once H1's OWN required CI is green (every existing
 * run green and every expected check present: each check name of T's check
 * suites that share a name with H1, `absentExpectedChecks`, sentinel issue
 * #154) and the task is still accepted, the record holds the exact
 * carried-merge marker at `work`
 * (`carriedMergeMarker`) for the launcher's delivery pass, which merges only
 * under that marker, re-derives the exact proof itself and merges H1 at
 * exactly T (`ops/hosted-autonomy-spent-delivery.ts`). The runtime never
 * merges a carried head: its merge port refuses every merge on a branch without
 * enforced strict checks (live ai.ubq.fi has no rules), so the launcher, which
 * merges every ai.ubq.fi delivery, makes this one too (round-2 recheck P1).
 *
 * Bounds: one refresh per record per base tip (the refresh intent key binds
 * PR, head and observed tip, and the target advances), serialised per
 * repository by the delivery line (`deliveryQueueAhead`), and at most
 * `CARRIED_REFRESH_LIMIT` refreshes per reviewed head, counted from git (the
 * first-parent distance from H0, so no state field and no reset by a
 * refresh); every wait (CI, proof, a pull request still reporting the
 * refreshed-from head or the launcher's delivery record) keeps its `since`
 * and parks after `CARRIED_WAIT_BOUND_MS` with a precise blocker, and the
 * carried-merge marker, which restarts on every poll, parks that long after
 * H1's own CI completed. A legacy record whose final round is open and whose
 * red head on a moved base is not the candidate's own failure takes the same
 * mechanical refresh once the tip is green, and otherwise waits, bounded, and
 * parks with a precise non-correctable CI blocker
 * (`holdUncorrectableLegacyHead`, issue #155). A
 * refresh conflict keeps the refresh's own terminal `base refresh has
 * conflicts at <T>` block; a differing patch, a red H1, the refresh limit or a
 * stalled wait parks under the ceiling prefix. Nothing is ever charged here.
 *
 * Rollback (R79): every write is a shape R79 writes and parses itself (the
 * base-refresh intent, `ci_pending`/`backoff`/`unavailable` waits at `work`, an
 * `other` blocker, the `delivery` transition beside a release request the
 * launcher wrote). Under R79 a refreshed head at `work` is published and
 * reviewed as R79 does with every refreshed head. Generation 81 adds one
 * write of an existing shape (R80 writes it too): a deliverable head that
 * defers in the line clears its stale `ci_pending` wait at `delivery` once.
 */
import type { GitSha } from "../contracts/brands.ts";
import {
  carriedPatchHolds,
  type CarriedPatchProofV1,
  type CarriedPatchRequestV1,
  type GitHubCheckV1,
} from "../contracts/ports.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { WorkRecordV1, WorkWaitV1 } from "../contracts/work-record.ts";
import {
  carriedMergeMarker,
  cleanReview,
  latestPullReview,
  reviewedIdentity,
} from "./carried-review.ts";
import {
  absentCheckLabels,
  baseRedDetail,
  ciCheckLabels,
  failedChecks,
  latestChecks,
  unattributedDetail,
} from "./ci-rejection.ts";
import { ensureBaseRefreshIntent } from "./loop-base-refresh.ts";
import { CHECK_POLL_MS, checkGithubCooldown } from "./loop-bounds.ts";
import { absentExpectedChecks, decideCiGate } from "./loop-checks.ts";
import {
  observeHeadFailure,
  RED_BASE_RECHECK_MS,
} from "./loop-ci-correction.ts";
import { deliveryQueueDeferral } from "./loop-delivery-queue.ts";
import { releaseRequestMatchesDelivery } from "./loop-records.ts";
import {
  legacyCutoff,
  parkAtReviewRoundCeiling,
} from "./loop-review-round-cap.ts";
import { persistWork } from "./loop-state.ts";
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
  legacyFinalRoundOpen,
  REVIEW_ROUND_CEILING_BASE_MOVED,
  REVIEW_ROUND_CEILING_CARRIED_CI_FAILED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_PATCH_CHANGED_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_REFRESH_LIMIT_PREFIX,
  REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX,
  REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX,
} from "./review-round-cap.ts";
import {
  advanceToDelivery,
  clearWait,
  markBlocked,
  setWait,
} from "./transitions.ts";

/**
 * Bound on every carried-delivery wait (CI, proof, a lagging pull request,
 * the launcher's merge or its delivery record): 6 hours.
 */
export const CARRIED_WAIT_BOUND_MS = 6 * 60 * 60_000;

/**
 * Mechanical refreshes one reviewed head may be carried through: the base
 * moving again after this many parks the record instead of refreshing it
 * once more. Counted from git (`CarriedPatchProofV1.refreshes`), so a
 * refresh, which clears every wait, never resets it.
 */
export const CARRIED_REFRESH_LIMIT = 6;

/** Stalled detail: the record awaits the launcher's carried merge. */
export const CARRIED_AWAITING_LAUNCHER_MERGE =
  "the launcher did not merge the green refreshed head";

/** Stalled detail: merged, but the launcher wrote no delivery record. */
export const CARRIED_AWAITING_LAUNCHER_RECORD =
  "merged without the launcher's delivery record";

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
 * legacy class keeps it; a legacy head red through its base is held instead,
 * `holdUncorrectableLegacyHead`), pending (or green while an expected check
 * of its reviewed base does not exist on it yet, or that base's runs cannot
 * be read) waits at `delivery` and parks after
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
    if (legacyFinalRoundOpen(context.snapshot, record, legacyCutoff(context))) {
      const held = await holdUncorrectableLegacyHead(
        deps,
        context,
        record,
        observed.value.checks,
        observedBase,
      );
      if (held !== "generic") return held;
    }
    return persistWork(
      deps,
      context,
      markBlocked(record, "other", decision.blocked, deps.clock.now()),
    );
  }
  // Every existing run is green: a check its reviewed base's suites expect
  // and GitHub has not created on it yet is awaited like a running one, and
  // so is a reviewed base whose runs cannot be read.
  const absent = await absentExpectedChecks(
    deps,
    record,
    observed.value.checks,
  );
  if (absent === null || absent.length > 0) {
    return boundedWait(
      deps,
      context,
      record,
      "ci_pending",
      CHECK_POLL_MS,
      `${REVIEW_ROUND_CEILING_REVIEWED_CI_PENDING_PREFIX}${
        absentCheckLabels(absent)
      }`,
    );
  }
  const carried = await carryReviewedHead(deps, context, record, observedBase);
  return carried === "unauthorized"
    ? parkAtReviewRoundCeiling(
      deps,
      context,
      record,
      REVIEW_ROUND_CEILING_BASE_MOVED,
    )
    : carried;
}

/**
 * The one mechanical refresh of a spent reviewed head onto `observedBase`,
 * carrying its review: `unauthorized` (nothing read but the task) unless the
 * latest completed review binds this exact head and base, authorizes its
 * merge, and the port can prove the carried patch; otherwise its turn in the
 * repository's delivery line, then null (the caller writes the refresh
 * intent). Nothing is charged.
 */
async function carryReviewedHead(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  observedBase: GitSha,
): Promise<StepResultV1 | null | "unauthorized"> {
  const reviewer = deps.github.reviewerIdentity;
  const receipt = latestPullReview(context.snapshot, record, reviewer);
  if (
    deps.github.proveCarriedPatch === undefined || receipt === null ||
    receipt.pullRequest.head !== record.target.head ||
    receipt.pullRequest.base !== record.target.base
  ) return "unauthorized";
  const task = await readDeliveryTaskContext(deps, record);
  if (task === "unavailable") {
    return { kind: "deferred", detail: "merge task context is unavailable" };
  }
  if (!reviewAuthorizesMerge(receipt, record, reviewer, task)) {
    return "unauthorized";
  }
  const deferral = deliveryQueueDeferral(deps, context, record, observedBase);
  // Deliverable now: a `ci_pending` wait left from an earlier poll would read
  // to the line as a head still waiting for its CI, and every higher number
  // would go first. It is cleared once (the next deferral writes nothing).
  if (deferral !== null && record.wait?.reason === "ci_pending") {
    return persistWork(deps, context, clearWait(record, deps.clock.now()));
  }
  return deferral;
}

/**
 * A legacy record whose final round is open, at the ceiling on a moved base,
 * on a red head its own change did not break (round-2 recheck P3: the red
 * reviewed base, a base check still running, or no usable base evidence).
 * The generic `CI checks failed: ...` blocker is the launcher's correction
 * rule's: it re-admitted the record as a CI correction on every pass, and
 * `correctFailedHeadBeforeRefresh` declined the fix every time (no candidate
 * attribution), so each pass took a correction slot and nothing moved. A base
 * check still running is awaited instead (bounded, uncharged, at `delivery`).
 *
 * A red reviewed base B0 (or a failure no base evidence attributes) never
 * turns the head green, and on a moved base no launcher rule re-runs or
 * re-admits it (issue #155). So once the tip `observedBase` is complete and
 * green, the head takes the uncharged mechanical refresh a green spent head
 * takes (`carryReviewedHead`), and the refreshed head's own CI decides
 * (`executeCarriedDelivery`). While the tip is not green the record waits at
 * `delivery` (a `ci_pending` wait, so it holds nobody in the line), bounded
 * by `CARRIED_WAIT_BOUND_MS`. A head its review does not authorize to carry,
 * or one still waiting at the bound, parks with its precise blocker:
 * `CI checks failed on the red reviewed base: ...` (base evidence exists) or
 * `CI checks failed without base evidence: ...`, both in the class
 * (`CI_RED_PREFIXES`). It then stays parked until the owner acts, and the
 * launcher reports it on every pass. `generic` for a failure the candidate
 * caused (or one no longer observed): the caller keeps the generic blocker
 * the correction rule owns.
 */
async function holdUncorrectableLegacyHead(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  checks: readonly GitHubCheckV1[],
  observedBase: GitSha,
): Promise<StepResultV1 | null | "generic"> {
  const observed = await observeHeadFailure(deps, record);
  if (observed === null) {
    return { kind: "deferred", detail: "CI check observation unavailable" };
  }
  if (observed.kind === "clean" || observed.kind === "candidate") {
    return "generic";
  }
  const failed = failedChecks(checks);
  if (observed.kind === "base_pending") {
    return boundedWait(
      deps,
      context,
      record,
      "ci_pending",
      CHECK_POLL_MS,
      unattributedDetail(failed),
    );
  }
  const park = observed.kind === "base_red"
    ? baseRedDetail(failed)
    : unattributedDetail(failed);
  const tip = await deps.github.readChecks(observedBase);
  if (!tip.ok) {
    return { kind: "deferred", detail: "CI check observation unavailable" };
  }
  const tipGate = decideCiGate(tip.value.checks);
  if (tipGate !== "proceed") {
    return boundedWait(
      deps,
      context,
      record,
      "ci_pending",
      tipGate === "wait" ? CHECK_POLL_MS : RED_BASE_RECHECK_MS,
      park,
    );
  }
  const carried = await carryReviewedHead(deps, context, record, observedBase);
  if (carried !== "unauthorized") return carried;
  return persistWork(
    deps,
    context,
    markBlocked(record, "other", park, deps.clock.now()),
  );
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
 * The work step of a spent record at its ceiling whose current head is a
 * refresh of an earlier reviewed head. Null when the record is no carried
 * candidate (the caller parks it as before). Otherwise, in order: the patch
 * proof (git only), the pull request (merged at this exact head: the
 * launcher's delivery record, or an off-tip park; still at the head this one
 * was refreshed from: a bounded wait for GitHub to report the push), the
 * head's own CI (red: never refreshed, #156), the tip (moved again: one more
 * refresh of a green or pending head through the line, at most
 * `CARRIED_REFRESH_LIMIT`), that CI green with every check T's suites expect
 * present, the live task acceptance of the reviewed identity, and then the
 * carried-merge marker for the launcher's merge, bounded from that CI's
 * completion.
 */
export async function executeCarriedDelivery(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
): Promise<StepResultV1 | null> {
  const queueGuard = await guardQueueOperation(deps, context, record, "resume");
  if (queueGuard !== null) return queueGuard;
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
  const pull = await deps.github.readPullRequest(pr);
  if (!pull.ok) {
    return { kind: "deferred", detail: "carried pull request unavailable" };
  }
  const observed = pull.value;
  if (observed === null || observed.headRef !== record.target.branch) {
    return null;
  }
  if (observed.state === "merged") {
    return observed.head === head && observed.mergeSha !== null
      ? carriedMerged(deps, context, record, receipt, observed.mergeSha)
      : null;
  }
  if (observed.state !== "open") return null;
  if (observed.head !== head) {
    // GitHub reports a pull request's new head asynchronously after a push:
    // the head this one was refreshed from (or the reviewed head) is a lag,
    // waited out (bounded); any other head is foreign and parks.
    if (
      observed.head !== proof.value.refreshedFrom &&
      observed.head !== receipt.pullRequest.head
    ) return null;
    return boundedWait(
      deps,
      context,
      record,
      "unavailable",
      CHECK_POLL_MS,
      `${REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX}the pull request still reports ${observed.head}, not ${head}`,
    );
  }
  // H1's own CI is read before the tip (#156): a red H1 that its own change
  // caused parks at once instead of being refreshed (a refresh is one more CI
  // run while the record holds the delivery line, up to
  // `CARRIED_REFRESH_LIMIT` times). A red the base caused, or one no base
  // evidence attributes yet, may still be cured by a refresh onto a moved tip,
  // so it keeps that path (review finding, upheld 3 of 3).
  const checks = await deps.github.readChecks(head);
  if (!checks.ok) {
    return { kind: "deferred", detail: "CI check observation unavailable" };
  }
  const decision = decideCiGate(checks.value.checks);
  if (decision !== "proceed" && decision !== "wait") {
    const observed = await observeHeadFailure(deps, record);
    if (observed === null) {
      return { kind: "deferred", detail: "CI check observation unavailable" };
    }
    if (observed.kind === "candidate") {
      return gateCarriedChecks(
        deps,
        context,
        record,
        checks.value.checks,
        decision,
      );
    }
  }
  // The base moved again: one more refresh of this tip, in its turn, unless
  // the reviewed head was already carried through the most refreshes.
  const refresh = await ensureBaseRefreshIntent(
    deps,
    context,
    record,
    (observedBase) =>
      proof.value.refreshes >= CARRIED_REFRESH_LIMIT
        ? parkAtReviewRoundCeiling(
          deps,
          context,
          record,
          `${REVIEW_ROUND_CEILING_CARRIED_REFRESH_LIMIT_PREFIX}${proof.value.refreshes} refreshes; reviewed ${request.reviewedHead} on ${request.reviewedBase}, refreshed ${head} on ${request.base}, tip ${observedBase}`,
        )
        : Promise.resolve(
          deliveryQueueDeferral(deps, context, record, observedBase),
        ),
  );
  if (refresh !== null) return refresh;
  if (decision !== "proceed") {
    return gateCarriedChecks(
      deps,
      context,
      record,
      checks.value.checks,
      decision,
    );
  }
  // Every existing run on H1 is green; a check T's suites expect that GitHub
  // has not created on H1 yet (a `needs:` job) is awaited like a running one,
  // so the marker never names a head whose required job never ran; a T whose
  // runs cannot be read is awaited the same way.
  const absent = await absentExpectedChecks(
    deps,
    record,
    checks.value.checks,
  );
  if (absent === null || absent.length > 0) {
    return boundedWait(
      deps,
      context,
      record,
      "ci_pending",
      CHECK_POLL_MS,
      `${REVIEW_ROUND_CEILING_CARRIED_CI_PENDING_PREFIX}${
        absentCheckLabels(absent)
      }`,
    );
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
  // Everything the merge needs holds: the launcher's delivery pass merges
  // this exact head at this exact tip (it re-derives every gate itself), and
  // only while the record carries the exact carried-merge marker. The marker
  // restarts its `since` on every poll (that keeps its shape exact), so the
  // bound counts from the refreshed head's own CI completion instead.
  const now = deps.clock.now();
  const green = ciCompletedAt(checks.value.checks);
  if (green === null || now - green >= CARRIED_WAIT_BOUND_MS) {
    return persistWork(
      deps,
      context,
      markBlocked(
        record,
        "other",
        `${REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX}${CARRIED_AWAITING_LAUNCHER_MERGE}`,
        now,
      ),
    );
  }
  return persistWork(
    deps,
    context,
    setWait(record, carriedMergeMarker(now), now),
  );
}

/**
 * When the head's required CI finished: the latest completion (or, for a
 * check GitHub reported without one, its start) over the latest run of every
 * check; null when no check carries either instant.
 */
function ciCompletedAt(checks: readonly GitHubCheckV1[]): number | null {
  let at: number | null = null;
  for (const check of latestChecks([...checks])) {
    const instant = check.completedAt ?? check.startedAt;
    if (instant !== null && (at === null || instant > at)) at = instant;
  }
  return at;
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

/**
 * The pull request is merged at exactly the refreshed head. The launcher's
 * delivery pass made that merge and records it (a production release request
 * naming the carried receipt): once that request is there the record moves
 * to `delivery` with the runtime's own transition (the launcher does that
 * itself for the Gateway; a self record is never rewritten by it). Until then
 * it waits, bounded: the launcher adopts its own lost write from the same
 * gates, and a merge outside that path is never booked here.
 */
async function carriedMerged(
  deps: RepairCycleDepsV1,
  context: LoopContextV1,
  record: WorkRecordV1,
  receipt: ReviewReceiptV1,
  revision: GitSha,
): Promise<StepResultV1> {
  const queueGuard = await guardQueueDelivery(
    deps,
    context,
    record,
    receipt,
    revision,
  );
  if (queueGuard !== null) return queueGuard;
  const booked = context.snapshot.releaseRequests.some((request) =>
    request.target.environment === "production" &&
    releaseRequestMatchesDelivery(request, record) &&
    request.source.reviewReceiptId === receipt.id &&
    request.source.reviewRequestId === receipt.requestId
  );
  if (!booked) {
    const offTip = await carriedOffTipDetail(deps, record, revision);
    if (offTip !== null) {
      return persistWork(
        deps,
        context,
        markBlocked(record, "other", offTip, deps.clock.now()),
      );
    }
    return boundedWait(
      deps,
      context,
      record,
      "unavailable",
      CHECK_POLL_MS,
      `${REVIEW_ROUND_CEILING_CARRIED_STALLED_PREFIX}${CARRIED_AWAITING_LAUNCHER_RECORD}`,
    );
  }
  return persistWork(
    deps,
    context,
    advanceToDelivery(record, deps.clock.now()),
  );
}

/**
 * The launcher's own off-tip blocker for a carried merge whose commit's
 * parents are not exactly [T, H1] (#156), or null. The launcher books a
 * carried merge only on exactly those parents (and never rewrites a self
 * record), so such a merge can never be booked: the record parks at once,
 * naming the cause, instead of holding its repository's delivery line until
 * the 6-hour stall park. A native queue target is the launcher's to park (a
 * queue merge has the queue's parents); an unreadable or unknown commit
 * keeps the bounded wait.
 */
async function carriedOffTipDetail(
  deps: RepairCycleDepsV1,
  record: WorkRecordV1,
  revision: GitSha,
): Promise<string | null> {
  const { head, base } = record.target;
  const read = deps.github.readCommitParents;
  if (
    read === undefined || head === null ||
    isNativeQueueTarget(record.repository)
  ) return null;
  let parents;
  try {
    parents = await read.call(deps.github, revision);
  } catch {
    return null;
  }
  if (!parents.ok || parents.value === null) return null;
  const listed = parents.value;
  if (listed.length === 2 && listed[0] === base && listed[1] === head) {
    return null;
  }
  return `${REVIEW_ROUND_CEILING_CARRIED_OFF_TIP_PREFIX}merge ${revision} has parents ${
    listed.join(",") || "none"
  }, not ${base},${head}`;
}
