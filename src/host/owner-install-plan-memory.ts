import { canonicalStringify } from "../contracts/canonical.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CANCELLED_DELIVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN77_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GEN77_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GEN77_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN78_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GEN78_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GEN78_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN79_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GEN79_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GEN79_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LEARNING_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_LEARNING_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LEARNING_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MEMORY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MEMORY_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MEMORY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_REVISION,
  OWNER_DEVELOPMENT_INSTALL_STABILIZATION_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_STABILIZATION_REVISION,
  OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_REVISION,
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
  failedSettlementFor,
  healthyProofFor,
  movePlan,
  noChange,
  waiting,
} from "./owner-install-plan-proof.ts";

function mismatchRetryPriorProof(
  runtime: OwnerInstallPlanContextV1["runtime"],
) {
  const retained = healthyProofFor(
    runtime,
    OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_PRIOR_REVISION,
    OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_PRIOR_GENERATION,
  );
  if (retained !== null) return retained;
  const bootstrap = healthyProofFor(
    runtime,
    OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_PRIOR_REVISION,
    OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_GENERATION,
  );
  return bootstrap?.execution.purpose === "bootstrap" &&
      bootstrap.execution.releaseId === null
    ? bootstrap
    : null;
}

/** Ordered diagnostics, merge, delivery, versioned, learning and memory rungs. Unmatched pointers continue to the next group. */
export function planOwnerInstallMemory(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  // A failed generation 78 retains the existing generation 78 rollback below.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_GEN79_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_GEN79_PRIOR_GENERATION &&
    healthy !== null && failed === null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION,
      OWNER_DEVELOPMENT_INSTALL_GEN79_GENERATION,
      healthy,
      "install the generation 79 runtime after its exact generation 78 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_GEN79_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_GEN79_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GEN79_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_GEN79_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the exact recorded generation 78 healthy proof for the generation 79 rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GEN79_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed generation 79 runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting("the generation 79 healthy proof is not recorded");
  }

  // A failed generation 77 retains the existing generation 77 rollback below.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_GEN78_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_GEN78_PRIOR_GENERATION &&
    healthy !== null && failed === null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION,
      OWNER_DEVELOPMENT_INSTALL_GEN78_GENERATION,
      healthy,
      "install the generation 78 runtime after its exact generation 77 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_GEN78_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_GEN78_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GEN78_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_GEN78_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the exact recorded generation 77 healthy proof for the generation 78 rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GEN78_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed generation 78 runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting("the generation 78 healthy proof is not recorded");
  }

  // A failed generation 76 retains the existing throughput rollback below.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_GEN77_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_GEN77_PRIOR_GENERATION &&
    healthy !== null && failed === null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION,
      OWNER_DEVELOPMENT_INSTALL_GEN77_GENERATION,
      healthy,
      "install the generation 77 runtime after its exact generation 76 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_GEN77_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_GEN77_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GEN77_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_GEN77_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the exact recorded generation 76 healthy proof for the generation 77 rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GEN77_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed generation 77 runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting("the generation 77 healthy proof is not recorded");
  }

  // A failed R2 prior retains the existing stabilization rollback below.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_GENERATION &&
    healthy !== null && failed === null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_REVISION,
      OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_GENERATION,
      healthy,
      "install the fixed throughput runtime after its exact generation 75 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the exact recorded generation 75 healthy proof for the throughput rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_THROUGHPUT_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed throughput runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the throughput generation 76 healthy proof is not recorded",
    );
  }

  // This exact revision-bound transition is separate from the historical
  // generation 75 retry below. A failed prior keeps its original rollback.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_GENERATION &&
    healthy !== null && failed === null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_STABILIZATION_REVISION,
      OWNER_DEVELOPMENT_INSTALL_STABILIZATION_GENERATION,
      healthy,
      "install the fixed stabilization runtime after its exact generation 74 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_STABILIZATION_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_STABILIZATION_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the exact recorded generation 74 healthy proof for the stabilization rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_STABILIZATION_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed stabilization runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the stabilization generation 75 healthy proof is not recorded",
    );
  }

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
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_GENERATION,
        healthy,
        "install the mismatch-disposition runtime after its generation 73 healthy proof",
      );
    }
    return waiting(
      "the early-frame diagnostics generation 73 healthy proof is not recorded",
    );
  }

  // Mismatch-disposition rung. Only a HEALTHY generation 73 record takes this
  // branch; a failed 73 falls through to the early-frame rung's own rollback
  // below, so its rollback semantics stay as recorded.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_PRIOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_PRIOR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded generation 73 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed mismatch-disposition runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the mismatch-disposition generation 74 healthy proof is not recorded",
    );
  }

  // The exact rollback preserves generation 72 health until the protected
  // supervisor replaces it with its own generation 74 bootstrap settlement.
  // Either native producer must bind this same recorded predecessor; retain
  // the actual authorizing proof for retry failure restoration.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_STACKED_MERGE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_GENERATION
  ) {
    const prior = mismatchRetryPriorProof(runtime);
    if (prior === null) {
      return waiting(
        "the exact retained predecessor or rollback bootstrap healthy proof for the retry rung is unavailable",
      );
    }
    if (
      prior.execution.generation ===
          OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_PRIOR_GENERATION
        ? failedSettlementFor(
          runtime,
          OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_REVISION,
          OWNER_DEVELOPMENT_INSTALL_EARLY_FRAME_GENERATION,
        ) === null
        : canonicalStringify(prior) !==
          canonicalStringify(runtime.lastExecutionProof)
    ) {
      return waiting(
        "the exact failed producer or current rollback bootstrap settlement for the retry rung is unavailable",
      );
    }
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_REVISION,
      OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_GENERATION,
      prior,
      "install the mismatch-disposition retry runtime after its exact rollback producer proof",
    );
  }

  if (
    revision ===
      OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_REVISION &&
    generation ===
      OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_GENERATION
  ) {
    if (failed !== null) {
      const prior = mismatchRetryPriorProof(runtime);
      if (prior === null) {
        return waiting(
          "the exact recorded predecessor healthy proof for the retry rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MISMATCH_DISPOSITION_RETRY_PRIOR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed mismatch-disposition retry runtime to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the mismatch-disposition retry generation 75 healthy proof is not recorded",
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
