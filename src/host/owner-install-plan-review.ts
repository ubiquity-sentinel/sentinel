import {
  OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
} from "./owner-install-pins.ts";
import type {
  OwnerDevelopmentInstallPlanV1,
  OwnerInstallPlanContextV1,
} from "./owner-install-types.ts";
import {
  healthyProofFor,
  movePlan,
  waiting,
} from "./owner-install-plan-proof.ts";

/** Original reader, aggregate, review and exit-contract chain. Unmatched pointers continue to the next group. */
export function planOwnerInstallReview(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION
  ) {
    if (healthy === null) {
      return waiting("the original generation 5 healthy proof is not recorded");
    }
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
      OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
      healthy,
      "install the reader revision after the original healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_READER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_READER_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded original healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ORIGINAL_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed reader candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
        healthy,
        "install the aggregate revision after the reader healthy proof",
      );
    }
    return waiting("the reader generation 6 healthy proof is not recorded");
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_READER_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded reader healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_READER_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed aggregate candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION,
        healthy,
        "install the review recovery revision after the aggregate healthy proof",
      );
    }
    return waiting("the aggregate generation 7 healthy proof is not recorded");
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded aggregate healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_AGGREGATE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review recovery candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION,
        healthy,
        "install the review-step reconciliation after the review recovery healthy proof",
      );
    }
    return waiting(
      "the review recovery generation 8 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded review recovery healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECOVERY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review-step candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION,
        healthy,
        "install the reviewer provenance revision after the review-step healthy proof",
      );
    }
    return waiting(
      "the review-step generation 9 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded review-step healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_STEP_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed reviewer provenance candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION,
        healthy,
        "install the one-shot exit contract after the reviewer provenance healthy proof",
      );
    }
    return waiting(
      "the reviewer provenance generation 10 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded reviewer provenance healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEWER_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed exit contract candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION,
        healthy,
        "install the corrected grant revision after the exit-contract healthy proof",
      );
    }
    return waiting(
      "the exit contract generation 11 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded exit-contract healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_EXIT_CONTRACT_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed corrected grant candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION,
        healthy,
        "install the findings-feedback revision after the round-8 grant healthy proof",
      );
    }
    return waiting(
      "the corrected grant generation 12 healthy proof is not recorded",
    );
  }

  return undefined;
}
