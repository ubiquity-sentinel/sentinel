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
 * - re-run (L2): a head parked by the pre-review gate (red, pending, or with
 *   its CI fixes exhausted on a head no review has completed on) shares the
 *   once-per-head flake re-run (`hosted-autonomy-ci-rerun.ts`);
 * - green (L3): a pre-review park whose exact head is green again on its
 *   unchanged base returns to `work` under ANY runtime (the runtime's gate
 *   then requests the review; R79 would request it too), the exhausted park
 *   included;
 * - moved base (L3, generation 81): a red or pending pre-review park whose
 *   base moved returns to `work` under a proven CI-first runtime (R80
 *   included) with a review round left: the runtime refreshes it
 *   deterministically and uncharged and gates the refreshed head's CI before
 *   any review. The unchanged-base condition stays only on the green rule,
 *   which serves any runtime;
 * - fix (L3): a red pre-review park returns to `work` with the CI fix marker
 *   only under an exact allowlisted runtime whose hosted pre-review fix route
 *   is open (`HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES`, generation 81+), once
 *   its re-run can no longer act, with a CI fix and a review round left;
 * - legacy (E): the existing CI correction re-admission of a record whose
 *   rounds are spent (the one-time legacy final review) runs only under an
 *   exact allowlisted CI-first runtime (`HOSTED_AUTONOMY_CI_FIRST_RUNTIMES`):
 *   under R79 the refreshed head would be reviewed while still red;
 * - no fix and no moved-base refresh ever matches the exhausted park (L4:
 *   the runtime's own `ciCorrectable` counts the CI fixes);
 * - a legacy record's one final review round is handed to the
 *   runtime by NO re-admission except under a proven CI-first runtime
 *   (`legacyFinalRoundAdmissible`).
 */
import type { HostedRuntimeRecordV1 } from "../src/contracts/hosted-supervisor.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../src/contracts/state-snapshots.ts";
import {
  CI_FIX_EXHAUSTED_PREFIX,
  CI_PRE_REVIEW_PARK_PREFIXES,
  ciFixesLeft,
  reviewRoundAvailable,
} from "../src/repair/ci-first-policy.ts";
import { headReviewCompleted } from "../src/repair/loop-review-records.ts";
import { ciPublicationShape } from "../src/repair/ci-rejection.ts";
import { releaseRequestMatchesDelivery } from "../src/repair/loop-records.ts";
import { ordinaryReviewRoundsSpent } from "../src/repair/review-round-cap.ts";
import { ciCorrectionRuntimeProven } from "./hosted-autonomy-ci-retries.ts";
import { legacyReviewCutoffForRuntime } from "../src/host/legacy-review-cutoff-env.ts";
import { HOSTED_RUNTIME_ROLLOUT } from "../src/host/hosted-runtime-rollout.ts";

type WorkRow = RepairStateSnapshotV1["work"][number];

/** First runtime generation that carries the CI-first review gate. */
export const HOSTED_AUTONOMY_CI_FIRST_MIN_GENERATION = 80;

/**
 * First generation installed by the self-install path.  A runtime at this
 * generation or later is not represented by a historical rollout row; its
 * exact revision and healthy proof are the identity.  The known pre-CI-first
 * revisions remain excluded so a manual or accidental old-runtime restore can
 * never open the gate.
 */
export const HOSTED_AUTONOMY_CI_FIRST_SELF_INSTALLED_MIN_GENERATION = 82;

const PRE_CI_FIRST_REVISIONS: ReadonlySet<string> = new Set([
  "41bb853a1bedfc0422bf903dfabbe23bf714b44f", // R76
  "ab3613e0224ff92266bed21dde6f40e6b0aab54a", // R77
  "474f87eb639f97cd72b9bc4b9e56101488f841aa", // R78
  "549c7a69186b3d2070aa4e69c92ee846d183ce8f", // R79
]);

/**
 * Exact reviewed runtime revisions that carry the CI-first gate (generation
 * 80+), each named by the launcher commit that pins its install. A listed
 * revision counts only once it holds its own healthy proof at its installed
 * generation (`ciFirstRuntimeProven`): the legacy re-admission is inert under
 * any other runtime, R79 restored at any generation included.
 */
export const HOSTED_AUTONOMY_CI_FIRST_RUNTIMES: ReadonlySet<string> = new Set<
  string
>([
  ...HOSTED_RUNTIME_ROLLOUT.ciFirst,
  // Generation 80 (R80), pinned by its launcher commit.
  "e48e7e110e7cb2ed3385bf1be5165f05d8a4e481",
  // Generation 81 (R81), pinned by its launcher commit.
  "da98f5f49c45b57cfa97a45fe647c36b1021f302",
]);

/**
 * First runtime generation whose HOSTED runs open the pre-review CI fix route
 * (`HOSTED_PRE_REVIEW_CI_FIXES`): generation 80 kept it closed because its
 * rollback target R79 refused the cell; generation 81's rollback target R80
 * isolates it.
 */
export const HOSTED_AUTONOMY_CI_FIRST_FIX_MIN_GENERATION = 81;

/**
 * Exact reviewed runtime revisions whose hosted runs open the pre-review CI
 * fix route (`HOSTED_PRE_REVIEW_CI_FIXES` true in that revision's own tree,
 * which a test proves for every listed revision present locally), each named
 * by the launcher commit that pins its install. Generation 81's pin commit
 * lists its runtime here, and in `HOSTED_AUTONOMY_CI_FIRST_RUNTIMES` and the
 * CI-correction allowlist: a fix runtime counts only as a proven CI-first
 * runtime at generation 81+ (`ciFirstFixRuntimeProven`). R80 never belongs
 * here (its hosted route is closed), so a rollback re-admits no fix.
 */
export const HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES: ReadonlySet<string> =
  new Set<string>([
    ...HOSTED_RUNTIME_ROLLOUT.ciFirstFix,
    "da98f5f49c45b57cfa97a45fe647c36b1021f302",
  ]);

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

/**
 * True for the exact self-installed runtime at generation 82+ when its own
 * settled healthy proof binds that exact revision and generation.  Historical
 * exact allowlists remain the source of truth for generation 80/81 and for
 * any rollback target; this predicate only covers the post-R81 self-install
 * era, whose runtime identity is necessarily newer than the committed data
 * that reads it.
 */
export function ciFirstSelfInstalledRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
): boolean {
  return runtime !== null && runtime !== undefined &&
    runtime.generation >=
      HOSTED_AUTONOMY_CI_FIRST_SELF_INSTALLED_MIN_GENERATION &&
    !PRE_CI_FIRST_REVISIONS.has(runtime.activeRevision) &&
    ciCorrectionRuntimeProven(runtime, new Set([runtime.activeRevision]));
}

