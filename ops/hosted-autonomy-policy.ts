import { HISTORICAL_NOT_STARTED_DETAIL } from "../src/host/matrix-quarantine-state.ts";
import { CI_UNATTRIBUTED_DETAIL } from "../src/repair/ci-rejection.ts";
import { ATTEMPT_DETAIL_NO_CHANGE } from "../src/repair/attempt-policy.ts";
import {
  isDeliverableReviewRoundCeilingPark,
  isReviewRoundCeilingPark,
  MAX_REVIEW_ROUNDS,
  ordinaryReviewRoundsSpent,
} from "../src/repair/review-round-cap.ts";
import type { BudgetReservationV1 } from "../src/contracts/budget-reservation.ts";
import type { RepositoryIdentityV1 } from "../src/contracts/shared.ts";
import {
  HOSTED_CONTROLLER_DEPLOYMENT,
  HOSTED_CONTROLLER_SELF,
} from "../src/contracts/hosted-controller-deployment.ts";
import type { HostedAutonomyRecordV1 } from "./hosted-autonomy-types.ts";

/**
 * The one hosted self scope: the no-App owner credential identity that owns
 * this repository, its `development` base branch, its named deterministic
 * check and the trusted release path. Every other identity is a foreign target
 * and is handled entirely under its OWN repository surface.
 */
export const HOSTED_AUTONOMY_SELF_SCOPE: RepositoryIdentityV1 =
  HOSTED_CONTROLLER_SELF;

/** True only for the sentinel self scope, the one identity with named checks. */
export function isHostedSelf(repository: RepositoryIdentityV1): boolean {
  return repository.installationId ===
      HOSTED_AUTONOMY_SELF_SCOPE.installationId &&
    repository.owner === HOSTED_AUTONOMY_SELF_SCOPE.owner &&
    repository.name === HOSTED_AUTONOMY_SELF_SCOPE.name;
}

/** Exact repository identity equality, installation scope included. */
export function sameRepository(
  left: RepositoryIdentityV1,
  right: RepositoryIdentityV1,
): boolean {
  return left.installationId === right.installationId &&
    left.owner === right.owner && left.name === right.name;
}

/**
 * Stable repository scope key. This is the separator that makes every planning
 * identity repository-scoped: two repositories may both have an issue 120 and
 * they must never be confused.
 */
export function hostedRepositoryKey(
  repository: RepositoryIdentityV1,
): string {
  return `${repository.installationId}:${repository.owner}/${repository.name}`;
}

/** One issue identity: the pair (repository, issue number), never a number. */
export function hostedIssueKey(
  repository: RepositoryIdentityV1,
  issueNumber: number,
): string {
  return `${hostedRepositoryKey(repository)}#${issueNumber}`;
}

/** One delivery identity: repository, pull request, head and base. */
export function hostedDeliveryKey(
  repository: RepositoryIdentityV1,
  pullRequest: number,
  head: string,
  base: string,
): string {
  return `${hostedRepositoryKey(repository)}:${pullRequest}:${head}:${base}`;
}

/**
 * Coarse delivery eligibility, used for the CI-run approval and the self tip
 * read. The ordinary path is the runtime's own `review` and `delivery` steps.
 * A record parked in `work` or `blocked` is also a candidate once it has
 * spent every review round (owner decision 2026-10-16: three rounds, hard).
 * The runtime itself already advances a review with only P2/P3 findings to
 * `delivery` (only P0/P1 block), so a parked spent record is one whose rounds
 * ran out on P0/P1 corrections or on its CI. Whether such a record actually
 * merges is decided by `spentDeliveryAdmissible` and the latest-review rule
 * in `hosted-autonomy-spent-delivery.ts`; no other parked step is delivered.
 * "Spent" is the runtime's own count over the durable ledger
 * (`ordinaryReviewRoundsSpent`): a counter lagging its charges still counts
 * them, a proven refund frees its round, and a legacy record's one
 * final round (for a CI-fixed head) is extra. Of the runtime's ceiling parks
 * only REVIEWED and BASE_MOVED are ever delivered; a park with no completed
 * review, an unresolved P0/P1 or no task acceptance never reaches a merge
 * gate.
 */
