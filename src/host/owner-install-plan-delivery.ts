import {
  OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION,
  OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
  OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RELEASED_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RETIRE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION,
  OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
} from "./owner-install-pins.ts";
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

/** Released runtime, trigger, cadence, retirement and App identity chain. Unmatched pointers continue to the next group. */
export function planOwnerInstallDelivery(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RELEASED_GENERATION
  ) {
    // The retained healthy proof of this separately promoted pointer cannot
    // authorize forward installation while its latest settlement failed, and
    // no prior authority for rolling it back is recorded, so it waits.
    if (failed !== null) {
      return waiting(
        "the failed released generation 18 refuses forward installation",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION,
        healthy,
        "install the trigger revision after the released generation healthy proof",
      );
    }
    return waiting(
      "the released generation 18 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RELEASED_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded released healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RELEASED_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed trigger candidate to the released revision",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION,
        healthy,
        "install the base-advance revision after the trigger healthy proof",
      );
    }
    return waiting(
      "the trigger generation 19 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded trigger healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_TRIGGER_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed base-advance candidate to the trigger revision",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION,
        healthy,
        "install the cadence revision after the base-advance healthy proof",
      );
    }
    return waiting(
      "the base-advance generation 20 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded base-advance healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ADVANCE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed cadence candidate to the base-advance revision",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
        OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION,
        healthy,
        "install the guard revision after the cadence healthy proof",
      );
    }
    return waiting(
      "the cadence generation 21 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded cadence healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_CADENCE_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed guard candidate to the cadence revision",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RETIRE_GENERATION,
        healthy,
        "install the retirement revision after the guard healthy proof",
      );
    }
    return waiting("the guard generation 22 healthy proof is not recorded");
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RETIRE_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RETIRE_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
        OWNER_DEVELOPMENT_INSTALL_GUARD_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded guard healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_GUARD_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed retirement candidate to the guard revision",
      );
    }
    if (healthy !== null) {
      return noChange("the owner development installation is complete");
    }
    return waiting(
      "the retirement generation 23 healthy proof is not recorded",
    );
  }

  // The live pointer sits one generation past the retirement link (the
  // delivered self-repair merge advanced it through an ordinary correction
  // round). That exact revision still carries its own healthy proof, which
  // authorizes the App identity install; any other pointer stays a no-op.
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_GENERATION &&
    failed === null &&
    healthy !== null
  ) {
    return movePlan(
      "install",
      runtime,
      OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION,
      OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION,
      healthy,
      "install the ubiquity-sentinel App identity revision after the delivered round-2 healthy proof",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_APP_IDENTITY_GENERATION
  ) {
    // An exact failed settlement of this pointer is candidate failure
    // evidence even when an older healthy proof exists; the rollback still
    // requires the recorded healthy proof of the exact prior revision, so a
    // missing or unrelated proof stays a zero-write waiting outcome.
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION,
        OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded delivered round-2 healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_DELIVERED_ROUND2_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed App identity candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_REVISION,
        OWNER_DEVELOPMENT_INSTALL_MODEL_ROUTE_GENERATION,
        healthy,
        "install the DeepSeek fallback model-route revision after the App identity healthy proof",
      );
    }
    return waiting(
      "the App identity generation 25 healthy proof is not recorded",
    );
  }

  return undefined;
}
