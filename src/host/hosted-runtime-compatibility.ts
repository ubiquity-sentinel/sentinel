/** Every independently active custody floor must accept the same exact move. */
import type { GitSha } from "../contracts/brands.ts";
import type {
  HostedExecutionIntentV1,
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { OwnerDevelopmentInstallMoveV1 } from "./owner-install-types.ts";
import {
  allowsQueueExecution,
  allowsQueueOwnerInstallMove,
  allowsQueueRuntime,
  allowsQueueRuntimeMove,
  allowsQueueRuntimeTransition,
  QUEUE_RUNTIME_CAPABILITY_REFUSED,
  type QueueRuntimeCapability,
} from "./queue-runtime-capability.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  EXISTING_PR_RUNTIME_CAPABILITY_REFUSED,
  type ExistingPrRuntimeCapability,
  existingPrRuntimePolicy,
} from "./existing-pr-runtime-capability.ts";

export function runtimeCompatibilityRefusal(
  custody: ExistingPrRuntimeCapability = EXISTING_PR_RUNTIME_CAPABILITY,
): string {
  return custody?.custodyActivated === false
    ? QUEUE_RUNTIME_CAPABILITY_REFUSED
    : EXISTING_PR_RUNTIME_CAPABILITY_REFUSED;
}

export function allowsHostedRuntime(
  revision: GitSha,
  queue?: QueueRuntimeCapability,
  custody?: ExistingPrRuntimeCapability,
): boolean {
  return allowsQueueRuntime(revision, queue) &&
    allowsQueueRuntime(revision, existingPrRuntimePolicy(custody));
}

export function allowsHostedRuntimeMove(
  prior: GitSha,
  next: GitSha,
  queue?: QueueRuntimeCapability,
  custody?: ExistingPrRuntimeCapability,
): boolean {
  return allowsQueueRuntimeMove(prior, next, queue) &&
    allowsQueueRuntimeMove(prior, next, existingPrRuntimePolicy(custody));
}

export function allowsHostedOwnerInstallMove(
  move: OwnerDevelopmentInstallMoveV1,
  queue?: QueueRuntimeCapability,
  custody?: ExistingPrRuntimeCapability,
): boolean {
  return allowsQueueOwnerInstallMove(move, queue) &&
    allowsQueueOwnerInstallMove(move, existingPrRuntimePolicy(custody));
}

export function allowsHostedExecution(
  execution: HostedExecutionIntentV1,
  releases: readonly HostedReleaseRecordV1[],
  queue?: QueueRuntimeCapability,
  custody?: ExistingPrRuntimeCapability,
): boolean {
  return allowsQueueExecution(execution, releases, queue) &&
    allowsQueueExecution(execution, releases, existingPrRuntimePolicy(custody));
}

export function allowsHostedRuntimeTransition(
  base: ReleaseStateSnapshotV1 | null,
  runtime: HostedRuntimeRecordV1 | null,
  releases: readonly HostedReleaseRecordV1[],
  queue?: QueueRuntimeCapability,
  custody?: ExistingPrRuntimeCapability,
): boolean {
  return allowsQueueRuntimeTransition(base, runtime, releases, queue) &&
    allowsQueueRuntimeTransition(
      base,
      runtime,
      releases,
      existingPrRuntimePolicy(custody),
    );
}
