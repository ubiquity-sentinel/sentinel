/** Repair loop internals: review records. */
import { hasBlockingSeverity } from "../contracts/review-receipt.ts";
import type { ReviewObservationV1 } from "../contracts/ports.ts";
import type { ReviewReceiptV1 } from "../contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../contracts/work-record.ts";
import { ciCorrectionShape } from "./ci-rejection.ts";
import { isCiFixMarker } from "./ci-first-policy.ts";
import {
  latestCompletedReview,
  type LegacyCutoff,
} from "./review-round-cap.ts";
import { isAcceptanceFinding } from "./acceptance-correction.ts";
import {
  releaseRequestMatchesDelivery,
  sameRepositoryIdentity,
} from "./loop-records.ts";

/**
 * A completed review receipt with unresolved P0/P1 findings bound to the
 * record's CURRENT reviewed head means that head is rejected: the work step
 * must run a fresh bounded implementation and validate the NEW candidate
 * through the replay path before any publication. The rejected candidate is
 * never re-published and never re-reviewed (the frozen contract keeps a
 * head alongside a published PR, so the rejection is read from durable
 * evidence, not from a cleared field).
 */
export function rejectedReceipt(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): ReviewReceiptV1 | null {
  const head = record.target.head;
  const pr = record.target.pr;
  if (head === null || pr === null) return null;
  const receipt = snapshot.reviews.find(
    (review) =>
      review.pullRequest.number === pr &&
      review.pullRequest.head === head &&
      review.outcome === "completed",
  );
  if (receipt !== undefined && hasBlockingFindings(receipt)) return receipt;
  // JAM B6: the LATEST completed verdict of the head rejects it as well when
  // it is a not-fulfilled acceptance (its normalized P1). The
  // missing-acceptance recovery re-reviews the SAME head, so that head's
  // earlier change-only receipt may be listed first; read alone it would make
  // the rejected head look like one awaiting a CI correction, whose green exit
  // returns it to `review`, whose re-observation corrects it again, without
  // end. Every other verdict keeps the first-listed rule above unchanged.
  const latest = latestCompletedReview(snapshot, record);
  return latest !== null && latest.findings.some(isAcceptanceFinding)
    ? latest
    : null;
}

/**
 * Only unresolved P0/P1 findings reject a head, exactly as the merge gate
 * decides: unresolved P2/P3 findings never block delivery, so they must not
 * spend a correction round either.
 */
export function hasBlockingFindings(
  receipt: Pick<ReviewReceiptV1, "unresolvedSeverities">,
): boolean {
  return hasBlockingSeverity(receipt.unresolvedSeverities);
}

export function headRejectedByReview(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): boolean {
  return rejectedReceipt(snapshot, record) !== null;
}

/**
 * A completed review that refused nothing binds this exact PR/head/base: the
 * head was authorized as reviewed against the record's current base.
 */
export function headAcceptedByReview(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): boolean {
  return snapshot.reviews.some((review) =>
    sameRepositoryIdentity(review.repository, record.repository) &&
    review.pullRequest.number === record.target.pr &&
    review.pullRequest.head === record.target.head &&
    review.pullRequest.base === record.target.base &&
    review.outcome === "completed" && !hasBlockingFindings(review)
  );
}

/**
 * An issue task's head is reviewed clean on its base by a change-only
 * verdict: some completed review refusing nothing on this exact PR/head/base
 * carries no task acceptance. The merge gate refuses such a verdict with a
 * run-level `TASK_ACCEPTANCE_MISSING_DETAIL` state_error whenever it is the
 * receipt it selects, so a head carrying one is returned to `review`, never
 * to delivery: there the standing review is re-observed and either delivers
 * the head (its current verdict is task-bound) or requests the task-bound
 * review through the CI-first gate (the missing-acceptance recovery).
 */
export function headTaskAcceptanceMissing(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): boolean {
  if (record.related.issueNumber === null) return false;
  return snapshot.reviews.some((review) =>
    sameRepositoryIdentity(review.repository, record.repository) &&
    review.pullRequest.number === record.target.pr &&
    review.pullRequest.head === record.target.head &&
    review.pullRequest.base === record.target.base &&
    review.outcome === "completed" && !hasBlockingFindings(review) &&
    (review.taskAcceptance ?? null) === null
  );
}

