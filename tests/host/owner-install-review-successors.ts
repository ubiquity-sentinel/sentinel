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
  CLOSING_KEYWORD_GENERATION,
  CLOSING_KEYWORD_REVISION,
  NOW,
  PUBLISH_GATE_GENERATION,
  PUBLISH_GATE_REVISION,
  SUCCESSOR_GENERATION,
  SUCCESSOR_REVISION,
} from "./owner-install-fixture-constants.ts";
import {
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import type { assertReviewModelStart } from "./owner-install-review-start.ts";

export function assertReviewSuccessors(
  previous: ReturnType<typeof assertReviewModelStart>,
) {
  const { reviewModelHealthy } = previous;
  const successorHealthy = healthyProof(SUCCESSOR_REVISION, 38, 151);
  const publishGateInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: SUCCESSOR_REVISION,
        generation: SUCCESSOR_GENERATION,
        healthyProof: successorHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(publishGateInstall.status, "install");
  if (publishGateInstall.status !== "install") {
    throw new Error("expected publish gate install");
  }
  assert.equal(publishGateInstall.move.action, "install");
  assert.equal(publishGateInstall.move.priorRevision, SUCCESSOR_REVISION);
  assert.equal(
    publishGateInstall.move.priorGeneration,
    SUCCESSOR_GENERATION,
  );
  assert.equal(publishGateInstall.move.nextRevision, PUBLISH_GATE_REVISION);
  assert.equal(
    publishGateInstall.move.nextGeneration,
    PUBLISH_GATE_GENERATION,
  );
  assert.equal(
    publishGateInstall.move.nextGeneration,
    publishGateInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(publishGateInstall.move.priorHealthyProof),
    canonicalStringify(successorHealthy),
  );
  for (
    const healthy of [
      reviewModelHealthy,
      healthyProof(SUCCESSOR_REVISION, 39, 152),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SUCCESSOR_REVISION,
            generation: SUCCESSOR_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // The installed publish-gate generation 39 pointer is stable only with
  // its own bound healthy proof, and that exact proof authorizes exactly one
  // move to the fixed owner-approved successor runtime revision.
  const publishGateHealthy = healthyProof(PUBLISH_GATE_REVISION, 39, 157);
  const closingKeywordInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: PUBLISH_GATE_REVISION,
        generation: PUBLISH_GATE_GENERATION,
        healthyProof: publishGateHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(closingKeywordInstall.status, "install");
  if (closingKeywordInstall.status !== "install") {
    throw new Error("expected closing keyword install");
  }
  assert.equal(closingKeywordInstall.move.action, "install");
  assert.equal(
    closingKeywordInstall.move.priorRevision,
    PUBLISH_GATE_REVISION,
  );
  assert.equal(
    closingKeywordInstall.move.priorGeneration,
    PUBLISH_GATE_GENERATION,
  );
  assert.equal(
    closingKeywordInstall.move.nextRevision,
    CLOSING_KEYWORD_REVISION,
  );
  assert.equal(
    closingKeywordInstall.move.nextGeneration,
    CLOSING_KEYWORD_GENERATION,
  );
  assert.equal(
    closingKeywordInstall.move.nextGeneration,
    closingKeywordInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(closingKeywordInstall.move.priorHealthyProof),
    canonicalStringify(publishGateHealthy),
  );
  for (
    const healthy of [
      successorHealthy,
      healthyProof(PUBLISH_GATE_REVISION, 38, 158),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: PUBLISH_GATE_REVISION,
            generation: PUBLISH_GATE_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // The installed closing-keyword generation 40 pointer is stable only with
  // its own bound healthy proof, and that exact proof authorizes exactly one
  // move to the fixed owner-approved successor runtime revision.
  const closingKeywordHealthy = healthyProof(
    CLOSING_KEYWORD_REVISION,
    40,
    163,
  );
  const candidateLossInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSING_KEYWORD_REVISION,
        generation: CLOSING_KEYWORD_GENERATION,
        healthyProof: closingKeywordHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(candidateLossInstall.status, "install");
  if (candidateLossInstall.status !== "install") {
    throw new Error("expected candidate loss install");
  }
  assert.equal(candidateLossInstall.move.action, "install");
  assert.equal(
    candidateLossInstall.move.priorRevision,
    CLOSING_KEYWORD_REVISION,
  );
  assert.equal(
    candidateLossInstall.move.priorGeneration,
    CLOSING_KEYWORD_GENERATION,
  );
  assert.equal(
    candidateLossInstall.move.nextRevision,
    CANDIDATE_LOSS_REVISION,
  );
  assert.equal(
    candidateLossInstall.move.nextGeneration,
    CANDIDATE_LOSS_GENERATION,
  );
  assert.equal(
    candidateLossInstall.move.nextGeneration,
    candidateLossInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(candidateLossInstall.move.priorHealthyProof),
    canonicalStringify(closingKeywordHealthy),
  );
  for (
    const healthy of [
      publishGateHealthy,
      healthyProof(CLOSING_KEYWORD_REVISION, 39, 164),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: CLOSING_KEYWORD_REVISION,
            generation: CLOSING_KEYWORD_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // The installed candidate-loss generation 41 pointer is stable only with
  // its own bound healthy proof, and that exact proof authorizes exactly one
  // move to the fixed owner-approved successor runtime revision.
  const candidateLossHealthy = healthyProof(CANDIDATE_LOSS_REVISION, 41, 168);
  const closedPrInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CANDIDATE_LOSS_REVISION,
        generation: CANDIDATE_LOSS_GENERATION,
        healthyProof: candidateLossHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(closedPrInstall.status, "install");
  if (closedPrInstall.status !== "install") {
    throw new Error("expected closed PR install");
  }
  assert.equal(closedPrInstall.move.action, "install");
  assert.equal(
    closedPrInstall.move.priorRevision,
    CANDIDATE_LOSS_REVISION,
  );
  assert.equal(
    closedPrInstall.move.priorGeneration,
    CANDIDATE_LOSS_GENERATION,
  );
  assert.equal(closedPrInstall.move.nextRevision, CLOSED_PR_REVISION);
  assert.equal(closedPrInstall.move.nextGeneration, CLOSED_PR_GENERATION);
  assert.equal(
    closedPrInstall.move.nextGeneration,
    closedPrInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(closedPrInstall.move.priorHealthyProof),
    canonicalStringify(candidateLossHealthy),
  );
  for (
    const healthy of [
      closingKeywordHealthy,
      healthyProof(CANDIDATE_LOSS_REVISION, 40, 169),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: CANDIDATE_LOSS_REVISION,
            generation: CANDIDATE_LOSS_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // The installed closed-PR generation 42 pointer is stable only with its
  // own bound healthy proof, and that exact proof authorizes exactly one
  // move to the fixed owner-approved successor runtime revision.
  const closedPrHealthy = healthyProof(CLOSED_PR_REVISION, 42, 173);
  const closedPrHeadInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSED_PR_REVISION,
        generation: CLOSED_PR_GENERATION,
        healthyProof: closedPrHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(closedPrHeadInstall.status, "install");
  if (closedPrHeadInstall.status !== "install") {
    throw new Error("expected closed PR head install");
  }
  assert.equal(closedPrHeadInstall.move.action, "install");
  assert.equal(closedPrHeadInstall.move.priorRevision, CLOSED_PR_REVISION);
  assert.equal(
    closedPrHeadInstall.move.priorGeneration,
    CLOSED_PR_GENERATION,
  );
  assert.equal(
    closedPrHeadInstall.move.nextRevision,
    CLOSED_PR_HEAD_REVISION,
  );
  assert.equal(
    closedPrHeadInstall.move.nextGeneration,
    CLOSED_PR_HEAD_GENERATION,
  );
  assert.equal(
    closedPrHeadInstall.move.nextGeneration,
    closedPrHeadInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(closedPrHeadInstall.move.priorHealthyProof),
    canonicalStringify(closedPrHealthy),
  );
  for (
    const healthy of [
      candidateLossHealthy,
      healthyProof(CLOSED_PR_REVISION, 41, 174),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: CLOSED_PR_REVISION,
            generation: CLOSED_PR_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // The installed closed-PR head generation 43 pointer is stable only with
  // its own bound healthy proof, and that exact proof authorizes exactly one
  // move to the fixed owner-approved successor runtime revision.
  const closedPrHeadHealthy = healthyProof(
    CLOSED_PR_HEAD_REVISION,
    43,
    178,
  );
  const assignFirstInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: CLOSED_PR_HEAD_REVISION,
        generation: CLOSED_PR_HEAD_GENERATION,
        healthyProof: closedPrHeadHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(assignFirstInstall.status, "install");
  if (assignFirstInstall.status !== "install") {
    throw new Error("expected assign first install");
  }
  assert.equal(assignFirstInstall.move.action, "install");
  assert.equal(
    assignFirstInstall.move.priorRevision,
    CLOSED_PR_HEAD_REVISION,
  );
  assert.equal(
    assignFirstInstall.move.priorGeneration,
    CLOSED_PR_HEAD_GENERATION,
  );
  assert.equal(assignFirstInstall.move.nextRevision, ASSIGN_FIRST_REVISION);
  assert.equal(
    assignFirstInstall.move.nextGeneration,
    ASSIGN_FIRST_GENERATION,
  );
  assert.equal(
    assignFirstInstall.move.nextGeneration,
    assignFirstInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(assignFirstInstall.move.priorHealthyProof),
    canonicalStringify(closedPrHeadHealthy),
  );
  for (
    const healthy of [
      closedPrHealthy,
      healthyProof(CLOSED_PR_HEAD_REVISION, 42, 179),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: CLOSED_PR_HEAD_REVISION,
            generation: CLOSED_PR_HEAD_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }

  // The installed assign-first generation 44 pointer is stable only with its
  // own bound healthy proof, and that exact proof authorizes exactly one
  // move to the fixed owner-approved successor runtime revision.
  return {
    ...previous,
    successorHealthy,
    publishGateInstall,
    publishGateHealthy,
    closingKeywordInstall,
    closingKeywordHealthy,
    candidateLossInstall,
    candidateLossHealthy,
    closedPrInstall,
    closedPrHealthy,
    closedPrHeadInstall,
    closedPrHeadHealthy,
    assignFirstInstall,
  };
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
