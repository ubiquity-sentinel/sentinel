import { DORMANT_HOSTED_SUPERVISOR_POLICY } from "./hosted-supervisor-policy-fixture.ts";
import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  buildOwnerDevelopmentInstallSnapshot
    as productionBuildOwnerDevelopmentInstallSnapshot,
  OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
  planOwnerDevelopmentInstall as productionPlanOwnerDevelopmentInstall,
} from "../../src/host/owner-development-install.ts";
import {
  AGGREGATE,
  CANCELLED_RELEASE_RUNTIME_REVISION,
  EARLY_FRAME_RUNTIME_REVISION,
  LEARNING_RUNTIME_REVISION,
  MEMORY_RUNTIME_REVISION,
  MISMATCH_DISPOSITION_RUNTIME_REVISION,
  NOW,
  ORIGINAL,
  READER,
  STACKED_MERGE_RUNTIME_REVISION,
  STATE_HEAD,
  UNRELATED,
  VERSIONED_RUNTIME_REVISION,
} from "./owner-install-fixture-constants.ts";
import {
  acceptedRelease,
  cooldown,
  executionIntent,
  failedProof,
  healthyProof,
  notStartedProof,
  releaseSnapshot,
  requestedRelease,
  runtimeRecord,
} from "./owner-install-fixture-proofs.ts";

/**
 * Owner-authorized development installation: the pure planning and
 * serialization boundary only. These tests build parsed release snapshots with
 * the real contract parsers and assert the fixed one-shot decisions, the exact
 * intended snapshot movement and the canonical state-file bytes. No store,
 * network, Git write, model, credential or paid call is touched.
 */
Deno.test(
  "owner development install plan: original generation 5 installs the reader only with its exact healthy proof",
  () => {
    const proof = healthyProof(ORIGINAL, 5, 51);
    const ready = releaseSnapshot({
      runtime: runtimeRecord({
        revision: ORIGINAL,
        generation: 5,
        healthyProof: proof,
        executionProof: proof,
      }),
    });
    const plan = planOwnerDevelopmentInstall(ready, NOW);
    assert.equal(plan.status, "install");
    if (plan.status !== "install") throw new Error("expected install");
    assert.equal(plan.move.action, "install");
    assert.equal(plan.move.priorRevision, ORIGINAL);
    assert.equal(plan.move.priorGeneration, 5);
    assert.equal(plan.move.nextRevision, READER);
    assert.equal(plan.move.nextGeneration, 6);
    assert.equal(
      plan.move.nextGeneration,
      OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
    );
    assert.equal(plan.move.nextGeneration, plan.move.priorGeneration + 1);
    assert.equal(
      canonicalStringify(plan.move.priorHealthyProof),
      canonicalStringify(proof),
    );

    // Missing, unrelated and stale healthy proofs are zero-write waits.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({ revision: ORIGINAL, generation: 5 }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ORIGINAL,
          generation: 5,
          healthyProof: healthyProof(READER, 6, 52),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ORIGINAL,
          generation: 5,
          healthyProof: healthyProof(ORIGINAL, 4, 53),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: ORIGINAL,
          generation: 5,
          healthyProof: healthyProof(UNRELATED, 5, 54),
        }),
      }),
    ];
    for (const state of waits) {
      assert.equal(planOwnerDevelopmentInstall(state, NOW).status, "waiting");
    }
  },
);

