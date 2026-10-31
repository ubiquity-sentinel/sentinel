import type { GitSha } from "./brands.ts";
import type { ReleaseRequestV1 } from "./release.ts";
import type { OwnerSuccessorTaskAcceptanceV1 } from "./owner-successor-review.ts";
import {
  HOSTED_CONTROLLER_DEPLOYMENT,
  HOSTED_CONTROLLER_REPOSITORY,
  HOSTED_CONTROLLER_RUNTIME_ID,
  HOSTED_CONTROLLER_SUPERVISOR_REF,
} from "./hosted-controller-deployment.ts";

/** Fixed runtime record id of the one hosted self production runtime. */
export const HOSTED_RUNTIME_ID = HOSTED_CONTROLLER_RUNTIME_ID;
/** Retired pre-migration runtime id, accepted only while reading existing state. */
export const RETIRED_HOSTED_RUNTIME_ID = "ubiquity/sentinel:0:production";
/** Fixed supervisor workflow identity. */
export const HOSTED_SUPERVISOR_WORKFLOW_ID =
  HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowId;
export const HOSTED_SUPERVISOR_WORKFLOW_PATH =
  HOSTED_CONTROLLER_DEPLOYMENT.supervisorWorkflowPath;
export const HOSTED_SUPERVISOR_REF = HOSTED_CONTROLLER_SUPERVISOR_REF;
export const HOSTED_SUPERVISOR_REPOSITORY = HOSTED_CONTROLLER_REPOSITORY;
/** Retired pre-migration repository name, accepted only for state reads. */
export const RETIRED_HOSTED_SUPERVISOR_REPOSITORY = "ubiquity/sentinel";
/**
 * Actions run metadata has one-second/whole-second clock precision: adjacent
 * timestamps written by the platform may differ by up to 999 ms in either
 * direction without being a contradiction.
 */
export const HOSTED_ACTIONS_CLOCK_TOLERANCE_MS = 999;

export type HostedExecutionPurposeV1 =
  | "bootstrap"
  | "ordinary"
  | "prior"
  | "candidate"
  | "rollback";
export type HostedRunOutcomeV1 = "healthy" | "failed";
export type HostedReleasePhaseV1 =
  | "requested"
  | "promoting"
  | "verifying"
  | "accepted"
  | "rollback_pending"
  | "rollback_verifying"
  | "rolled_back"
  | "abandoned"
  | "owner_superseded";

/** Admissions and exact settlements; absent journals mean zero attempts. */
export interface HostedVerificationJournalV1 {
  attempts: number;
  failures: number;
  lastExecutionId: string | null;
  lastFailure: {
    proof: HostedExecutionSettlementV1;
    reason: "execution_failed" | "not_started";
  } | null;
  executionIds: string[];
  settledExecutionIds: string[];
}
export interface HostedAbandonmentV1 {
  reason:
    | "prior_verification_exhausted"
    | "candidate_verification_exhausted"
    | "candidate_verification_failed"
    | "included_in_successor";
  fromPhase: HostedReleasePhaseV1;
  executionIds: string[];
  successorRevision?: GitSha;
  recordedAt: number;
}
export interface HostedOrdinaryAdmissionV1 {
  mode: "healthy" | "degraded";
  executionId: string;
  revision: GitSha;
  generation: number;
  failedVerificationIds: string[];
}