export function deliveryEligible(
  record: HostedAutonomyRecordV1,
  snapshot: { readonly reservations: readonly BudgetReservationV1[] },
): boolean {
  if (record.nextStep === "review" || record.nextStep === "delivery") {
    return true;
  }
  if (record.nextStep !== "work" && record.nextStep !== "blocked") {
    return false;
  }
  if (
    isReviewRoundCeilingPark(record) &&
    !isDeliverableReviewRoundCeilingPark(record)
  ) return false;
  return ordinaryReviewRoundsSpent(snapshot, record);
}

/**
 * The closed set of blockers a spent-round `blocked` record may be merged
 * from, as exact (kind, message prefix) pairs: the runtime's merge-gate CI
 * failure and its unattributed CI block (merged only once the exact head is
 * green again) and the retired "review rounds exhausted" quota block. Every
 * other blocker (task acceptance, retired, merged outside the trusted path,
 * preservation unrecoverable, conflicts, release, attempt budget) is never
 * merged by the spent rule.
 */
export const HOSTED_AUTONOMY_SPENT_DELIVERY_BLOCKERS: readonly {
  readonly kind: string;
  readonly prefix: string;
}[] = [
  { kind: "other", prefix: "CI checks failed: " },
  { kind: "other", prefix: "CI checks failed without base evidence: " },
  {
    kind: "review_quota",
    prefix: "review rounds exhausted without an accepted verdict (",
  },
];

/** The base branch every reviewed candidate must be integrated into. */
export const HOSTED_AUTONOMY_BASE_BRANCH =
  HOSTED_CONTROLLER_DEPLOYMENT.sourceBranch;

/** The deterministic check the merge requires on the exact reviewed head. */
export const HOSTED_AUTONOMY_REQUIRED_CHECK = "test-local";

/** Retired reservation ceiling, retained only for exported API compatibility.
 * Reservation history stays charged and is never an admission throttle.
 */
export const HOSTED_AUTONOMY_MAX_RETRIES = 200;

/** Retired implementation ceiling, retained only for exported API compatibility. */
export const HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS = 4;

/**
 * The runtime's own hard review-round ceiling (`MAX_REVIEW_ROUNDS`, owner
 * decision 2026-10-16). A record that has spent every review round can never
 * turn another correction into a reviewed verdict, so the only remaining
 * delivery path is the receipt it already holds. The runtime's CI correction
 * ceiling (`CI_CORRECTION_REVIEW_ROUNDS`) is pinned equal by test. A record's
 * own allowance (the durable ledger and the one-time legacy round) comes from
 * `reviewRoundsLeft`.
 */
export const HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS = MAX_REVIEW_ROUNDS;

/**
 * Static blocker message for a record whose source issue no longer exists. It
 * deliberately matches none of the retryable prefixes, so the retry pass never
 * revives it.
 */
export const HOSTED_AUTONOMY_RETIRED =
  "source issue is closed; the repair no longer exists";

/**
 * The trusted publication identity of autonomously repaired pull requests
 * before the App migration. Kept as the single legacy login for callers that
 * still name it.
 */
export const HOSTED_AUTONOMY_TRUSTED_AUTHOR = "github-actions[bot]";
/** The sentinel App bot identity that now authors repaired pull requests. */
export const HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR = "ubiquity-sentinel[bot]";
/**
 * The same fixed sentinel App identity (App 4682172, bot user 319834869) is
 * the ONLY reviewer that may authorize issue-backed delivery at the persisted
 * receipt boundary: `authorizingReceipt` pins
 * `HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR` as the receipt's exact reviewer, so a
 * self-consistent receipt naming any other reviewer never authorizes. Legacy
 * receipts keep parsing; they simply refuse as new authorization.
 */
/**
 * Bounded transition set: a pull request published by a runtime at an older
 * installed revision is authored by `github-actions[bot]`, one published after
 * this migration by `ubiquity-sentinel[bot]`. This dual acceptance is a scoped
 * transition rule; remove the old login after the first app-authored delivery
 * is observed.
 */
export const HOSTED_AUTONOMY_TRUSTED_AUTHORS: readonly string[] = [
  HOSTED_AUTONOMY_TRUSTED_AUTHOR,
  "ubiquity-sentinel[bot]",
];

