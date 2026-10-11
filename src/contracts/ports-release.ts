import type { GitSha } from "./brands.ts";
import type { DeploymentIdentityV1, MetricsSampleV1 } from "./shared.ts";
import type { PortResultV1 } from "./ports.ts";

// ---------------------------------------------------------------------------
// DenoReleasePort (m05): exact build discovery, current identity, promotion
// (which requires HTTP 204) and health/metrics sampling. The Git SHA and the
// Deno revision id are a single typed DeploymentIdentityV1; the build
// transaction id stays a separate exact identity.
// ---------------------------------------------------------------------------

export interface DenoBuildV1 {
  projectId: string;
  buildTransactionId: string;
  identity: DeploymentIdentityV1;
  status: "succeeded" | "failed" | "running" | "unknown";
  createdAt: number;
}

/** Exactly-one-candidate lookup: several records mean "ambiguous", not "found". */
export type BuildLookupV1 =
  | { status: "found"; build: DenoBuildV1 }
  | { status: "none" }
  | { status: "ambiguous" };

export interface DenoDeploymentV1 {
  projectId: string;
  /** Observed deployed identity; null means it could not be determined. */
  identity: DeploymentIdentityV1 | null;
  domain: string | null;
  status: "live" | "not_deployed" | "unknown";
  updatedAt: number | null;
}

export interface DenoPromotionRequestV1 {
  projectId: string;
  identity: DeploymentIdentityV1;
}

export const DENO_PROMOTION_REQUIRED_STATUS = 204;

export type DenoPromotionOutcomeV1 =
  | {
    outcome: "promoted";
    statusCode: 204;
    observedIdentity: DeploymentIdentityV1 | null;
  }
  | { outcome: "rejected"; statusCode: number; detail: string }
  | { outcome: "ambiguous"; statusCode: number | null; detail: string };

export interface HealthSampleConfigV1 {
  baseUrl: string;
  healthPath: string;
  managedBodyMarker: string;
  /** Non-secret identity headers that must match the managed deployment. */
  managedHeaders: { name: string; value: string }[];
  domain: string | null;
}

export interface HealthSampleV1 {
  at: number;
  status: "healthy" | "degraded" | "unreachable";
  httpStatus: number | null;
  bodyMarkerPresent: boolean | null;
  headersMatch: boolean | null;
  /** Observed exact deployed identity; null means it could not be determined. */
  identity: DeploymentIdentityV1 | null;
  domain: string | null;
}

export interface MetricsSampleConfigV1 {
  baseUrl: string;
  metricsPath: string;
  /**
   * Exact deployment identity (Git SHA + revision id) the window belongs to;
   * a sample window is never inferred from the current wall clock on resume.
   */
  identity: DeploymentIdentityV1;
  /** Inclusive start of the exact telemetry window; nonnegative. */
  windowStart: number;
  /** Exclusive end of the telemetry window; windowStart < windowEnd. */
  windowEnd: number;
  domain: string | null;
}

export interface DenoReleasePort {
  /**
   * Exact lookup by merged Git SHA, build transaction id AND the exact Deno
   * revision id from the authenticated build-receipt resolver. The revision id
   * is the required selector: two builds for the same SHA must never bind the
   * wrong accepted build receipt, and the platform never carries the Git SHA
   * or transaction id as a label. The transaction id is provenance supplied by
   * the trusted receipt resolver, never inferred from platform data.
   */
  findBuiltCandidate(
    projectId: string,
    revision: GitSha,
    buildTransactionId: string,
    revisionId: string,
  ): Promise<PortResultV1<BuildLookupV1>>;
  readCurrentDeployment(
    projectId: string,
  ): Promise<PortResultV1<DenoDeploymentV1>>;
  promote(
    request: DenoPromotionRequestV1,
  ): Promise<PortResultV1<DenoPromotionOutcomeV1>>;
  sampleHealth(
    config: HealthSampleConfigV1,
  ): Promise<PortResultV1<HealthSampleV1>>;
  sampleMetrics(
    config: MetricsSampleConfigV1,
  ): Promise<PortResultV1<MetricsSampleV1>>;
}
