import {
  OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LEARNING_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LEARNING_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MEMORY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MEMORY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_VERSIONED_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_VERSIONED_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_VERSIONED_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_VERSIONED_REVISION,
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

/** Ordered diagnostics, merge, delivery, versioned, learning and memory rungs. Unmatched pointers continue to the next group. */
export function planOwnerInstallMemory(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  // Early-frame diagnostics rung. Only a HEALTHY generation 72 record takes
  // this branch; a failed 72 falls through to the stacked-merge rung's own
  // rollback below, so its rollback semantics stay as recorded.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_GENERATION &&
    healthy !== null &&
    // A failed settlement on the prior generation keeps the original
    // rollback path: the successor never installs over a failed candidate.
    failed === null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_REVISION,
      OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_GENERATION,
      healthy,
      "install the early-frame diagnostics runtime after its generation 72 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 72 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed early-frame diagnostics runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the early-frame diagnostics generation 73 healthy proof is not recorded",
    );
  }

  // Stacked-merge verification rung. Only a HEALTHY generation 71 record
  // takes this branch; a failed 71 falls through to the cancelled-delivery
  // rung's own rollback below, so its rollback semantics stay as recorded.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_GENERATION &&
    healthy !== null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_REVISION,
      OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_GENERATION,
      healthy,
      "install the stacked-merge verification runtime after its generation 71 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 71 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed stacked-merge verification runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the stacked-merge verification generation 72 healthy proof is not recorded",
    );
  }

  // Cancelled-release settlement rung. Only a HEALTHY generation 70 record
  // takes this branch; a failed 70 falls through to the versioned rung's own
  // rollback below, so its two-stage rollback semantics stay exactly as
  // recorded.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_REVISION &&
    generation ===
      OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_GENERATION &&
    healthy !== null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_REVISION,
      OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_GENERATION,
      healthy,
      "install the cancelled-release settlement runtime after its generation 70 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 70 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed cancelled-release settlement runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the cancelled-release settlement generation 71 healthy proof is not recorded",
    );
  }

  // Versioned-recovery rung. Only a HEALTHY generation 69 record takes this
  // branch; a failed 69 falls through to the learning rung's rollback below,
  // so the two-stage rollback semantics stay exactly as recorded.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_VERSIONED_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_VERSIONED_PRIOR_GENERATION &&
    healthy !== null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_VERSIONED_REVISION,
      OWNER_DEVELOPMENT_INSTALL_VERSIONED_GENERATION,
      healthy,
      "install the versioned-recovery runtime after its generation 69 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_VERSIONED_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_VERSIONED_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_VERSIONED_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_VERSIONED_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 69 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_VERSIONED_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed versioned-recovery runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the versioned-recovery generation 70 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_GENERATION
  ) {
    if (healthy === null) {
      return waiting(
        "the recorded generation 68 healthy proof is not recorded",
      );
    }
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_LEARNING_REVISION,
      OWNER_DEVELOPMENT_INSTALL_LEARNING_GENERATION,
      healthy,
      "install the learning-depth runtime after its generation 68 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_LEARNING_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_LEARNING_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 68 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed learning-depth runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the learning-depth generation 69 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_GENERATION
  ) {
    if (healthy === null) {
      return waiting(
        "the recorded generation 67 healthy proof is not recorded",
      );
    }
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_MEMORY_REVISION,
      OWNER_DEVELOPMENT_INSTALL_MEMORY_GENERATION,
      healthy,
      "install the durable-memory runtime after its generation 67 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_MEMORY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_MEMORY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 67 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed durable-memory runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the durable-memory generation 68 healthy proof is not recorded",
    );
  }

  return undefined;
}
