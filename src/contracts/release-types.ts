import type { GitSha } from "./brands.ts";
import type {
  DeploymentIdentityV1,
  MetricsSampleV1,
  RepositoryIdentityV1,
} from "./shared.ts";
import type { StabilityMetricV1 } from "./repository-config.ts";

export type ReleaseRequestStatusV1 =
  | "open"
  | "fulfilled"
  | "failed"
  | "cancelled";
export type ReleaseTargetEnvironmentV1 = "production" | "isolated";
export type ReleasePhaseV1 =
  | "requested"
  | "promoting"
  | "monitoring"
  | "accepted"
  | "failed"
  | "rolled_back";
export type ReleaseIntentActionV1 = "promote" | "rollback";

export interface ReleaseRequestV1 {
  version: "v1";
  kind: "release_request";
  id: string;
  target: {
    repository: RepositoryIdentityV1;
    environment: ReleaseTargetEnvironmentV1;
  };
  /** The exact accepted merged SHA — the only revision this request may promote. */
  revision: GitSha;
  source: {
    pullRequest: number;
    reviewRequestId: string;
    reviewReceiptId: string | null;
    head: GitSha;
    base: GitSha;
  };
  status: ReleaseRequestStatusV1;
  failureReason: string | null;
  createdAt: number;
}

export interface ReleaseIntentV1 {
  action: ReleaseIntentActionV1;
  /** Deterministic idempotency key persisted before the external effect. */
  key: string;
  persistedAt: number;
}

export interface ReleaseObservedV1 {
  /** Actual exact platform identity observed after the effect; null until observed. */
  identity: DeploymentIdentityV1 | null;
  domain: string | null;
  /** Whether the observed identity was machine-verified (body/headers). */
  verified: boolean;
  at: number | null;
}

export interface ReleaseMonitoringV1 {
  startedAt: number | null;
  samples: number;
  /** False after interruption; acceptance is impossible without continuity. */
  continuous: boolean;
  lastSampleAt: number | null;
}

export interface AcceptanceThresholdResultV1 {
  metric: StabilityMetricV1;
  observedRate: number | null;
  /** Baseline rate from the persisted baseline evidence; null when unavailable. */
  baselineRate: number | null;
  maxRate: number;
  maxIncrease: number;
  passed: boolean;
}

export interface AcceptanceResultV1 {
  /** The exact controlled identity this acceptance proves, never an approximation. */
  identity: DeploymentIdentityV1;
  windowMs: number;
  sampleIntervalMs: number;
  continuous: boolean;
  /** Persisted baseline evidence (actual samples, denominators and flags). */
  baseline: MetricsSampleV1[];
  /** Persisted acceptance sample evidence; never a bare boolean. */
  samples: MetricsSampleV1[];
  thresholdResults: AcceptanceThresholdResultV1[];
  passed: boolean;
}

export interface ReleaseReceiptV1 {
  action: ReleaseIntentActionV1;
  ok: boolean;
  statusCode: number | null;
  observedIdentity: DeploymentIdentityV1 | null;
  observedDomain: string | null;
  at: number;
  detail: string | null;
}

export interface ReleaseErrorV1 {
  at: number;
  kind: string;
  detail: string;
  recovered: boolean;
}

export interface ReleaseRecordV1 {
  version: "v1";
  kind: "release_record";
  /** Repository the release targets (identity, resolves the deploy config). */
  repository: RepositoryIdentityV1;
  /** Isolated environment is a separate, representable target from production. */
  environment: ReleaseTargetEnvironmentV1;
  id: string;
  requestId: string;
  /** Recorded from the release request; the only promotable Git revision. */
  requestRevision: GitSha;
  /** Exact candidate identity (Git SHA + Deno revision id) plus the build transaction. */
  candidate: {
    identity: DeploymentIdentityV1;
    buildTransactionId: string;
  };
  /** Healthy exact prior identity attested before promotion. */
  prior: { identity: DeploymentIdentityV1; verifiedHealthyAt: number };
  phase: ReleasePhaseV1;
  intent: ReleaseIntentV1 | null;
  observed: ReleaseObservedV1;
  monitoring: ReleaseMonitoringV1;
  acceptance: AcceptanceResultV1 | null;
  receipts: {
    promote: ReleaseReceiptV1 | null;
    rollback: ReleaseReceiptV1 | null;
    error: ReleaseErrorV1 | null;
  };
  createdAt: number;
  updatedAt: number;
}
