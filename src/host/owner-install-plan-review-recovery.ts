import {
  OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
} from "./owner-install-pins.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ROLLBACK_TARGET_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RUNTIME_SOURCE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RUNTIME_SOURCE_REVISION,
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

/** Review-phase retry, livelock, wait, cooldown and child-deadline chain. Unmatched pointers continue to the next group. */
export function planOwnerInstallReviewRecovery(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure evidence
    // even when a healthy proof exists; the rollback still requires the
    // recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded assign-first healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review-phase PR candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the review-phase PR generation 45 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_ROLLBACK_TARGET_GENERATION
  ) {
    // Monotonic rollback target of the failed generation 45 candidate:
    // exactly one further owner-approved move installs the same review-phase
    // PR revision as generation 47, and a failed generation 47 candidate rolls
    // back exactly once more to this same recorded prior at generation 48.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ROLLBACK_TARGET_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded rollback-target healthy proof is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review-phase PR retry candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_GENERATION,
        healthy,
        "install the review-phase PR revision after the rollback-target healthy proof",
      );
    }
    return waiting(
      "the review-phase PR retry generation 47 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ROLLBACK_TARGET_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded rollback-target healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review-phase PR retry candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_REVISION,
        OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_GENERATION,
        healthy,
        "install the livelock-bound revision after the review-phase PR retry healthy proof",
      );
    }
    return waiting(
      "the review-phase PR retry generation 47 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_GENERATION
  ) {
    // A failed candidate settles exactly once by rolling back to the recorded
    // prior — the proven review-phase PR retry revision — at a monotonic
    // generation, authorized by its retained healthy proof.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded review-phase PR retry healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_RETRY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed livelock-bound candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_GENERATION,
        healthy,
        "install the review-wait-bound revision after the livelock-bound healthy proof",
      );
    }
    return waiting(
      "the livelock-bound generation 48 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_GENERATION
  ) {
    // A failed candidate settles exactly once by rolling back to the recorded
    // prior — the proven livelock-bound revision — at a monotonic generation,
    // authorized by its retained healthy proof.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_REVISION,
        OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded livelock-bound healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LIVELOCK_BOUND_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review-wait-bound candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_REVISION,
        OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_GENERATION,
        healthy,
        "install the cooldown-bound revision after the review-wait-bound healthy proof",
      );
    }
    return waiting(
      "the review-wait-bound generation 49 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_GENERATION
  ) {
    // A failed candidate settles exactly once by rolling back to the recorded
    // prior — the proven review-wait-bound revision — at a monotonic
    // generation, authorized by its retained healthy proof.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded review-wait-bound healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_WAIT_BOUND_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed cooldown-bound candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_GENERATION,
        healthy,
        "install the child-deadline revision after the cooldown-bound healthy proof",
      );
    }
    return waiting(
      "the cooldown-bound generation 50 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_GENERATION
  ) {
    // A failed candidate settles exactly once by rolling back to the recorded
    // prior — the proven cooldown-bound revision — at a monotonic generation,
    // authorized by its retained healthy proof.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_REVISION,
        OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded cooldown-bound healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_COOLDOWN_BOUND_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed child-deadline candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_SOURCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_SOURCE_GENERATION,
        healthy,
        "install the runtime-source revision after the child-deadline healthy proof",
      );
    }
    return waiting(
      "the child-deadline generation 51 healthy proof is not recorded",
    );
  }

  return undefined;
}
