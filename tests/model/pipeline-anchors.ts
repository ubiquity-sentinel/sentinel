/**
 * The source anchors of every modeled lifecycle transition (`pipeline.ts`):
 * the exact code text each transition was transcribed from.
 */
import { anchor } from "./anchors.ts";

export const A = {
  grant: anchor(
    "p.grant",
    "src/host/matrix-planner.ts",
    "isMatrixImplementationReadyV1",
  ),
  ceilingWork: anchor(
    "p.ceilingWork",
    "src/repair/loop-work.ts",
    "return parkAtReviewRoundCeiling(deps, context, record);",
  ),
  manual: anchor(
    "p.manual",
    "src/repair/loop-implementation.ts",
    `{ reason: "manual", since: now, until: null },`,
  ),
  ingest: anchor(
    "p.ingest",
    "src/host/matrix-ingest.ts",
    `"matrix cell produced no trusted receipt";`,
  ),
  preserve: anchor(
    "p.preserve",
    "src/repair/loop-work.ts",
    "return executeCandidatePreservation(deps, context, record);",
  ),
  ciFirst: anchor(
    "p.ciFirst",
    "src/repair/loop-review-request.ts",
    "const gated = await gateReviewOnCi(deps, context, record);",
  ),
  preReviewBound: anchor(
    "p.preReviewBound",
    "src/repair/loop-ci-first.ts",
    "now - since >= PRE_REVIEW_CI_BOUND_MS &&",
  ),
  preReviewBaseRed: anchor(
    "p.preReviewBaseRed",
    "src/repair/loop-ci-first.ts",
    "until: deps.clock.now() + RED_BASE_RECHECK_MS,",
  ),
  closedRepublish: anchor(
    "p.closedRepublish",
    "src/repair/loop-review-observation.ts",
    `clearIntent(retireClosedPublication(record, now, "work"), now),`,
  ),
  ctxWait: anchor(
    "p.ctxWait",
    "src/repair/loop-review-result.ts",
    `if (task === "unavailable") {`,
  ),
  correction: anchor(
    "p.correction",
    "src/repair/loop-review-result.ts",
    "? advanceToCorrection(clearIntent(withEvidence, now), now)",
  ),
  acceptanceCorrection: anchor(
    "p.acceptanceCorrection",
    "src/repair/loop-review-result.ts",
    "if (refusal === TASK_ACCEPTANCE_NOT_FULFILLED_DETAIL) {",
  ),
  releaseDeferred: anchor(
    "p.releaseDeferred",
    "src/repair/loop-release.ts",
    "return deferRelease(deps, context, record, now);",
  ),
  rejectedPark: anchor(
    "p.rejectedPark",
    "src/repair/loop-review-result.ts",
    "if (unresolved && reviewRoundsSpentOut(context, record)) {",
  ),
  deliveryCiPending: anchor(
    "p.deliveryCiPending",
    "src/repair/loop-checks.ts",
    `reason: "ci_pending",`,
  ),
  deliveryBaseRed: anchor(
    "p.deliveryBaseRed",
    "src/repair/loop-ci-correction.ts",
    `reason: "backoff",`,
  ),
  mergeRefusedBackoff: anchor(
    "p.mergeRefusedBackoff",
    "src/repair/loop-merge.ts",
    `reason === "checks_pending" || reason === "conflict" ||`,
  ),
  mergeStaleRefresh: anchor(
    "p.mergeStaleRefresh",
    "src/repair/loop-merge.ts",
    "deps.clock.now() - record.intent.startedAt >= CHECK_POLL_MS",
  ),
  mergeBaseGuard: anchor(
    "p.mergeBaseGuard",
    "src/github/port-merge.ts",
    `return blocked("base_mismatch", pull.value.head);`,
  ),
  launcherHeadSkip: anchor(
    "p.launcherHeadSkip",
    "ops/hosted-autonomy-delivery-pass.ts",
    "if (pull === null || pull.headSha !== head) continue;",
  ),
  headMismatch: anchor(
    "p.headMismatch",
    "src/github/port-merge.ts",
    `return blocked("head_mismatch", pull.value.head);`,
  ),
  mergeUnreadable: anchor(
    "p.mergeUnreadable",
    "src/repair/loop-merge.ts",
    "// An unobservable pull request is re-read after one poll, never parked.",
  ),
  receiptUnparsable: anchor(
    "p.receiptUnparsable",
    "src/repair/loop-merge.ts",
    `{ reason: "review_pending", since: now, until: null },`,
  ),
  poison: anchor(
    "p.poison",
    "src/repair/loop-merge.ts",
    'return { kind: "state_error", detail: semanticDetail };',
  ),
  vpsWait: anchor(
    "p.vpsWait",
    "src/repair/vps-delivery.ts",
    'if (matching.length !== 1) return { kind: "wait" };',
  ),
  releaseWait: anchor(
    "p.releaseWait",
    "src/repair/loop-release.ts",
    '{ reason: "unavailable", since: now, until: now + RELEASE_POLL_MS },',
  ),
  refreshRefused: anchor(
    "p.refreshRefused",
    "src/repair/loop-base-refresh-failure.ts",
    "export function refuseBaseRefresh(",
  ),
  refreshFail: anchor(
    "p.refreshFail",
    "src/repair/loop-base-refresh-failure.ts",
    `if (
    failures >= MAX_BASE_REFRESH_FAILURES &&
    !isPassportWorkTrial(record.repository)
  ) {`,
  ),
  carried: anchor(
    "p.carried",
    "src/repair/loop-work.ts",
    "return await spentOnMovedBase(deps, context, record, observedBase);",
  ),
  spentRed: anchor(
    "p.spentRed",
    "src/repair/loop-carried-delivery.ts",
    'markBlocked(record, "other", decision.blocked, deps.clock.now()),',
  ),
  correctBeforeRefresh: anchor(
    "p.correctBeforeRefresh",
    "src/repair/loop-work.ts",
    "const corrected = await correctFailedHeadBeforeRefresh(",
  ),
};
