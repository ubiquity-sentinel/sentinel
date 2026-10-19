import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  BASE_FETCH,
  CLOSING_KEYWORD_GENERATION,
  CLOSING_KEYWORD_REVISION,
  NOW,
  PUBLISH_GATE_GENERATION,
  PUBLISH_GATE_REVISION,
  REVIEW_MODEL,
  REVIEW_MODEL_GENERATION,
  SUCCESSOR_GENERATION,
  SUCCESSOR_REVISION,
} from "./owner-install-fixture-constants.ts";
import {
  failedProof,
  healthyProof,
  notStartedProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import type { assertReviewExecutionBounds } from "./owner-install-review-execution.ts";

export function assertReviewPublicationRollbacks(
  previous: ReturnType<typeof assertReviewExecutionBounds>,
) {
  const {
    baseFetchHealthy,
    reviewModelHealthy,
    successorHealthy,
    publishGateHealthy,
  } = previous;
  const failedClosingKeyword = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSING_KEYWORD_REVISION,
        generation: CLOSING_KEYWORD_GENERATION,
        healthyProof: publishGateHealthy,
        executionProof: failedProof(CLOSING_KEYWORD_REVISION, 40, 165),
      }),
    }),
    NOW,
  );
  assert.equal(failedClosingKeyword.status, "rollback");
  if (failedClosingKeyword.status !== "rollback") {
    throw new Error("expected closing keyword rollback");
  }
  assert.equal(failedClosingKeyword.move.action, "rollback");
  assert.equal(
    failedClosingKeyword.move.priorRevision,
    CLOSING_KEYWORD_REVISION,
  );
  assert.equal(
    failedClosingKeyword.move.priorGeneration,
    CLOSING_KEYWORD_GENERATION,
  );
  assert.equal(
    failedClosingKeyword.move.nextRevision,
    PUBLISH_GATE_REVISION,
  );
  assert.equal(failedClosingKeyword.move.nextGeneration, 41);
  assert.equal(
    failedClosingKeyword.move.nextGeneration,
    failedClosingKeyword.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(failedClosingKeyword.move.priorHealthyProof),
    canonicalStringify(publishGateHealthy),
  );

  // A closing-keyword failure that does not bind the exact pointer or a
  // missing retained prior never rolls back.
  const closingKeywordWaits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSING_KEYWORD_REVISION,
        generation: CLOSING_KEYWORD_GENERATION,
        healthyProof: publishGateHealthy,
        executionProof: failedProof(CLOSING_KEYWORD_REVISION, 39, 166),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSING_KEYWORD_REVISION,
        generation: CLOSING_KEYWORD_GENERATION,
        executionProof: failedProof(CLOSING_KEYWORD_REVISION, 40, 167),
      }),
    }),
  ];
  for (const state of closingKeywordWaits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // A failed publish-gate generation 39 candidate settles exactly once by
  // rolling back only to the exact previously proven successor revision
  // with a monotonic generation 40, authorized by its retained healthy
  // proof.
  const failedPublishGate = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: PUBLISH_GATE_REVISION,
        generation: PUBLISH_GATE_GENERATION,
        healthyProof: successorHealthy,
        executionProof: failedProof(PUBLISH_GATE_REVISION, 39, 159),
      }),
    }),
    NOW,
  );
  assert.equal(failedPublishGate.status, "rollback");
  if (failedPublishGate.status !== "rollback") {
    throw new Error("expected publish gate rollback");
  }
  assert.equal(failedPublishGate.move.action, "rollback");
  assert.equal(failedPublishGate.move.priorRevision, PUBLISH_GATE_REVISION);
  assert.equal(
    failedPublishGate.move.priorGeneration,
    PUBLISH_GATE_GENERATION,
  );
  assert.equal(failedPublishGate.move.nextRevision, SUCCESSOR_REVISION);
  assert.equal(failedPublishGate.move.nextGeneration, 40);
  assert.equal(
    failedPublishGate.move.nextGeneration,
    failedPublishGate.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(failedPublishGate.move.priorHealthyProof),
    canonicalStringify(successorHealthy),
  );

  // A publish-gate failure that does not bind the exact pointer and a
  // missing retained prior never roll back.
  const publishGateWaits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: PUBLISH_GATE_REVISION,
        generation: PUBLISH_GATE_GENERATION,
        healthyProof: successorHealthy,
        executionProof: failedProof(PUBLISH_GATE_REVISION, 38, 160),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: PUBLISH_GATE_REVISION,
        generation: PUBLISH_GATE_GENERATION,
        executionProof: failedProof(PUBLISH_GATE_REVISION, 39, 161),
      }),
    }),
  ];
  for (const state of publishGateWaits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // The post-rollback successor generation 40 pointer is terminal: it is
  // outside the one-shot chain and never reattempts either movement.
  for (
    const healthy of [
      healthyProof(SUCCESSOR_REVISION, 40, 162),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SUCCESSOR_REVISION,
            generation: 40,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
  }

  // A failed generation 38 successor candidate settles exactly once by
  // rolling back only to the exact previously proven review model revision
  // with a monotonic generation 39, authorized by its retained healthy
  // proof.
  const failedSuccessor = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: SUCCESSOR_REVISION,
        generation: SUCCESSOR_GENERATION,
        healthyProof: reviewModelHealthy,
        executionProof: failedProof(SUCCESSOR_REVISION, 38, 153),
      }),
    }),
    NOW,
  );
  assert.equal(failedSuccessor.status, "rollback");
  if (failedSuccessor.status !== "rollback") {
    throw new Error("expected successor rollback");
  }
  assert.equal(failedSuccessor.move.action, "rollback");
  assert.equal(failedSuccessor.move.priorRevision, SUCCESSOR_REVISION);
  assert.equal(failedSuccessor.move.priorGeneration, SUCCESSOR_GENERATION);
  assert.equal(failedSuccessor.move.nextRevision, REVIEW_MODEL);
  assert.equal(failedSuccessor.move.nextGeneration, 39);
  assert.equal(
    failedSuccessor.move.nextGeneration,
    failedSuccessor.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(failedSuccessor.move.priorHealthyProof),
    canonicalStringify(reviewModelHealthy),
  );

  // A successor failure that does not bind the exact pointer, a
  // no-execution settlement and a missing retained prior never roll back.
  const successorWaits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: SUCCESSOR_REVISION,
        generation: SUCCESSOR_GENERATION,
        healthyProof: reviewModelHealthy,
        executionProof: failedProof(SUCCESSOR_REVISION, 37, 154),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: SUCCESSOR_REVISION,
        generation: SUCCESSOR_GENERATION,
        healthyProof: reviewModelHealthy,
        executionProof: notStartedProof(
          SUCCESSOR_REVISION,
          SUCCESSOR_GENERATION,
        ),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: SUCCESSOR_REVISION,
        generation: SUCCESSOR_GENERATION,
        executionProof: failedProof(SUCCESSOR_REVISION, 38, 155),
      }),
    }),
  ];
  for (const state of successorWaits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // The post-rollback review model generation 39 pointer is terminal: it is
  // outside the one-shot chain and never reattempts either movement.
  for (
    const healthy of [
      healthyProof(REVIEW_MODEL, 39, 156),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REVIEW_MODEL,
            generation: 39,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
  }

  // A failed generation 37 candidate settles exactly once by rolling back
  // to the exact previously proven generation 36 revision with a monotonic
  // generation 38, authorized by its recorded healthy proof.
  const failed = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_MODEL,
        generation: REVIEW_MODEL_GENERATION,
        healthyProof: baseFetchHealthy,
        executionProof: failedProof(
          REVIEW_MODEL,
          REVIEW_MODEL_GENERATION,
          145,
        ),
      }),
    }),
    NOW,
  );
  assert.equal(failed.status, "rollback");
  if (failed.status !== "rollback") throw new Error("expected rollback");
  assert.equal(failed.move.action, "rollback");
  assert.equal(failed.move.priorRevision, REVIEW_MODEL);
  assert.equal(failed.move.priorGeneration, REVIEW_MODEL_GENERATION);
  assert.equal(failed.move.nextRevision, BASE_FETCH);
  assert.equal(failed.move.nextGeneration, 38);
  assert.equal(failed.move.nextGeneration, failed.move.priorGeneration + 1);
  assert.equal(
    canonicalStringify(failed.move.priorHealthyProof),
    canonicalStringify(baseFetchHealthy),
  );

  // A failure that does not bind the exact pointer, a no-execution
  // settlement and a missing recorded prior never roll back.
  const waits = [
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_MODEL,
        generation: REVIEW_MODEL_GENERATION,
        healthyProof: baseFetchHealthy,
        executionProof: failedProof(REVIEW_MODEL, 36, 146),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_MODEL,
        generation: REVIEW_MODEL_GENERATION,
        healthyProof: baseFetchHealthy,
        executionProof: notStartedProof(
          REVIEW_MODEL,
          REVIEW_MODEL_GENERATION,
        ),
      }),
    }),
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_MODEL,
        generation: REVIEW_MODEL_GENERATION,
        executionProof: failedProof(
          REVIEW_MODEL,
          REVIEW_MODEL_GENERATION,
          147,
        ),
      }),
    }),
  ];
  for (const state of waits) {
    const plan = planOwnerDevelopmentInstall(state, NOW);
    assert.notEqual(plan.status, "rollback");
    assert.equal(plan.status, "waiting");
  }

  // The post-rollback base fetch generation 38 pointer is terminal: it is
  // outside the one-shot chain and never reattempts either movement.
  for (
    const healthy of [
      healthyProof(BASE_FETCH, 38, 148),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: BASE_FETCH,
            generation: 38,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
  }
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
