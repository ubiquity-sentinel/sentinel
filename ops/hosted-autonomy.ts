/**
 * Bounded self-upkeep for the hosted supervisor, run FIRST inside the protected
 * maintenance job (before `prepare`, under the same `sentinel-repair` lock the
 * repair job holds), so its state changes are visible to that run's own
 * execution:
 *
 *  A CANDIDATE-REF REVALIDATION runs before any blocked work is selected for a
 *  retry grant. The runtime's ONE terminal diagnosis that the managed candidate
 *  branch ref matched neither the saved candidate head nor the recorded
 *  published head is re-read from the record's OWN repository surface; only a
 *  record whose saved descriptor, published head and canonical preservation ref
 *  all bind to that same repository, task and producing operation, and whose
 *  live branch ref reports exactly the original saved head, returns to `work`
 *  with only that blocker cleared. The pass returns immediately after that
 *  write, so a delivery or review decision is never made in the same run from a
 *  state the runtime has not yet reconciled; every other identity is untouched.
 *
 *  1. RETRY PASS — a work record blocked by one of the runtime's TRANSIENT
 *     failures (a model session that produced no trusted receipt or candidate,
 *     an exhausted attempt budget, exhausted review rounds, a review that
 *     produced no verdict within its bounded wait, or a review admission that
 *     was already settled at the current head) is granted the smallest closed
 *     counter adjustment that makes its next admission an UNUSED reservation
 *     identity; a work-returning grant must also land strictly below the
 *     runtime's own implementation-attempt ceiling, because admission at or
 *     above that ceiling is refused outright. A review-returning grant instead
 *     persists the review-round floor its own settled `review_request` charges
 *     prove — never zeroing or lowering a charged counter — and, once every
 *     review identity inside the runtime's round allowance is spent at that
 *     head, records the runtime's own base-refresh intent for a newer observed
 *     base, which is what supplies a new head and therefore fresh identities.
 *     When every identity at the record's current base is already charged, a
 *     work-returning grant uses that same base-refresh path, and a review
 *     intent is cleared only when its exact request reservation is proven
 *     settled. Each task may use at most `HOSTED_AUTONOMY_MAX_RETRIES` such
 *     grants, counted in the task's durable reservations (every purpose,
 *     including one still `reserved`), so no uncharged retry cycle exists and a
 *     task can never loop forever. Nothing is deleted or reset: the preserved
 *     `retries` counter, every charge, reservation, receipt, review and
 *     candidate stay exactly as they are, and only `attempts` is lowered by a
 *     work-returning grant.
 *
 *  2. DELIVERY PASS — a record whose exact reviewed head carries a completed
 *     review receipt that POSITIVELY accepts the record's own source issue,
 *     bound to the trusted live issue statement read immediately before the
 *     merge (the shared predicate of `src/repair/review-gate.ts`; a legacy
 *     quality-only receipt, a wrong-task digest, a not-fulfilled/uncertain or
 *     already-satisfied-base verdict never authorizes delivery) and a
 *     successful deterministic check is delivered end to
 *     end without an operator: the expected-head merge is performed with a
 *     compare-and-swap under the runtime's own criteria — necessary because
 *     this deployment's `development` ruleset carries no active `pull_request`
 *     rule, so the runtime's trusted merge port refuses by design — and then
 *     the exact release request the runtime's delivery step would have written
 *     is recorded for the trusted supervisor, which still owns prior/candidate
 *     proofs, promotion, acceptance and rollback. A record the runtime parked
 *     in `work`/`blocked` because its own correction predicate demanded a round
 *     it can no longer review is delivered from the same receipt: the review
 *     budget is spent, so no further verdict is reachable.
 *
 *  3. CLOSURE PASS — a SELF record whose exact pull request and reviewed head
 *     are delivered by an ACCEPTED hosted release is closed, exactly as before,
 *     and only while the same semantic receipt predicate still authorizes it
 *     against the trusted issue statement read immediately before the closure.
 *     A FOREIGN record is closed from its OWN merged pull request instead: the
 *     trusted release path is bound to the self scope by design, so sentinel
 *     holds no release authority for another repository and never fabricates a
 *     hosted release for one. Its closure requires the pull merged under a
 *     named merge commit with exactly two parents equal to the recorded base
 *     and head, the revision integrated into that repository's recorded base
 *     branch, and a completed authorizing receipt for the exact
 *     repository/PR/head/base.
 *
 * Every surface, base branch, deterministic check, issue identity and delivery
 * decision is resolved PER REPOSITORY: a record is read and written only under
 * its own repository identity, its own repository default branch supplies its
 * base branch, and one repository's issue number can never be confused with
 * another's. An unreadable surface, a missing default branch, a missing
 * check-run, an unreadable pull or any mismatched head/base/author fails
 * closed with an explicit bounded action and changes nothing.
 *
 * It writes no review, receipt, proof, promotion or acceptance, and it never
 * merges without a completed current-head receipt, a green deterministic check
 * and an unchanged recorded base.
 *
 * Runs only inside the protected `sentinel-supervisor` maintenance job at the
 * dispatched source commit.
 */
