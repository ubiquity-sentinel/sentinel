import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";
import { CLOSED_C_WAVE } from "./modern-matrix-recovery.ts";
import type {
  OwnerStartupRecoveryAuthorityV1,
} from "./owner-startup-recovery.ts";
import type {
  OwnerDevelopmentInstallFilesV1,
  OwnerDevelopmentInstallMoveV1,
  OwnerDevelopmentInstallRecordV1,
  OwnerMatrixRecoveryEvidenceV1,
} from "./owner-install-types.ts";
import { planOwnerDevelopmentInstall } from "./owner-install-plan.ts";
import { allowsHostedOwnerInstallMove } from "./hosted-runtime-compatibility.ts";
import type { QueueRuntimeCapability } from "./queue-runtime-capability.ts";
import type { ExistingPrRuntimeCapability } from "./existing-pr-runtime-capability.ts";
import {
  allowsOwnerFutureRecoveryMove,
  type OwnerFutureRecoveryAuthority,
  ownerFutureRecoveryBootstrap,
} from "./owner-install-future-recovery.ts";
import type { HostedRuntimeRollout } from "./hosted-runtime-rollout.ts";
import {
  type OwnerSupersessionAuthority,
  ownerSupersessionTransition,
} from "./owner-install-supersession.ts";
import {
  MAX_COMMIT_MESSAGE_CHARS,
  sha256HexText,
  STATIC_PLAN,
} from "./owner-install-api.ts";

/**
 * Pure intended-snapshot construction: same collections and records, sequence
 * plus one, stateHead set to the exact read head, and exactly one runtime
 * change (activeRevision, generation+1, updatedAt and nextOrdinaryAt=now).
 * Historical proofs and every other runtime field are preserved verbatim.
 */
export function buildOwnerDevelopmentInstallSnapshot(
  snapshot: ReleaseStateSnapshotV1,
  head: GitSha,
  move: OwnerDevelopmentInstallMoveV1,
  now: number,
  recovery?: OwnerMatrixRecoveryEvidenceV1,
  startup?: OwnerStartupRecoveryAuthorityV1,
  /** Trusted in-process fixture only; production defaults to reviewed source. */
  capability?: QueueRuntimeCapability,
  custodyCapability?: ExistingPrRuntimeCapability,
  future?: OwnerFutureRecoveryAuthority,
  rollout?: HostedRuntimeRollout,
  supersession?: OwnerSupersessionAuthority,
): ReleaseStateSnapshotV1 {
  if (
    !allowsHostedOwnerInstallMove(move, capability, custodyCapability) ||
    (future !== undefined && !allowsOwnerFutureRecoveryMove(
      snapshot,
      move,
      future,
      capability,
      custodyCapability,
      rollout,
    ))
  ) {
    throw new Error(STATIC_PLAN);
  }
  const parsed = tryParse(parseReleaseStateSnapshotV1, snapshot);
  if (!parsed.ok || !isGitSha(head)) throw new Error(STATIC_PLAN);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error(STATIC_PLAN);
  const state = parsed.value;
  const runtime = state.hostedRuntimes.length === 1
    ? state.hostedRuntimes[0]
    : null;
  if (runtime === null) throw new Error(STATIC_PLAN);
  const binding = recovery?.binding ?? CLOSED_C_WAVE;
  const recoveryPlan = recovery === undefined
    ? undefined
    : planOwnerDevelopmentInstall(
      state,
      now,
      recovery,
      undefined,
      capability,
      custodyCapability,
    );
  const heldMatrixRollback = recovery !== undefined &&
    recovery.releaseHead === head &&
    move.action === "rollback" && move.priorRevision === recovery.candidate &&
    move.priorGeneration === binding.generation + 1 &&
    move.nextRevision === binding.runtimeSha &&
    move.nextGeneration === binding.generation + 2 &&
    recoveryPlan?.status === "rollback" &&
    canonicalStringify(recoveryPlan.move) === canonicalStringify(move);
  if (
    runtime.activeRevision !== move.priorRevision ||
    runtime.generation !== move.priorGeneration ||
    runtime.generation + 1 !== move.nextGeneration ||
    runtime.activeRevision === move.nextRevision ||
    (!heldMatrixRollback && (runtime.lastHealthyProof === null ||
      canonicalStringify(runtime.lastHealthyProof) !==
        canonicalStringify(move.priorHealthyProof)))
  ) {
    throw new Error(STATIC_PLAN);
  }
  if (
    startup !== undefined || future !== undefined || supersession !== undefined
  ) {
    const intended = planOwnerDevelopmentInstall(
      state,
      now,
      recovery,
      startup,
      capability,
      custodyCapability,
      rollout,
      future,
      supersession,
    );
    if (
      (startup !== undefined && startup.releaseHead !== head) ||
      (intended.status !== "install" && intended.status !== "rollback") ||
      canonicalStringify(intended.move) !== canonicalStringify(move)
    ) throw new Error(STATIC_PLAN);
  }
  const superseded = supersession === undefined
    ? undefined
    : ownerSupersessionTransition(
      state,
      head,
      now,
      supersession,
      move,
      capability,
      custodyCapability,
      rollout,
    );
  const execution = superseded !== undefined
    ? superseded.execution
    : future !== undefined
    ? ownerFutureRecoveryBootstrap(future, head, now)
    : startup === undefined
    ? runtime.execution
    : parseHostedExecutionIntentV1({
      id: `${startup.run.runId}:${startup.run.runAttempt}:repair`,
      ...startup.run,
      purpose: "bootstrap",
      revision: move.nextRevision,
      generation: move.nextGeneration,
      releaseId: null,
      createdAt: now,
    });
  const nextRuntime = tryParse(parseHostedRuntimeRecordV1, {
    ...runtime,
    execution,
    activeRevision: move.nextRevision,
    generation: move.nextGeneration,
    updatedAt: now,
    nextOrdinaryAt: now,
  });
  if (!nextRuntime.ok) throw new Error(STATIC_PLAN);
  const next = tryParse(parseReleaseStateSnapshotV1, {
    ...state,
    stateHead: head,
    sequence: state.sequence + 1,
    updatedAt: now,
    hostedRuntimes: [nextRuntime.value],
    ...(superseded === undefined
      ? {}
      : { hostedReleases: superseded.hostedReleases }),
  });
  if (!next.ok) throw new Error(STATIC_PLAN);
  return next.value;
}

