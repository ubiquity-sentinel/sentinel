import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  BASE_FETCH,
  BASE_FETCH_GENERATION,
  NOW,
  QUIET_REASONING,
  QUIET_REASONING_GENERATION,
  REASON_CODE,
  REVIEW_MODEL,
  REVIEW_MODEL_GENERATION,
  SETTLEMENT_RECOVERY,
} from "./owner-install-fixture-constants.ts";
import {
  cooldown,
  executionIntent,
  failedProof,
  healthyProof,
  notStartedProof,
  releaseSnapshot,
  requestedRelease,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";

Deno.test(
  "owner install: settlement recovery revision preserves install and rollback gates",
  () => {
    const reasonHealthy = healthyProof(REASON_CODE, 33, 111);
    // The fixed owner-approved pin: only the recorded generation 33 healthy
    // proof authorizes exactly one move to the settlement recovery revision.
    assert.equal(
      SETTLEMENT_RECOVERY,
      "83a7cd8162d808887a27ad733c64db6e3a7c77ac",
    );
    const fixed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REASON_CODE,
          generation: 33,
          healthyProof: reasonHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(fixed.status, "install");
    if (fixed.status !== "install") throw new Error("expected install");
    assert.equal(fixed.move.priorRevision, REASON_CODE);
    assert.equal(fixed.move.priorGeneration, 33);
    assert.equal(fixed.move.nextRevision, SETTLEMENT_RECOVERY);
    assert.equal(fixed.move.nextGeneration, 34);
    assert.equal(
      canonicalStringify(fixed.move.priorHealthyProof),
      canonicalStringify(reasonHealthy),
    );

    // A healthy proof bound to another revision or generation never
    // authorizes the fixed pin.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REASON_CODE,
            generation: 33,
            healthyProof: healthyProof(SETTLEMENT_RECOVERY, 33, 112),
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
            revision: REASON_CODE,
            generation: 33,
            healthyProof: healthyProof(REASON_CODE, 34, 113),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // An in-flight execution, a non-terminal release and an active cooldown
    // each keep the pin a zero-write wait.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REASON_CODE,
            generation: 33,
            healthyProof: reasonHealthy,
            execution: executionIntent(REASON_CODE, 33),
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
            revision: REASON_CODE,
            generation: 33,
            healthyProof: reasonHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: REASON_CODE,
            generation: 33,
            healthyProof: reasonHealthy,
          }),
          cooldowns: [cooldown(NOW + 1)],
        }),
        NOW,
      ).status,
      "waiting",
    );

    // The installed generation 34 pointer is stable only with its own bound
    // healthy proof; that proof authorizes the fixed quiet-reasoning install
    // to generation 35.
    const settlementHealthy = healthyProof(SETTLEMENT_RECOVERY, 34, 114);
    const quietInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT_RECOVERY,
          generation: 34,
          healthyProof: settlementHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(quietInstall.status, "install");
    if (quietInstall.status !== "install") throw new Error("expected install");
    assert.equal(quietInstall.move.priorRevision, SETTLEMENT_RECOVERY);
    assert.equal(quietInstall.move.priorGeneration, 34);
    assert.equal(quietInstall.move.nextRevision, QUIET_REASONING);
    assert.equal(quietInstall.move.nextGeneration, QUIET_REASONING_GENERATION);
    assert.equal(
      canonicalStringify(quietInstall.move.priorHealthyProof),
      canonicalStringify(settlementHealthy),
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            healthyProof: reasonHealthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // A failed generation 34 candidate settles exactly once by rolling back to
    // the genuine prior revision with a monotonic generation 35.
    const failedSettlement = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT_RECOVERY,
          generation: 34,
          healthyProof: reasonHealthy,
          executionProof: failedProof(SETTLEMENT_RECOVERY, 34, 115),
        }),
      }),
      NOW,
    );
    assert.equal(failedSettlement.status, "rollback");
    if (failedSettlement.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(failedSettlement.move.priorRevision, SETTLEMENT_RECOVERY);
    assert.equal(failedSettlement.move.priorGeneration, 34);
    assert.equal(failedSettlement.move.nextRevision, REASON_CODE);
    assert.equal(failedSettlement.move.nextGeneration, 35);
    assert.equal(
      canonicalStringify(failedSettlement.move.priorHealthyProof),
      canonicalStringify(reasonHealthy),
    );
    // Without the recorded reason-code healthy proof the rollback waits.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            executionProof: failedProof(SETTLEMENT_RECOVERY, 34, 116),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  },
);

