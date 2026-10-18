/** Future exact rungs precede, but never rewrite, the historical install chain. */
import {
  HOSTED_RUNTIME_ROLLOUT,
  type HostedRuntimeRollout,
  parseHostedRuntimeRollout,
} from "./hosted-runtime-rollout.ts";
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

export function planOwnerInstallRollout(
  context: OwnerInstallPlanContextV1,
  rollout: HostedRuntimeRollout = HOSTED_RUNTIME_ROLLOUT,
): OwnerDevelopmentInstallPlanV1 | undefined {
  let pins: HostedRuntimeRollout;
  try {
    pins = parseHostedRuntimeRollout(rollout);
  } catch {
    return waiting("future runtime rollout data is invalid");
  }
  const { runtime, revision, generation, healthy, failed } = context;
  if (
    pins.installs.some((pin) =>
      pin.fromRevision === revision && pin.toGeneration + 1 === generation
    )
  ) {
    return healthy === null
      ? waiting("the restored future runtime needs its own healthy proof")
      : noChange("the future runtime rollback is terminal");
  }
  const incoming = pins.installs.find((pin) =>
    pin.toRevision === revision && pin.toGeneration === generation
  );
  if (incoming && failed !== null) {
    if (!incoming.rollbackToPrior) {
      return waiting("the failed future runtime has no accepted rollback");
    }
    const prior = healthyProofFor(
      runtime,
      incoming.fromRevision,
      incoming.fromGeneration,
    );
    if (prior === null) {
      return waiting(
        "the exact prior healthy proof for rollback is unavailable",
      );
    }
    return movePlan(
      "rollback",
      runtime,
      incoming.fromRevision,
      generation + 1,
      prior,
      "restore the exact accepted predecessor after future runtime failure",
    );
  }
  const outgoing = pins.installs.find((pin) =>
    pin.fromRevision === revision && pin.fromGeneration === generation
  );
  if (outgoing && healthy !== null && failed === null) {
    return movePlan(
      "install",
      runtime,
      outgoing.toRevision,
      outgoing.toGeneration,
      healthy,
      "install the exact future runtime after its predecessor healthy proof",
    );
  }
  if (incoming) {
    return healthy === null
      ? waiting("the future runtime needs its own healthy proof")
      : noChange("the future runtime installation is complete");
  }
  // An outgoing-only historical predecessor may still need its old rollback.
  // Its failed/unhealthy state never grants installation of the future runtime.
  return undefined;
}