/**
 * Serialization boundary of the two changed blobs. The manifest and the
 * hosted-runtime record use the store's existing layout and canonical bytes
 * (canonicalStringify + LF); the record file name is the SHA-256 of the
 * runtime id exactly as the release store addresses it.
 */
export async function ownerDevelopmentInstallFiles(
  snapshot: ReleaseStateSnapshotV1,
  head: GitSha,
  supersededReleaseId?: string,
): Promise<OwnerDevelopmentInstallFilesV1> {
  const parsed = tryParse(parseReleaseStateSnapshotV1, snapshot);
  if (!parsed.ok || !isGitSha(head) || parsed.value.stateHead !== head) {
    throw new Error(STATIC_PLAN);
  }
  const runtime = parsed.value.hostedRuntimes.length === 1
    ? parsed.value.hostedRuntimes[0]
    : null;
  if (runtime === null) throw new Error(STATIC_PLAN);
  const manifest = {
    version: "v1",
    kind: "release_state_manifest",
    sequence: parsed.value.sequence,
    updatedAt: parsed.value.updatedAt,
    stateHead: head,
  };
  return {
    manifest: {
      path: "manifest.json",
      text: `${canonicalStringify(manifest)}\n`,
    },
    record: {
      path: `hostedRuntimes/${await sha256HexText(runtime.id)}.json`,
      text: `${canonicalStringify(runtime)}\n`,
    },
    ...(supersededReleaseId === undefined ? {} : {
      releaseRecord: {
        path: `hostedReleases/${await sha256HexText(supersededReleaseId)}.json`,
        text: `${
          canonicalStringify(
            parsed.value.hostedReleases.find((r) =>
              r.id === supersededReleaseId
            ) ?? (() => {
              throw new Error(STATIC_PLAN);
            })(),
          )
        }\n`,
      },
    }),
  };
}

/** Bounded commit message carrying the exact installation record. */
export function ownerDevelopmentInstallCommitMessage(
  record: OwnerDevelopmentInstallRecordV1,
): string {
  const proof = tryParse(parseHostedRunProofV1, record.priorHealthyProof);
  if (
    record.version !== "v1" ||
    record.kind !== "owner_development_install" ||
    record.authority !== "owner" ||
    (record.action !== "install" && record.action !== "rollback") ||
    !Number.isSafeInteger(record.authorizedAt) || record.authorizedAt < 0 ||
    !isGitSha(record.priorRevision) ||
    !isGitSha(record.nextRevision) ||
    !isGitSha(record.stateHead) ||
    !Number.isSafeInteger(record.priorGeneration) ||
    record.priorGeneration < 1 ||
    !Number.isSafeInteger(record.nextGeneration) ||
    record.nextGeneration !== record.priorGeneration + 1 ||
    record.priorRevision === record.nextRevision ||
    !/^[0-9a-f]{64}$/.test(record.nonce) ||
    !proof.ok
  ) {
    throw new Error(STATIC_PLAN);
  }
  const message = `owner-development-install\n\n${
    canonicalStringify(record)
  }\n`;
  if (message.length > MAX_COMMIT_MESSAGE_CHARS) throw new Error(STATIC_PLAN);
  return message;
}