Deno.test(
  "owner install: quiet reasoning revision preserves install and rollback gates",
  () => {
    const settlementHealthy = healthyProof(SETTLEMENT_RECOVERY, 34, 121);
    // The fixed owner-approved pin: only the recorded generation 34 healthy
    // proof authorizes exactly one move to the quiet reasoning revision.
    const install = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT_RECOVERY,
          generation: 34,
          healthyProof: settlementHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(install.status, "install");
    if (install.status !== "install") throw new Error("expected install");
    assert.equal(install.move.action, "install");
    assert.equal(install.move.priorRevision, SETTLEMENT_RECOVERY);
    assert.equal(install.move.priorGeneration, 34);
    assert.equal(install.move.nextRevision, QUIET_REASONING);
    assert.equal(install.move.nextGeneration, QUIET_REASONING_GENERATION);
    assert.equal(install.move.nextGeneration, install.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(install.move.priorHealthyProof),
      canonicalStringify(settlementHealthy),
    );

    // A healthy proof bound to another revision or generation, and no
    // recorded proof at all, never authorize the fixed pin.
    for (
      const healthy of [
        healthyProof(QUIET_REASONING, 34, 122),
        healthyProof(SETTLEMENT_RECOVERY, 35, 123),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: SETTLEMENT_RECOVERY,
              generation: 34,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // An in-flight execution, a non-terminal release and an active cooldown
    // each keep the pin a zero-write wait.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            healthyProof: settlementHealthy,
            execution: executionIntent(SETTLEMENT_RECOVERY, 34),
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
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            healthyProof: settlementHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: SETTLEMENT_RECOVERY,
            generation: 34,
            healthyProof: settlementHealthy,
          }),
          cooldowns: [cooldown(NOW + 1)],
        }),
        NOW,
      ).status,
      "waiting",
    );

    // The installed generation 35 pointer is stable only with its own bound
    // healthy proof; that proof authorizes the fixed base fetch install to
    // generation 36.
    const quietHealthy = healthyProof(QUIET_REASONING, 35, 124);
    const baseFetchInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: quietHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(baseFetchInstall.status, "install");
    if (baseFetchInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(baseFetchInstall.move.priorRevision, QUIET_REASONING);
    assert.equal(
      baseFetchInstall.move.priorGeneration,
      QUIET_REASONING_GENERATION,
    );
    assert.equal(baseFetchInstall.move.nextRevision, BASE_FETCH);
    assert.equal(baseFetchInstall.move.nextGeneration, BASE_FETCH_GENERATION);
    assert.equal(
      canonicalStringify(baseFetchInstall.move.priorHealthyProof),
      canonicalStringify(quietHealthy),
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: QUIET_REASONING,
            generation: QUIET_REASONING_GENERATION,
            healthyProof: settlementHealthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // A failed generation 35 candidate settles exactly once by rolling back
    // to the exact previously proven generation 34 revision with a monotonic
    // generation 36, authorized by its recorded healthy proof.
    const failed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: settlementHealthy,
          executionProof: failedProof(
            QUIET_REASONING,
            QUIET_REASONING_GENERATION,
            125,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(failed.status, "rollback");
    if (failed.status !== "rollback") throw new Error("expected rollback");
    assert.equal(failed.move.action, "rollback");
    assert.equal(failed.move.priorRevision, QUIET_REASONING);
    assert.equal(failed.move.priorGeneration, QUIET_REASONING_GENERATION);
    assert.equal(failed.move.nextRevision, SETTLEMENT_RECOVERY);
    assert.equal(failed.move.nextGeneration, 36);
    assert.equal(failed.move.nextGeneration, failed.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(failed.move.priorHealthyProof),
      canonicalStringify(settlementHealthy),
    );

    // A failure that does not bind the exact pointer, a no-execution
    // settlement and a missing recorded prior never roll back.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: settlementHealthy,
          executionProof: failedProof(QUIET_REASONING, 34, 126),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: settlementHealthy,
          executionProof: notStartedProof(
            QUIET_REASONING,
            QUIET_REASONING_GENERATION,
          ),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          executionProof: failedProof(
            QUIET_REASONING,
            QUIET_REASONING_GENERATION,
            127,
          ),
        }),
      }),
    ];
    for (const state of waits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // The post-rollback generation 36 pointer is terminal: it is outside the
    // one-shot chain and never reattempts either movement.
    for (
      const healthy of [
        healthyProof(SETTLEMENT_RECOVERY, 36, 128),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: SETTLEMENT_RECOVERY,
              generation: 36,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "no_change",
      );
    }
  },
);

