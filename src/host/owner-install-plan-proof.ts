import type { GitSha } from "../contracts/brands.ts";
import type {
  HostedRunProofV1,
  HostedRuntimeRecordV1,
} from "../contracts/hosted-supervisor.ts";
import type {
  OwnerDevelopmentInstallActionV1,
  OwnerDevelopmentInstallMoveV1,
  OwnerDevelopmentInstallPlanV1,
} from "./owner-install-types.ts";

/** Exact healthy proof binding one revision and generation, or null. */
export function healthyProofFor(
  runtime: HostedRuntimeRecordV1,
  revision: GitSha,
  generation: number,
): HostedRunProofV1 | null {
  const proof = runtime.lastHealthyProof;
  if (proof === null || proof.outcome !== "healthy") return null;
  if (proof.execution.revision !== revision) return null;
  if (proof.execution.generation !== generation) return null;
  return proof;
}

/**
 * Exact settled failed run proof binding one revision and generation. The
 * deterministic execution id and the settlement slot are the identity; a
 * no-execution settlement is never candidate failure evidence.
 */
export function failedSettlementFor(
  runtime: HostedRuntimeRecordV1,
  revision: GitSha,
  generation: number,
): HostedRunProofV1 | null {
  const settlement = runtime.lastExecutionProof;
  if (settlement === null || settlement.outcome !== "failed") return null;
  if (settlement.execution.revision !== revision) return null;
  if (settlement.execution.generation !== generation) return null;
  return settlement;
}

export function movePlan(
  action: OwnerDevelopmentInstallActionV1,
  runtime: HostedRuntimeRecordV1,
  nextRevision: GitSha,
  nextGeneration: number,
  priorHealthyProof: HostedRunProofV1,
  detail: string,
): OwnerDevelopmentInstallPlanV1 {
  const move: OwnerDevelopmentInstallMoveV1 = {
    action,
    priorRevision: runtime.activeRevision,
    priorGeneration: runtime.generation,
    nextRevision,
    nextGeneration,
    priorHealthyProof,
  };
  return action === "install"
    ? { status: "install", move, detail }
    : { status: "rollback", move, detail };
}

export function waiting(detail: string): OwnerDevelopmentInstallPlanV1 {
  return { status: "waiting", detail };
}

export function noChange(detail: string): OwnerDevelopmentInstallPlanV1 {
  return { status: "no_change", detail };
}