Deno.test(
  "owner development install plan: in-flight execution, active release and active cooldown wait",
  () => {
    const proof = healthyProof(ORIGINAL, 5, 55);
    const runtime = runtimeRecord({
      revision: ORIGINAL,
      generation: 5,
      healthyProof: proof,
      executionProof: proof,
    });
    const inFlight = releaseSnapshot({
      runtime: runtimeRecord({
        revision: ORIGINAL,
        generation: 5,
        healthyProof: proof,
        executionProof: proof,
        execution: executionIntent(ORIGINAL, 5),
      }),
    });
    assert.equal(planOwnerDevelopmentInstall(inFlight, NOW).status, "waiting");

    const activeRelease = releaseSnapshot({
      runtime,
      hostedReleases: [requestedRelease()],
    });
    assert.equal(
      planOwnerDevelopmentInstall(activeRelease, NOW).status,
      "waiting",
    );

    const activeCooldown = releaseSnapshot({
      runtime,
      cooldowns: [cooldown(NOW + 60_000)],
    });
    assert.equal(
      planOwnerDevelopmentInstall(activeCooldown, NOW).status,
      "waiting",
    );

    // An expired cooldown is history, not a recurring global stop.
    const expiredCooldown = releaseSnapshot({
      runtime,
      cooldowns: [cooldown(NOW - 1)],
    });
    assert.equal(
      planOwnerDevelopmentInstall(expiredCooldown, NOW).status,
      "install",
    );
  },
);

Deno.test(
  "owner development install plan: reader generation 6 installs the aggregate only after its exact fresh healthy proof",
  () => {
    const proof = healthyProof(READER, 6, 56);
    const ready = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: proof,
        executionProof: proof,
      }),
      hostedReleases: [acceptedRelease()],
    });
    const plan = planOwnerDevelopmentInstall(ready, NOW);
    assert.equal(plan.status, "install");
    if (plan.status !== "install") throw new Error("expected install");
    assert.equal(plan.move.priorRevision, READER);
    assert.equal(plan.move.priorGeneration, 6);
    assert.equal(plan.move.nextRevision, AGGREGATE);
    assert.equal(plan.move.nextGeneration, 7);

    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({ revision: READER, generation: 6 }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: healthyProof(READER, 5, 57),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: healthyProof(ORIGINAL, 5, 58),
        }),
      }),
    ];
    for (const state of waits) {
      assert.equal(planOwnerDevelopmentInstall(state, NOW).status, "waiting");
    }
  },
);

Deno.test(
  "owner development install plan: an exact failed candidate rolls back once only to its fixed recorded prior",
  () => {
    const originalHealthy = healthyProof(ORIGINAL, 5, 61);
    const readerHealthy = healthyProof(READER, 6, 62);

    const readerFailed = releaseSnapshot({
      runtime: runtimeRecord({
        revision: READER,
        generation: 6,
        healthyProof: originalHealthy,
        executionProof: failedProof(READER, 6, 63),
      }),
    });
    const readerPlan = planOwnerDevelopmentInstall(readerFailed, NOW);
    assert.equal(readerPlan.status, "rollback");
    if (readerPlan.status !== "rollback") throw new Error("expected rollback");
    assert.equal(readerPlan.move.priorRevision, READER);
    assert.equal(readerPlan.move.priorGeneration, 6);
    assert.equal(readerPlan.move.nextRevision, ORIGINAL);
    assert.equal(readerPlan.move.nextGeneration, 7);
    assert.equal(
      canonicalStringify(readerPlan.move.priorHealthyProof),
      canonicalStringify(originalHealthy),
    );

    const aggregateFailed = releaseSnapshot({
      runtime: runtimeRecord({
        revision: AGGREGATE,
        generation: 7,
        healthyProof: readerHealthy,
        executionProof: failedProof(AGGREGATE, 7, 64),
      }),
    });
    const aggregatePlan = planOwnerDevelopmentInstall(aggregateFailed, NOW);
    assert.equal(aggregatePlan.status, "rollback");
    if (aggregatePlan.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(aggregatePlan.move.nextRevision, READER);
    assert.equal(aggregatePlan.move.nextGeneration, 8);
    assert.equal(
      canonicalStringify(aggregatePlan.move.priorHealthyProof),
      canonicalStringify(readerHealthy),
    );

    // Failures that do not bind the exact pointer, a missing recorded prior
    // and a no-execution settlement never roll back.
    const waits = [
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: originalHealthy,
          executionProof: failedProof(READER, 5, 65),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: originalHealthy,
          executionProof: failedProof(UNRELATED, 6, 66),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          executionProof: failedProof(READER, 6, 67),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: READER,
          generation: 6,
          healthyProof: originalHealthy,
          executionProof: notStartedProof(READER, 6),
        }),
      }),
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: UNRELATED,
          generation: 9,
          executionProof: failedProof(UNRELATED, 9, 68),
        }),
      }),
    ];
    for (const state of waits) {
      const plan = planOwnerDevelopmentInstall(state, NOW);
      assert.notEqual(plan.status, "rollback");
    }
    assert.equal(
      planOwnerDevelopmentInstall(waits[0], NOW).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(waits[1], NOW).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(waits[2], NOW).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(waits[3], NOW).status,
      "waiting",
    );
    assert.equal(
      planOwnerDevelopmentInstall(waits[4], NOW).status,
      "no_change",
    );
  },
);

