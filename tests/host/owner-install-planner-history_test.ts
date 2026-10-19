import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall } from "../../src/host/owner-development-install.ts";
import {
  ADVANCE,
  AGGREGATE,
  APP_IDENTITY,
  CADENCE,
  CANDIDATE_AUTH,
  DELIVERED_ROUND2,
  EXIT_CONTRACT,
  FINDINGS,
  FOREIGN_AUTH,
  GUARD,
  HISTORY,
  LEDGER,
  MODEL_ROUTE,
  MULTI_TARGET,
  NOW,
  ORIGINAL,
  PRESERVE_SCOPE,
  QUIET_REASONING,
  QUIET_REASONING_GENERATION,
  READER,
  REASON_CODE,
  RECEIPT,
  RECOVERY,
  RELEASED,
  RESERVE_MODEL,
  RETIRE,
  REVIEW_STEP,
  REVIEWER,
  ROUND8,
  SCOPE_GATE,
  SETTLEMENT,
  SETTLEMENT_RECOVERY,
  TRIGGER,
  UNRELATED,
} from "./owner-install-fixture-constants.ts";
import {
  failedProof,
  healthyProof,
  releaseSnapshot,
  requestedRelease,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";

Deno.test(
  "owner development install plan: completed and unrelated pointers do nothing",
  () => {
    const originalHealthy = healthyProof(ORIGINAL, 5, 71);
    const readerHealthy = healthyProof(READER, 6, 72);
    const aggregateHealthy = healthyProof(AGGREGATE, 7, 73);

    // Post-rollback targets never reattempt installation.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: ORIGINAL,
            generation: 7,
            healthyProof: originalHealthy,
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: READER,
            generation: 8,
            healthyProof: readerHealthy,
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: AGGREGATE,
            generation: 7,
            healthyProof: aggregateHealthy,
          }),
        }),
        NOW,
      ).status,
      "install",
      "the aggregate healthy proof authorizes the review recovery install",
    );
    // The review recovery healthy proof authorizes the review-step install.
    const recoveryHealthy = healthyProof(RECOVERY, 8, 75);
    const reviewStepPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RECOVERY,
          generation: 8,
          healthyProof: recoveryHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(reviewStepPlan.status, "install");
    if (reviewStepPlan.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(reviewStepPlan.move.nextRevision, REVIEW_STEP);
    assert.equal(reviewStepPlan.move.nextGeneration, 9);
    // The review-step healthy proof authorizes the reviewer provenance install.
    const reviewStepHealthy = healthyProof(REVIEW_STEP, 9, 78);
    const reviewerPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_STEP,
          generation: 9,
          healthyProof: reviewStepHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(reviewerPlan.status, "install");
    if (reviewerPlan.status !== "install") throw new Error("expected install");
    assert.equal(reviewerPlan.move.nextRevision, REVIEWER);
    assert.equal(reviewerPlan.move.nextGeneration, 10);
    // The reviewer healthy proof authorizes the exit-contract install.
    const reviewerHealthy = healthyProof(REVIEWER, 10, 79);
    const exitPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEWER,
          generation: 10,
          healthyProof: reviewerHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(exitPlan.status, "install");
    if (exitPlan.status !== "install") throw new Error("expected install");
    assert.equal(exitPlan.move.nextRevision, EXIT_CONTRACT);
    assert.equal(exitPlan.move.nextGeneration, 11);
    // The exit-contract healthy proof authorizes the corrected-grant install.
    const exitHealthy = healthyProof(EXIT_CONTRACT, 11, 81);
    const round8Plan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: EXIT_CONTRACT,
          generation: 11,
          healthyProof: exitHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(round8Plan.status, "install");
    if (round8Plan.status !== "install") throw new Error("expected install");
    assert.equal(round8Plan.move.nextRevision, ROUND8);
    assert.equal(round8Plan.move.nextGeneration, 12);
    // The corrected-grant healthy proof authorizes the findings install.
    const round8Healthy = healthyProof(ROUND8, 12, 83);
    const findingsPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ROUND8,
          generation: 12,
          healthyProof: round8Healthy,
        }),
      }),
      NOW,
    );
    assert.equal(findingsPlan.status, "install");
    if (findingsPlan.status !== "install") throw new Error("expected install");
    assert.equal(findingsPlan.move.nextRevision, FINDINGS);
    assert.equal(findingsPlan.move.nextGeneration, 13);
    // The findings healthy proof authorizes the rejection-history install.
    const findingsHealthy = healthyProof(FINDINGS, 13, 84);
    const historyPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: FINDINGS,
          generation: 13,
          healthyProof: findingsHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(historyPlan.status, "install");
    if (historyPlan.status !== "install") throw new Error("expected install");
    assert.equal(historyPlan.move.nextRevision, HISTORY);
    assert.equal(historyPlan.move.nextGeneration, 14);
    // The rejection-history healthy proof authorizes the receipt install.
    const historyHealthy = healthyProof(HISTORY, 14, 85);
    const receiptPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: HISTORY,
          generation: 14,
          healthyProof: historyHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(receiptPlan.status, "install");
    if (receiptPlan.status !== "install") throw new Error("expected install");
    assert.equal(receiptPlan.move.nextRevision, RECEIPT);
    assert.equal(receiptPlan.move.nextGeneration, 15);
    // The receipt-submission healthy proof authorizes the ledger install.
    const receiptHealthy = healthyProof(RECEIPT, 15, 86);
    const ledgerPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RECEIPT,
          generation: 15,
          healthyProof: receiptHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(ledgerPlan.status, "install");
    if (ledgerPlan.status !== "install") throw new Error("expected install");
    assert.equal(ledgerPlan.move.nextRevision, LEDGER);
    assert.equal(ledgerPlan.move.nextGeneration, 16);
    // The ledger healthy proof authorizes the settlement install, and the
    // settlement generation is the fixed end of the chain.
    const ledgerHealthy = healthyProof(LEDGER, 16, 87);
    const settlementPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: LEDGER,
          generation: 16,
          healthyProof: ledgerHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(settlementPlan.status, "install");
    if (settlementPlan.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(settlementPlan.move.nextRevision, SETTLEMENT);
    assert.equal(settlementPlan.move.nextGeneration, 17);
    const settlementHealthy = healthyProof(SETTLEMENT, 17, 88);
    const settlementHealthyPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT,
          generation: 17,
          healthyProof: settlementHealthy,
        }),
      }),
      NOW,
    );
    // The settlement healthy proof cannot authorize the two-generation jump to
    // the trigger revision the snapshot builder always rejects; the separate
    // hosted promotion owns the 17 -> 18 movement, so this waits.
    assert.equal(settlementHealthyPlan.status, "waiting");
    // The released generation the promotion accepted installs the trigger.
    const releasedPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RELEASED,
          generation: 18,
          healthyProof: healthyProof(RELEASED, 18, 89),
        }),
      }),
      NOW,
    );
    assert.equal(releasedPlan.status, "install");
    if (releasedPlan.status !== "install") throw new Error("expected install");
    assert.equal(releasedPlan.move.nextRevision, TRIGGER);
    assert.equal(releasedPlan.move.nextGeneration, 19);
    // The trigger healthy proof authorizes the base-advance install.
    const triggerHealthy = healthyProof(TRIGGER, 19, 90);
    const advancePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: TRIGGER,
          generation: 19,
          healthyProof: triggerHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(advancePlan.status, "install");
    if (advancePlan.status !== "install") throw new Error("expected install");
    assert.equal(advancePlan.move.nextRevision, ADVANCE);
    assert.equal(advancePlan.move.nextGeneration, 20);
    // The base-advance healthy proof authorizes the cadence install.
    const advanceHealthy = healthyProof(ADVANCE, 20, 91);
    const cadencePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ADVANCE,
          generation: 20,
          healthyProof: advanceHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(cadencePlan.status, "install");
    if (cadencePlan.status !== "install") throw new Error("expected install");
    assert.equal(cadencePlan.move.nextRevision, CADENCE);
    assert.equal(cadencePlan.move.nextGeneration, 21);
    // The cadence healthy proof authorizes the guard install.
    const cadenceHealthy = healthyProof(CADENCE, 21, 92);
    const guardPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CADENCE,
          generation: 21,
          healthyProof: cadenceHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(guardPlan.status, "install");
    if (guardPlan.status !== "install") throw new Error("expected install");
    assert.equal(guardPlan.move.nextRevision, GUARD);
    assert.equal(guardPlan.move.nextGeneration, 22);
    // The guard healthy proof authorizes the retirement install.
    const guardHealthy = healthyProof(GUARD, 22, 93);
    const retirePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: GUARD,
          generation: 22,
          healthyProof: guardHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(retirePlan.status, "install");
    if (retirePlan.status !== "install") throw new Error("expected install");
    assert.equal(retirePlan.move.nextRevision, RETIRE);
    assert.equal(retirePlan.move.nextGeneration, 23);
    // The retirement generation itself is a no-op (its install already ran).
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: RETIRE,
            generation: 23,
            healthyProof: healthyProof(RETIRE, 23, 94),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );
    // The delivered round-2 revision past the retirement link authorizes the
    // App identity install; its own healthy proof is the authority.
    const appPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: DELIVERED_ROUND2,
          generation: 24,
          healthyProof: healthyProof(DELIVERED_ROUND2, 24, 95),
        }),
      }),
      NOW,
    );
    assert.equal(appPlan.status, "install");
    if (appPlan.status !== "install") throw new Error("expected install");
    assert.equal(appPlan.move.nextRevision, APP_IDENTITY);
    assert.equal(appPlan.move.nextGeneration, 25);
    // The App identity healthy proof authorizes the model-route install.
    const routePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: APP_IDENTITY,
          generation: 25,
          healthyProof: healthyProof(APP_IDENTITY, 25, 96),
        }),
      }),
      NOW,
    );
    assert.equal(routePlan.status, "install");
    if (routePlan.status !== "install") throw new Error("expected install");
    assert.equal(routePlan.move.nextRevision, MODEL_ROUTE);
    assert.equal(routePlan.move.nextGeneration, 26);
    // The model-route healthy proof authorizes the reserve-model install.
    const reservePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MODEL_ROUTE,
          generation: 26,
          healthyProof: healthyProof(MODEL_ROUTE, 26, 97),
        }),
      }),
      NOW,
    );
    assert.equal(reservePlan.status, "install");
    if (reservePlan.status !== "install") throw new Error("expected install");
    assert.equal(reservePlan.move.nextRevision, RESERVE_MODEL);
    assert.equal(reservePlan.move.nextGeneration, 27);
    // The reserve-model healthy proof authorizes the multi-target install.
    const multiTargetPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: RESERVE_MODEL,
          generation: 27,
          healthyProof: healthyProof(RESERVE_MODEL, 27, 98),
        }),
      }),
      NOW,
    );
    assert.equal(multiTargetPlan.status, "install");
    if (multiTargetPlan.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(multiTargetPlan.move.nextRevision, MULTI_TARGET);
    assert.equal(multiTargetPlan.move.nextGeneration, 28);
    // The multi-target healthy proof authorizes the scope-gate install.
    const scopeGatePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MULTI_TARGET,
          generation: 28,
          healthyProof: healthyProof(MULTI_TARGET, 28, 99),
        }),
      }),
      NOW,
    );
    assert.equal(scopeGatePlan.status, "install");
    if (scopeGatePlan.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(scopeGatePlan.move.nextRevision, SCOPE_GATE);
    assert.equal(scopeGatePlan.move.nextGeneration, 29);
    // The scope-gate healthy proof authorizes the target-scoped auth install.
    const authPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SCOPE_GATE,
          generation: 29,
          healthyProof: healthyProof(SCOPE_GATE, 29, 100),
        }),
      }),
      NOW,
    );
    assert.equal(authPlan.status, "install");
    if (authPlan.status !== "install") throw new Error("expected install");
    assert.equal(authPlan.move.nextRevision, CANDIDATE_AUTH);
    assert.equal(authPlan.move.nextGeneration, 30);
    // The candidate-auth healthy proof authorizes the preservation-scope
    // install.
    const preservePlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANDIDATE_AUTH,
          generation: 30,
          healthyProof: healthyProof(CANDIDATE_AUTH, 30, 101),
        }),
      }),
      NOW,
    );
    assert.equal(preservePlan.status, "install");
    if (preservePlan.status !== "install") throw new Error("expected install");
    assert.equal(preservePlan.move.nextRevision, PRESERVE_SCOPE);
    assert.equal(preservePlan.move.nextGeneration, 31);
    // The preserve-scope healthy proof authorizes the foreign-auth install.
    const auth2Plan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: PRESERVE_SCOPE,
          generation: 31,
          healthyProof: healthyProof(PRESERVE_SCOPE, 31, 102),
        }),
      }),
      NOW,
    );
    assert.equal(auth2Plan.status, "install");
    if (auth2Plan.status !== "install") throw new Error("expected install");
    assert.equal(auth2Plan.move.nextRevision, FOREIGN_AUTH);
    assert.equal(auth2Plan.move.nextGeneration, 32);
    // The foreign-auth healthy proof authorizes the reason-code install.
    const reasonPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: FOREIGN_AUTH,
          generation: 32,
          healthyProof: healthyProof(FOREIGN_AUTH, 32, 103),
        }),
      }),
      NOW,
    );
    assert.equal(reasonPlan.status, "install");
    if (reasonPlan.status !== "install") throw new Error("expected install");
    assert.equal(reasonPlan.move.nextRevision, REASON_CODE);
    assert.equal(reasonPlan.move.nextGeneration, 33);
    // The reason-code healthy proof authorizes the settlement recovery install
    // to the fixed owner-approved pin.
    const reasonSettled = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REASON_CODE,
          generation: 33,
          healthyProof: healthyProof(REASON_CODE, 33, 104),
        }),
      }),
      NOW,
    );
    assert.equal(reasonSettled.status, "install");
    if (reasonSettled.status !== "install") throw new Error("expected install");
    assert.equal(reasonSettled.move.nextRevision, SETTLEMENT_RECOVERY);
    assert.equal(reasonSettled.move.nextGeneration, 34);
    // The settlement recovery healthy proof authorizes the fixed
    // quiet-reasoning install, the last link of the chain.
    const quietPlan = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: SETTLEMENT_RECOVERY,
          generation: 34,
          healthyProof: healthyProof(SETTLEMENT_RECOVERY, 34, 105),
        }),
      }),
      NOW,
    );
    assert.equal(quietPlan.status, "install");
    if (quietPlan.status !== "install") throw new Error("expected install");
    assert.equal(quietPlan.move.nextRevision, QUIET_REASONING);
    assert.equal(quietPlan.move.nextGeneration, QUIET_REASONING_GENERATION);
    const exitFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: EXIT_CONTRACT,
          generation: 11,
          healthyProof: reviewerHealthy,
          executionProof: failedProof(EXIT_CONTRACT, 11, 82),
        }),
      }),
      NOW,
    );
    assert.equal(exitFailed.status, "rollback");
    if (exitFailed.status !== "rollback") throw new Error("expected rollback");
    assert.equal(exitFailed.move.nextRevision, REVIEWER);
    assert.equal(exitFailed.move.nextGeneration, 12);
    // A failed reviewer candidate rolls back once to the exact review-step
    // revision, authorized by its recorded healthy proof.
    const reviewerFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEWER,
          generation: 10,
          healthyProof: reviewStepHealthy,
          executionProof: failedProof(REVIEWER, 10, 80),
        }),
      }),
      NOW,
    );
    assert.equal(reviewerFailed.status, "rollback");
    if (reviewerFailed.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(reviewerFailed.move.nextRevision, REVIEW_STEP);
    assert.equal(reviewerFailed.move.nextGeneration, 11);
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({ revision: REVIEWER, generation: 10 }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    // A failed review-step candidate rolls back once to the exact review
    // recovery revision, authorized by its recorded healthy proof.
    const reviewStepFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: REVIEW_STEP,
          generation: 9,
          healthyProof: recoveryHealthy,
          executionProof: failedProof(REVIEW_STEP, 9, 79),
        }),
      }),
      NOW,
    );
    assert.equal(reviewStepFailed.status, "rollback");
    if (reviewStepFailed.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(reviewStepFailed.move.nextRevision, RECOVERY);
    assert.equal(reviewStepFailed.move.nextGeneration, 10);
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({ revision: REVIEW_STEP, generation: 9 }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    // A failed review recovery candidate rolls back once, to the exact
    // aggregate revision, authorized by its recorded healthy proof.
    const recoveryFailed = releaseSnapshot({
      runtime: runtimeRecord({
        revision: RECOVERY,
        generation: 8,
        healthyProof: aggregateHealthy,
        executionProof: failedProof(RECOVERY, 8, 76),
      }),
    });
    const recoveryRollback = planOwnerDevelopmentInstall(recoveryFailed, NOW);
    assert.equal(recoveryRollback.status, "rollback");
    if (recoveryRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(recoveryRollback.move.priorRevision, RECOVERY);
    assert.equal(recoveryRollback.move.nextRevision, AGGREGATE);
    assert.equal(recoveryRollback.move.nextGeneration, 9);
    assert.equal(
      canonicalStringify(recoveryRollback.move.priorHealthyProof),
      canonicalStringify(aggregateHealthy),
    );
    // Without the recorded aggregate healthy proof the rollback waits.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: RECOVERY,
            generation: 8,
            executionProof: failedProof(RECOVERY, 8, 77),
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    // A review recovery pointer without any proof yet is an ordinary wait for
    // the verification execution's healthy proof.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({ revision: RECOVERY, generation: 8 }),
        }),
        NOW,
      ).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: UNRELATED,
            generation: 9,
            healthyProof: healthyProof(UNRELATED, 9, 74),
          }),
        }),
        NOW,
      ).status,
      "no_change",
    );

    // No hosted runtime is the supervisor's own seeding work, not this gate.
    assert.equal(
      planOwnerDevelopmentInstall(releaseSnapshot({}), NOW).status,
      "waiting",
    );

    // An active hosted release waits even when the final revision is healthy.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: AGGREGATE,
            generation: 7,
            healthyProof: aggregateHealthy,
          }),
          hostedReleases: [requestedRelease()],
        }),
        NOW,
      ).status,
      "waiting",
    );
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