/** Separate from maintenance requests: an exact CI-backed launcher installation. */
export interface HostedInstallationRecordV1 {
  version: "v1";
  kind: "hosted_installation";
  id: string;
  candidateRevision: GitSha;
  previousRevision: GitSha;
  previousGeneration: number;
  previousHealthyProof: HostedRunProofV1 | null;
  ci: { revision: GitSha; checkRunId: number };
  phase:
    | "requested"
    | "bootstrapping"
    | "accepted"
    | "rollback_pending"
    | "rollback_verifying"
    | "rolled_back"
    | "rollback_failed";
  pointerIntent: HostedPointerIntentV1 | null;
  bootstrapExecutionId: string | null;
  bootstrapProof: HostedExecutionSettlementV1 | null;
  rollbackExecutionId: string | null;
  rollbackProof: HostedExecutionSettlementV1 | null;
  createdAt: number;
  updatedAt: number;
  /**
   * #191: the first bootstrap attempt's settlement when it never reached the
   * startup-ready marker. Its presence consumes the single same-pointer retry;
   * `bootstrapExecutionId`/`bootstrapProof` then bind the retry. Absent on
   * records that never retried, so earlier readers keep their exact shape.
   */
  retriedBootstrapProof?: HostedExecutionSettlementV1;
}
export interface HostedOwnerSupersessionIntentV1 {
  releaseId: string;
  requestSha256: string;
  sourceSha256: string;
  taskSha256: string;
  workId: string;
  workSha256: string;
  issueNumber: number;
  repairHead: GitSha;
  releaseHead: GitSha;
  repairSnapshotSha256: string;
  releaseSnapshotSha256: string;
  fromRevision: GitSha;
  fromGeneration: number;
  authorizedAt: number;
  toRevision: GitSha;
  toGeneration: number;
  controllerSourceRevision: GitSha;
  acceptanceBaseRevision: GitSha;
  controllerCodeSha256: string;
  ciRevision: GitSha;
  requiredAncestors: readonly GitSha[];
  failedProofSha256: string;
  retainedHealthyProofSha256: string;
  healthyWitnessHead: GitSha;
  originalFailedPriorExecution: HostedExecutionIntentV1;
  originalFailedPriorJobId: number;
  /** Immutable native fingerprint excluding only the fresh observation time. */
  originalFailedPriorNativeSha256: string;
}

/** Explicit owner intent, independently authenticated; never a release proof. */
export interface HostedOwnerDispositionV1 {
  version: "v1";
  kind: "owner_supersession";
  intent: HostedOwnerSupersessionIntentV1;
  intentSha256: string;
  controllerRevision: GitSha;
  controllerCiRevision: GitSha;
  failedPriorProof: HostedRunProofV1;
  originalFailedPriorProof: HostedRunProofV1;
  retainedHealthyProof: HostedRunProofV1;
}

export interface HostedOwnerSuccessorTaskBindingV1 {
  releaseId: string;
  requestSha256: string;
  intentSha256: string;
  successorRevision: GitSha;
  successorGeneration: number;
  taskSha256: string;
  issueNumber: number;
  workId: string;
  acceptanceBaseRevision: GitSha;
  controllerSourceRevision: GitSha;
  controllerCodeSha256: string;
  ciRevision: GitSha;
}
export interface HostedOwnerSuccessorBindingV1 {
  id: string;
  binding: HostedOwnerSuccessorTaskBindingV1;
  bindingSha256: string;
  controllerRevision: GitSha;
  recoveryFromRevision: GitSha;
  recoveryFromGeneration: number;
  movement: "recovery" | "install" | "rollback";
  movementProof: HostedRunProofV1;
  movementProofSha256: string;
}
export type HostedPointerActionV1 = "promote" | "rollback";

/**
 * One exact hosted execution request. `id` is the exact deterministic
 * `runId:runAttempt:repair` identity; `launcherSha` is the immutable launcher
 * (workflow/controller) revision and is deliberately separate from the
 * execution revision and from any observed base SHA.
 */
export interface HostedExecutionIntentV1 {
  id: string;
  runId: number;
  runAttempt: number;
  launcherSha: GitSha;
  purpose: HostedExecutionPurposeV1;
  revision: GitSha;
  generation: number;
  /** Release this execution belongs to; null exactly for bootstrap/ordinary. */
  releaseId: string | null;
  createdAt: number;
}

/**
 * Immutable proof of one completed hosted job: the FULL execution intent, the
 * fixed workflow/repository/ref identity, positive job id, the platform
 * timestamps, the observed outcome and the exact log digest. `settled` is
 * always true (an unsettled run is never proof) and a healthy proof must carry
 * the startup flag, the observed base SHA and the terminal instant.
 */
export interface HostedRunProofV1 {
  execution: HostedExecutionIntentV1;
  workflowId: number;
  workflowPath: string;
  repository: string;
  ref: string;
  jobId: number;
  startedAt: number;
  finishedAt: number;
  observedAt: number;
  outcome: HostedRunOutcomeV1;
  startupReady: boolean;
  settled: true;
  baseSha: GitSha | null;
  terminalAt: number | null;
  logDigest: string;
}

