import { isGitSha } from "../contracts/brands.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { parseHostedRunProofV1 } from "../contracts/hosted-supervisor.ts";
import { parseReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { tryParse } from "../contracts/validation.ts";
import { CLOSED_C_WAVE } from "./modern-matrix-recovery.ts";
import type {
  OwnerStartupRecoveryAuthorityV1,
} from "./owner-startup-recovery.ts";
import { planOwnerStartupRecovery } from "./owner-startup-recovery.ts";
import type {
  OwnerDevelopmentInstallPlanV1,
  OwnerInstallPlanContextV1,
  OwnerMatrixRecoveryEvidenceV1,
} from "./owner-install-types.ts";
import {
  failedSettlementFor,
  healthyProofFor,
  movePlan,
  noChange,
  waiting,
} from "./owner-install-plan-proof.ts";
import { planOwnerInstallReview } from "./owner-install-plan-review.ts";
import {
  planOwnerInstallReviewEvidence,
} from "./owner-install-plan-review-evidence.ts";
import { planOwnerInstallDelivery } from "./owner-install-plan-delivery.ts";
import { planOwnerInstallAuth } from "./owner-install-plan-auth.ts";
import { planOwnerInstallModel } from "./owner-install-plan-model.ts";
import {
  planOwnerInstallPublication,
} from "./owner-install-plan-publication.ts";
import {
  planOwnerInstallReviewRecovery,
} from "./owner-install-plan-review-recovery.ts";
import {
  planOwnerInstallRuntimeRecovery,
} from "./owner-install-plan-runtime-recovery.ts";
import {
  planOwnerInstallConcurrency,
} from "./owner-install-plan-concurrency.ts";
import { planOwnerInstallMemory } from "./owner-install-plan-memory.ts";
import {
  allowsHostedOwnerInstallMove,
  runtimeCompatibilityRefusal,
} from "./hosted-runtime-compatibility.ts";
import {
  QUEUE_RUNTIME_CAPABILITY,
  type QueueRuntimeCapability,
} from "./queue-runtime-capability.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  type ExistingPrRuntimeCapability,
} from "./existing-pr-runtime-capability.ts";
import type { HostedRuntimeRollout } from "./hosted-runtime-rollout.ts";
import { planOwnerInstallRollout } from "./owner-install-plan-rollout.ts";
import {
  allowsOwnerFutureRecoveryMove,
  type OwnerFutureRecoveryAuthority,
  planOwnerFutureRecovery,
} from "./owner-install-future-recovery.ts";
import {
  type OwnerSupersessionAuthority,
  planOwnerSupersession,
} from "./owner-install-supersession.ts";

/**
 * Pure planning boundary. The snapshot is re-validated, so an unparsed or
 * tampered record set can never authorize movement. Nothing here performs I/O:
 * the caller supplies the exact read snapshot and the current clock.
 */
export function planOwnerDevelopmentInstall(
  snapshot: ReleaseStateSnapshotV1,
  now: number,
  recovery?: OwnerMatrixRecoveryEvidenceV1,
  startup?: OwnerStartupRecoveryAuthorityV1,
  /** Trusted in-process fixture only; production defaults to reviewed source. */
  capability?: QueueRuntimeCapability,
  custodyCapability?: ExistingPrRuntimeCapability,
  rollout?: HostedRuntimeRollout,
  future?: OwnerFutureRecoveryAuthority,
  supersession?: OwnerSupersessionAuthority,
): OwnerDevelopmentInstallPlanV1 {
  if (supersession !== undefined) {
    if (
      future !== undefined || startup !== undefined || recovery !== undefined
    ) return waiting("conflicting owner recovery modes");
    const parsed = tryParse(parseReleaseStateSnapshotV1, snapshot);
    if (
      !parsed.ok || !Number.isSafeInteger(now) || now < 0 ||
      parsed.value.hostedRuntimes.length !== 1 ||
      parsed.value.hostedRuntimes[0].execution !== null ||
      parsed.value.githubCooldowns.some((c) =>
        c.retryNotBefore === null || now < c.retryNotBefore
      )
    ) return waiting("owner supersession state is unavailable");
    const plan = planOwnerSupersession(
      parsed.value,
      supersession,
      capability,
      custodyCapability,
      rollout,
    );
    if (
      (plan.status === "install" || plan.status === "rollback") &&
      !allowsHostedOwnerInstallMove(plan.move, capability, custodyCapability)
    ) return waiting(runtimeCompatibilityRefusal(custodyCapability));
    return plan;
  }
  if (future !== undefined) {
    const queue = capability ?? QUEUE_RUNTIME_CAPABILITY;
    const custody = custodyCapability ?? EXISTING_PR_RUNTIME_CAPABILITY;
    if (queue.proofActivated !== true || custody.custodyActivated !== true) {
      return waiting("future recovery requires both active custody floors");
    }
  }
  const plan = planOwnerDevelopmentInstallUnchecked(
    snapshot,
    now,
    recovery,
    startup,
    rollout,
    future,
  );
  if (
    future !== undefined &&
    (plan.status === "install" || plan.status === "rollback") &&
    !allowsOwnerFutureRecoveryMove(
      snapshot,
      plan.move,
      future,
      capability,
      custodyCapability,
      rollout,
    )
  ) return waiting(runtimeCompatibilityRefusal(custodyCapability));
  if (
    (plan.status === "install" || plan.status === "rollback") &&
    !allowsHostedOwnerInstallMove(plan.move, capability, custodyCapability)
  ) return waiting(runtimeCompatibilityRefusal(custodyCapability));
  return plan;
}