/**
 * Age after which a blocked implementation's producing evidence can no longer
 * arrive. Matrix plan and cell artifacts are uploaded with `retention-days: 7`
 * (supervisor.yml), so after eight days no late result can be imported for the
 * retained admission and its uncertainty can never be resolved by evidence.
 */
export const HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS = 8 * 24 * 60 * 60 * 1000;

/** The runtime's merge-gate CI blocker on a reviewed head (`decideCiGate`). */
export const HOSTED_AUTONOMY_CI_FAILED_PREFIX = "CI checks failed: ";

/**
 * The CI-correction runtime's terminal block for a failed head check that no
 * base observation attributes (`unattributedDetail`). It deliberately does
 * not start with `HOSTED_AUTONOMY_CI_FAILED_PREFIX`.
 */
export const HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX =
  `${CI_UNATTRIBUTED_DETAIL}: `;

/**
 * Blocker prefix the preservation disposition writes once a parked candidate
 * is proven unrecoverable (ops/hosted-autonomy-preservation-disposition.ts).
 * The consumed admission stays charged; only a fresh, separately charged
 * admission can continue the open task.
 */
export const PRESERVATION_UNRECOVERABLE_PREFIX =
  "candidate preservation unrecoverable";

/**
 * The exact transient blockers the retry pass may clear, with the step the
 * record returns to. A blocker outside this closed set is never touched.
 *
 * The two review classes are the runtime's own transient review outcomes: a
 * review whose durable admission was settled while its operation intent was
 * lost (re-entry on the same identity is the runtime's terminal "settled
 * without an intent" contradiction), and the legacy bounded no-verdict review
 * wait. Both return to `review`, where the runtime rehydrates its standing
 * review before any new charge and continues inside its own round allowance.
 *
 * Base-refresh TERMINAL blocks are deliberately absent from this prefix
 * table. A deterministic conflict ("base refresh has conflicts[ at <base>]")
 * is never re-admitted here: only its own exact rule in
 * `hosted-autonomy-conflict-retries.ts` may return it, once, to a proven
 * conflict-resolution runtime (inert while that allowlist is empty), and a
 * charged resolution's marker refuses every class of this table while its
 * settled charge names the still-current base tip (`conflictMarkerVerdict`
 * in `planHostedRetries`). The exact per-job credential-expiry messages ("base
 * refresh failed 3 consecutive times: auth_failed ...") need the owned open
 * PR and published head verified on the exact branch and a target-specific
 * transition, so they have their own exact rule in
 * `hosted-autonomy-base-refresh-retries.ts` under the same charged-identity and
 * closed-issue gates.
 */
