/**
 * Spent-round delivery (owner decision 2026-10-16: review rounds are capped at
 * three; once they are spent, a PR whose LATEST completed current-head review
 * has no unresolved P0/P1 and whose required CI on that exact head is green
 * merges, and its remaining P2/P3 findings become follow-up issues). Pure
 * predicates plus the bounded live gates the delivery pass runs before its
 * one external merge; the pass itself (`hosted-autonomy-delivery-pass.ts`)
 * owns the merge and the single state write.
 *
 * Nothing here relaxes the merge invariants: no merge without an authorizing
 * current-head review, only P0/P1 block, red or pending required CI never
 * merges, and a Gateway merge is made only when its release request provably
 * binds afterwards (so release bookkeeping can never be skipped or faked).
 */
import {
  BLOCKING_SEVERITIES,
  hasBlockingSeverity,
} from "../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type {
  ReviewReceiptV1,
  ReviewTaskStatementV1,
} from "../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  parseReleaseRequestV1,
  type ReleaseRequestV1,
} from "../src/contracts/release.ts";
import {
  isCarriedMergeMarker,
  latestPullReview,
  reviewedIdentity,
} from "../src/repair/carried-review.ts";
import { releaseRequestId } from "../src/repair/keys.ts";
import {
  releaseRequestMatchesDelivery,
  touchesProtected,
} from "../src/repair/loop-records.ts";
import { createLocalRepositoryConfig } from "../src/host/local-config.ts";
import { selectTrustedTargetPolicyV1 } from "../src/host/target-policy.ts";
import { reviewAuthorizesMerge } from "../src/repair/review-gate.ts";
import { advanceToDelivery } from "../src/repair/transitions.ts";
import {
  isDeliverableReviewRoundCeilingPark,
  ordinaryReviewRoundsSpent,
} from "../src/repair/review-round-cap.ts";
import {
  gatewayRequestBindsDelivery,
  isGatewayVpsRepository,
} from "../src/repair/vps-delivery.ts";
import {
  boundReviewReceipts,
  buildHostedReleaseRequest,
} from "./hosted-autonomy-delivery.ts";
import {
  deliveryEligible,
  HOSTED_AUTONOMY_SPENT_DELIVERY_BLOCKERS,
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  hostedIssueKey,
  isHostedSelf,
  sameRepository,
} from "./hosted-autonomy-policy.ts";
import {
  type HostedTreeChangeV1,
  sameTreeChanges,
  treeChangesDigest,
} from "./hosted-autonomy-github-trees.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyRecordV1,
} from "./hosted-autonomy-types.ts";
import type {
  HostedAutonomyPassContextV1,
  HostedAutonomyScopeV1,
} from "./hosted-autonomy-scopes.ts";

/**
 * Decision D3 (2026-10-16, launcher only), DISABLED: the coordinator chose
 * option (b) under owner decision (2) instead (docs/DECISIONS.md; the
 * runtime's carried refresh, `src/repair/loop-carried-delivery.ts`, and this
 * pass's carried merge, `carriedMergeGate`), because D3's merged result is
 * never CI-tested. D3 would merge a spent Gateway
 * record whose reviewed base B is a strict ancestor of the current base tip T
 * onto T (GitHub merges the exact reviewed head into the current tip) when
 * the pull is mergeable and T's own CI is complete and green. The merged
 * result T + head is never CI-tested: the head's green checks ran on
 * `refs/pull/N/merge` against B, possibly under an older workflow with fewer
 * jobs (live PR 1011: 2 of today's 4 jobs, 384 commits behind), and T's CI
 * covers T alone, so such a merge can turn `development` red for every other
 * PR. While false every record keeps the exact-base rule and a moved base is
 * `base_moved`. Before enabling it the gate must also require the head's
 * green check names to cover every check name on T, refuse a B...T drift
 * touching any file the PR changes or any dependency, lockfile or CI file,
 * and bound how far T is ahead of B.
 */
export const HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE = false;

/** Retired count throttle; retained for callers that import the policy. */
export const HOSTED_AUTONOMY_SPENT_READS_PER_PASS = Number.MAX_SAFE_INTEGER;

/**
 * True once the record's ordinary review rounds are spent, by the runtime's
 * own count over the durable ledger (`ordinaryReviewRoundsSpent`).
 */
export function reviewSpent(
  record: HostedAutonomyRecordV1,
  snapshot: Pick<RepairStateSnapshotV1, "reservations">,
): boolean {
  return ordinaryReviewRoundsSpent(snapshot, record);
}

