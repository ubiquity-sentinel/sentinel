import {
  OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION,
  OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_REASON_CODE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION,
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

/** Model route, target scope and candidate authorization chain. Unmatched pointers continue to the next group. */
export function planOwnerInstallAuth(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded App identity healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed model-route candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_GENERATION,
        healthy,
        "install the gpt-reserve model revision after the model-route healthy proof",
      );
    }
    return waiting(
      "the model-route generation 26 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded model-route healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed reserve-model candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_GENERATION,
        healthy,
        "install the multi-target revision after the reserve-model healthy proof",
      );
    }
    return waiting(
      "the reserve-model generation 27 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded reserve-model healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RESERVE_MODEL_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed multi-target candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_GENERATION,
        healthy,
        "install the scope-admitting revision after the multi-target healthy proof",
      );
    }
    return waiting(
      "the multi-target generation 28 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded multi-target healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MULTI_TARGET_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed scope-gate candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_GENERATION,
        healthy,
        "install the target-scoped candidate auth revision after the scope-gate healthy proof",
      );
    }
    return waiting(
      "the scope-gate generation 29 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded scope-gate healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SCOPE_GATE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed candidate-auth candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_GENERATION,
        healthy,
        "install the target-bound preservation revision after the candidate-auth healthy proof",
      );
    }
    return waiting(
      "the candidate-auth generation 30 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded candidate-auth healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CANDIDATE_AUTH_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed preserve-scope candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_GENERATION,
        healthy,
        "install the foreign-auth revision after the preserve-scope healthy proof",
      );
    }
    return waiting(
      "the preserve-scope generation 31 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded preserve-scope healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_PRESERVE_SCOPE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed foreign-auth candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_REASON_CODE_GENERATION,
        healthy,
        "install the reason-code revision after the foreign-auth healthy proof",
      );
    }
    return waiting(
      "the foreign-auth generation 32 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_REASON_CODE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_REASON_CODE_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION,
        OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded foreign-auth healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FOREIGN_AUTH_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed reason-code candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_RECOVERY_GENERATION,
        healthy,
        "install the settlement recovery revision after the reason-code healthy proof",
      );
    }
    return waiting(
      "the reason-code generation 33 healthy proof is not recorded",
    );
  }

  return undefined;
}