export const HOSTED_AUTONOMY_RETRYABLE: readonly {
  readonly prefix: string;
  readonly nextStep: "work" | "review" | "delivery";
  /**
   * Minimum age of the retained admission's evidence before a grant, measured
   * from the creation of the exact charge the intent names (the blocker's own
   * `since` only when no intent is retained). Set only for uncertain outcomes
   * whose evidence must first be provably expired; `evidenceExpired` also
   * requires an unproduced record and a settled-ambiguous implementation
   * charge.
   */
  readonly minBlockedMs?: number;
}[] = [
  {
    prefix: "model run ended without a trusted receipt",
    nextStep: "work",
  },
  {
    // A cell whose model run failed on infrastructure ("model run failed
    // (unavailable)", "(bundle)", ...) is the runtime's own transient class:
    // the durable attempt memory bounds equivalent outcomes and owns the
    // six-hour decay window. Without this entry the classified transient
    // decay could never fire, because the record stayed blocked forever
    // (twelve such records had been parked since 2026-10-04).
    prefix: "model run failed (",
    nextStep: "work",
  },
  {
    // A cell that never started because the run's own session window closed
    // ("past the model cutoff or no longer fits the run bounds") proves
    // nothing about the task: the next run has a fresh window. Five records
    // were parked on this scheduling refusal since 2026-10-05.
    prefix:
      "implementation start is past the model cutoff or no longer fits the run bounds",
    nextStep: "work",
  },
  {
    prefix: "model run did not complete with a trusted candidate",
    nextStep: "work",
  },
  {
    // A completed session that left its checkout unchanged (the runtime's own
    // no-progress class, ai.ubq.fi 300's real outcome). It gets the ordinary
    // work grant; the repeat-failure bound
    // (`hosted-autonomy-repeat-failure.ts`) parks it for the owner after
    // `REPEAT_FAILURE_PARK_THRESHOLD` identical outcomes.
    prefix: ATTEMPT_DETAIL_NO_CHANGE,
    nextStep: "work",
  },
  {
    // A truthfully proven historical not-started admission is resolved
    // uncertainty, not a model outcome: the existing retry authority still
    // owns whether a fresh eligible start follows, under its own attempt
    // ceiling, durable reservation identity, source and closed-issue gates.
    prefix: HISTORICAL_NOT_STARTED_DETAIL,
    nextStep: "work",
  },
  {
    prefix: "implementation attempt budget exhausted",
    nextStep: "work",
  },
  {
    prefix: "review rounds exhausted without an accepted verdict",
    nextStep: "review",
  },
  {
    prefix: "review produced no verdict within the bounded review wait",
    nextStep: "review",
  },
  {
    prefix: "review admission already settled without an intent",
    nextStep: "review",
  },
  {
    prefix: "model admission refused: duplicate",
    nextStep: "work",
  },
  {
    // An uncertain implementation outcome stays charged (its admission is
    // already settled ambiguous, which intentClosable requires) and is never
    // refunded. Once its matrix evidence is past retention no late result can
    // be imported for it, so the open task gets a fresh, separately charged
    // admission instead of staying parked forever. This covers both the
    // runtime's own uncertainty detail and the matrix ingester's
    // "original admission retained without usable artifact evidence" form.
    prefix: "implementation outcome uncertain",
    nextStep: "work",
    minBlockedMs: HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS,
  },
  {
    // A historical matrix manifest that authenticated but was rejected for
    // ordering (for example reservation_after_manifest) leaves the model
    // outcome uncertain in exactly the same way.
    prefix: "authenticated historical matrix manifest rejected:",
    nextStep: "work",
    minBlockedMs: HOSTED_AUTONOMY_EVIDENCE_EXPIRY_MS,
  },
  {
    // A reviewed head parked on its merge-gate CI failure by a runtime that
    // predates CI attribution. The grant only returns it to `delivery`; the
    // installed runtime re-observes the head and its reviewed base and owns
    // the outcome (correction round, red-base wait or terminal block). It is
    // inert unless the authenticated installed runtime is an allowlisted
    // generation-78+ CI-correction revision holding its own healthy proof
    // (`ciCorrectionRuntimeProven`), until the head's once-per-head flake
    // re-run can no longer act, beyond the per-pass correction cap, and for
    // any shape but the exact reviewed, unreleased publication with a review
    // round left (`ciRedeliveryEligible`) — except for a head whose CI the
    // retry pass read as all green again on its unchanged reviewed base (a
    // re-run flake), which re-admits under any runtime and any spent round
    // count (`ciGreenRedeliveryEligible`).
    prefix: HOSTED_AUTONOMY_CI_FAILED_PREFIX,
    nextStep: "delivery",
  },
  {
    // The CI-correction runtime's own unattributed block. Only the green-head
    // rule re-admits it (a re-run flake now green on its unchanged reviewed
    // base); it is never a correction, which would only block it again.
    prefix: HOSTED_AUTONOMY_CI_UNATTRIBUTED_PREFIX,
    nextStep: "delivery",
  },
  {
    // Written only by the preservation disposition after native proof that
    // the parked candidate can never be preserved; the record then holds no
    // candidate, intent or descriptor, and its consumed charge stays charged.
    prefix: PRESERVATION_UNRECOVERABLE_PREFIX,
    nextStep: "work",
  },
];

/**
 * Exact bounded message the current-matrix history walk throws when its scan
 * budget is exhausted. The walk itself stays fail-closed (nothing is written
 * after the bound); the hosted entry point classifies this exact availability
 * condition as a deferred, non-fatal result so one oversized history walk can
 * never fail the maintenance job and skip prepare, matrix_plan and delivery.
 */
export const CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE =
  "current matrix history deadline exhausted";

/** True when a thrown autonomy error is that bounded availability condition. */
export function isDeferredCurrentMatrixHistoryBudget(error: unknown): boolean {
  return error instanceof Error &&
    error.message === CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE;
}
