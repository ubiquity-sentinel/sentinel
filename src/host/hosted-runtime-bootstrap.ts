/** Pointer health precedes unrelated release work; health is never fabricated. */
import type { HostedRuntimeRecordV1 } from "../contracts/hosted-supervisor.ts";
import { hostedOrdinaryAdmissionMode } from "../contracts/hosted-supervisor-verification.ts";
import type { ExistingPrRuntimeCapability } from "./existing-pr-runtime-capability.ts";
import type { QueueRuntimeCapability } from "./queue-runtime-capability.ts";
import type { HostedRuntimeRollout } from "./hosted-runtime-rollout.ts";

export function hostedRuntimeBootstrapDisposition(
  runtime: HostedRuntimeRecordV1,
  _queue?: QueueRuntimeCapability,
  _custody?: ExistingPrRuntimeCapability,
  _rollout?: HostedRuntimeRollout,
): "ordinary" | "bootstrap" | "hold" {
  if (runtime.verificationBlocked) return "hold";
  return hostedOrdinaryAdmissionMode(runtime) === null
    ? "bootstrap"
    : "ordinary";
}
