/** Every independently active custody floor must accept the same exact move. */
import type { GitSha } from "../contracts/brands.ts";
import { parseHostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { tryParse } from "../contracts/validation.ts";
import type {
  HostedExecutionIntentV1,
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { OwnerDevelopmentInstallMoveV1 } from "./owner-install-types.ts";
import {
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
  _queue?: QueueRuntimeCapability,
  _custody?: ExistingPrRuntimeCapability,
): boolean {
  if (!tryParse(parseHostedExecutionIntentV1, execution).ok) return false;
  if (execution.purpose === "ordinary" || execution.purpose === "bootstrap") {
    return true;
  }
  const release = releases.find((r) => r.id === execution.releaseId);
  if (!release) return false;
  if (execution.purpose === "prior") {
    return release.phase === "requested" &&
      release.priorRevision === execution.revision;
  }
  if (execution.purpose === "candidate") {
    return release.phase === "verifying" &&
      release.request.revision === execution.revision;
  }
  return release.phase === "rollback_verifying" &&
    release.priorRevision === execution.revision;
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
