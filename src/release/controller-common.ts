// Shared release cycle shapes and exact identity/failure helpers.
import type { Clock } from "../contracts/ports.ts";
import type {
  DenoReleasePort,
  ReleaseStateWriter,
  StateReadView,
} from "../contracts/ports.ts";
import type { GitSha } from "../contracts/brands.ts";
import type { StabilityPolicyV1 } from "../contracts/repository-config.ts";
import type {
  AcceptanceResultV1,
  ReleaseErrorV1,
  ReleasePhaseV1,
  ReleaseRecordV1,
} from "../contracts/release.ts";
import type {
  ReleaseRequestV1,
  ReleaseTargetEnvironmentV1,
} from "../contracts/release.ts";
import type {
  DeploymentIdentityV1,
  MetricsSampleV1,
  RepositoryIdentityV1,
} from "../contracts/shared.ts";
import type { ReleaseTargetConfigV1 } from "./config.ts";
import { buildAcceptanceResult, evaluateAcceptance } from "./acceptance.ts";
import type { BuildReceiptResolverV1 } from "./resolver.ts";

export type ReleaseCycleResultV1 =
  | { status: "idle"; warnings: string[] }
  | { status: "waiting"; detail: string; warnings: string[] }
  | {
    status: "advanced";
    recordId: string;
    phase: ReleasePhaseV1;
    warnings: string[];
  }
  | {
    status: "persisted";
    recordId: string;
    phase: ReleasePhaseV1;
    warnings: string[];
  }
  | { status: "conflict"; recordId: string | null; warnings: string[] }
  | {
    status: "blocked";
    recordId: string | null;
    detail: string;
    warnings: string[];
  };

export interface ReleaseControllerOptions {
  /** The exact target repository this controller owns. */
  repository: RepositoryIdentityV1;
  /** The exact target environment (production/isolated). */
  environment: ReleaseTargetEnvironmentV1;
  /** m05 trusted configuration (identity headers, bounds). */
  target: ReleaseTargetConfigV1;
  /** Enabled owner stability policy (validated at construction). */
  policy: StabilityPolicyV1;
  stateRead: StateReadView;
  stateWrite: ReleaseStateWriter;
  deno: DenoReleasePort;
  resolver: BuildReceiptResolverV1;
  clock: Clock;
}

export interface LoadedContextV1 {
  /** All matching open requests in deterministic order. */
  requests: ReleaseRequestV1[];
  /** Matching records in non-terminal phases (0 or 1 valid; more conflicts). */
  active: ReleaseRecordV1[];
  /** Matching terminal records. */
  terminal: ReleaseRecordV1[];
  releaseHead: GitSha | null;
}

export const ERROR_RULES: Record<
  string,
  { detail: string; recovered: boolean }
> = {
  promotion_not_applied: {
    detail: "promotion did not take effect",
    recovered: true,
  },
  unrelated_newer_deployment: {
    detail: "an unrelated newer deployment is current",
    recovered: false,
  },
  acceptance_insufficient: {
    detail: "acceptance evidence is insufficient",
    recovered: false,
  },
};

export function sameIdentity(
  a: DeploymentIdentityV1,
  b: DeploymentIdentityV1,
): boolean {
  return a.gitSha === b.gitSha && a.revisionId === b.revisionId;
}

export function sameRepository(
  a: RepositoryIdentityV1,
  b: RepositoryIdentityV1,
): boolean {
  return a.owner === b.owner && a.name === b.name &&
    a.installationId === b.installationId;
}

export function isTerminalPhase(phase: ReleasePhaseV1): boolean {
  return phase === "accepted" || phase === "rolled_back" || phase === "failed";
}

export function completeSample(sample: MetricsSampleV1): boolean {
  return sample.coverage.status === "complete" &&
    sample.requestCount !== null;
}

export function buildDiagnosticAcceptance(
  identity: DeploymentIdentityV1,
  policy: StabilityPolicyV1,
  baseline: MetricsSampleV1[],
  samples: MetricsSampleV1[],
): AcceptanceResultV1 | null {
  if (samples.length === 0) return null;
  const evaluation = evaluateAcceptance(policy, baseline, samples);
  return buildAcceptanceResult(
    identity,
    baseline,
    samples,
    evaluation,
  );
}

export function makeError(at: number, kind: string): ReleaseErrorV1 {
  const rule = ERROR_RULES[kind] ?? {
    detail: "release recorded a failure",
    recovered: false,
  };
  return {
    at,
    kind,
    detail: rule.detail,
    recovered: rule.recovered,
  };
}
