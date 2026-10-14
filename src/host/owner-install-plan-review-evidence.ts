import {
  OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
  OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
  OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
  OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
  OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION,
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

/** Findings, history, receipt, ledger and settlement chain. Unmatched pointers continue to the next group. */
export function planOwnerInstallReviewEvidence(
  context: OwnerInstallPlanContextV1,
): OwnerDevelopmentInstallPlanV1 | undefined {
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    revision === OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded round-8 grant healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_ROUND8_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed findings-feedback candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION,
        healthy,
        "install the rejection-history revision after the findings-feedback healthy proof",
      );
    }
    return waiting(
      "the findings-feedback generation 13 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded findings-feedback healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_FINDINGS_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed rejection-history candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION,
        healthy,
        "install the receipt-submission revision after the rejection-history healthy proof",
      );
    }
    return waiting(
      "the rejection-history generation 14 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded rejection-history healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_HISTORY_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed receipt-submission candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION,
        healthy,
        "install the ledger revision after the receipt-submission healthy proof",
      );
    }
    return waiting(
      "the receipt-submission generation 15 healthy proof is not recorded",
    );
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded receipt-submission healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_RECEIPT_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed ledger candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      return movePlan(
        "install",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION,
        OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_GENERATION,
        healthy,
        "install the settlement revision after the ledger healthy proof",
      );
    }
    return waiting("the ledger generation 16 healthy proof is not recorded");
  }

  if (
    revision === OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_REVISION &&
    generation === OWNER_DEVELOPMENT_INSTALL_SETTLEMENT_GENERATION
  ) {
    if (failed !== null) {
      const prior = healthyProofFor(
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_GENERATION,
      );
      if (prior === null) {
        return waiting(
          "the recorded ledger healthy proof for the rollback is unavailable",
        );
      }
      return movePlan(
        "rollback",
        runtime,
        OWNER_DEVELOPMENT_INSTALL_LEDGER_REVISION,
        runtime.generation + 1,
        prior,
        "roll back the failed settlement candidate to its recorded prior",
      );
    }
    if (healthy !== null) {
      // The 17 -> 18 movement belongs to the separate hosted promotion that
      // accepted the released revision; planning the trigger revision here
      // would be a two-generation jump the install snapshot builder always
      // rejects, so this planner waits for that promotion instead.
      return waiting(
        "the released generation 18 promotion owns the next movement",
      );
    }
    return waiting(
      "the settlement generation 17 healthy proof is not recorded",
    );
  }

  return undefined;
}
