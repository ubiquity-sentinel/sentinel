/**
 * Re-admission of a reviewed head that a pre-correction runtime parked on its
 * merge-gate CI failure ("CI checks failed: ..."). The grant only returns the
 * record to `delivery` with its blocker cleared; it writes no CI evidence and
 * decides nothing about the failure. The installed runtime's own CI gate then
 * re-observes the exact head and its reviewed base: a candidate-caused failure
 * opens a correction round while rounds remain, a red base defers without
 * spending one, and a broken head on a moved base is corrected before any
 * refresh. Charges, counters and the publication identity are untouched.
 *
 * The rule is inert unless the AUTHENTICATED installed runtime is an exact
 * allowlisted CI-correction revision at generation 77 or later that holds its
 * own healthy proof for that exact pointer. Under any other runtime a
 * re-admitted head would only be re-gated and blocked again (or, under a
 * rolled-back generation 76, refreshed and re-reviewed).
 */
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import { ciCorrectable } from "../src/repair/ci-rejection.ts";
import {
  HOSTED_AUTONOMY_CI_FAILED_PREFIX,
  sameRepository,
} from "./hosted-autonomy-policy.ts";

/** First runtime generation whose repair loop carries the CI correction route. */
export const HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION = 77;

/**
 * Exact reviewed runtime revisions that carry the CI correction route. It
 * never names 74/75/76, and it stays EMPTY while a hosted run keeps that route
 * closed (`HOSTED_CI_CORRECTIONS`, false in generation 77 because its rollback
 * target 76 refuses the correction cell): under such a runtime a re-admitted
 * head is only blocked again. The first runtime that opens it is pinned here.
 */
export const HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES: ReadonlySet<string> =
  new Set<string>([]);

/**
 * True only for an allowlisted CI-correction runtime at generation 77+ whose
 * own settled healthy proof binds this exact revision and generation. A
 * missing, failed or foreign proof never activates the rule.
 */
export function ciCorrectionRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  allowlist: ReadonlySet<string> = HOSTED_AUTONOMY_CI_CORRECTION_RUNTIMES,
): boolean {
  if (runtime === null || runtime === undefined) return false;
  const proof = runtime.lastHealthyProof;
  return allowlist.has(runtime.activeRevision) &&
    Number.isSafeInteger(runtime.generation) &&
    runtime.generation >= HOSTED_AUTONOMY_CI_CORRECTION_MIN_GENERATION &&
    proof !== null && proof.outcome === "healthy" && proof.settled === true &&
    proof.startupReady === true &&
    proof.execution.revision === runtime.activeRevision &&
    proof.execution.generation === runtime.generation;
}

type WorkRow = RepairStateSnapshotV1["work"][number];

/**
 * True only for the exact legacy shape the runtime's merge gate leaves: an
 * issue task blocked on its own reviewed, still-published head with no
 * operation in flight, a review round left and no release request. The caller
 * checks the installed runtime first (`ciCorrectionRuntimeProven`).
 *
 * The record shape is the runtime's own `ciCorrectable` predicate (issue task,
 * exact publication, a durably described candidate, no operation in flight
 * and fewer than `CI_CORRECTION_REVIEW_ROUNDS` review rounds), never a copy:
 * a head the runtime cannot correct is blocked again by its merge gate at
 * once, so re-admitting it would only churn on every pass.
 */
export function ciRedeliveryEligible(
  snapshot: RepairStateSnapshotV1,
  record: WorkRow,
): boolean {
  const blocker = record.blocker;
  if (
    blocker === null || blocker.kind !== "other" ||
    !blocker.message.startsWith(HOSTED_AUTONOMY_CI_FAILED_PREFIX)
  ) return false;
  if (record.related.issueNumber === null || !ciCorrectable(record)) {
    return false;
  }
  const { head, pr, base } = record.target;
  // The gate that failed ran after review authorization: the exact head must
  // hold its completed, non-rejecting review against this base.
  const reviewed = snapshot.reviews.some((review) =>
    sameRepository(review.repository, record.repository) &&
    review.pullRequest.number === pr && review.pullRequest.head === head &&
    review.pullRequest.base === base && review.outcome === "completed" &&
    !review.unresolvedSeverities.some((s) => s === "P0" || s === "P1")
  );
  if (!reviewed) return false;
  // A release-phase CI block belongs to an already merged delivery.
  return !snapshot.releaseRequests.some((request) =>
    sameRepository(request.target.repository, record.repository) &&
    request.source.pullRequest === pr && request.source.head === head
  );
}
