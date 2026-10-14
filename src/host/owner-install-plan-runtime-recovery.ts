import {
  OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_SUCCESSOR_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_SUCCESSOR_REVISION,
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

/** Unproven runtime owner repair and exact runtime-recovery rollbacks. Unmatched pointers continue to the next group. */
export function planOwnerInstallRuntimeRecovery(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RUNTIME_SOURCE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RUNTIME_SOURCE_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure evidence
    // even when an older healthy proof exists; the rollback still requires the
    // recorded healthy proof of the exact prior revision, so a missing or
    // unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded child-deadline healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed runtime-source candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    const prior = healthyProofFor(
      runtime,
      OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION,
      OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_GENERATION,
    );
    if (prior === null) {
      return waiting(
        "the recorded child-deadline healthy proof for the owner repair is unavailable",
      );
    }
    // Only the unproven pointer takes this exceptional repair path. A
    // conflicting settlement cannot be discarded to manufacture eligibility;
    // the exact failed settlement has already taken rollback precedence above.
    const settlement = runtime.lastExecutionProof;
    if (
      settlement !== null &&
      (settlement.execution.revision === revision ||
        settlement.execution.generation >= generation)
    ) {
      return waiting(
        "the runtime-source settlement does not authorize the unproven owner repair",
      );
    }
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_REVISION,
      OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_GENERATION,
      prior,
      "install the pinned owner repair with the retained child-deadline healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded child-deadline healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CHILD_DEADLINE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed owner repair to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_GENERATION,
        healthy,
        "install the runtime recovery revision after the owner-repair healthy proof",
      );
    }
    return waiting(
      "the owner-repair generation 53 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded owner-repair healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_OWNER_REPAIR_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed runtime recovery to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_SUCCESSOR_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_SUCCESSOR_GENERATION,
        healthy,
        "install the runtime recovery successor after the generation 54 healthy proof",
      );
    }
    return waiting(
      "the runtime recovery generation 54 healthy proof is not recorded",
    );
  }

  if (
    revision ===
      OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_SUCCESSOR_REVISION &&
    generation ===
      OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_SUCCESSOR_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded runtime recovery healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RUNTIME_RECOVERY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed runtime recovery successor to its recorded proven predecessor",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the runtime recovery successor generation 55 healthy proof is not recorded",
    );
  }

  return undefined;
}
