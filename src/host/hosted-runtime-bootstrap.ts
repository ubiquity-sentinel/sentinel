/** Exact source-pinned future installation health, before unrelated releases. */
import type { HostedRuntimeRecordV1 } from "../contracts/hosted-supervisor.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  type ExistingPrRuntimeCapability,
} from "./existing-pr-runtime-capability.ts";
import { allowsHostedRuntime } from "./hosted-runtime-compatibility.ts";
import {
  HOSTED_RUNTIME_ROLLOUT,
  type HostedRuntimeRollout,
  parseHostedRuntimeRollout,
} from "./hosted-runtime-rollout.ts";
import {
  failedSettlementFor,
  healthyProofFor,
} from "./owner-install-plan-proof.ts";
import {
  QUEUE_RUNTIME_CAPABILITY,
  type QueueRuntimeCapability,
} from "./queue-runtime-capability.ts";

/** No admission switch, environment input, pointer mutation, or invented proof. */
export function hostedRuntimeBootstrapDisposition(
  runtime: HostedRuntimeRecordV1,
  queue?: QueueRuntimeCapability,
  custody: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
  rollout: HostedRuntimeRollout = HOSTED_RUNTIME_ROLLOUT,
): "ordinary" | "bootstrap" | "hold" {
  if (
    custody?.custodyActivated !== true
  ) return "ordinary";
  const { activeRevision: revision, generation } = runtime;
  try {
    const pins = parseHostedRuntimeRollout(rollout);
    const pin = pins.installs.find((pin) =>
      pin.toRevision === revision && pin.toGeneration === generation
    );
    const restored = pins.installs.find((pin) =>
      pin.rollbackToPrior &&
      pin.fromRevision === revision && pin.toGeneration + 1 === generation
    );
    const recovery = pins.recoveries.some((row) =>
      row.toRevision === revision && row.toGeneration === generation
    );
    if (pin === undefined && restored === undefined && !recovery) {
      return "ordinary";
    }
    if (
      (queue ?? QUEUE_RUNTIME_CAPABILITY).proofActivated !== true ||
      !allowsHostedRuntime(revision, queue, custody)
    ) return "hold";
    if (failedSettlementFor(runtime, revision, generation) !== null) {
      return "hold";
    }
    if (healthyProofFor(runtime, revision, generation) !== null) {
      return "ordinary";
    }
    if (recovery) return "hold";
    const prior = pin ?? restored!;
    return healthyProofFor(
        runtime,
        prior.fromRevision,
        prior.fromGeneration,
      ) !==
        null
      ? "bootstrap"
      : "hold";
  } catch {
    return "hold";
  }
}