Deno.test(
  "owner install: base fetch revision preserves install and rollback gates",
  () => {
    const quietHealthy = healthyProof(QUIET_REASONING, 35, 131);
    // The fixed owner-approved pin: only the recorded generation 35 healthy
    // proof authorizes exactly one move to the base fetch revision.
    const install = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: QUIET_REASONING,
          generation: QUIET_REASONING_GENERATION,
          healthyProof: quietHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(install.status, "install");
    if (install.status !== "install") throw new Error("expected install");
    assert.equal(install.move.action, "install");
    assert.equal(install.move.priorRevision, QUIET_REASONING);
    assert.equal(install.move.priorGeneration, QUIET_REASONING_GENERATION);
    assert.equal(install.move.nextRevision, BASE_FETCH);
    assert.equal(install.move.nextGeneration, BASE_FETCH_GENERATION);
    assert.equal(install.move.nextGeneration, install.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(install.move.priorHealthyProof),
      canonicalStringify(quietHealthy),
    );

    // A healthy proof bound to another revision or generation, and no
    // recorded proof at all, never authorize the fixed pin.
    for (
      const healthy of [
        healthyProof(BASE_FETCH, 35, 132),
        healthyProof(QUIET_REASONING, 36, 133),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: QUIET_REASONING,
              generation: QUIET_REASONING_GENERATION,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "waiting",
      );
    }

    // An in-flight execution, a non-terminal release and an active cooldown
    // each keep the pin a zero-write wait.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: QUIET_REASONING,
            generation: QUIET_REASONING_GENERATION,
            healthyProof: quietHealthy,
            execution: executionIntent(
              QUIET_REASONING,
              QUIET_REASONING_GENERATION,
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
            revision: QUIET_REASONING,
            generation: QUIET_REASONING_GENERATION,
            healthyProof: quietHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: QUIET_REASONING,
            generation: QUIET_REASONING_GENERATION,
            healthyProof: quietHealthy,
          }),
          cooldowns: [cooldown(NOW + 1)],
        }),
        NOW,
      ).status,
      "waiting",
    );

    // The installed generation 36 pointer is stable only with its own bound
    // healthy proof; that proof authorizes the fixed review model install to
    // generation 37.
    const baseFetchHealthy = healthyProof(BASE_FETCH, 36, 134);
    const reviewModelInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: baseFetchHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(reviewModelInstall.status, "install");
    if (reviewModelInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(reviewModelInstall.move.priorRevision, BASE_FETCH);
    assert.equal(
      reviewModelInstall.move.priorGeneration,
      BASE_FETCH_GENERATION,
    );
    assert.equal(reviewModelInstall.move.nextRevision, REVIEW_MODEL);
    assert.equal(
      reviewModelInstall.move.nextGeneration,
      REVIEW_MODEL_GENERATION,
    );
    assert.equal(
      canonicalStringify(reviewModelInstall.move.priorHealthyProof),
      canonicalStringify(baseFetchHealthy),
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: BASE_FETCH,
            generation: BASE_FETCH_GENERATION,
            healthyProof: quietHealthy,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );

    // A failed generation 36 candidate settles exactly once by rolling back
    // to the exact previously proven generation 35 revision with a monotonic
    // generation 37, authorized by its recorded healthy proof.
    const failed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: quietHealthy,
          executionProof: failedProof(BASE_FETCH, BASE_FETCH_GENERATION, 135),
        }),
      }),
      NOW,
    );
    assert.equal(failed.status, "rollback");
    if (failed.status !== "rollback") throw new Error("expected rollback");
    assert.equal(failed.move.action, "rollback");
    assert.equal(failed.move.priorRevision, BASE_FETCH);
    assert.equal(failed.move.priorGeneration, BASE_FETCH_GENERATION);
    assert.equal(failed.move.nextRevision, QUIET_REASONING);
    assert.equal(failed.move.nextGeneration, 37);
    assert.equal(failed.move.nextGeneration, failed.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(failed.move.priorHealthyProof),
      canonicalStringify(quietHealthy),
    );

    // A failure that does not bind the exact pointer, a no-execution
    // settlement and a missing recorded prior never roll back.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: quietHealthy,
          executionProof: failedProof(BASE_FETCH, 35, 136),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          healthyProof: quietHealthy,
          executionProof: notStartedProof(BASE_FETCH, BASE_FETCH_GENERATION),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: BASE_FETCH,
          generation: BASE_FETCH_GENERATION,
          executionProof: failedProof(BASE_FETCH, BASE_FETCH_GENERATION, 137),
        }),
      }),
    ];
    for (const state of waits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
      assert.equal(plan.status, "waiting");
    }

    // The post-rollback generation 37 pointer is terminal: it is outside the
    // one-shot chain and never reattempts either movement.
    for (
      const healthy of [
        healthyProof(QUIET_REASONING, 37, 138),
        null,
      ]
    ) {
      assert.equal(
        planOwnerDevelopmentInstall(
          releaseSnapshot({
            runtime: runtimeRecord({
              revision: QUIET_REASONING,
              generation: 37,
              healthyProof: healthy,
            }),
          }),
          NOW,
        ).status,
        "no_change",
      );
    }
  },
);

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
