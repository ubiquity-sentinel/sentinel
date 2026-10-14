import {
  OWNER_DEVELOPMENT_INSTALL_APP_AUTH_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_APP_AUTH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REASON_CODE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION,
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

/** Settlement recovery, reasoning, base fetching and review-model chain. Unmatched pointers continue to the next group. */
export function planOwnerInstallModel(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REASON_CODE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded reason-code healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed settlement recovery candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_REVISION,
        OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_GENERATION,
        healthy,
        "install the quiet reasoning revision after the settlement recovery healthy proof",
      );
    }
    return waiting(
      "the settlement recovery generation 34 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when a healthy proof exists; the rollback still requires
    // the recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded settlement recovery healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed quiet reasoning candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_GENERATION,
        healthy,
        "install the base fetch revision after the quiet reasoning healthy proof",
      );
    }
    return waiting(
      "the quiet reasoning generation 35 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when a healthy proof exists; the rollback still requires
    // the recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_REVISION,
        OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded quiet reasoning healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_QUIET_REASONING_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed base fetch candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_GENERATION,
        healthy,
        "install the review model revision after the base fetch healthy proof",
      );
    }
    return waiting(
      "the base fetch generation 36 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when a healthy proof exists; the rollback still requires
    // the recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded base fetch healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_BASE_FETCH_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed review model candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_APP_AUTH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_APP_AUTH_GENERATION,
        healthy,
        "install the app auth revision after the review model healthy proof",
      );
    }
    return waiting(
      "the review model generation 37 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_APP_AUTH_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_APP_AUTH_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when a healthy proof exists; the rollback still requires
    // the recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded review model healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REVIEW_MODEL_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed app auth candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_PUBLISH_GATE_GENERATION,
        healthy,
        "install the publish-gate revision after the app auth healthy proof",
      );
    }
    return waiting(
      "the app auth generation 38 healthy proof is not recorded",
    );
  }

  return undefined;
}
