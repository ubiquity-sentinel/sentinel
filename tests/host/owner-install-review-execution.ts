import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  buildOwnerDevelopmentInstallSnapshot
    as productionBuildOwnerDevelopmentInstallSnapshot,
  planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall,
} from "../../src/host/owner-development-install.ts";
import {
  CHILD_DEADLINE_GENERATION,
  CHILD_DEADLINE_REVISION,
  COOLDOWN_BOUND_GENERATION,
  COOLDOWN_BOUND_REVISION,
  NOW,
  REVIEW_WAIT_BOUND_GENERATION,
  REVIEW_WAIT_BOUND_REVISION,
  STATE_HEAD,
} from "./owner-install-fixture-constants.ts";
import {
  acceptedRelease,
  cooldown,
  executionIntent,
  healthyProof,
  releaseSnapshot,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";
import type { assertReviewDispatchBounds } from "./owner-install-review-dispatch.ts";

export function assertReviewExecutionBounds(
  previous: ReturnType<typeof assertReviewDispatchBounds>,
) {
  const reviewWaitHealthy = healthyProof(
    REVIEW_WAIT_BOUND_REVISION,
    REVIEW_WAIT_BOUND_GENERATION,
    199,
  );
  const cooldownInstall = planOwnerDevelopmentInstall(
    releaseSnapshot({
      runtime: runtimeRecord({
        revision: REVIEW_WAIT_BOUND_REVISION,
        generation: REVIEW_WAIT_BOUND_GENERATION,
        healthyProof: reviewWaitHealthy,
      }),
    }),
    NOW,
  );
  assert.equal(cooldownInstall.status, "install");
  if (cooldownInstall.status !== "install") {
    throw new Error("expected cooldown-bound install");
  }
  assert.equal(cooldownInstall.move.nextRevision, COOLDOWN_BOUND_REVISION);
  assert.equal(
    cooldownInstall.move.nextGeneration,
    COOLDOWN_BOUND_GENERATION,
  );
  assert.equal(
    cooldownInstall.move.nextGeneration,
    cooldownInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(cooldownInstall.move.priorHealthyProof),
    canonicalStringify(reviewWaitHealthy),
  );
  // The installed generation 50 pointer is stable only with its own bound
  // healthy proof; without it the plan waits, and a failed candidate rolls
  // back exactly once to the recorded review-wait-bound prior. Its own
  // healthy proof authorizes exactly one further, final move: the
  // child-deadline revision at generation 51.
  const cooldownHealthy = healthyProof(
    COOLDOWN_BOUND_REVISION,
    COOLDOWN_BOUND_GENERATION,
    201,
  );
  const childDeadlineState = releaseSnapshot({
    runtime: runtimeRecord({
      revision: COOLDOWN_BOUND_REVISION,
      generation: COOLDOWN_BOUND_GENERATION,
      healthyProof: cooldownHealthy,
      executionProof: cooldownHealthy,
    }),
    hostedReleases: [acceptedRelease()],
    cooldowns: [cooldown(NOW - 1)],
  });
  const childDeadlineInstall = planOwnerDevelopmentInstall(
    childDeadlineState,
    NOW,
  );
  assert.equal(childDeadlineInstall.status, "install");
  if (childDeadlineInstall.status !== "install") {
    throw new Error("expected child-deadline install");
  }
  assert.equal(childDeadlineInstall.move.action, "install");
  assert.equal(
    childDeadlineInstall.move.priorRevision,
    COOLDOWN_BOUND_REVISION,
  );
  assert.equal(
    childDeadlineInstall.move.priorGeneration,
    COOLDOWN_BOUND_GENERATION,
  );
  assert.equal(
    childDeadlineInstall.move.nextRevision,
    CHILD_DEADLINE_REVISION,
  );
  assert.equal(
    childDeadlineInstall.move.nextGeneration,
    CHILD_DEADLINE_GENERATION,
  );
  assert.equal(
    childDeadlineInstall.move.nextGeneration,
    childDeadlineInstall.move.priorGeneration + 1,
  );
  assert.equal(
    canonicalStringify(childDeadlineInstall.move.priorHealthyProof),
    canonicalStringify(cooldownHealthy),
  );
  // The planned move builds the exact intended snapshot: only the pointer,
  // generation and timestamps change and every historical proof is preserved.
  const childDeadlinePlanned = buildOwnerDevelopmentInstallSnapshot(
    childDeadlineState,
    STATE_HEAD,
    childDeadlineInstall.move,
    NOW,
  );
  assert.equal(
    childDeadlinePlanned.sequence,
    childDeadlineState.sequence + 1,
  );
  assert.equal(childDeadlinePlanned.stateHead, STATE_HEAD);
  assert.equal(
    childDeadlinePlanned.hostedRuntimes[0].activeRevision,
    CHILD_DEADLINE_REVISION,
  );
  assert.equal(
    childDeadlinePlanned.hostedRuntimes[0].generation,
    CHILD_DEADLINE_GENERATION,
  );
  assert.equal(
    canonicalStringify(
      childDeadlinePlanned.hostedRuntimes[0].lastHealthyProof,
    ),
    canonicalStringify(cooldownHealthy),
  );
  // A healthy proof bound to another revision or generation, and no recorded
  // proof at all, never authorize the fixed child-deadline pin.
  for (
    const healthy of [
      healthyProof(
        COOLDOWN_BOUND_REVISION,
        COOLDOWN_BOUND_GENERATION - 1,
        208,
      ),
      healthyProof(
        REVIEW_WAIT_BOUND_REVISION,
        COOLDOWN_BOUND_GENERATION,
        209,
      ),
      null,
    ]
  ) {
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: COOLDOWN_BOUND_REVISION,
            generation: COOLDOWN_BOUND_GENERATION,
            healthyProof: healthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  }
  // A running generation 50 execution blocks the child-deadline install until
  // it settles.
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: COOLDOWN_BOUND_REVISION,
          generation: COOLDOWN_BOUND_GENERATION,
          healthyProof: cooldownHealthy,
          execution: executionIntent(
            COOLDOWN_BOUND_REVISION,
            COOLDOWN_BOUND_GENERATION,
          ),
        }),
      }),
      NOW,
    ).status,
    "waiting",
  );
  assert.equal(
    planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: COOLDOWN_BOUND_REVISION,
          generation: COOLDOWN_BOUND_GENERATION,
        }),
      }),
      NOW,
    ).status,
    "waiting",
  );
  return { ...previous, reviewWaitHealthy, cooldownHealthy };
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

/** Snapshot validation uses the same historical policy as its real planner. */
function buildOwnerDevelopmentInstallSnapshot(
  ...args: Parameters<typeof productionBuildOwnerDevelopmentInstallSnapshot>
): ReturnType<typeof productionBuildOwnerDevelopmentInstallSnapshot> {
  return productionBuildOwnerDevelopmentInstallSnapshot(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.queue : args[6],
    args[7] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.custody : args[7],
    args[8],
    args[9] === undefined ? DORMANT_HOSTED_SUPERVISOR_POLICY.rollout : args[9],
    args[10],
  );
}
