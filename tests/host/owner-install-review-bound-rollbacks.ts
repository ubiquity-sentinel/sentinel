import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  ASSIGN_FIRST_REVISION,
  CHILD_DEADLINE_GENERATION,
  CHILD_DEADLINE_REVISION,
  COOLDOWN_BOUND_GENERATION,
  COOLDOWN_BOUND_REVISION,
  LIVELOCK_BOUND_GENERATION,
  LIVELOCK_BOUND_REVISION,
  NOW,
  REVIEW_PHASE_PR_GENERATION,
  REVIEW_PHASE_PR_RETRY_REVISION,
  REVIEW_PHASE_PR_REVISION,
  REVIEW_WAIT_BOUND_GENERATION,
  REVIEW_WAIT_BOUND_REVISION,
  RUNTIME52_GENERATION,
  RUNTIME52_REVISION,
} from "./owner-install-fixture-constants.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import type { assertReviewExecutionBounds } from "./owner-install-review-execution.ts";

export function assertReviewBoundRollbacks(
  previous: ReturnType<typeof assertReviewExecutionBounds>,
) {
  const {
    assignFirstHealthy,
    retryHealthy,
    livelockHealthy,
    reviewWaitHealthy,
    cooldownHealthy,
  } = previous;
  const failedCooldown = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: COOLDOWN_BOUND_REVISION,
        generation: COOLDOWN_BOUND_GENERATION,
        healthyProof: reviewWaitHealthy,
        executionProof: failedProof(
          COOLDOWN_BOUND_REVISION,
          COOLDOWN_BOUND_GENERATION,
          202,
        ),
      }),
    }),
    NOW,
  );
  assert.equal(failedCooldown.status, "rollback");
  if (failedCooldown.status !== "rollback") {
    throw new Error("expected cooldown-bound rollback");
  }
  assert.equal(failedCooldown.move.nextRevision, REVIEW_WAIT_BOUND_REVISION);
  assert.equal(
    failedCooldown.move.nextGeneration,
    COOLDOWN_BOUND_GENERATION + 1,
  );

  // A failed child-deadline generation 51 candidate settles exactly once by
  // rolling back only to the exact previously proven cooldown-bound revision
  // with a monotonic generation 52, authorized by its retained healthy proof.
  const failedChildDeadline = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CHILD_DEADLINE_REVISION,
        generation: CHILD_DEADLINE_GENERATION,
        healthyProof: cooldownHealthy,
        executionProof: failedProof(
          CHILD_DEADLINE_REVISION,
          CHILD_DEADLINE_GENERATION,
          203,
        ),
      }),
    }),
    NOW,
  );
  assert.equal(failedChildDeadline.status, "rollback");
  if (failedChildDeadline.status !== "rollback") {
    throw new Error("expected child-deadline rollback");
  }
  assert.equal(failedChildDeadline.move.action, "rollback");
  assert.equal(
    failedChildDeadline.move.priorRevision,
    CHILD_DEADLINE_REVISION,
  );
  assert.equal(
    failedChildDeadline.move.priorGeneration,
    CHILD_DEADLINE_GENERATION,
  );
  assert.equal(
    failedChildDeadline.move.nextRevision,
    COOLDOWN_BOUND_REVISION,
  );
  assert.equal(
    failedChildDeadline.move.nextGeneration,
    CHILD_DEADLINE_GENERATION + 1,
  );
  assert.equal(
    failedChildDeadline.move.nextGeneration,
    failedChildDeadline.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(failedChildDeadline.move.priorHealthyProof),
    canonicalStringify(cooldownHealthy),
  );
  // The installed child-deadline pointer's own bound healthy proof authorizes
  // exactly one further movement: the runtime-source rung at generation 52.
  // A missing retained prior and an unbound failure never roll back.
  const runtimeSourcePlan = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CHILD_DEADLINE_REVISION,
        generation: CHILD_DEADLINE_GENERATION,
        healthyProof: healthyProof(
          CHILD_DEADLINE_REVISION,
          CHILD_DEADLINE_GENERATION,
          204,
        ),
      }),
    }),
    NOW,
  );
  assert.equal(runtimeSourcePlan.status, "install");
  if (runtimeSourcePlan.status !== "install") {
    throw new Error("expected install");
  }
  assert.equal(runtimeSourcePlan.move.nextRevision, RUNTIME52_REVISION);
  assert.equal(runtimeSourcePlan.move.nextGeneration, RUNTIME52_GENERATION);
  assert.equal(
    runtimeSourcePlan.move.nextGeneration,
    runtimeSourcePlan.move.priorGeneration + 1,
  );
  for (
    const state of [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CHILD_DEADLINE_REVISION,
          generation: CHILD_DEADLINE_GENERATION,
          executionProof: failedProof(
            CHILD_DEADLINE_REVISION,
            CHILD_DEADLINE_GENERATION,
            206,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CHILD_DEADLINE_REVISION,
          generation: CHILD_DEADLINE_GENERATION,
          healthyProof: cooldownHealthy,
          executionProof: failedProof(
            CHILD_DEADLINE_REVISION,
            CHILD_DEADLINE_GENERATION - 1,
            207,
          ),
        }),
      }),
    ]
  ) {
    assert.equal(planOwnerDevelopmentInstall(state, NOW).status, "waiting");
  }
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_WAIT_BOUND_REVISION,
          generation: REVIEW_WAIT_BOUND_GENERATION,
        }),
      }),
      NOW,
    ).status,
    "waiting",
  );
  const failedReviewWait = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_WAIT_BOUND_REVISION,
        generation: REVIEW_WAIT_BOUND_GENERATION,
        healthyProof: livelockHealthy,
        executionProof: failedProof(
          REVIEW_WAIT_BOUND_REVISION,
          REVIEW_WAIT_BOUND_GENERATION,
          200,
        ),
      }),
    }),
    NOW,
  );
  assert.equal(failedReviewWait.status, "rollback");
  if (failedReviewWait.status !== "rollback") {
    throw new Error("expected review-wait-bound rollback");
  }
  assert.equal(
    failedReviewWait.move.nextRevision,
    LIVELOCK_BOUND_REVISION,
  );
  assert.equal(
    failedReviewWait.move.nextGeneration,
    REVIEW_WAIT_BOUND_GENERATION + 1,
  );
  const failedLivelock = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: LIVELOCK_BOUND_REVISION,
        generation: LIVELOCK_BOUND_GENERATION,
        healthyProof: retryHealthy,
        executionProof: failedProof(
          LIVELOCK_BOUND_REVISION,
          LIVELOCK_BOUND_GENERATION,
          198,
        ),
      }),
    }),
    NOW,
  );
  assert.equal(failedLivelock.status, "rollback");
  if (failedLivelock.status !== "rollback") {
    throw new Error("expected livelock-bound rollback");
  }
  assert.equal(
    failedLivelock.move.nextRevision,
    REVIEW_PHASE_PR_RETRY_REVISION,
  );
  assert.equal(
    failedLivelock.move.nextGeneration,
    LIVELOCK_BOUND_GENERATION + 1,
  );
  assert.equal(
    canonicalStringify(failedLivelock.move.priorHealthyProof),
    canonicalStringify(retryHealthy),
  );

  // A failed review-phase PR generation 45 candidate settles exactly once by
  // rolling back only to the exact previously proven assign-first revision
  // with a monotonic generation 46, authorized by its retained healthy
  // proof.
  const failedReviewPhase = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_PHASE_PR_REVISION,
        generation: REVIEW_PHASE_PR_GENERATION,
        healthyProof: assignFirstHealthy,
        executionProof: failedProof(REVIEW_PHASE_PR_REVISION, 45, 190),
      }),
    }),
    NOW,
  );
  assert.equal(failedReviewPhase.status, "rollback");
  if (failedReviewPhase.status !== "rollback") {
    throw new Error("expected review-phase PR rollback");
  }
  assert.equal(failedReviewPhase.move.action, "rollback");
  assert.equal(
    failedReviewPhase.move.priorRevision,
    REVIEW_PHASE_PR_REVISION,
  );
  assert.equal(
    failedReviewPhase.move.priorGeneration,
    REVIEW_PHASE_PR_GENERATION,
  );
  assert.equal(
    failedReviewPhase.move.nextRevision,
    ASSIGN_FIRST_REVISION,
  );
  assert.equal(failedReviewPhase.move.nextGeneration, 46);
  assert.equal(
    canonicalStringify(failedReviewPhase.move.priorHealthyProof),
    canonicalStringify(assignFirstHealthy),
  );

  // A review-phase PR failure that does not bind the exact pointer or a
  // missing retained prior never rolls back.
  const reviewPhaseWaits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_PHASE_PR_REVISION,
        generation: REVIEW_PHASE_PR_GENERATION,
        healthyProof: assignFirstHealthy,
        executionProof: failedProof(REVIEW_PHASE_PR_REVISION, 44, 191),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_PHASE_PR_REVISION,
        generation: REVIEW_PHASE_PR_GENERATION,
        executionProof: failedProof(REVIEW_PHASE_PR_REVISION, 45, 192),
      }),
    }),
  ];
  for (const state of reviewPhaseWaits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // A failed assign-first generation 44 candidate settles exactly once by
  // rolling back only to the exact previously proven closed-PR head revision
  // with a monotonic generation 45, authorized by its retained healthy
  // proof.
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