Deno.test(
  "owner development install plan: generation 69 learning install follows a healthy 68 and rolls back once",
  () => {
    const memoryHealthy = healthyProof(MEMORY_RUNTIME_REVISION, 68, 141);
    const learningInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MEMORY_RUNTIME_REVISION,
          generation: 68,
          healthyProof: memoryHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(learningInstall.status, "install");
    if (learningInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(learningInstall.move.priorRevision, MEMORY_RUNTIME_REVISION);
    assert.equal(learningInstall.move.priorGeneration, 68);
    assert.equal(learningInstall.move.nextRevision, LEARNING_RUNTIME_REVISION);
    assert.equal(learningInstall.move.nextGeneration, 69);
    assert.equal(
      canonicalStringify(learningInstall.move.priorHealthyProof),
      canonicalStringify(memoryHealthy),
    );

    // A failed generation 69 restores the recorded generation 68 revision
    // exactly once at monotonic generation 70; the post-rollback pointer is
    // then terminal.
    const learningRollback = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: LEARNING_RUNTIME_REVISION,
          generation: 69,
          healthyProof: memoryHealthy,
          executionProof: failedProof(LEARNING_RUNTIME_REVISION, 69, 142),
        }),
      }),
      NOW,
    );
    assert.equal(learningRollback.status, "rollback");
    if (learningRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(
      learningRollback.move.priorRevision,
      LEARNING_RUNTIME_REVISION,
    );
    assert.equal(learningRollback.move.priorGeneration, 69);
    assert.equal(learningRollback.move.nextRevision, MEMORY_RUNTIME_REVISION);
    assert.equal(learningRollback.move.nextGeneration, 70);
    assert.equal(
      canonicalStringify(learningRollback.move.priorHealthyProof),
      canonicalStringify(memoryHealthy),
    );

    // Without the recorded generation 68 healthy proof the learning install
    // waits instead of moving the pointer.
    assert.equal(
      planOwnerDevelopmentInstall(
        releaseSnapshot({
          runtime: runtimeRecord({
            revision: MEMORY_RUNTIME_REVISION,
            generation: 68,
            healthyProof: null,
          }),
        }),
        NOW,
      ).status,
      "waiting",
    );
  },
);

