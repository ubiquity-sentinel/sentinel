import type { GitSha } from "../contracts/brands.ts";
import type {
  HostedRunProofV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ClosedCWaveBindingV1 } from "./modern-matrix-recovery.ts";

export interface OwnerMatrixRecoveryEvidenceV1 {
  candidate: GitSha;
  repairHead: GitSha;
  releaseHead: GitSha;
  ownHealthyProof: HostedRunProofV1;
  failedOrdinaryProof: HostedRunProofV1;
  nativeQuiescent: true;
  artifactCustody: true;
  chargesVerified: true;
  /** In-process deterministic fixture binding; production uses the fixed C tuple. */
  binding?: ClosedCWaveBindingV1;
}

export type OwnerDevelopmentInstallActionV1 = "install" | "rollback";

/** One exact planned pointer movement and the proof that authorizes it. */
export interface OwnerDevelopmentInstallMoveV1 {
  action: OwnerDevelopmentInstallActionV1;
  priorRevision: GitSha;
  priorGeneration: number;
  nextRevision: GitSha;
  nextGeneration: number;
  /**
   * Exact recorded healthy proof authorizing this movement: the current
   * pointer's proof for an install, or the recorded previously healthy
   * revision's proof for a rollback or the pinned unproven-pointer repair.
   */
  priorHealthyProof: HostedRunProofV1;
}

export type OwnerDevelopmentInstallPlanV1 =
  | {
    status: "install";
    move: OwnerDevelopmentInstallMoveV1;
    detail: string;
  }
  | {
    status: "rollback";
    move: OwnerDevelopmentInstallMoveV1;
    detail: string;
  }
  | { status: "waiting"; detail: string }
  | { status: "no_change"; detail: string };

/** Exact canonical state-file set of one planned owner installation. */
export interface OwnerDevelopmentInstallFileV1 {
  path: string;
  text: string;
}

export interface OwnerDevelopmentInstallFilesV1 {
  manifest: OwnerDevelopmentInstallFileV1;
  record: OwnerDevelopmentInstallFileV1;
  releaseRecord?: OwnerDevelopmentInstallFileV1;
}

/**
 * Permanent owner-authorized installation record carried by the state commit.
 * It is deliberately NOT a contract record: it is the explicit external owner
 * migration marker in the commit message, not a review or release receipt.
 */
export interface OwnerDevelopmentInstallRecordV1 {
  version: "v1";
  kind: "owner_development_install";
  authority: "owner";
  action: OwnerDevelopmentInstallActionV1;
  /** Authority timestamp of this exact installation operation. */
  authorizedAt: number;
  priorRevision: GitSha;
  priorGeneration: number;
  nextRevision: GitSha;
  nextGeneration: number;
  /** Exact parent state head the created commit extends. */
  stateHead: GitSha;
  /** Exact recorded healthy proof authorizing the movement. */
  priorHealthyProof: HostedRunProofV1;
  /** Random trusted write nonce; identical writes never collide. */
  nonce: string;
}

/** Sanitized bounded result; identities only, never a payload or credential. */
export interface OwnerDevelopmentInstallResultV1 {
  kind: "owner_development_install";
  status: "installed" | "rolled_back" | "waiting" | "no_change" | "failed";
  action: OwnerDevelopmentInstallActionV1 | null;
  priorRevision: string | null;
  priorGeneration: number | null;
  candidateRevision: string | null;
  candidateGeneration: number | null;
  stateHead: string | null;
  stateCommit: string | null;
  detail: string;
}

export type OwnerDevelopmentInstallStateReadV1 =
  | { status: "found"; snapshot: ReleaseStateSnapshotV1; head: GitSha }
  | { status: "absent" }
  | { status: "unavailable" };

export type OwnerDevelopmentInstallWriteV1 =
  | { status: "confirmed"; commit: GitSha }
  | { status: "not_confirmed"; commit: GitSha | null; detail: string };

export interface OwnerDevelopmentInstallApiResponseV1 {
  status: number;
  value: unknown;
}

export interface OwnerInstallPlanContextV1 {
  runtime: HostedRuntimeRecordV1;
  revision: GitSha;
  generation: number;
  healthy: HostedRunProofV1 | null;
  failed: HostedRunProofV1 | null;
}