/**
 * No-execution settlement: the exact repair job was skipped or absent for this
 * execution intent, proven from the exact job listing. It deliberately has no
 * start time, startup flag, base SHA, terminal instant or log digest: no
 * execution evidence is fabricated. `finishedAt`/`observedAt` are the listing
 * observation times and `evidenceDigest` is the digest of that listing.
 */
export interface HostedNotStartedProofV1 {
  execution: HostedExecutionIntentV1;
  workflowId: number;
  workflowPath: string;
  repository: string;
  ref: string;
  /** Exact repair job id when skipped; null when the listing has no repair job. */
  jobId: number | null;
  finishedAt: number;
  observedAt: number;
  outcome: "not_started";
  evidenceDigest: string;
}

/**
 * How one execution ended: a real run proof (healthy/failed) or an explicit
 * no-execution settlement. Only real run proofs may ever claim health.
 */
export type HostedExecutionSettlementV1 =
  | HostedRunProofV1
  | HostedNotStartedProofV1;

/**
 * The one hosted runtime pointer. `lastHealthyProof` may belong to an earlier
 * generation while a candidate is under verification; `execution` (when
 * present) must bind the exact pointer revision and generation.
 * `lastExecutionProof` is the settlement of the immediately previous
 * execution (run proof or no-execution proof): it is written atomically with
 * clearing that exact execution, so an unknown settlement is never silently
 * lost and a new execution can only start in a LATER write.
 */
export interface HostedRuntimeRecordV1 {
  version: "v1";
  kind: "hosted_runtime";
  id: string;
  activeRevision: GitSha;
  generation: number;
  lastHealthyProof: HostedRunProofV1 | null;
  /** Settlement of the cleared previous execution; never a health claim. */
  lastExecutionProof: HostedExecutionSettlementV1 | null;
  nextOrdinaryAt: number;
  execution: HostedExecutionIntentV1 | null;
  createdAt: number;
  updatedAt: number;
  verificationFailures?: number;
  failedVerificationIds?: string[];
  lastVerificationId?: string | null;
  lastTurn?: "ordinary" | "verification";
  ordinaryAdmission?: HostedOrdinaryAdmissionV1;
  verificationBlocked?: boolean;
}

/** Persisted-before-effect pointer intent (promote or rollback). */
export interface HostedPointerIntentV1 {
  action: HostedPointerActionV1;
  expectedRevision: GitSha;
  nextRevision: GitSha;
  expectedGeneration: number;
  createdAt: number;
}

/**
 * One hosted release receipt. `id` is exactly the release request id and the
 * request is stored in full (strict ReleaseRequestV1). Proofs are immutable
 * once present; the pointer intent is the only promotable movement authority.
 * `priorProof`/`rollbackProof` are healthy-only: a failed prior or rollback
 * execution retains the real runtime settlement and its bounded verification
 * journal; failed rollback never authorizes ordinary model starts.
 * `candidateProof` records the FIRST exact candidate result, healthy or failed.
 */
export interface HostedReleaseRecordV1 {
  version: "v1";
  kind: "hosted_release";
  id: string;
  request: ReleaseRequestV1;
  priorRevision: GitSha;
  phase: HostedReleasePhaseV1;
  verification?: {
    prior: HostedVerificationJournalV1;
    candidate: HostedVerificationJournalV1;
  };
  abandonment?: HostedAbandonmentV1;
  priorProof: HostedRunProofV1 | null;
  candidateProof: HostedRunProofV1 | null;
  rollbackProof: HostedRunProofV1 | null;
  pointerIntent: HostedPointerIntentV1 | null;
  /** Present only on the distinct immutable owner_superseded terminal. */
  ownerDisposition?: HostedOwnerDispositionV1;
  ownerAcceptance?: OwnerSuccessorTaskAcceptanceV1;
  ownerSuccessorBindings?: HostedOwnerSuccessorBindingV1[];
  createdAt: number;
  updatedAt: number;
}