Deno.test(
  "owner development install plan: generation 70 versioned-recovery install follows a healthy 69 and rolls back once",
  () => {
    const learningHealthy = healthyProof(LEARNING_RUNTIME_REVISION, 69, 151);
    const versionedInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: LEARNING_RUNTIME_REVISION,
          generation: 69,
          healthyProof: learningHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(versionedInstall.status, "install");
    if (versionedInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(
      versionedInstall.move.priorRevision,
      LEARNING_RUNTIME_REVISION,
    );
    assert.equal(versionedInstall.move.priorGeneration, 69);
    assert.equal(
      versionedInstall.move.nextRevision,
      VERSIONED_RUNTIME_REVISION,
    );
    assert.equal(versionedInstall.move.nextGeneration, 70);
    assert.equal(
      canonicalStringify(versionedInstall.move.priorHealthyProof),
      canonicalStringify(learningHealthy),
    );

    // A failed generation 70 restores the recorded generation 69 revision
    // once at monotonic generation 71.
    const versionedRollback = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: VERSIONED_RUNTIME_REVISION,
          generation: 70,
          healthyProof: learningHealthy,
          executionProof: failedProof(VERSIONED_RUNTIME_REVISION, 70, 152),
        }),
      }),
      NOW,
    );
    assert.equal(versionedRollback.status, "rollback");
    if (versionedRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(
      versionedRollback.move.priorRevision,
      VERSIONED_RUNTIME_REVISION,
    );
    assert.equal(versionedRollback.move.priorGeneration, 70);
    assert.equal(
      versionedRollback.move.nextRevision,
      LEARNING_RUNTIME_REVISION,
    );
    assert.equal(versionedRollback.move.nextGeneration, 71);
    assert.equal(
      canonicalStringify(versionedRollback.move.priorHealthyProof),
      canonicalStringify(learningHealthy),
    );

    // A failed generation 69 still falls through to the learning rung's own
    // rollback, never to the versioned rung.
    const learningFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: LEARNING_RUNTIME_REVISION,
          generation: 69,
          healthyProof: healthyProof(MEMORY_RUNTIME_REVISION, 68, 153),
          executionProof: failedProof(LEARNING_RUNTIME_REVISION, 69, 154),
        }),
      }),
      NOW,
    );
    assert.equal(learningFailed.status, "rollback");
    if (learningFailed.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(learningFailed.move.nextRevision, MEMORY_RUNTIME_REVISION);
    assert.equal(learningFailed.move.nextGeneration, 70);
  },
);

Deno.test(
  "owner development install plan: generation 71 cancelled-release settlement install follows a healthy 70 and rolls back once",
  () => {
    const versionedHealthy = healthyProof(VERSIONED_RUNTIME_REVISION, 70, 161);
    const settlementInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: VERSIONED_RUNTIME_REVISION,
          generation: 70,
          healthyProof: versionedHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(settlementInstall.status, "install");
    if (settlementInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(
      settlementInstall.move.priorRevision,
      VERSIONED_RUNTIME_REVISION,
    );
    assert.equal(settlementInstall.move.priorGeneration, 70);
    assert.equal(
      settlementInstall.move.nextRevision,
      CANCELLED_RELEASE_RUNTIME_REVISION,
    );
    assert.equal(settlementInstall.move.nextGeneration, 71);
    assert.equal(
      canonicalStringify(settlementInstall.move.priorHealthyProof),
      canonicalStringify(versionedHealthy),
    );

    // A failed generation 71 restores the recorded generation 70 revision
    // once at monotonic generation 72.
    const settlementRollback = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANCELLED_RELEASE_RUNTIME_REVISION,
          generation: 71,
          healthyProof: versionedHealthy,
          executionProof: failedProof(
            CANCELLED_RELEASE_RUNTIME_REVISION,
            71,
            162,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(settlementRollback.status, "rollback");
    if (settlementRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(
      settlementRollback.move.priorRevision,
      CANCELLED_RELEASE_RUNTIME_REVISION,
    );
    assert.equal(settlementRollback.move.priorGeneration, 71);
    assert.equal(
      settlementRollback.move.nextRevision,
      VERSIONED_RUNTIME_REVISION,
    );
    assert.equal(settlementRollback.move.nextGeneration, 72);
    assert.equal(
      canonicalStringify(settlementRollback.move.priorHealthyProof),
      canonicalStringify(versionedHealthy),
    );

    // A failed generation 70 still falls through to the versioned rung's own
    // rollback, never to the settlement rung.
    const versionedFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: VERSIONED_RUNTIME_REVISION,
          generation: 70,
          healthyProof: healthyProof(LEARNING_RUNTIME_REVISION, 69, 163),
          executionProof: failedProof(VERSIONED_RUNTIME_REVISION, 70, 164),
        }),
      }),
      NOW,
    );
    assert.equal(versionedFailed.status, "rollback");
    if (versionedFailed.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(versionedFailed.move.nextRevision, LEARNING_RUNTIME_REVISION);
    assert.equal(versionedFailed.move.nextGeneration, 71);
  },
);