function planOwnerDevelopmentInstallUnchecked(
  snapshot: ReleaseStateSnapshotV1,
  now: number,
  recovery?: OwnerMatrixRecoveryEvidenceV1,
  startup?: OwnerStartupRecoveryAuthorityV1,
  rollout?: HostedRuntimeRollout,
  future?: OwnerFutureRecoveryAuthority,
): OwnerDevelopmentInstallPlanV1 {
  const parsed = tryParse(parseReleaseStateSnapshotV1, snapshot);
  if (!parsed.ok) {
    return waiting("release state is not the exact parsed snapshot");
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    return waiting("the supplied clock is invalid");
  }
  const state = parsed.value;
  if (state.hostedRuntimes.length !== 1) {
    return waiting("the single hosted runtime pointer is not installed");
  }
  const runtime = state.hostedRuntimes[0];
  if (runtime.execution !== null) {
    return waiting("a hosted runtime execution is in flight");
  }
  if (
    state.hostedReleases.some((release) =>
      release.pointerIntent !== null ||
      (release.phase !== "accepted" && release.phase !== "rolled_back")
    )
  ) {
    return waiting("a hosted release is not terminal");
  }
  if (
    state.githubCooldowns.some((cooldown) =>
      cooldown.retryNotBefore === null || now < cooldown.retryNotBefore
    )
  ) {
    return waiting("a github cooldown is active");
  }

  if (future !== undefined) {
    if (startup !== undefined || recovery !== undefined) {
      return waiting("conflicting owner recovery modes");
    }
    return planOwnerFutureRecovery(state, future, rollout);
  }
  if (startup !== undefined) {
    if (recovery !== undefined) {
      return waiting("conflicting owner recovery modes");
    }
    return planOwnerStartupRecovery(runtime, startup);
  }

  const revision = runtime.activeRevision;
  const generation = runtime.generation;
  const healthy = healthyProofFor(runtime, revision, generation);
  const failed = failedSettlementFor(runtime, revision, generation);

  if (recovery !== undefined) {
    const binding = recovery.binding ?? CLOSED_C_WAVE;
    const prior = tryParse(parseHostedRunProofV1, recovery.ownHealthyProof);
    const originalFailure = tryParse(
      parseHostedRunProofV1,
      recovery.failedOrdinaryProof,
    );
    if (
      !isGitSha(recovery.candidate) ||
      recovery.candidate === binding.runtimeSha ||
      !isGitSha(recovery.repairHead) || !isGitSha(recovery.releaseHead) ||
      recovery.nativeQuiescent !== true || recovery.artifactCustody !== true ||
      recovery.chargesVerified !== true || !prior.ok || !originalFailure.ok ||
      prior.value.outcome !== "healthy" ||
      prior.value.execution.revision !== binding.runtimeSha ||
      prior.value.execution.generation !== binding.generation ||
      originalFailure.value.outcome !== "failed" ||
      originalFailure.value.execution.purpose !== "ordinary" ||
      originalFailure.value.execution.revision !== binding.runtimeSha ||
      originalFailure.value.execution.generation !== binding.generation ||
      originalFailure.value.execution.runId !== binding.run.runId ||
      originalFailure.value.execution.runAttempt !== binding.run.runAttempt ||
      originalFailure.value.execution.launcherSha !== binding.run.launcherSha ||
      prior.value.finishedAt > originalFailure.value.startedAt
    ) return waiting("closed matrix recovery authority is unavailable");
    if (revision === binding.runtimeSha && generation === binding.generation) {
      if (
        healthy === null || failed === null ||
        canonicalStringify(healthy) !== canonicalStringify(prior.value) ||
        canonicalStringify(failed) !== canonicalStringify(originalFailure.value)
      ) {
        return waiting(
          "the exact C generation 60 health and later ordinary failure are unavailable",
        );
      }
      return movePlan(
        "install",
        runtime,
        recovery.candidate,
        generation + 1,
        healthy,
        "install the exact matrix recovery after authenticated C-wave ingestion",
      );
    }
    if (
      revision === recovery.candidate && generation === binding.generation + 1
    ) {
      if (failed !== null) {
        return movePlan(
          "rollback",
          runtime,
          binding.runtimeSha,
          generation + 1,
          prior.value,
          "restore exact C after failed matrix recovery bootstrap or ordinary execution",
        );
      }
      return healthy === null
        ? waiting(
          "the matrix recovery generation 61 needs its own bootstrap health",
        )
        : noChange("the matrix recovery installation is complete");
    }
    if (
      revision === binding.runtimeSha && generation === binding.generation + 2
    ) {
      return healthy === null
        ? waiting(
          "the restored C generation 62 needs its own health; recovery cannot reinstall",
        )
        : noChange("the matrix recovery rollback is terminal");
    }
  }

  const context: OwnerInstallPlanContextV1 = {
    runtime,
    revision,
    generation,
    healthy,
    failed,
  };
  // Keep the original branch order, including overlapping predecessor tuples.
  const planned = planOwnerInstallRollout(context, rollout) ??
    planOwnerInstallReview(context) ??
    planOwnerInstallReviewEvidence(context) ??
    planOwnerInstallDelivery(context) ??
    planOwnerInstallAuth(context) ??
    planOwnerInstallModel(context) ??
    planOwnerInstallPublication(context) ??
    planOwnerInstallReviewRecovery(context) ??
    planOwnerInstallRuntimeRecovery(context) ??
    planOwnerInstallConcurrency(context) ??
    planOwnerInstallMemory(context);
  if (planned !== undefined) return planned;

  // Any other pointer, including a completed rollback target, is deliberately
  // a no-op so this one-shot never becomes a recurring global gate.
  return noChange(
    "the runtime pointer is outside the owner installation chain",
  );
}
