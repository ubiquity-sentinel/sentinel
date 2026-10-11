import type { GitSha } from "./brands.ts";
import type { ReleaseRequestV1 } from "./release.ts";

/** Fixed runtime record id of the one hosted self production runtime. */
export const HOSTED_RUNTIME_ID = "ubiquity/sentinel:0:production";
/** Fixed supervisor workflow identity. */
export const HOSTED_SUPERVISOR_WORKFLOW_ID = 357012162;
export const HOSTED_SUPERVISOR_WORKFLOW_PATH =
  ".github/workflows/supervisor.yml";
export const HOSTED_SUPERVISOR_REF = "refs/heads/sentinel-supervisor";
export const HOSTED_SUPERVISOR_REPOSITORY = "ubiquity/sentinel";
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
  | "rolled_back";
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
 * execution is recorded solely in the runtime `lastExecutionProof` and leaves
 * the release in `requested`/`rollback_verifying` for a deterministic retry.
 * `candidateProof` records the FIRST exact candidate result, healthy or failed.
 */
export interface HostedReleaseRecordV1 {
  version: "v1";
  kind: "hosted_release";
  id: string;
  request: ReleaseRequestV1;
  priorRevision: GitSha;
  phase: HostedReleasePhaseV1;
  priorProof: HostedRunProofV1 | null;
  candidateProof: HostedRunProofV1 | null;
  rollbackProof: HostedRunProofV1 | null;
  pointerIntent: HostedPointerIntentV1 | null;
  createdAt: number;
  updatedAt: number;
}
