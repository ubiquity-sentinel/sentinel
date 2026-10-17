/**
 * Launcher half of the CI-first pipeline (owner decision 2026-10-16, "CI
 * first, then review, then merge"). The runtime's pre-review gate
 * (`src/repair/loop-ci-first.ts`) waits for a head's CI at `work` and parks a
 * head that stays red or pending; this module decides only what the launcher
 * may do about those states. It charges, refunds and decides nothing about a
 * failure, and every rule is a pure predicate over the authenticated state:
 *
 * - approval (L1): a bot-pushed head's CI run that GitHub holds for approval
 *   is approved while the record waits at `work` on its published head or is
 *   parked by the pre-review gate, not only in review or delivery;
 * - re-run (L2): a head parked red before review shares the once-per-head
 *   flake re-run (`hosted-autonomy-ci-rerun.ts`);
 * - green (L3): a pre-review park whose exact head is green again on its
 *   unchanged base returns to `work` under ANY runtime (the runtime's gate
 *   then requests the review; R79 would request it too);
 * - fix (L3): a red pre-review park returns to `work` with the CI fix marker
 *   only under an exact allowlisted runtime whose hosted pre-review fix route
 *   is open (`HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`, empty in generation 80),
 *   once its re-run can no longer act, with a CI fix and a review round left;
 * - legacy (E): the existing CI correction re-admission of a record whose
 *   rounds are spent (the one-time legacy final review) runs only under an
 *   exact allowlisted CI-first runtime (`HOSTED_AUTONOMY_CI_FIRST_RUNTIMES`):
 *   under R79 the refreshed head would be reviewed while still red;
 * - nothing ever matches the exhausted park (L4: the runtime's own
 *   `ciCorrectable` counts the CI fixes);
 * - a listed legacy record's one final review round is handed to the
 *   runtime by NO re-admission except under a proven CI-first runtime
 *   (`legacyFinalRoundAdmissible`).
 */
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import type { RepairStateSnapshotV1 } from "../src/contracts/state-snapshots.ts";
import {
  CI_PRE_REVIEW_PARK_PREFIXES,
  ciFixesLeft,
  reviewRoundAvailable,
} from "../src/repair/ci-first-policy.ts";
import { ciPublicationShape } from "../src/repair/ci-rejection.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import { ordinaryReviewRoundsSpent } from "../src/repair/review-round-cap.ts";
import { ciCorrectionRuntimeProven } from "./hosted-autonomy-ci-retries.ts";

type WorkRow = RepairStateSnapshotV1["work"][number];

/** First runtime generation that carries the CI-first review gate. */
export const HOSTED_AUTONOMY_CI_FIRST_MIN_GENERATION = 80;

/**
 * Exact reviewed runtime revisions that carry the CI-first gate (generation
 * 80+). Empty until R80 is installed and pinned: the legacy re-admission is
 * inert under any other runtime.
 */
export const HOSTED_AUTONOMY_CI_FIRST_RUNTIMES: ReadonlySet<string> = new Set<
  string
>([]);

/**
 * Exact reviewed runtime revisions whose hosted runs open the pre-review CI
 * fix route (`HOSTED_PRE_REVIEW_CI_FIXES` true in that revision's tree).
 * Generation 80 keeps that route closed (its rollback target R79 refuses the
 * cell), so this stays empty until a later generation opens it.
 */
export const HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES: ReadonlySet<string> =
  new Set<string>([]);

/**
 * True only for an allowlisted CI-first runtime at generation 80+ whose own
 * settled healthy proof binds this exact revision and generation.
 */
export function ciFirstRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  allowlist: ReadonlySet<string> = HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
): boolean {
  return runtime !== null && runtime !== undefined &&
    runtime.generation >= HOSTED_AUTONOMY_CI_FIRST_MIN_GENERATION &&
    ciCorrectionRuntimeProven(runtime, allowlist);
}

/** Denial reason of a legacy final round withheld from a non-CI-first runtime. */
export const LEGACY_ROUND_REQUIRES_CI_FIRST = "legacy_round_requires_ci_first";

/**
 * Whether a re-admission may hand the runtime a record whose next review
 * would be a listed legacy record's one final round (every ordinary round
 * spent, `ordinaryReviewRoundsSpent`; the ceiling's pin + 1 leaves exactly one
 * more, `reviewRoundsLeft`). Owner decision 2026-10-16: that review is
 * exactly ONE, current-head and on the green head, and only a proven CI-first
 * runtime (`ciFirstRuntimeProven`) reviews a head only once its CI is green;
 * R79, the rollback target, reviews before CI, so under it the round would be
 * spent on a red head. Every re-admission that can lead to that review asks
 * this first: the retry table's work, review and conflict re-pend grants, the
 * pre-review CI-first returns, the CI correction's legacy rule, the
 * base-refresh, conflict and refresh re-arm re-admissions. A record with an
 * ordinary round left always passes; one with no round at all is refused
 * earlier by `reviewRoundsLeft`.
 */
export function legacyFinalRoundAdmissible(
  snapshot: Pick<RepairStateSnapshotV1, "reservations">,
  record: WorkRow,
  ciFirst: boolean,
): boolean {
  return ciFirst || !ordinaryReviewRoundsSpent(snapshot, record);
}

/** The record's exact published, unreleased head (any task or review). */
function publishedHead(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests">,
  record: WorkRow,
): boolean {
  const { head, pr, branch, base, candidateState } = record.target;
  return head !== null && pr !== null && branch !== null && head !== base &&
    (candidateState === undefined ||
      (candidateState.preserved !== null &&
        candidateState.publishedHead === head)) &&
    !snapshot.releaseRequests.some((request) =>
      releaseRequestMatchesDelivery(request, record)
    );
}

/** Parked by the runtime's pre-review CI gate (red or pending past bound). */
export function preReviewCiParked(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests">,
  record: WorkRow,
): boolean {
  const blocker = record.blocker;
  return record.nextStep === "blocked" && record.intent === null &&
    blocker !== null && blocker.kind === "other" &&
    CI_PRE_REVIEW_PARK_PREFIXES.some((prefix) =>
      blocker.message.startsWith(prefix)
    ) &&
    record.related.issueNumber !== null && ciPublicationShape(record) &&
    publishedHead(snapshot, record);
}

/** A pre-review park a CI fix may still be admitted for. */
export function preReviewFixEligible(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests" | "reservations">,
  record: WorkRow,
): boolean {
  return preReviewCiParked(snapshot, record) && ciFixesLeft(record) &&
    reviewRoundAvailable(snapshot, record);
}

/**
 * L1: a record whose bot-pushed head may have a CI run held for approval
 * while it waits for (or was parked by) its pre-review CI: at `work` with no
 * operation in flight on its published head, or parked by the pre-review
 * gate. Approval only lets the repository's own deterministic check run.
 */
export function ciFirstApprovalEligible(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests">,
  record: WorkRow,
): boolean {
  if (record.nextStep === "work") {
    return record.intent === null && publishedHead(snapshot, record);
  }
  return preReviewCiParked(snapshot, record);
}