/** True for the parked steps only the spent rule may deliver from. */
export function parkedStep(record: HostedAutonomyRecordV1): boolean {
  return record.nextStep === "work" || record.nextStep === "blocked";
}

/**
 * The closed spent-delivery shape: every review round spent, in `work`,
 * `blocked`, `review` (with no review in flight) or `delivery`, no open
 * operation intent, a PR, head and base, an issue source, no newer candidate
 * than the reviewed head (a preserved candidate must be exactly the reviewed
 * head and base, published), and when blocked one of the allowlisted
 * (kind, prefix) blockers. Task
 * acceptance, retired, hand-merged, preservation-unrecoverable, conflict,
 * release and budget blocks are all excluded.
 */
export function spentDeliveryAdmissible(
  record: HostedAutonomyRecordV1,
  snapshot: Pick<RepairStateSnapshotV1, "reservations">,
): boolean {
  if (
    record.nextStep !== "work" && record.nextStep !== "blocked" &&
    record.nextStep !== "review" && record.nextStep !== "delivery"
  ) return false;
  const { pr, head, base, candidateState } = record.target;
  if (
    !reviewSpent(record, snapshot) || record.intent !== null || pr === null ||
    head === null || base === null || record.source.kind !== "issue" ||
    record.related.issueNumber === null
  ) return false;
  if (candidateState !== undefined) {
    const preserved = candidateState.preserved;
    if (
      preserved === null || preserved.head !== head ||
      preserved.base !== base || candidateState.publishedHead !== head
    ) return false;
  }
  // A `review` record still waiting is waiting on a review in flight, whose
  // verdict would be the latest one: it is never merged ahead of it.
  if (record.nextStep === "review") return record.wait === null;
  if (record.nextStep !== "blocked") return true;
  // The runtime's REVIEWED and BASE_MOVED ceiling parks, by exact message.
  if (isDeliverableReviewRoundCeilingPark(record)) return true;
  const blocker = record.blocker;
  return blocker !== null &&
    HOSTED_AUTONOMY_SPENT_DELIVERY_BLOCKERS.some((allowed) =>
      allowed.kind === blocker.kind &&
      blocker.message.startsWith(allowed.prefix)
    );
}

/**
 * Every completed review of the exact (repository, PR, head, base) by the
 * fixed sentinel App reviewer, whatever its findings, latest last (by
 * `completedAt`, then `observedAt`, then id). It never authorizes anything
 * by itself.
 */
