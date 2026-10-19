import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  ASSIGN_FIRST_GENERATION,
  ASSIGN_FIRST_REVISION,
  CANDIDATE_LOSS_GENERATION,
  CANDIDATE_LOSS_REVISION,
  CLOSED_PR_GENERATION,
  CLOSED_PR_HEAD_GENERATION,
  CLOSED_PR_HEAD_REVISION,
  CLOSED_PR_REVISION,
  CLOSING_KEYWORD_REVISION,
  NOW,
} from "./owner-install-fixture-constants.ts";
import {
  failedProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import type { assertReviewExecutionBounds } from "./owner-install-review-execution.ts";

export function assertReviewCandidateRollbacks(
  previous: ReturnType<typeof assertReviewExecutionBounds>,
) {
  const {
    closingKeywordHealthy,
    candidateLossHealthy,
    closedPrHealthy,
    closedPrHeadHealthy,
  } = previous;
  const failedAssignFirst = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: ASSIGN_FIRST_REVISION,
        generation: ASSIGN_FIRST_GENERATION,
        healthyProof: closedPrHeadHealthy,
        executionProof: failedProof(ASSIGN_FIRST_REVISION, 44, 185),
      }),
    }),
    NOW,
  );
  assert.equal(failedAssignFirst.status, "rollback");
  if (failedAssignFirst.status !== "rollback") {
    throw new Error("expected assign first rollback");
  }
  assert.equal(failedAssignFirst.move.action, "rollback");
  assert.equal(
    failedAssignFirst.move.priorRevision,
    ASSIGN_FIRST_REVISION,
  );
  assert.equal(
    failedAssignFirst.move.priorGeneration,
    ASSIGN_FIRST_GENERATION,
  );
  assert.equal(
    failedAssignFirst.move.nextRevision,
    CLOSED_PR_HEAD_REVISION,
  );
  assert.equal(failedAssignFirst.move.nextGeneration, 45);
  assert.equal(
    canonicalStringify(failedAssignFirst.move.priorHealthyProof),
    canonicalStringify(closedPrHeadHealthy),
  );

  // An assign-first failure that does not bind the exact pointer or a
  // missing retained prior never rolls back.
  const assignFirstWaits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: ASSIGN_FIRST_REVISION,
        generation: ASSIGN_FIRST_GENERATION,
        healthyProof: closedPrHeadHealthy,
        executionProof: failedProof(ASSIGN_FIRST_REVISION, 43, 186),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: ASSIGN_FIRST_REVISION,
        generation: ASSIGN_FIRST_GENERATION,
        executionProof: failedProof(ASSIGN_FIRST_REVISION, 44, 187),
      }),
    }),
  ];
  for (const state of assignFirstWaits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // A failed closed-PR head generation 43 candidate settles exactly once by
  // rolling back only to the exact previously proven closed-PR revision
  // with a monotonic generation 44, authorized by its retained healthy
  // proof.
  const failedClosedPrHead = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSED_PR_HEAD_REVISION,
        generation: CLOSED_PR_HEAD_GENERATION,
        healthyProof: closedPrHealthy,
        executionProof: failedProof(CLOSED_PR_HEAD_REVISION, 43, 180),
      }),
    }),
    NOW,
  );
  assert.equal(failedClosedPrHead.status, "rollback");
  if (failedClosedPrHead.status !== "rollback") {
    throw new Error("expected closed PR head rollback");
  }
  assert.equal(failedClosedPrHead.move.action, "rollback");
  assert.equal(
    failedClosedPrHead.move.priorRevision,
    CLOSED_PR_HEAD_REVISION,
  );
  assert.equal(
    failedClosedPrHead.move.priorGeneration,
    CLOSED_PR_HEAD_GENERATION,
  );
  assert.equal(failedClosedPrHead.move.nextRevision, CLOSED_PR_REVISION);
  assert.equal(failedClosedPrHead.move.nextGeneration, 44);
  assert.equal(
    canonicalStringify(failedClosedPrHead.move.priorHealthyProof),
    canonicalStringify(closedPrHealthy),
  );

  // A closed-PR head failure that does not bind the exact pointer or a
  // missing retained prior never rolls back.
  const closedPrHeadWaits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSED_PR_HEAD_REVISION,
        generation: CLOSED_PR_HEAD_GENERATION,
        healthyProof: closedPrHealthy,
        executionProof: failedProof(CLOSED_PR_HEAD_REVISION, 42, 181),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSED_PR_HEAD_REVISION,
        generation: CLOSED_PR_HEAD_GENERATION,
        executionProof: failedProof(CLOSED_PR_HEAD_REVISION, 43, 182),
      }),
    }),
  ];
  for (const state of closedPrHeadWaits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // A failed closed-PR generation 42 candidate settles exactly once by
  // rolling back only to the exact previously proven candidate-loss
  // revision with a monotonic generation 43, authorized by its retained
  // healthy proof.
  const failedClosedPr = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSED_PR_REVISION,
        generation: CLOSED_PR_GENERATION,
        healthyProof: candidateLossHealthy,
        executionProof: failedProof(CLOSED_PR_REVISION, 42, 175),
      }),
    }),
    NOW,
  );
  assert.equal(failedClosedPr.status, "rollback");
  if (failedClosedPr.status !== "rollback") {
    throw new Error("expected closed PR rollback");
  }
  assert.equal(failedClosedPr.move.action, "rollback");
  assert.equal(failedClosedPr.move.priorRevision, CLOSED_PR_REVISION);
  assert.equal(failedClosedPr.move.priorGeneration, CLOSED_PR_GENERATION);
  assert.equal(
    failedClosedPr.move.nextRevision,
    CANDIDATE_LOSS_REVISION,
  );
  assert.equal(failedClosedPr.move.nextGeneration, 43);
  assert.equal(
    failedClosedPr.move.nextGeneration,
    failedClosedPr.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(failedClosedPr.move.priorHealthyProof),
    canonicalStringify(candidateLossHealthy),
  );

  // A closed-PR failure that does not bind the exact pointer or a missing
  // retained prior never rolls back.
  const closedPrWaits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSED_PR_REVISION,
        generation: CLOSED_PR_GENERATION,
        healthyProof: candidateLossHealthy,
        executionProof: failedProof(CLOSED_PR_REVISION, 41, 176),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSED_PR_REVISION,
        generation: CLOSED_PR_GENERATION,
        executionProof: failedProof(CLOSED_PR_REVISION, 42, 177),
      }),
    }),
  ];
  for (const state of closedPrWaits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // A failed candidate-loss generation 41 candidate settles exactly once by
  // rolling back only to the exact previously proven closing-keyword
  // revision with a monotonic generation 42, authorized by its retained
  // healthy proof.
  const failedCandidateLoss = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CANDIDATE_LOSS_REVISION,
        generation: CANDIDATE_LOSS_GENERATION,
        healthyProof: closingKeywordHealthy,
        executionProof: failedProof(CANDIDATE_LOSS_REVISION, 41, 170),
      }),
    }),
    NOW,
  );
  assert.equal(failedCandidateLoss.status, "rollback");
  if (failedCandidateLoss.status !== "rollback") {
    throw new Error("expected candidate loss rollback");
  }
  assert.equal(failedCandidateLoss.move.action, "rollback");
  assert.equal(
    failedCandidateLoss.move.priorRevision,
    CANDIDATE_LOSS_REVISION,
  );
  assert.equal(
    failedCandidateLoss.move.priorGeneration,
    CANDIDATE_LOSS_GENERATION,
  );
  assert.equal(
    failedCandidateLoss.move.nextRevision,
    CLOSING_KEYWORD_REVISION,
  );
  assert.equal(failedCandidateLoss.move.nextGeneration, 42);
  assert.equal(
    failedCandidateLoss.move.nextGeneration,
    failedCandidateLoss.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(failedCandidateLoss.move.priorHealthyProof),
    canonicalStringify(closingKeywordHealthy),
  );

  // A candidate-loss failure that does not bind the exact pointer or a
  // missing retained prior never rolls back.
  const candidateLossWaits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CANDIDATE_LOSS_REVISION,
        generation: CANDIDATE_LOSS_GENERATION,
        healthyProof: closingKeywordHealthy,
        executionProof: failedProof(CANDIDATE_LOSS_REVISION, 40, 171),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CANDIDATE_LOSS_REVISION,
        generation: CANDIDATE_LOSS_GENERATION,
        executionProof: failedProof(CANDIDATE_LOSS_REVISION, 41, 172),
      }),
    }),
  ];
  for (const state of candidateLossWaits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // A failed closing-keyword generation 40 candidate settles exactly once by
  // rolling back only to the exact previously proven publish-gate revision
  // with a monotonic generation 41, authorized by its retained healthy
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