/**
 * Snapshot-only shape of a reviewed head the delivery gate returned to `work`
 * for a CI correction: an accepted, unreleased head on its reviewed base with
 * a review round left. Nothing persisted names the CI failure (generation 76
 * could not parse it), so this shape only makes the record ELIGIBLE: the
 * correction itself starts only after the attribution is re-derived from live
 * check runs (`confirmCiCorrection`), and anything else returns the head to
 * the delivery gate that owns it.
 */
export function headAwaitsCiCorrection(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  /** `ciCorrectionRouteOpen(deps)`: a closed route awaits nothing. */
  ciRouteOpen = true,
  /** The legacy cutoff this run evaluates under (`review-round-cap.ts`). */
  cutoff?: LegacyCutoff,
): boolean {
  return ciRouteOpen && record.nextStep === "work" &&
    ciCorrectionShape(record, snapshot, cutoff) &&
    !headRejectedByReview(snapshot, record) &&
    headAcceptedByReview(snapshot, record) &&
    !snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, record)
    );
}

/**
 * A completed review of any outcome binds this record's exact PR/head.
 */
export function headReviewCompleted(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
): boolean {
  return snapshot.reviews.some((review) =>
    sameRepositoryIdentity(review.repository, record.repository) &&
    review.pullRequest.number === record.target.pr &&
    review.pullRequest.head === record.target.head &&
    review.outcome === "completed"
  );
}

/**
 * Snapshot-only shape of a red, never-reviewed head the CI-first review gate
 * returned to `work` for its CI fix (`loop-ci-first.ts`): the zero-length
 * `backoff` marker on an unreleased, published issue head no completed review
 * binds, with a CI fix and a review round left. Like the reviewed-head
 * correction, it only makes the record ELIGIBLE: the fix starts only after the
 * failure is re-derived from live check runs (`confirmPreReviewCiFix`), and
 * anything else clears the marker uncharged.
 */
export function headAwaitsPreReviewCiFix(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  /** `preReviewCiFixRouteOpen(deps)`: a closed route awaits nothing. */
  routeOpen = false,
  cutoff?: LegacyCutoff,
): boolean {
  const candidateState = record.target.candidateState;
  return routeOpen && record.nextStep === "work" &&
    isCiFixMarker(record.wait) &&
    ciCorrectionShape(record, snapshot, cutoff) &&
    (candidateState === undefined ||
      candidateState.publishedHead === record.target.head) &&
    !headReviewCompleted(snapshot, record) &&
    !snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, record)
    );
}

/**
 * The record's current head must be corrected, never re-published or
 * re-reviewed: a completed review rejected it with an unresolved P0/P1, it is
 * a reviewed head awaiting its live-verified CI correction, or it is a red,
 * never-reviewed head awaiting its live-verified CI fix.
 */
export function headNeedsCorrection(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  /** `ciCorrectionRouteOpen(deps)`: closed, only a review rejection counts. */
  ciRouteOpen = true,
  /** `preReviewCiFixRouteOpen(deps)`: closed, no pre-review fix counts. */
  preReviewRouteOpen = false,
  /** The legacy cutoff this run evaluates under (`review-round-cap.ts`). */
  cutoff?: LegacyCutoff,
): boolean {
  return headRejectedByReview(snapshot, record) ||
    headAwaitsCiCorrection(snapshot, record, ciRouteOpen, cutoff) ||
    headAwaitsPreReviewCiFix(snapshot, record, preReviewRouteOpen, cutoff);
}

/** Bounded batch of the exact unresolved findings a correction must resolve. */
export const MAX_CORRECTION_FINDINGS = 8;

/** Bound of one finding message carried into the correction prompt. */
export const MAX_CORRECTION_FINDING_CHARS = 2_000;

/** Bound of earlier rejection receipts folded into one correction prompt. */
export const MAX_CORRECTION_HISTORY_RECEIPTS = 3;