export function identityBoundReviews(
  reviews: readonly ReviewReceiptV1[],
  repository: RepositoryIdentityV1,
  pullRequest: number,
  head: string,
  base: string,
): ReviewReceiptV1[] {
  return reviews.filter((review) =>
    sameRepository(review.repository, repository) &&
    review.pullRequest.number === pullRequest &&
    review.pullRequest.head === head && review.pullRequest.base === base &&
    review.outcome === "completed" && review.resultId !== null &&
    review.completedAt !== null &&
    review.observedReviewer === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR &&
    review.expectedReviewer === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR
  ).sort((a, b) =>
    (a.completedAt ?? 0) - (b.completedAt ?? 0) ||
    a.observedAt - b.observedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * The receipt a release request names when the delivery pass merged a
 * refreshed head under a CARRIED review (`carriedMergeGate`): the exact receipt
 * and request ids the request records, a completed review of the same
 * repository and pull request by the fixed App reviewer, of a different head
 * than the request's merged one. Null for any other request.
 */
export function carriedRequestReceipt(
  reviews: readonly ReviewReceiptV1[],
  request: ReleaseRequestV1,
): ReviewReceiptV1 | null {
  const receiptId = request.source.reviewReceiptId;
  if (receiptId === null) return null;
  const receipt = reviews.find((review) =>
    review.id === receiptId &&
    review.requestId === request.source.reviewRequestId
  );
  return receipt !== undefined &&
      sameRepository(receipt.repository, request.target.repository) &&
      receipt.pullRequest.number === request.source.pullRequest &&
      receipt.pullRequest.head !== request.source.head &&
      receipt.outcome === "completed" && receipt.resultId !== null &&
      receipt.completedAt !== null &&
      receipt.observedReviewer === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR &&
      receipt.expectedReviewer === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR
    ? receipt
    : null;
}

/**
 * The delivery pass's action line for a record merged under a carried review
 * (in `delivery` beside its production release request): the reviewed
 * identity and receipt, the merged refreshed identity and the merged
 * revision. Both patch digests and the head's green CI runs are in that merge
 * commit's message and in the pass's own `carried_merge` line. Null for any
 * other record.
 */
export function carriedDeliveryAction(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests" | "reviews">,
  record: HostedAutonomyRecordV1,
): string | null {
  if (record.nextStep !== "delivery") return null;
  for (const request of snapshot.releaseRequests) {
    if (
      request.target.environment !== "production" ||
      !releaseRequestMatchesDelivery(request, record)
    ) continue;
    const receipt = carriedRequestReceipt(snapshot.reviews, request);
    if (receipt === null) continue;
    return `delivery:${record.id}:carried:pr=${request.source.pullRequest}:reviewed=${receipt.pullRequest.head}@${receipt.pullRequest.base}:receipt=${receipt.id}:merged=${request.source.head}@${request.source.base}:sha=${request.revision}`;
  }
  return null;
}

/** True when a review leaves uncounted findings or an unresolved P0. */
export function reviewBlocksMerge(review: ReviewReceiptV1): boolean {
  return review.findingsUncounted !== 0 ||
    hasBlockingSeverity(review.unresolvedSeverities) ||
    review.findings.some((finding) =>
      !finding.resolved && BLOCKING_SEVERITIES.includes(finding.severity)
    );
}

export type LatestReviewVerdictV1 =
  | { kind: "authorized"; receipt: ReviewReceiptV1 }
  /** The latest review leaves an unresolved P0/P1 or uncounted findings. */
  | { kind: "blocking" }
  /** No bound review, or the shared predicate refuses the latest one. */
  | { kind: "refused" };

/**
 * The merge decision of the LATEST completed current-head review: an earlier
 * clean review never outvotes a later P0/P1 on the same head and base. It
 * authorizes only through the shared predicate (fixed App reviewer, trusted
 * live task statement).
 */
export function latestAuthorizingReceipt(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
  task: ReviewTaskStatementV1 | null | "unavailable",
): LatestReviewVerdictV1 {
  const { pr, head, base } = record.target;
  if (pr === null || head === null || base === null) return { kind: "refused" };
  const latest = identityBoundReviews(
    snapshot.reviews,
    record.repository,
    pr,
    head,
    base,
  ).at(-1);
  if (latest === undefined) return { kind: "refused" };
  if (reviewBlocksMerge(latest)) return { kind: "blocking" };
  return reviewAuthorizesMerge(
      latest,
      record,
      HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
      task,
    )
    ? { kind: "authorized", receipt: latest }
    : { kind: "refused" };
}

/**
 * Required CI on the exact head: self `test-local`, foreign every check and,
 * when `base` names the commit the head is tested against, every check the
 * base's suites expect (a `needs:` job GitHub creates late, issue #154). An
 * unreadable read is not green.
 */
export async function headIsGreen(
  surface: HostedAutonomyGitHubV1,
  self: boolean,
  head: string,
  base?: string,
): Promise<boolean> {
  try {
    return self
      ? await surface.hasSuccessfulCheck(head)
      : await surface.hasAllChecksGreen(head, base) === true;
  } catch {
    return false;
  }
}

/** The record a spent Gateway merge writes: the runtime's own transition. */
export function spentDelivered(
  record: HostedAutonomyRecordV1,
  now: number,
): HostedAutonomyRecordV1 | null {
  try {
    return advanceToDelivery(record, now);
  } catch {
    return null;
  }
}

/**
 * The spent gates that need live reads, before any external effect: the
 * source issue must be definitively open, and a Gateway record's release
 * request must provably bind once the record is advanced (the runtime's own
 * `gatewayRequestBindsDelivery` over a provisional request at the reviewed
 * head), so a merge whose request could never be recorded is impossible.
 */
export async function spentMergeRefusal(
  context: HostedAutonomyPassContextV1,
  scope: HostedAutonomyScopeV1,
  record: HostedAutonomyRecordV1,
  receipt: ReviewReceiptV1,
  /** A carried merge: the request binds the carried receipt instead. */
  carried = false,
): Promise<"issue_not_open" | "request_unbindable" | "clock_invalid" | null> {
  const issueNumber = record.related.issueNumber;
  const { pr, head, base } = record.target;
  const surface = scope.surface;
  if (
    issueNumber === null || surface === null || pr === null ||
    head === null || base === null ||
    context.closedIssues.has(hostedIssueKey(record.repository, issueNumber))
  ) return "issue_not_open";
  let open: boolean | null = null;
  try {
    open = await surface.readIssueOpen(issueNumber);
  } catch {
    open = null;
  }
  if (open !== true) return "issue_not_open";
  if (!isGatewayVpsRepository(record.repository)) return null;
  const now = context.deps.clock.now();
  if (!Number.isSafeInteger(now) || now < context.snapshot.updatedAt) {
    return "clock_invalid";
  }
  const advanced = spentDelivered(record, now);
  const provisional = await buildHostedReleaseRequest(
    record.repository,
    head,
    head,
    base,
    pr,
    receipt,
    now,
  );
  return advanced !== null && provisional !== null &&
      await (carried
        ? carriedRequestBindsDelivery
        : gatewayRequestBindsDelivery)(
          provisional,
          advanced,
          receipt,
          head,
        )
    ? null
    : "request_unbindable";
}

/**
 * (a2) The moved-base gates that need no CI read, in order: the reviewed base
 * B is a strict ancestor of the tip T on the record's own repository, the
 * pull still records B as its base (so the post-merge evidence binds B), and
 * GitHub reports the pull mergeable (null is still being computed).
 */
export async function movedBaseRefusal(
  surface: HostedAutonomyGitHubV1,
  pull: HostedAutonomyPullV1,
  base: string,
  tip: string,
): Promise<"base_moved" | "mergeability_pending" | "merge_conflicted" | null> {
  if (tip === base || pull.baseSha !== base) return "base_moved";
  let advanced = false;
  try {
    advanced = await surface.baseAdvanced?.(base, tip) ?? false;
  } catch {
    advanced = false;
  }
  if (!advanced) return "base_moved";
  if (pull.mergeable === true) return null;
  return pull.mergeable === false ? "merge_conflicted" : "mergeability_pending";
}

/**
 * The crash window of a spent merge: the PR is already merged but its state
 * write was lost. Only the App's own verified merge of the exact reviewed
 * head, with green required CI on that head, is adopted; anything else
 * (a hand merge, an unverifiable merge, red CI) was merged outside the
 * trusted path and nothing is recorded for it.
 */
export async function adoptableSpentMerge(
  surface: HostedAutonomyGitHubV1,
  pull: HostedAutonomyPullV1,
  self: boolean,
  head: string,
): Promise<boolean> {
  return pull.mergedBy === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR &&
    await headIsGreen(surface, self, head);
}

/**
 * Every gate between the pull read and the external merge except the final
 * task re-read and opt-out, in order: the spent gates of a parked record; the
 * reviewed base (a moved base refuses `base_moved` unless the moved-base
 * rule is enabled, which it is not by default, and the spent Gateway record
 * passes it, which also runs the spent gates); the
 * foreign base ref; green required CI on the exact head; and, onto a moved
 * base, green complete CI on the tip itself (read once per repository per
 * pass through `tipGreen`). `spent` is true when the merge is made under the
 * spent rule, so the Gateway record is written with `advanceToDelivery`.
 */
/**
 * Issue #158 item 2: a launcher merge never lands a change to the target's
 * protected paths (the list runtime publication refuses). A change set that
 * cannot be resolved for the target fails closed.
 */
function touchesTargetProtected(
  repository: RepositoryIdentityV1,
  changes: readonly Pick<HostedTreeChangeV1, "path">[],
): boolean {
  try {
    const policy = selectTrustedTargetPolicyV1(
      createLocalRepositoryConfig(),
      repository,
    );
    return changes.some((change) =>
      touchesProtected(policy.protectedPaths, change.path)
    );
  } catch {
    return true;
  }
}

/**
 * The pull request's changed paths (a rename's previous path included)
 * checked against the target's protected paths. The production surface
 * always lists files; a fixture surface without that read skips the check.
 * A failed or incomplete listing refuses.
 */
async function protectedPathRefusal(
  surface: HostedAutonomyGitHubV1,
  repository: RepositoryIdentityV1,
  pull: number,
): Promise<"protected_path" | "protected_path_unverified" | null> {
  if (surface.listPullFiles === undefined) return null;
  let paths: readonly string[] | null = null;
  try {
    paths = await surface.listPullFiles(pull);
  } catch {
    paths = null;
  }
  if (paths === null) return "protected_path_unverified";
  return touchesTargetProtected(
      repository,
      paths.map((path) => ({ path })),
    )
    ? "protected_path"
    : null;
}

export async function preMergeGate(input: {
  context: HostedAutonomyPassContextV1;
  scope: HostedAutonomyScopeV1;
  record: HostedAutonomyRecordV1;
  receipt: ReviewReceiptV1;
  pull: HostedAutonomyPullV1;
  baseTip: string;
  tipGreen: Map<string, boolean>;
}): Promise<{ refusal: string | null; spent: boolean }> {
  const { context, scope, record, receipt, pull, baseTip } = input;
  const { head, base } = record.target;
  const surface = scope.surface;
  if (surface === null || head === null || base === null) {
    return { refusal: "surface_unreadable", spent: false };
  }
  const self = isHostedSelf(record.repository);
  const parked = parkedStep(record);
  const moved = baseTip !== base;
  if (parked || moved) {
    if (
      moved &&
      (!(context.deps.spentMovedBaseMerge ??
        HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE) ||
        !isGatewayVpsRepository(record.repository) ||
        !spentDeliveryAdmissible(record, context.snapshot))
    ) return { refusal: "base_moved", spent: false };
    const refusal = await spentMergeRefusal(context, scope, record, receipt);
    if (refusal !== null) return { refusal, spent: false };
  }
  if (moved) {
    const refusal = await movedBaseRefusal(surface, pull, base, baseTip);
    if (refusal !== null) return { refusal, spent: false };
  }
  // A foreign pull must target the exact branch its repository declares as
  // the delivered base; a mismatched base ref is never merged.
  if (!self && pull.baseRef !== scope.baseBranch) {
    return { refusal: "base_mismatch", spent: false };
  }
  // Red, pending or incomplete required CI on the exact head never merges:
  // every check the reviewed base's suites expect must exist on it.
  if (!await headIsGreen(surface, self, head, base)) {
    return { refusal: "checks_pending", spent: false };
  }
  if (moved) {
    // The tip the merge lands on must itself be complete and green, so a red
    // development is attributable to the last merge and moved-base merges
    // are serialised by the tip's own CI (the pass calls merge at most once
    // per repository).
    let green = input.tipGreen.get(scope.key);
    if (green === undefined) {
      green = await headIsGreen(surface, false, baseTip);
      input.tipGreen.set(scope.key, green);
    }
    if (!green) return { refusal: "base_ci_pending", spent: false };
  }
  // Last, so only a head about to merge pays for the file listing.
  const protectedRefusal = await protectedPathRefusal(
    surface,
    record.repository,
    pull.number,
  );
  if (protectedRefusal !== null) {
    return { refusal: protectedRefusal, spent: false };
  }
  return { refusal: null, spent: parked || moved };
}

/**
 * Every eligible spent record may be read on each pass. A record changed by
 * an earlier phase still waits for the next pass. CI, current-head review,
 * source identity and the one-merge-per-repository-per-pass gate remain
 * unchanged. With `onTip` (#156), a record with a review of its own head is
 * left out unless `onTip` holds for it (`spentOnTip`); a carried head on a
 * moved base keeps its own exemption.
 */
export function spentReadWindow(
  snapshot: RepairStateSnapshotV1,
  _now: number,
  settled?: ReadonlySet<string>,
  onTip?: (record: HostedAutonomyRecordV1) => boolean,
): Set<string> {
  return new Set(
    snapshot.work.filter((record) =>
      settled?.has(record.id) !== true &&
      deliveryEligible(record, snapshot) && parkedStep(record) &&
      spentDeliveryAdmissible(record, snapshot) &&
      ((boundReviewReceipts(snapshot, record).length > 0 &&
        onTip?.(record) !== false) ||
        (carriedRecordAwaited(record) &&
          carriedMergeReceipt(snapshot, record) !== null))
    ).map((record) => record.id),
  );
}

/**
 * True when the pass can still merge a spent record on `tip` (#156): its
 * reviewed base is that tip, read once for the pass (an unread tip admits it;
 * the pass reports the unreadable base), or the moved-base merge (D3)
 * applies to it. Otherwise `preMergeGate` can only refuse it `base_moved`.
 */
export function spentOnTip(
  record: HostedAutonomyRecordV1,
  tip: string | null,
  movedBaseMerge: boolean,
): boolean {
  return tip === null || record.target.base === tip ||
    (movedBaseMerge && isGatewayVpsRepository(record.repository));
}

// ---- carried merge (owner decision 2026-10-16 (2), option (b)) -----------
//
// The runtime refreshes a spent record's reviewed head H0 (on B0) onto the
// moved tip T mechanically and leaves the refreshed head H1 at `work` once its
// own CI is green (`src/repair/loop-carried-delivery.ts`). The runtime cannot
// merge it: its merge port requires enforced strict checks, and live
// ai.ubq.fi has no branch rules, so only this pass merges ai.ubq.fi (round-2
// recheck P1). Here H1 merges at exactly T under H0's completed review only
// while the runtime holds its exact carried-merge marker, when the pull
// request's patch is exactly the reviewed one (equal change sets of
// merge-base(B0, H0) -> H0 and T -> H1 by path, mode and full blob id, read
// from GitHub's Git trees), T is a strict ancestor of H1 and still the tip
// immediately before the merge (the merge result is H1's own tree, which its
// green CI tested; a merge commit whose parents are not exactly [T, H1] is
// never booked) and every ordinary spent gate holds.

/**
 * The carried merge candidate shape (pure; it authorizes nothing): a spent
 * record at `work` with nothing in flight, an issue source with a PR, head and
 * base, no completed review of its own head and base, whose LATEST completed
 * review of the pull request (any head, the fixed App reviewer) is of an
 * EARLIER head and leaves no unresolved P0/P1 and nothing uncounted. That
 * receipt, or null.
 */
export function carriedMergeReceipt(
  snapshot: Pick<RepairStateSnapshotV1, "reviews" | "reservations">,
  record: HostedAutonomyRecordV1,
): ReviewReceiptV1 | null {
  const { pr, head, base } = record.target;
  if (
    record.nextStep !== "work" || record.intent !== null ||
    record.source.kind !== "issue" || record.related.issueNumber === null ||
    pr === null || head === null || base === null ||
    !reviewSpent(record, snapshot) ||
    identityBoundReviews(snapshot.reviews, record.repository, pr, head, base)
        .length > 0
  ) return null;
  const latest = latestPullReview(
    snapshot,
    record,
    HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  );
  return latest !== null && latest.pullRequest.head !== head &&
      latest.resultId !== null && latest.completedAt !== null &&
      !reviewBlocksMerge(latest)
    ? latest
    : null;
}

/**
 * The runtime has proved a carried head and waits for this pass's merge: the
 * exact carried-merge marker at `work` (`isCarriedMergeMarker`), which only
 * the runtime's carried step writes, after its git proof, the head's green CI
 * and the task re-read (round-2 recheck P3: any `backoff` at `work` used to
 * count, the CI-first red-base hold of a model-written CI fix included). No
 * other state is ever merged.
 */
export function carriedMergeAwaited(record: HostedAutonomyRecordV1): boolean {
  return record.nextStep === "work" && isCarriedMergeMarker(record.wait);
}

/**
 * The runtime may wait on this pass: for its merge (`carriedMergeAwaited`),
 * or with any `unavailable` wait at `work` (#156). The runtime writes that
 * wait once the pull request merged, for the bookkeeping this pass adopts
 * only from its own verified merge and the exact proof, but also before any
 * merge (an unavailable patch proof or base ref, a pull request still
 * reporting the refreshed-from head), and the record carries no merged fact.
 * So the pass reads such a record's pull request first and nothing else
 * unless that pull request is merged (`carried_awaiting_runtime` otherwise).
 */
export function carriedRecordAwaited(record: HostedAutonomyRecordV1): boolean {
  return carriedMergeAwaited(record) ||
    (record.nextStep === "work" && record.wait?.reason === "unavailable");
}

/**
 * The carried merge's authorization: the carried receipt through the shared
 * predicate, as of the reviewed identity it binds (fixed App reviewer, the
 * trusted live task statement).
 */
export function carriedAuthorizingReceipt(
  snapshot: RepairStateSnapshotV1,
  record: HostedAutonomyRecordV1,
  task: ReviewTaskStatementV1 | null | "unavailable",
): LatestReviewVerdictV1 {
  const receipt = carriedMergeReceipt(snapshot, record);
  if (receipt === null) return { kind: "refused" };
  return reviewAuthorizesMerge(
      receipt,
      reviewedIdentity(record, receipt),
      HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
      task,
    )
    ? { kind: "authorized", receipt }
    : { kind: "refused" };
}

/**
 * A release request binds a carried delivery: the exact production request
 * of the advanced record (its refreshed head and tip, its merged revision,
 * the deterministic id) naming exactly the carried receipt, which leaves no
 * unresolved P0/P1 and accepted this record's own issue.
 */
export async function carriedRequestBindsDelivery(
  request: ReleaseRequestV1,
  record: HostedAutonomyRecordV1,
  receipt: ReviewReceiptV1,
  revision: string = request.revision,
): Promise<boolean> {
  try {
    const parsed = parseReleaseRequestV1(request);
    return (record.nextStep === "delivery" || record.nextStep === "review") &&
      record.repository.installationId > 0 &&
      releaseRequestMatchesDelivery(parsed, record) &&
      parsed.revision === revision &&
      parsed.id === await releaseRequestId(
          record.repository,
          parsed.revision,
          parsed.source.pullRequest,
        ) &&
      carriedRequestReceipt([receipt], parsed) === receipt &&
      !reviewBlocksMerge(receipt) &&
      (record.related.issueNumber === null ||
        receipt.taskAcceptance?.issueNumber === record.related.issueNumber);
  } catch {
    return false;
  }
}

/** The carried proof one pass derived, for the action line and commit. */
export interface CarriedMergeProofV1 {
  reviewedHead: string;
  reviewedBase: string;
  head: string;
  base: string;
  receipt: string;
  /** The merge base GitHub names for the reviewed side (`B0...H0`). */
  reviewedMergeBase: string;
  /** SHA-256 of the exact change set both sides share, and its size. */
  changes: string;
  paths: number;
  /** Rendered merge-base diff digests, evidence only (null: unrendered). */
  reviewedPatch: string | null;
  refreshedPatch: string | null;
  /** Completed successful workflow runs on the head (null: not listed). */
  runs: readonly number[] | null;
}

/** A receipt id as plain evidence text (no mention, reference or control). */
function plainId(id: string): string {
  return /^[A-Za-z0-9._:-]{1,256}$/.test(id) ? id : "unprintable";
}

/** A rendered diff digest as evidence text. */
function rendered(digest: string | null): string {
  return digest ?? "unrendered";
}

/** The pass's action line for one carried merge it is about to make. */
export function carriedMergeAction(
  record: HostedAutonomyRecordV1,
  proof: CarriedMergeProofV1,
): string {
  return `delivery:${record.id}:carried_merge:pr=${record.target.pr}:reviewed=${proof.reviewedHead}@${proof.reviewedBase}:receipt=${
    plainId(proof.receipt)
  }:refreshed=${proof.head}@${proof.base}:changes=${proof.changes}/${proof.paths}:patch=${
    rendered(proof.reviewedPatch)
  }/${rendered(proof.refreshedPatch)}:ci=${
    proof.runs === null ? "unlisted" : proof.runs.join(",") || "none"
  }`;
}

/** The carried merge's commit message: the whole proof, plain text only. */
export function carriedMergeEvidence(proof: CarriedMergeProofV1): string {
  return [
    "Sentinel carried review (owner decision 2026-10-16 (2), option b):",
    `reviewed head ${proof.reviewedHead} on base ${proof.reviewedBase}, review receipt ${
      plainId(proof.receipt)
    }`,
    `refreshed head ${proof.head} on base ${proof.base} (a strict ancestor of the head)`,
    `exact change set sha256 ${proof.changes} (${proof.paths} paths by path, mode and full blob id): ${proof.reviewedMergeBase}..${proof.reviewedHead} equals ${proof.base}..${proof.head}`,
    `merge-base diff sha256 ${proof.reviewedBase}...${proof.reviewedHead} ${
      rendered(proof.reviewedPatch)
    } (evidence only)`,
    `merge-base diff sha256 ${proof.base}...${proof.head} ${
      rendered(proof.refreshedPatch)
    } (evidence only)`,
    `required CI on ${proof.head}: every check run completed successfully; workflow runs ${
      proof.runs === null ? "unlisted" : proof.runs.join(", ") || "none"
    }`,
  ].join("\n");
}

/** One rendered diff digest for the evidence line; null when unrendered. */
async function renderedDigest(
  surface: HostedAutonomyGitHubV1,
  base: string,
  head: string,
): Promise<string | null> {
  try {
    const digest = await surface.comparePatchDigest?.(base, head) ?? null;
    return digest !== null && /^[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

/**
 * The exact patch proof (round-2 recheck P3): the full sets of (path, old
 * mode, old blob id, new mode, new blob id) of merge-base(B0, H0) -> H0 and
 * T -> H1 are equal, read from GitHub's Git trees (`mergeBaseTreeChanges`),
 * and T is the refreshed side's own merge base. GitHub's rendered diffs are
 * read only for the evidence line. A tree GitHub truncates, or any failed
 * read, is no proof.
 */
export async function carriedPatchRefusal(
  surface: HostedAutonomyGitHubV1,
  receipt: ReviewReceiptV1,
  head: string,
  base: string,
): Promise<
  | {
    refusal:
      | "carried_proof_unavailable"
      | "carried_patch_changed"
      | "carried_not_on_tip"
      | "protected_path";
  }
  | {
    refusal: null;
    reviewedMergeBase: string;
    changes: string;
    paths: number;
    reviewedPatch: string | null;
    refreshedPatch: string | null;
  }
> {
  if (surface.mergeBaseTreeChanges === undefined) {
    return { refusal: "carried_proof_unavailable" };
  }
  const reviewedBase = receipt.pullRequest.base;
  const reviewedHead = receipt.pullRequest.head;
  let reviewed = null;
  let refreshed = null;
  try {
    reviewed = await surface.mergeBaseTreeChanges(reviewedBase, reviewedHead);
    refreshed = reviewed === null
      ? null
      : await surface.mergeBaseTreeChanges(base, head);
  } catch {
    return { refusal: "carried_proof_unavailable" };
  }
  if (reviewed === null || refreshed === null) {
    return { refusal: "carried_proof_unavailable" };
  }
  if (refreshed.mergeBase !== base) return { refusal: "carried_not_on_tip" };
  if (!sameTreeChanges(reviewed.changes, refreshed.changes)) {
    return { refusal: "carried_patch_changed" };
  }
  if (touchesTargetProtected(receipt.repository, reviewed.changes)) {
    return { refusal: "protected_path" };
  }
  return {
    refusal: null,
    reviewedMergeBase: reviewed.mergeBase,
    changes: await treeChangesDigest(reviewed.changes),
    paths: reviewed.changes.length,
    reviewedPatch: await renderedDigest(surface, reviewedBase, reviewedHead),
    refreshedPatch: await renderedDigest(surface, base, head),
  };
}

/**
 * Every gate between the pull read and the carried merge except the final
 * task re-read, the opt-out and the uncached tip re-read the pass makes
 * immediately before the merge, in order: the pass's tip is exactly the
 * refreshed head's base T; the spent gates (the source issue open, a Gateway
 * request that will bind the carried receipt); the foreign base ref; green
 * required CI on the refreshed head itself, with every check T's suites
 * expect present; T a strict ancestor of that head
 * (so the merge result is the head's own CI-tested tree); and the exact patch
 * proof. Returns the proof (with the head's green workflow runs and the
 * rendered diff digests, read for evidence only) or the refusal. A carried
 * merge is made only for the self scope and the Gateway, whose bookkeeping
 * this pass writes.
 */
export async function carriedMergeGate(input: {
  context: HostedAutonomyPassContextV1;
  scope: HostedAutonomyScopeV1;
  record: HostedAutonomyRecordV1;
  receipt: ReviewReceiptV1;
  pull: HostedAutonomyPullV1;
  baseTip: string;
}): Promise<{ refusal: string | null; proof: CarriedMergeProofV1 | null }> {
  const { context, scope, record, receipt, pull, baseTip } = input;
  const { head, base } = record.target;
  const surface = scope.surface;
  if (surface === null || head === null || base === null) {
    return { refusal: "surface_unreadable", proof: null };
  }
  const self = isHostedSelf(record.repository);
  if (!self && !isGatewayVpsRepository(record.repository)) {
    return { refusal: "carried_unsupported", proof: null };
  }
  if (baseTip !== base) return { refusal: "carried_base_moved", proof: null };
  const spent = await spentMergeRefusal(context, scope, record, receipt, true);
  if (spent !== null) return { refusal: spent, proof: null };
  if (!self && pull.baseRef !== scope.baseBranch) {
    return { refusal: "base_mismatch", proof: null };
  }
  // H1 was tested against T: every check T's suites expect must exist on
  // it, so a `needs:` job not created yet never merges unrun.
  if (!await headIsGreen(surface, self, head, base)) {
    return { refusal: "checks_pending", proof: null };
  }
  let contained = false;
  try {
    contained = await surface.baseAdvanced?.(base, head) ?? false;
  } catch {
    contained = false;
  }
  if (!contained) return { refusal: "carried_not_on_tip", proof: null };
  const patch = await carriedPatchRefusal(surface, receipt, head, base);
  if (patch.refusal !== null) return { refusal: patch.refusal, proof: null };
  let runs: number[] | null = null;
  try {
    const listed = await surface.listHeadRuns?.(head) ?? null;
    runs = listed === null
      ? null
      : listed.filter((run) =>
        run.headSha === head && run.status === "completed" &&
        run.conclusion === "success"
      ).map((run) => run.id).sort((a, b) => a - b);
  } catch {
    runs = null;
  }
  return {
    refusal: null,
    proof: {
      reviewedHead: receipt.pullRequest.head,
      reviewedBase: receipt.pullRequest.base,
      head,
      base,
      receipt: receipt.id,
      reviewedMergeBase: patch.reviewedMergeBase,
      changes: patch.changes,
      paths: patch.paths,
      reviewedPatch: patch.reviewedPatch,
      refreshedPatch: patch.refreshedPatch,
      runs,
    },
  };
}