export {
  CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE,
  HOSTED_AUTONOMY_BASE_BRANCH,
  HOSTED_AUTONOMY_MAX_IMPLEMENTATION_ATTEMPTS,
  HOSTED_AUTONOMY_MAX_RETRIES,
  HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS,
  HOSTED_AUTONOMY_REQUIRED_CHECK,
  HOSTED_AUTONOMY_RETIRED,
  HOSTED_AUTONOMY_RETRYABLE,
  HOSTED_AUTONOMY_TRUSTED_APP_AUTHOR,
  HOSTED_AUTONOMY_TRUSTED_AUTHOR,
  HOSTED_AUTONOMY_TRUSTED_AUTHORS,
  hostedDeliveryKey,
  hostedIssueKey,
  hostedRepositoryKey,
  isDeferredCurrentMatrixHistoryBudget,
} from "./hosted-autonomy-policy.ts";
export {
  type HostedAutonomyDepsV1,
  type HostedAutonomyGitHubV1,
  type HostedAutonomyHeadPullV1,
  type HostedAutonomyPullV1,
  type HostedAutonomyReasonV1,
  type HostedAutonomyResultV1,
  type HostedSelfJobV1,
  type HostedSelfObservationV1,
  type HostedSelfRunV1,
  type MaintenanceFailureCategoryV1,
} from "./hosted-autonomy-types.ts";
export {
  createHostedClosedMatrixRecovery,
  createHostedHistoricalMatrixQuarantine,
} from "./hosted-autonomy-matrix-adapters.ts";
export { HOSTED_HISTORICAL_RELEASE_WITNESSES } from "./hosted-autonomy-matrix-bindings.ts";
export {
  applyHostedRetries,
  planHostedRetries,
  type RetryDenialV1,
  type RetryPlanV1,
} from "./hosted-autonomy-retries.ts";
export {
  applyBaseRefreshReadmissions,
  BASE_REFRESH_AUTH_BLOCKERS,
  type BaseRefreshCandidateV1,
  type BaseRefreshReadmissionV1,
  decideBaseRefreshReadmission,
  planBaseRefreshReadmissions,
} from "./hosted-autonomy-base-refresh-retries.ts";
export { buildHostedReleaseRequest } from "./hosted-autonomy-delivery.ts";
export {
  applyHostedClosures,
  applyHostedRetirements,
  type HostedClosurePlanV1,
  planHostedClosures,
  planHostedRetirements,
} from "./hosted-autonomy-closures.ts";
export { runSelfObservationPass } from "./hosted-autonomy-observation.ts";
export { runHostedAutonomy } from "./hosted-autonomy-runner.ts";
export {
  parseHostedAutonomyHeadPulls,
  parseHostedAutonomyPull,
  revisionIntegratedIntoBase,
} from "./hosted-autonomy-github-pull.ts";
export { createHostedAutonomyGitHub } from "./hosted-autonomy-github.ts";
export { runHostedAutonomyMain } from "./hosted-autonomy-main.ts";
export { isHardAutonomyFailure } from "./hosted-autonomy-state.ts";

import { runHostedAutonomyMain } from "./hosted-autonomy-main.ts";

if (import.meta.main) {
  Deno.exitCode = await runHostedAutonomyMain();
}