Deno.test(
  "owner development install plan: generation 72 stacked-merge verification install follows a healthy 71 and rolls back once",
  () => {
    const cancelledHealthy = healthyProof(
      CANCELLED_RELEASE_RUNTIME_REVISION,
      71,
      171,
    );
    const stackedInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANCELLED_RELEASE_RUNTIME_REVISION,
          generation: 71,
          healthyProof: cancelledHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(stackedInstall.status, "install");
    if (stackedInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(
      stackedInstall.move.priorRevision,
      CANCELLED_RELEASE_RUNTIME_REVISION,
    );
    assert.equal(stackedInstall.move.priorGeneration, 71);
    assert.equal(
      stackedInstall.move.nextRevision,
      STACKED_MERGE_RUNTIME_REVISION,
    );
    assert.equal(stackedInstall.move.nextGeneration, 72);
    assert.equal(
      canonicalStringify(stackedInstall.move.priorHealthyProof),
      canonicalStringify(cancelledHealthy),
    );

    // A failed generation 72 restores the recorded generation 71 revision
    // once at monotonic generation 73.
    const stackedRollback = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: STACKED_MERGE_RUNTIME_REVISION,
          generation: 72,
          healthyProof: cancelledHealthy,
          executionProof: failedProof(
            STACKED_MERGE_RUNTIME_REVISION,
            72,
            172,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(stackedRollback.status, "rollback");
    if (stackedRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(
      stackedRollback.move.priorRevision,
      STACKED_MERGE_RUNTIME_REVISION,
    );
    assert.equal(stackedRollback.move.priorGeneration, 72);
    assert.equal(
      stackedRollback.move.nextRevision,
      CANCELLED_RELEASE_RUNTIME_REVISION,
    );
    assert.equal(stackedRollback.move.nextGeneration, 73);

    // A failed generation 71 still falls through to the cancelled-delivery
    // rung's own rollback, never to the stacked-merge rung.
    const cancelledFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: CANCELLED_RELEASE_RUNTIME_REVISION,
          generation: 71,
          healthyProof: healthyProof(VERSIONED_RUNTIME_REVISION, 70, 173),
          executionProof: failedProof(
            CANCELLED_RELEASE_RUNTIME_REVISION,
            71,
            174,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(cancelledFailed.status, "rollback");
    if (cancelledFailed.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(cancelledFailed.move.nextRevision, VERSIONED_RUNTIME_REVISION);
    assert.equal(cancelledFailed.move.nextGeneration, 72);
  },
);

Deno.test(
  "owner development install plan: generation 73 early-frame diagnostics install follows a healthy 72 and rolls back once",
  () => {
    const stackedHealthy = healthyProof(
      STACKED_MERGE_RUNTIME_REVISION,
      72,
      181,
    );
    const earlyFrameInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: STACKED_MERGE_RUNTIME_REVISION,
          generation: 72,
          healthyProof: stackedHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(earlyFrameInstall.status, "install");
    if (earlyFrameInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(
      earlyFrameInstall.move.priorRevision,
      STACKED_MERGE_RUNTIME_REVISION,
    );
    assert.equal(earlyFrameInstall.move.priorGeneration, 72);
    assert.equal(
      earlyFrameInstall.move.nextRevision,
      EARLY_FRAME_RUNTIME_REVISION,
    );
    assert.equal(earlyFrameInstall.move.nextGeneration, 73);

    // A failed generation 73 restores the recorded generation 72 revision
    // once at monotonic generation 74.
    const earlyFrameRollback = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: EARLY_FRAME_RUNTIME_REVISION,
          generation: 73,
          healthyProof: stackedHealthy,
          executionProof: failedProof(EARLY_FRAME_RUNTIME_REVISION, 73, 182),
        }),
      }),
      NOW,
    );
    assert.equal(earlyFrameRollback.status, "rollback");
    if (earlyFrameRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(
      earlyFrameRollback.move.nextRevision,
      STACKED_MERGE_RUNTIME_REVISION,
    );
    assert.equal(earlyFrameRollback.move.nextGeneration, 74);

    // A generation 72 pointer carrying BOTH a healthy proof and a failed
    // settlement still takes the original rollback path: the successor never
    // installs over a failed candidate.
    const stackedBoth = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: STACKED_MERGE_RUNTIME_REVISION,
          generation: 72,
          healthyProof: stackedHealthy,
          executionProof: failedProof(STACKED_MERGE_RUNTIME_REVISION, 72, 185),
        }),
      }),
      NOW,
    );
    // With no recorded healthy proof for the rollback predecessor the chain
    // waits instead of installing: the successor still never installs over a
    // failed candidate.
    assert.equal(stackedBoth.status, "waiting");

    // A failed generation 72 still falls through to the stacked-merge rung's
    // own rollback, never to the early-frame rung.
    const stackedFailed = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: STACKED_MERGE_RUNTIME_REVISION,
          generation: 72,
          healthyProof: healthyProof(
            CANCELLED_RELEASE_RUNTIME_REVISION,
            71,
            183,
          ),
          executionProof: failedProof(STACKED_MERGE_RUNTIME_REVISION, 72, 184),
        }),
      }),
      NOW,
    );
    assert.equal(stackedFailed.status, "rollback");
    if (stackedFailed.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(
      stackedFailed.move.nextRevision,
      CANCELLED_RELEASE_RUNTIME_REVISION,
    );
    assert.equal(stackedFailed.move.nextGeneration, 73);
  },
);

