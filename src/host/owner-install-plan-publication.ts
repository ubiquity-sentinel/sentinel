import {
  OWNER_DEVELOPMENT_INSTALL_APP_AUTH_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_APP_AUTH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_REVISION,
  OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_REVISION,
} from "./owner-install-pins.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_REVISION,
} from "./owner-install-runtime-pins.ts";
import type {
  OwnerDevelopmentInstallPlanV1,
  OwnerInstallPlanContextV1,
} from "./owner-install-types.ts";
import {
  healthyProofFor,
  movePlan,
  waiting,
} from "./owner-install-plan-proof.ts";

/** Publication, closure and assignment chain. Unmatched pointers continue to the next group. */
export function planOwnerInstallPublication(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when a healthy proof exists; the rollback still requires
    // the recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_APP_AUTH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_APP_AUTH_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded app auth healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_APP_AUTH_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed publish-gate candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_GENERATION,
        healthy,
        "install the closing-keyword revision after the publish-gate healthy proof",
      );
    }
    return waiting(
      "the publish-gate generation 39 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure evidence
    // even when a healthy proof exists; the rollback still requires the
    // recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded publish-gate healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed closing-keyword candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_GENERATION,
        healthy,
        "install the candidate-loss revision after the closing-keyword healthy proof",
      );
    }
    return waiting(
      "the closing-keyword generation 40 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure evidence
    // even when a healthy proof exists; the rollback still requires the
    // recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded closing-keyword healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSING_KEYWORD_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed candidate-loss candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_GENERATION,
        healthy,
        "install the closed-PR republish revision after the candidate-loss healthy proof",
      );
    }
    return waiting(
      "the candidate-loss generation 41 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure evidence
    // even when a healthy proof exists; the rollback still requires the
    // recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded candidate-loss healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_LOSS_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed closed-PR candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_GENERATION,
        healthy,
        "install the closed-PR head revision after the closed-PR healthy proof",
      );
    }
    return waiting(
      "the closed-PR generation 42 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure evidence
    // even when a healthy proof exists; the rollback still requires the
    // recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded closed-PR healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed closed-PR head candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_GENERATION,
        healthy,
        "install the assign-first revision after the closed-PR head healthy proof",
      );
    }
    return waiting(
      "the closed-PR head generation 43 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_ASSIGN_FIRST_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure evidence
    // even when a healthy proof exists; the rollback still requires the
    // recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded closed-PR head healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CLOSED_PR_HEAD_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed assign-first candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_PHASE_PR_GENERATION,
        healthy,
        "install the review-phase PR revision after the assign-first healthy proof",
      );
    }
    return waiting(
      "the assign-first generation 44 healthy proof is not recorded",
    );
  }

  return undefined;
}