export function correctionFindings(
  snapshot: RepairStateSnapshotV1,
  record: WorkRecordV1,
  /** The live-verified CI finding of this exact head, never persisted. */
  ciFinding: { severity: string; path: string | null; message: string } | null =
    null,
): { severity: string; path: string | null; message: string }[] | null {
  const current = rejectedReceipt(snapshot, record);
  if (current === null && ciFinding === null) return null;
  // The rejection of this exact candidate FIRST (its live CI failure, then its
  // review), then the unresolved findings of the most recent earlier
  // rejections of the SAME pull request: one receipt is not enough evidence
  // when the task has been refused several times for different cases of the
  // same rule, which is exactly how a correction converges on the rule
  // instead of the last reported case. A CI correction of a head no review
  // rejected carries no history: a later review ACCEPTED that head, which
  // superseded every earlier rejection of the pull request, so only the live
  // CI failure is the correction's to resolve.
  const history = current === null ? [] : snapshot.reviews
    .filter((review) =>
      review.pullRequest.number === current.pullRequest.number &&
      review.outcome === "completed" &&
      hasBlockingFindings(review) &&
      review.id !== current.id
    )
    .sort((a, b) => b.observedAt - a.observedAt)
    .slice(0, MAX_CORRECTION_HISTORY_RECEIPTS);
  const seen = new Set<string>();
  const findings: { severity: string; path: string | null; message: string }[] =
    ciFinding === null ? [] : [ciFinding];
  for (const review of current === null ? [] : [current, ...history]) {
    for (const finding of review.findings) {
      if (finding.resolved) continue;
      const message = finding.message.slice(0, MAX_CORRECTION_FINDING_CHARS);
      const key = `${finding.severity}\u0000${
        finding.path ?? ""
      }\u0000${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        severity: finding.severity,
        path: finding.path,
        message,
      });
      if (findings.length >= MAX_CORRECTION_FINDINGS) {
        return findings;
      }
    }
  }
  return findings.length === 0 ? null : findings;
}

/**
 * Review round of the request this record is waiting on. Round one is the
 * original identity; every later round is its own attempt.
 */
export function standingReviewAttempt(record: WorkRecordV1): number {
  const rounds = record.counters.reviewRounds;
  return rounds >= 1 ? rounds : 1;
}

/**
 * True only when the transport bound NO durable record to the asked identity:
 * no journal base, no terminal instant and no reviewer. A bound record that is
 * merely not terminal yet carries its own base, so it is never mistaken for an
 * absent one.
 */
export function isUnboundReviewObservation(
  value: ReviewObservationV1,
): boolean {
  return value.status === "unavailable" && value.completedAt === null &&
    value.observedBase === null && value.reviewer === null;
}

/** Preserve the exact request timestamp across durable review waits. */
export function reviewWaitSince(
  record: WorkRecordV1,
  fallback: number,
): number {
  if (
    record.wait?.reason === "review_pending" ||
    record.wait?.reason === "review_quota" ||
    record.wait?.reason === "unavailable"
  ) return record.wait.since;
  if (record.intent?.kind === "review_request") {
    return record.intent.startedAt;
  }
  return Math.min(record.updatedAt, fallback);
}

/**
 * Submission instant recorded on one settled review receipt.
 *
 * The loop normally knows the transport's OWN reported submission instant from
 * the pending wait, and that exact value is preserved. A bounded recovery can
 * clear the wait, however, and the record's remaining instants then POST-DATE a
 * completion that already happened; the strict receipt parser refuses such an
 * inversion (live deadlock: the round-10 review was re-armed forever and never
 * recorded). The derived instant is therefore capped at the observed completion,
 * so the receipt can never invert while the transport's own value stands
 * whenever it is still available.
 */
export function reviewSubmittedAt(
  record: WorkRecordV1,
  observedCompletedAt: number | null,
  fallback: number,
): number {
  const derived = reviewWaitSince(record, fallback);
  return observedCompletedAt === null
    ? derived
    : Math.min(derived, observedCompletedAt);
}
