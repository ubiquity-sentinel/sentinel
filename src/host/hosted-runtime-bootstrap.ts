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
import type { QueueRuntimeCapability } from "./queue-runtime-capability.ts";

/** No admission switch, environment input, pointer mutation, or invented proof. */
export function hostedRuntimeBootstrapDisposition(
  runtime: HostedRuntimeRecordV1,
  queue?: QueueRuntimeCapability,
  custody: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
  rollout: HostedRuntimeRollout = HOSTED_RUNTIME_ROLLOUT,
): "ordinary" | "bootstrap" | "hold" {
  if (
    custody?.custodyActivated !== true ||
    !allowsHostedRuntime(runtime.activeRevision, queue, custody)
  ) return "ordinary";
  const { activeRevision: revision, generation } = runtime;
  try {
    const pin = parseHostedRuntimeRollout(rollout).installs.find((pin) =>
      pin.toRevision === revision && pin.toGeneration === generation
    );
    if (pin === undefined) return "ordinary";
    if (failedSettlementFor(runtime, revision, generation) !== null) {
      return "hold";
    }
    if (healthyProofFor(runtime, revision, generation) !== null) {
      return "ordinary";
    }
    return healthyProofFor(runtime, pin.fromRevision, pin.fromGeneration) !==
        null
      ? "bootstrap"
      : "hold";
  } catch {
    return "hold";
  }
}
