/** Trusted launcher capability pins, independent of queue occupancy and mode. */
import { type GitSha, isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import type {
  HostedExecutionIntentV1,
  HostedReleaseRecordV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { HOSTED_CUSTODY_CAPABILITY } from "./hosted-custody-capability.ts";
import type { OwnerDevelopmentInstallMoveV1 } from "./owner-install-types.ts";

export interface QueueRuntimeMigration {
  readonly fromRevision: GitSha;
  readonly fromGeneration: number;
  readonly toRevision: GitSha;
  readonly toGeneration: number;
}

export interface QueueRuntimeCapability {
  readonly proofActivated: boolean;
  readonly revisions: readonly GitSha[];
  /** Owner installation only. Never an execution, fallback or generic release grant. */
  readonly ownerInstallMigrations?: readonly QueueRuntimeMigration[];
}

/**
 * Populate only with exact, accepted proof-capable runtime commits, after each
 * runtime is frozen. The later launcher owns these pins. Generations and healthy
 * predecessor proofs remain independently checked by the existing controller.
 * No environment selector or empty queue can lower this boundary.
 *
 * The first proof-active migration needs a separately reviewed exact tuple.
 * Its predecessor never becomes executable or eligible for rollback merely
 * because the owner may move away from it. Missing tuples refuse migration.
 */
export const QUEUE_RUNTIME_CAPABILITY: QueueRuntimeCapability =
  HOSTED_CUSTODY_CAPABILITY.queue;

export const QUEUE_RUNTIME_CAPABILITY_REFUSED =
  "queue proof activation requires an accepted exact runtime capability";

export function allowsQueueRuntime(
  revision: GitSha,
  policy: QueueRuntimeCapability = QUEUE_RUNTIME_CAPABILITY,
): boolean {
  if (policy?.proofActivated === false) return true;
  return policy?.proofActivated === true && isGitSha(revision) &&
    Array.isArray(policy.revisions) && policy.revisions.every(isGitSha) &&
    policy.revisions.includes(revision);
}

/** A safe candidate alone cannot authorize retaining an unsafe rollback. */
export function allowsQueueRuntimeMove(
  prior: GitSha,
  next: GitSha,
  policy: QueueRuntimeCapability = QUEUE_RUNTIME_CAPABILITY,
): boolean {
  return allowsQueueRuntime(prior, policy) && allowsQueueRuntime(next, policy);
}

/** Narrow first-activation escape: the existing owner installer still owns every gate. */
export function allowsQueueOwnerInstallMove(
  move: OwnerDevelopmentInstallMoveV1,
  policy: QueueRuntimeCapability = QUEUE_RUNTIME_CAPABILITY,
): boolean {
  if (allowsQueueRuntimeMove(move.priorRevision, move.nextRevision, policy)) {
    return true;
  }
  if (
    move.action !== "install" || !allowsQueueRuntime(move.nextRevision, policy)
  ) return false;
  const migrations = policy.ownerInstallMigrations;
  return Array.isArray(migrations) &&
    migrations.every((migration) =>
      migration !== null && typeof migration === "object" &&
      isGitSha(migration.fromRevision) && isGitSha(migration.toRevision) &&
      migration.fromRevision !== migration.toRevision &&
      Number.isSafeInteger(migration.fromGeneration) &&
      migration.fromGeneration > 0 &&
      Number.isSafeInteger(migration.toGeneration) &&
      migration.toGeneration === migration.fromGeneration + 1
    ) &&
    migrations.some((migration) =>
      migration.fromRevision === move.priorRevision &&
      migration.fromGeneration === move.priorGeneration &&
      migration.toRevision === move.nextRevision &&
      migration.toGeneration === move.nextGeneration
    );
}

/** A resumed candidate also retains its original exact rollback obligation. */
export function allowsQueueExecution(
  execution: HostedExecutionIntentV1,
  releases: readonly HostedReleaseRecordV1[],
  policy: QueueRuntimeCapability = QUEUE_RUNTIME_CAPABILITY,
): boolean {
  if (!allowsQueueRuntime(execution.revision, policy)) return false;
  if (policy.proofActivated === false || execution.releaseId === null) {
    return true;
  }
  const release = releases.find((row) => row.id === execution.releaseId);
  return release !== undefined && allowsQueueRuntimeMove(
    release.priorRevision,
    release.request.revision,
    policy,
  );
}

/** Final write boundary: settlement can clear an old execution without rearming it. */
export function allowsQueueRuntimeTransition(
  base: ReleaseStateSnapshotV1 | null,
  runtime: HostedRuntimeRecordV1 | null,
  releases: readonly HostedReleaseRecordV1[],
  policy: QueueRuntimeCapability = QUEUE_RUNTIME_CAPABILITY,
): boolean {
  const before = base?.hostedRuntimes[0] ?? null;
  // Final capability boundary before CAS. Settling an old saved execution is
  // allowed, but introducing one or moving its pointer must remain accepted.
  if (runtime !== null) {
    if (
      (before === null &&
        !allowsQueueRuntime(runtime.activeRevision, policy)) ||
      (before !== null &&
        (runtime.activeRevision !== before.activeRevision ||
          runtime.generation !== before.generation) &&
        !allowsQueueRuntimeMove(
          before.activeRevision,
          runtime.activeRevision,
          policy,
        )) ||
      (runtime.execution !== null &&
        !sameCapabilityValue(runtime.execution, before?.execution ?? null) &&
        (!allowsQueueExecution(runtime.execution, releases, policy) ||
          !allowsQueueRuntimeMove(
            runtime.activeRevision,
            runtime.execution.revision,
            policy,
          )))
    ) return false;
  }
  for (const release of releases) {
    const intent = release.pointerIntent;
    const saved = base?.hostedReleases.find((row) => row.id === release.id);
    if (
      intent !== null &&
      !sameCapabilityValue(intent, saved?.pointerIntent ?? null) &&
      (!allowsQueueRuntimeMove(
        intent.expectedRevision,
        intent.nextRevision,
        policy,
      ) ||
        !allowsQueueRuntimeMove(
          release.priorRevision,
          release.request.revision,
          policy,
        ))
    ) return false;
  }
  return true;
}

function sameCapabilityValue(left: unknown, right: unknown): boolean {
  return canonicalStringify(left) === canonicalStringify(right);
}