/** Self-install counterpart of `ciFirstFixRuntimeProven`. */
export function ciFirstFixSelfInstalledRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
): boolean {
  return runtime !== null && runtime !== undefined &&
    runtime.generation >= HOSTED_AUTONOMY_CI_FIRST_FIX_MIN_GENERATION &&
    ciFirstSelfInstalledRuntimeProven(runtime);
}

/**
 * True only for an allowlisted fix runtime (`fixAllowlist`) at generation
 * 81+ that is also a proven CI-first runtime (`ciFirstAllowlist`), with its
 * own settled healthy proof binding this exact revision and generation.
 */
export function ciFirstFixRuntimeProven(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  fixAllowlist: ReadonlySet<string> = HOSTED_AUTONOMY_CI_FIRST_FIX_RUNTIMES,
  ciFirstAllowlist: ReadonlySet<string> = HOSTED_AUTONOMY_CI_FIRST_RUNTIMES,
): boolean {
  return runtime !== null && runtime !== undefined &&
    runtime.generation >= HOSTED_AUTONOMY_CI_FIRST_FIX_MIN_GENERATION &&
    ciFirstRuntimeProven(runtime, fixAllowlist) &&
    ciFirstRuntimeProven(runtime, ciFirstAllowlist);
}

/** Denial reason of a legacy final round withheld from a non-CI-first runtime. */
export const LEGACY_ROUND_REQUIRES_CI_FIRST = "legacy_round_requires_ci_first";

/**
 * Whether a re-admission may hand the runtime a record whose next review
 * would be a legacy record's one final round (every ordinary round
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

/**
 * Parked by the runtime's pre-review CI gate on its published head, red or
 * pending past bound (`prefixes`): the parks every pre-review rule takes.
 */
export function preReviewCiParked(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests">,
  record: WorkRow,
  prefixes: readonly string[] = CI_PRE_REVIEW_PARK_PREFIXES,
): boolean {
  const blocker = record.blocker;
  return record.nextStep === "blocked" && record.intent === null &&
    blocker !== null && blocker.kind === "other" &&
    prefixes.some((prefix) => blocker.message.startsWith(prefix)) &&
    record.related.issueNumber !== null && ciPublicationShape(record) &&
    publishedHead(snapshot, record);
}

/**
 * The pre-review gate's exhausted park (generation 81): three CI fixes
 * spent, on a published head no completed review binds. Only the
 * once-per-head re-run and the green rule take it, never a fix or a
 * moved-base refresh. The merge gate writes the same message for a REVIEWED
 * head, whose green head belongs to delivery, not to another review: that
 * park keeps generation 80's terms (nothing re-admits it).
 */
export function preReviewCiExhausted(
  snapshot: RepairStateSnapshotV1,
  record: WorkRow,
): boolean {
  return preReviewCiParked(snapshot, record, [CI_FIX_EXHAUSTED_PREFIX]) &&
    !headReviewCompleted(snapshot, record);
}

/**
 * Any park the pre-review gate wrote that the once-per-head re-run and the
 * green rule take: red, pending, or exhausted on a never-reviewed head.
 */
export function preReviewGateParked(
  snapshot: RepairStateSnapshotV1,
  record: WorkRow,
): boolean {
  return preReviewCiParked(snapshot, record) ||
    preReviewCiExhausted(snapshot, record);
}

/** A pre-review park a CI fix may still be admitted for. */
export function preReviewFixEligible(
  snapshot: Pick<RepairStateSnapshotV1, "releaseRequests" | "reservations">,
  record: WorkRow,
  cutoff?: number | null,
): boolean {
  return preReviewCiParked(snapshot, record) && ciFixesLeft(record) &&
    reviewRoundAvailable(snapshot, record, cutoff);
}

/**
 * The legacy review cutoff the launcher's own round counts use: the one
 * pinned cutoff (`legacyReviewCutoffForRuntime`, checked against release
 * custody when the caller has it), only under a proven CI-first runtime
 * (every legacy re-admission needs one); otherwise null, and no record is
 * legacy.
 */
export function launcherLegacyCutoff(
  runtime: HostedRuntimeRecordV1 | null | undefined,
  ciFirst: boolean,
  release?: ReleaseStateSnapshotV1 | null,
): number | null {
  return ciFirst ? legacyReviewCutoffForRuntime(runtime, release) : null;
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
