import type {
  HostedExecutionSettlementV1,
  HostedInstallationRecordV1,
} from "../contracts/hosted-supervisor.ts";

/** Native settlement and rollback intent are journaled with clearing the execution. */
export function settleHostedInstallations(
  records: readonly HostedInstallationRecordV1[],
  proof: HostedExecutionSettlementV1,
  now: number,
): HostedInstallationRecordV1[] {
  return records.map((r) => {
    if (
      r.phase === "bootstrapping" &&
      r.bootstrapExecutionId === proof.execution.id && r.bootstrapProof === null
    ) {
      return {
        ...r,
        bootstrapProof: proof,
        phase: proof.outcome === "healthy" ? "accepted" : "rollback_pending",
        pointerIntent: proof.outcome === "healthy" ? null : {
          action: "rollback",
          expectedRevision: r.candidateRevision,
          nextRevision: r.previousRevision,
          expectedGeneration: r.previousGeneration + 1,
          createdAt: now,
        },
        updatedAt: now,
      };
    }
    if (
      r.phase === "rollback_verifying" &&
      r.rollbackExecutionId === proof.execution.id && r.rollbackProof === null
    ) {
      return {
        ...r,
        rollbackProof: proof,
        phase: proof.outcome === "healthy" ? "rolled_back" : "rollback_failed",
        updatedAt: now,
      };
    }
    return r;
  });
}