Deno.test(
  "owner development install plan: generation 74 mismatch-disposition install follows a healthy 73 and rolls back once",
  () => {
    const earlyFrameHealthy = healthyProof(
      EARLY_FRAME_RUNTIME_REVISION,
      73,
      191,
    );
    const dispositionInstall = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: EARLY_FRAME_RUNTIME_REVISION,
          generation: 73,
          healthyProof: earlyFrameHealthy,
        }),
      }),
      NOW,
    );
    assert.equal(dispositionInstall.status, "install");
    if (dispositionInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(
      dispositionInstall.move.priorRevision,
      EARLY_FRAME_RUNTIME_REVISION,
    );
    assert.equal(dispositionInstall.move.priorGeneration, 73);
    assert.equal(
      dispositionInstall.move.nextRevision,
      MISMATCH_DISPOSITION_RUNTIME_REVISION,
    );
    assert.equal(dispositionInstall.move.nextGeneration, 74);
    assert.equal(
      canonicalStringify(dispositionInstall.move.priorHealthyProof),
      canonicalStringify(earlyFrameHealthy),
    );

    // A failed generation 74 restores the recorded generation 73 revision
    // once at monotonic generation 75.
    const dispositionRollback = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MISMATCH_DISPOSITION_RUNTIME_REVISION,
          generation: 74,
          healthyProof: earlyFrameHealthy,
          executionProof: failedProof(
            MISMATCH_DISPOSITION_RUNTIME_REVISION,
            74,
            192,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(dispositionRollback.status, "rollback");
    if (dispositionRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(
      dispositionRollback.move.nextRevision,
      EARLY_FRAME_RUNTIME_REVISION,
    );
    assert.equal(dispositionRollback.move.nextGeneration, 75);

    // A healthy generation 74 selects the separately pinned stabilization runtime.
    const dispositionComplete = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MISMATCH_DISPOSITION_RUNTIME_REVISION,
          generation: 74,
          healthyProof: healthyProof(
            MISMATCH_DISPOSITION_RUNTIME_REVISION,
            74,
            193,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(dispositionComplete.status, "install");
    if (dispositionComplete.status !== "install") {
      throw new Error("expected stabilization install");
    }
    assert.equal(
      dispositionComplete.move.nextRevision,
      "da9d6b437b6cb2725deed081b50778b7dc46a9a5",
    );
    assert.equal(dispositionComplete.move.nextGeneration, 75);
  },
);

Deno.test(
  "owner development install plan: generation 75 mismatch-disposition retry installs only after the once-only generation 74 rollback",
  () => {
    const stackedHealthy = healthyProof(
      STACKED_MERGE_RUNTIME_REVISION,
      72,
      201,
    );
    const source = releaseSnapshot({
      runtime: runtimeRecord({
        revision: STACKED_MERGE_RUNTIME_REVISION,
        generation: 72,
        healthyProof: stackedHealthy,
      }),
    });
    const earlyInstall = planOwnerDevelopmentInstall(source, NOW);
    if (earlyInstall.status !== "install") {
      throw new Error("expected early install");
    }
    const early = buildOwnerDevelopmentInstallSnapshot(
      source,
      STATE_HEAD,
      earlyInstall.move,
      NOW,
    );
    const failed = {
      ...early,
      hostedRuntimes: [{
        ...early.hostedRuntimes[0],
        lastExecutionProof: failedProof(EARLY_FRAME_RUNTIME_REVISION, 73, 202),
      }],
    };
    const earlyRollback = planOwnerDevelopmentInstall(failed, NOW + 1);
    if (earlyRollback.status !== "rollback") {
      throw new Error("expected early rollback");
    }
    const restored = buildOwnerDevelopmentInstallSnapshot(
      failed,
      STATE_HEAD,
      earlyRollback.move,
      NOW + 1,
    );
    assert.deepEqual(
      restored.hostedRuntimes[0].lastHealthyProof,
      stackedHealthy,
    );
    const retryInstall = planOwnerDevelopmentInstall(restored, NOW + 2);
    assert.equal(retryInstall.status, "install");
    if (retryInstall.status !== "install") {
      throw new Error("expected install");
    }
    assert.equal(
      retryInstall.move.priorRevision,
      STACKED_MERGE_RUNTIME_REVISION,
    );
    assert.equal(retryInstall.move.priorGeneration, 74);
    assert.equal(
      retryInstall.move.nextRevision,
      MISMATCH_DISPOSITION_RUNTIME_REVISION,
    );
    assert.equal(retryInstall.move.nextGeneration, 75);
    assert.equal(
      canonicalStringify(retryInstall.move.priorHealthyProof),
      canonicalStringify(stackedHealthy),
    );

    // A failed generation 75 restores the recorded generation 72 revision
    // once at monotonic generation 76.
    const retryRollback = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MISMATCH_DISPOSITION_RUNTIME_REVISION,
          generation: 75,
          healthyProof: stackedHealthy,
          executionProof: failedProof(
            MISMATCH_DISPOSITION_RUNTIME_REVISION,
            75,
            202,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(retryRollback.status, "rollback");
    if (retryRollback.status !== "rollback") {
      throw new Error("expected rollback");
    }
    assert.equal(
      retryRollback.move.nextRevision,
      STACKED_MERGE_RUNTIME_REVISION,
    );
    assert.equal(retryRollback.move.nextGeneration, 76);

    // A healthy generation 75 completes the chain.
    const retryComplete = planOwnerDevelopmentInstall(
      releaseSnapshot({
        runtime: runtimeRecord({
          revision: MISMATCH_DISPOSITION_RUNTIME_REVISION,
          generation: 75,
          healthyProof: healthyProof(
            MISMATCH_DISPOSITION_RUNTIME_REVISION,
            75,
            203,
          ),
        }),
      }),
      NOW,
    );
    assert.equal(retryComplete.status, "no_change");
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
