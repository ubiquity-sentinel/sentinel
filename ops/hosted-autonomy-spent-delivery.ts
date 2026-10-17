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
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type {
  ReviewReceiptV1,
  ReviewTaskStatementV1,
} from "../src/contracts/review-receipt.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
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
 * Decision D3 (2026-10-16, launcher only), DISABLED until the owner signs it
 * off: a spent Gateway record whose reviewed base B is a strict ancestor of
 * the current base tip T would merge onto T (GitHub merges the exact reviewed
 * head into the current tip) when the pull is mergeable and T's own CI is
 * complete and green. The merged result T + head is never CI-tested: the
 * head's green checks ran on `refs/pull/N/merge` against B, possibly under an
 * older workflow with fewer jobs (live PR 1011: 2 of today's 4 jobs, 384
 * commits behind), and T's CI covers T alone, so such a merge can turn
 * `development` red for every other PR. While false every record keeps the
 * exact-base rule and a moved base is `base_moved`. Before enabling it the
 * gate must also require the head's green check names to cover every check
 * name on T, refuse a B...T drift touching any file the PR changes or any
 * dependency, lockfile or CI file, and bound how far T is ahead of B.
 */
export const HOSTED_AUTONOMY_SPENT_MOVED_BASE_MERGE = false;

/** Spent-round records that need live reads, per delivery pass. */
export const HOSTED_AUTONOMY_SPENT_READS_PER_PASS = 8;

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

/** True when a review leaves uncounted findings or an unresolved P0/P1. */
export function reviewBlocksMerge(review: ReviewReceiptV1): boolean {
  return review.findingsUncounted !== 0 ||
    review.unresolvedSeverities.some((s) => s === "P0" || s === "P1") ||
    review.findings.some((finding) =>
      !finding.resolved &&
      (finding.severity === "P0" || finding.severity === "P1")
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

/** Required CI on the exact head: self `test-local`, foreign every check. */
export async function headIsGreen(
  surface: HostedAutonomyGitHubV1,
  self: boolean,
  head: string,
): Promise<boolean> {
  try {
    return self
      ? await surface.hasSuccessfulCheck(head)
      : await surface.hasAllChecksGreen(head);
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
      await gatewayRequestBindsDelivery(provisional, advanced, receipt, head)
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
  verified: boolean,
): Promise<boolean> {
  return pull.mergedBy === HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR && verified &&
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
  // Red or pending required CI on the exact head never merges.
  if (!await headIsGreen(surface, self, head)) {
    return { refusal: "checks_pending", spent: false };
  }
  if (moved) {
    // The tip the merge lands on must itself be complete and green, so a red
    // development is attributable to the last merge and moved-base merges
    // are serialised by the tip's own CI (the pass calls merge at most once).
    let green = input.tipGreen.get(scope.key);
    if (green === undefined) {
      green = await headIsGreen(surface, false, baseTip);
      input.tipGreen.set(scope.key, green);
    }
    if (!green) return { refusal: "base_ci_pending", spent: false };
  }
  return { refusal: null, spent: parked || moved };
}

/**
 * The parked spent-round records this pass may read live: the pure spent
 * shape with at least one bound clean receipt first (no read), then at most
 * `HOSTED_AUTONOMY_SPENT_READS_PER_PASS` of them, starting at an offset that
 * advances every five minutes so no record is starved by the ones ordered
 * before it. A record an earlier write of this pass settled (`settled`, see
 * hosted-autonomy-continuation.ts) is left to the next pass and takes no slot.
 */
export function spentReadWindow(
  snapshot: RepairStateSnapshotV1,
  now: number,
  settled?: ReadonlySet<string>,
): Set<string> {
  const ids = snapshot.work.filter((record) =>
    settled?.has(record.id) !== true &&
    deliveryEligible(record, snapshot) && parkedStep(record) &&
    spentDeliveryAdmissible(record, snapshot) &&
    boundReviewReceipts(snapshot, record).length > 0
  ).map((record) => record.id);
  if (ids.length <= HOSTED_AUTONOMY_SPENT_READS_PER_PASS) return new Set(ids);
  const offset = Number.isSafeInteger(now) && now >= 0
    ? Math.floor(now / 300_000) % ids.length
    : 0;
  return new Set(
    [...ids.slice(offset), ...ids.slice(0, offset)].slice(
      0,
      HOSTED_AUTONOMY_SPENT_READS_PER_PASS,
    ),
  );
}
