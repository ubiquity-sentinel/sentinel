import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  ASSIGN_FIRST_GENERATION,
  ASSIGN_FIRST_REVISION,
  LIVELOCK_BOUND_GENERATION,
  LIVELOCK_BOUND_REVISION,
  NOW,
  REVIEW_PHASE_PR_GENERATION,
  REVIEW_PHASE_PR_RETRY_GENERATION,
  REVIEW_PHASE_PR_RETRY_REVISION,
  REVIEW_PHASE_PR_REVISION,
  REVIEW_WAIT_BOUND_GENERATION,
  REVIEW_WAIT_BOUND_REVISION,
  ROLLBACK_TARGET_GENERATION,
} from "./owner-install-fixture-constants.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import type { assertReviewSuccessors } from "./owner-install-review-successors.ts";

export function assertReviewDispatchBounds(
  previous: ReturnType<typeof assertReviewSuccessors>,
) {
  const { closedPrHeadHealthy } = previous;
  const assignFirstHealthy = healthyProof(ASSIGN_FIRST_REVISION, 44, 183);
  const reviewPhaseInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: ASSIGN_FIRST_REVISION,
        generation: ASSIGN_FIRST_GENERATION,
        healthyProof: assignFirstHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(reviewPhaseInstall.status, "install");
  if (reviewPhaseInstall.status !== "install") {
    throw new Error("expected review-phase PR install");
  }
  assert.equal(reviewPhaseInstall.move.action, "install");
  assert.equal(
    reviewPhaseInstall.move.priorRevision,
    ASSIGN_FIRST_REVISION,
  );
  assert.equal(
    reviewPhaseInstall.move.priorGeneration,
    ASSIGN_FIRST_GENERATION,
  );
  assert.equal(
    reviewPhaseInstall.move.nextRevision,
    REVIEW_PHASE_PR_REVISION,
  );
  assert.equal(
    reviewPhaseInstall.move.nextGeneration,
    REVIEW_PHASE_PR_GENERATION,
  );
  assert.equal(
    reviewPhaseInstall.move.nextGeneration,
    reviewPhaseInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(reviewPhaseInstall.move.priorHealthyProof),
    canonicalStringify(assignFirstHealthy),
  );
  for (
    const healthy of [
      closedPrHeadHealthy,
      healthyProof(ASSIGN_FIRST_REVISION, 43, 184),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: ASSIGN_FIRST_REVISION,
            generation: ASSIGN_FIRST_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // The installed review-phase PR generation 45 pointer is stable only with
  // its own bound healthy proof, and that stable pointer is terminal.
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_PHASE_PR_REVISION,
          generation: REVIEW_PHASE_PR_GENERATION,
          healthyProof: healthyProof(REVIEW_PHASE_PR_REVISION, 45, 188),
        }),
      }),
      NOW,
    ).status,
    "no_change",
  );
  for (
    const healthy of [
      assignFirstHealthy,
      healthyProof(REVIEW_PHASE_PR_REVISION, 44, 189),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REVIEW_PHASE_PR_REVISION,
            generation: REVIEW_PHASE_PR_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // The generation 45 candidate really failed (a runner shutdown killed its
  // execution), so the guard rolled exactly once to the recorded prior at
  // monotonic generation 46; that rollback-target pointer is now the base of
  // a separate owner-approved rung.
  const rollbackTargetHealthy = healthyProof(
    ASSIGN_FIRST_REVISION,
    ROLLBACK_TARGET_GENERATION,
    193,
  );
  const retryInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: ASSIGN_FIRST_REVISION,
        generation: ROLLBACK_TARGET_GENERATION,
        healthyProof: rollbackTargetHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(retryInstall.status, "install");
  if (retryInstall.status !== "install") {
    throw new Error("expected review-phase PR retry install");
  }
  assert.equal(retryInstall.move.action, "install");
  assert.equal(retryInstall.move.priorRevision, ASSIGN_FIRST_REVISION);
  assert.equal(
    retryInstall.move.priorGeneration,
    ROLLBACK_TARGET_GENERATION,
  );
  assert.equal(
    retryInstall.move.nextRevision,
    REVIEW_PHASE_PR_RETRY_REVISION,
  );
  assert.equal(
    retryInstall.move.nextGeneration,
    REVIEW_PHASE_PR_RETRY_GENERATION,
  );
  assert.equal(
    retryInstall.move.nextGeneration,
    retryInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(retryInstall.move.priorHealthyProof),
    canonicalStringify(rollbackTargetHealthy),
  );

  // A failed retry candidate rolls exactly once more to the same recorded
  // prior at generation 48, and a missing proof stays a zero-write wait.
  const failedRetry = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_PHASE_PR_RETRY_REVISION,
        generation: REVIEW_PHASE_PR_RETRY_GENERATION,
        healthyProof: rollbackTargetHealthy,
        executionProof: failedProof(
          REVIEW_PHASE_PR_RETRY_REVISION,
          REVIEW_PHASE_PR_RETRY_GENERATION,
          194,
        ),
      }),
    }),
    NOW,
  );
  assert.equal(failedRetry.status, "rollback");
  if (failedRetry.status !== "rollback") {
    throw new Error("expected review-phase PR retry rollback");
  }
  assert.equal(failedRetry.move.nextRevision, ASSIGN_FIRST_REVISION);
  assert.equal(failedRetry.move.nextGeneration, 48);
  assert.equal(
    canonicalStringify(failedRetry.move.priorHealthyProof),
    canonicalStringify(rollbackTargetHealthy),
  );
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_PHASE_PR_RETRY_REVISION,
          generation: REVIEW_PHASE_PR_RETRY_GENERATION,
          executionProof: failedProof(
            REVIEW_PHASE_PR_RETRY_REVISION,
            REVIEW_PHASE_PR_RETRY_GENERATION,
            195,
          ),
        }),
      }),
      NOW,
    ).status,
    "waiting",
  );

  // The installed retry generation 47 pointer is stable only with its own
  // bound healthy proof, and that proof authorizes exactly one further
  // owner-approved move: the livelock-bound revision at generation 48.
  const retryHealthy = healthyProof(
    REVIEW_PHASE_PR_RETRY_REVISION,
    REVIEW_PHASE_PR_RETRY_GENERATION,
    196,
  );
  const livelockInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_PHASE_PR_RETRY_REVISION,
        generation: REVIEW_PHASE_PR_RETRY_GENERATION,
        healthyProof: retryHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(livelockInstall.status, "install");
  if (livelockInstall.status !== "install") {
    throw new Error("expected livelock-bound install");
  }
  assert.equal(
    livelockInstall.move.nextRevision,
    LIVELOCK_BOUND_REVISION,
  );
  assert.equal(
    livelockInstall.move.nextGeneration,
    LIVELOCK_BOUND_GENERATION,
  );
  assert.equal(
    livelockInstall.move.nextGeneration,
    livelockInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(livelockInstall.move.priorHealthyProof),
    canonicalStringify(retryHealthy),
  );

  // The installed generation 48 pointer is terminal only with its own bound
  // healthy proof; without it the plan is a zero-write wait, and a failed
  // candidate rolls back exactly once to the recorded retry prior at a
  // monotonic generation. Its own healthy proof authorizes exactly one
  // further move: the review-wait-bound revision at generation 49.
  const livelockHealthy = healthyProof(
    LIVELOCK_BOUND_REVISION,
    LIVELOCK_BOUND_GENERATION,
    197,
  );
  const reviewWaitInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: LIVELOCK_BOUND_REVISION,
        generation: LIVELOCK_BOUND_GENERATION,
        healthyProof: livelockHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(reviewWaitInstall.status, "install");
  if (reviewWaitInstall.status !== "install") {
    throw new Error("expected review-wait-bound install");
  }
  assert.equal(
    reviewWaitInstall.move.nextRevision,
    REVIEW_WAIT_BOUND_REVISION,
  );
  assert.equal(
    reviewWaitInstall.move.nextGeneration,
    REVIEW_WAIT_BOUND_GENERATION,
  );
  assert.equal(
    reviewWaitInstall.move.nextGeneration,
    reviewWaitInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(reviewWaitInstall.move.priorHealthyProof),
    canonicalStringify(livelockHealthy),
  );
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: LIVELOCK_BOUND_REVISION,
          generation: LIVELOCK_BOUND_GENERATION,
        }),
      }),
      NOW,
    ).status,
    "waiting",
  );
  return { ...previous, assignFirstHealthy, retryHealthy, livelockHealthy };
}

/** Keep explicit policy/refusal inputs; only historical omissions use fixture policy. */
function planOwnerDevelopmentInstall(
  ...args: Parameters<typeof productionPlanOwnerDevelopmentInstall>
): ReturnType<typeof productionPlanOwnerDevelopmentInstall> {
  return productionPlanOwnerDevelopmentInstall(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.queue : args[4],
    args[5] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.custody : args[5],
    args[6] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.rollout : args[6],
    args[7],
    args[8],
  );
}
