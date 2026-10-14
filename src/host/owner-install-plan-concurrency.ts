import {
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PLANNER_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PLANNER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_REVISION,
} from "./owner-install-runtime-pins.ts";
import type {
  OwnerDevelopmentInstallPlanV1,
  OwnerInstallPlanContextV1,
} from "./owner-install-types.ts";
import {
  healthyProofFor,
  movePlan,
  noChange,
  waiting,
} from "./owner-install-plan-proof.ts";

/** Concurrency, retry and planner generations with their own settlements. Unmatched pointers continue to the next group. */
export function planOwnerInstallConcurrency(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_GENERATION
  ) {
    const settlement = runtime.lastExecutionProof;
    if (
      healthy === null || settlement === null ||
      settlement.outcome !== "healthy" ||
      settlement.execution.revision !== revision ||
      settlement.execution.generation !== generation ||
      settlement.observedAt < healthy.observedAt
    ) {
      return waiting(
        "the current generation 56 healthy settlement is not recorded",
      );
    }
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_REVISION,
      OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_GENERATION,
      healthy,
      "install the concurrency revision after the generation 56 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 56 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed concurrency candidate to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the concurrency generation 57 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_PRIOR_GENERATION
  ) {
    const settlement = runtime.lastExecutionProof;
    if (
      healthy === null || settlement === null ||
      settlement.outcome !== "healthy" ||
      settlement.execution.revision !== revision ||
      settlement.execution.generation !== generation ||
      settlement.observedAt < healthy.observedAt
    ) {
      return waiting(
        "the current generation 58 healthy settlement is not recorded",
      );
    }
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_REVISION,
      OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_GENERATION,
      healthy,
      "install the concurrency retry after its own generation 58 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 58 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed concurrency retry to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      const settlement = runtime.lastExecutionProof;
      if (
        settlement === null || settlement.outcome !== "healthy" ||
        settlement.execution.revision !== revision ||
        settlement.execution.generation !== generation ||
        settlement.observedAt < healthy.observedAt
      ) {
        return waiting(
          "the current generation 59 healthy settlement is not recorded",
        );
      }
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PLANNER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PLANNER_GENERATION,
        healthy,
        "install the planner successor after its own generation 59 healthy proof",
      );
    }
    return waiting(
      "the concurrency retry generation 59 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PLANNER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_PLANNER_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 59 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CONCURRENCY_RETRY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed planner successor to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the planner successor generation 60 healthy proof is not recorded",
    );
  }

  return undefined;
}
