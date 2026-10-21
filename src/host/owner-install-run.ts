import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { HOSTED_SUPERVISOR_REF } from "../contracts/hosted-supervisor.ts";
import type { StateReadView } from "../contracts/ports.ts";
import type { ReleaseStateSnapshotV1 } from "../contracts/state-snapshots.ts";
import { CLOSED_C_WAVE } from "./modern-matrix-recovery.ts";
import type { ClosedCWaveBindingV1 } from "./modern-matrix-recovery.ts";
import {
  isOwnerStartupRecoveryTuple,
  OWNER_STARTUP_RECOVERY_GENERATION,
  OWNER_STARTUP_RECOVERY_WITNESS,
} from "./owner-startup-recovery.ts";
import type {
  OwnerStartupRecoveryAuthorityV1,
} from "./owner-startup-recovery.ts";
import { OWNER_DEVELOPMENT_INSTALL_REPOSITORY } from "./owner-install-pins.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_MATRIX_RECOVERY_REVISION,
} from "./owner-install-runtime-pins.ts";
import type {
  OwnerDevelopmentInstallFilesV1,
  OwnerMatrixRecoveryEvidenceV1,
} from "./owner-install-types.ts";
import { planOwnerDevelopmentInstall } from "./owner-install-plan.ts";
import {
  buildOwnerDevelopmentInstallSnapshot,
  ownerDevelopmentInstallCommitMessage,
  ownerDevelopmentInstallFiles,
} from "./owner-install-snapshot.ts";
import {
  ownerStartupNativeQuiescent,
  ownerStartupRepairUnchanged,
  ownerStartupSourceHead,
  readOwnerStartupRecoveryAuthority,
} from "./owner-install-startup-evidence.ts";
import {
  readOwnerMatrixRecoveryEvidence,
} from "./owner-install-matrix-evidence.ts";
import {
  createOwnerDevelopmentInstallState,
  readOwnerDevelopmentInstallState,
  verifyOwnerDevelopmentInstallRevision,
} from "./owner-install-state.ts";
import { writeOwnerDevelopmentInstallCommit } from "./owner-install-git.ts";
import {
  isToken,
  NONCE_BYTES,
  ownerDevelopmentInstallApi,
  randomHex,
  testLocalCheckSucceeded,
} from "./owner-install-api.ts";
import { failedResult, report, waitingResult } from "./owner-install-result.ts";
import {
  EXISTING_PR_RUNTIME_CAPABILITY,
  type ExistingPrRuntimeCapability,
} from "./existing-pr-runtime-capability.ts";
import { readHostedWriterQuiescence } from "./hosted-writer-quiescence.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import {
  QUEUE_RUNTIME_CAPABILITY,
  type QueueRuntimeCapability,
} from "./queue-runtime-capability.ts";
import {
  HOSTED_RUNTIME_ROLLOUT,
  type HostedRuntimeRollout,
  parseHostedRuntimeRollout,
} from "./hosted-runtime-rollout.ts";
import {
  type OwnerFutureRecoveryAuthority,
  ownerFutureRecoveryUnchanged,
  readOwnerFutureRecoveryAuthority,
} from "./owner-install-future-recovery.ts";
import {
  type OwnerSupersessionAuthority,
  ownerSupersessionUnchanged,
  readOwnerSupersededNormalAuthority,
  readOwnerSupersededRecoveryAuthority,
  readOwnerSupersessionAuthority,
} from "./owner-install-supersession.ts";
import { runOwnerSuccessorAcceptanceAppend } from "./owner-successor-acceptance-run.ts";

/**
 * Fixed production entry point. Reads only the named native identity and
 * credential variables; refuses before touching credentials when the process
 * is not the protected prepare job at the exact dispatched source commit.
 * Operational outcomes (waiting, no change, conflict, unconfirmed write) are
 * reported and exit zero so the unchanged supervisor is never blocked by this
 * one-shot; only invalid identity or credentials exit nonzero.
 */
export async function runOwnerDevelopmentInstallMain(input?: {
  /** Trusted in-process fixture seam; the workflow always uses the source pin. */
  matrixRecoveryRevision?: GitSha;
  matrixRecoveryBinding?: ClosedCWaveBindingV1;
  /** Only the temporary reviewed workflow supplies this fixed mode. */
  startupRecovery?: boolean;
  /** Immutable-history fixture seam; production always uses the source pin. */
  startupWitness?: GitSha;
  /** Trusted in-process fixture only; never read from the environment. */
  queueRuntimeCapability?: QueueRuntimeCapability;
  existingPrRuntimeCapability?: ExistingPrRuntimeCapability;
  /** Trusted fixture only; production uses reviewed source data. */
  rollout?: HostedRuntimeRollout;
}): Promise<number> {
  const repository = Deno.env.get("GITHUB_REPOSITORY");
  const ref = Deno.env.get("GITHUB_REF");
  const job = Deno.env.get("GITHUB_JOB");
  const sha = Deno.env.get("GITHUB_SHA");
  const workflowSha = Deno.env.get("GITHUB_WORKFLOW_SHA");
  if (
    repository !== OWNER_DEVELOPMENT_INSTALL_REPOSITORY ||
    ref !== HOSTED_SUPERVISOR_REF ||
    job !== "prepare" ||
    !isGitSha(sha) ||
    !isGitSha(workflowSha) ||
    sha !== workflowSha
  ) {
    return report(failedResult("identity_rejected"), 1);
  }
  const custodyCapability = input?.existingPrRuntimeCapability ??
    EXISTING_PR_RUNTIME_CAPABILITY;
  const rollout = parseHostedRuntimeRollout(
    input?.rollout ?? HOSTED_RUNTIME_ROLLOUT,
  );
  const custodyActive = custodyCapability.custodyActivated === true;
  let fenceRun: OwnerStartupRecoveryAuthorityV1["run"] | undefined;
  let startupRun: OwnerStartupRecoveryAuthorityV1["run"] | undefined;
  if (
    input?.startupRecovery === true || custodyActive ||
    rollout.recoveries.length > 0 || rollout.ownerSupersessions.length > 0
  ) {
    const runId = Number(Deno.env.get("GITHUB_RUN_ID"));
    const runAttempt = Number(Deno.env.get("GITHUB_RUN_ATTEMPT"));
    if (
      !Number.isSafeInteger(runId) || runId < 1 ||
      !Number.isSafeInteger(runAttempt) || runAttempt < 1 ||
      Deno.env.get("GITHUB_WORKFLOW_REF") !==
        "ubiquity-sentinel/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor"
    ) {
      return report(failedResult("startup_identity_rejected"), 1);
    }
    try {
      const source = await ownerStartupSourceHead();
      if (source !== sha) {
        return report(failedResult("startup_source_rejected"), 1);
      }
    } catch {
      return report(failedResult("startup_source_rejected"), 1);
    }
    fenceRun = { runId, runAttempt, launcherSha: sha };
    if (input?.startupRecovery === true) startupRun = fenceRun;
  }
  const nativeToken = Deno.env.get("GITHUB_TOKEN");
  const appToken = Deno.env.get("SENTINEL_SELF_TOKEN") ??
    Deno.env.get("SENTINEL_SUPERVISOR_TOKEN");
  if (!isToken(nativeToken) || !isToken(appToken)) {
    return report(failedResult("credentials_unavailable"), 1);
  }

  let state: StateReadView;
  try {
    state = await createOwnerDevelopmentInstallState(appToken);
  } catch {
    return report(failedResult("state_unavailable"));
  }

  const now = Date.now();
  const current = await readOwnerDevelopmentInstallState(state);
  if (current.status !== "found") {
    return report(
      waitingResult(
        current.status === "absent"
          ? "release state is absent"
          : "release state is unavailable",
        null,
        null,
      ),
    );
  }

  let startup: OwnerStartupRecoveryAuthorityV1 | undefined;
  if (startupRun !== undefined) {
    const pointer = current.snapshot.hostedRuntimes[0];
    if (
      pointer === undefined ||
      !isOwnerStartupRecoveryTuple(
        pointer.activeRevision,
        pointer.generation,
        true,
      )
    ) {
      return report({
        ...waitingResult(
          "pointer is outside pinned startup recovery",
          current.snapshot,
          current.head,
        ),
        status: "no_change",
      });
    }
    if (pointer.generation === OWNER_STARTUP_RECOVERY_GENERATION) {
      return report({
        ...waitingResult(
          "pinned startup recovery is terminal",
          current.snapshot,
          current.head,
        ),
        status: "no_change",
      });
    }
    try {
      startup = await readOwnerStartupRecoveryAuthority(
        state,
        nativeToken,
        current,
        startupRun,
        input?.startupWitness ?? OWNER_STARTUP_RECOVERY_WITNESS,
      );
    } catch {
      startup = undefined;
    }
    if (startup === undefined) {
      return report(
        waitingResult(
          "pinned startup recovery custody is unavailable",
          current.snapshot,
          current.head,
        ),
      );
    }
  }

  const recoveryRevision = input?.matrixRecoveryRevision ??
    OWNER_DEVELOPMENT_INSTALL_MATRIX_RECOVERY_REVISION;
  let recovery: OwnerMatrixRecoveryEvidenceV1 | undefined;
  const recoveryBinding = input?.matrixRecoveryBinding ?? CLOSED_C_WAVE;
  const pointer = current.snapshot.hostedRuntimes[0];
  const closedExecution = [
    pointer?.execution,
    pointer?.lastExecutionProof?.execution,
  ].some((execution) =>
    execution !== null && execution !== undefined &&
    execution.id ===
      `${recoveryBinding.run.runId}:${recoveryBinding.run.runAttempt}:repair` &&
    execution.runId === recoveryBinding.run.runId &&
    execution.runAttempt === recoveryBinding.run.runAttempt &&
    execution.launcherSha === recoveryBinding.run.launcherSha &&
    execution.revision === recoveryBinding.runtimeSha &&
    execution.generation === recoveryBinding.generation &&
    execution.purpose === "ordinary" && execution.releaseId === null
  );
  if (
    recoveryRevision !== null && pointer !== undefined &&
    ((pointer.activeRevision === recoveryBinding.runtimeSha &&
      ((pointer.generation === recoveryBinding.generation && closedExecution) ||
        pointer.generation === recoveryBinding.generation + 2)) ||
      (pointer.activeRevision === recoveryRevision &&
        pointer.generation === recoveryBinding.generation + 1))
  ) {
    try {
      recovery = await readOwnerMatrixRecoveryEvidence(
        state,
        nativeToken,
        current,
        recoveryRevision,
        recoveryBinding,
      );
    } catch {
      recovery = undefined;
    }
    if (recovery === undefined) {
      return report(
        waitingResult(
          "closed matrix recovery custody or charge readback is unavailable",
          current.snapshot,
          current.head,
        ),
      );
    }
  }
  const futureInput = fenceRun === undefined ? undefined : {
    state,
    token: nativeToken,
    current,
    run: fenceRun,
    queue: input?.queueRuntimeCapability ?? QUEUE_RUNTIME_CAPABILITY,
    custody: custodyCapability,
    rollout,
  };
  let future: OwnerFutureRecoveryAuthority | undefined;
  if (futureInput !== undefined && pointer?.execution === null) {
    const appended = await runOwnerSuccessorAcceptanceAppend(
      futureInput,
      appToken,
    );
    if (appended === "appended") {
      return report({
        ...waitingResult(
          "owner successor task acceptance appended; installed health and original request preserved",
          current.snapshot,
          current.head,
        ),
        status: "no_change",
      });
    }
  }
  let supersession: OwnerSupersessionAuthority | undefined;
  const supersessionSelected =
    rollout.ownerSupersessions.some((row) =>
      row.fromRevision === pointer?.activeRevision &&
      row.fromGeneration === pointer.generation
    ) &&
    current.snapshot.hostedReleases.some((r) => r.phase === "requested");
  const supersededRecoverySelected =
    current.snapshot.hostedReleases.some((r) =>
      r.phase === "owner_superseded" &&
      (r.ownerDisposition?.intent.toRevision === pointer?.activeRevision &&
          r.ownerDisposition.intent.toGeneration === pointer.generation ||
        r.ownerSuccessorBindings?.some((b) =>
          b.binding.successorRevision === pointer?.activeRevision &&
          b.binding.successorGeneration === pointer.generation
        ))
    ) &&
    rollout.recoveries.some((row) =>
      row.fromRevision === pointer?.activeRevision &&
      row.fromGeneration === pointer.generation
    );
  if (supersessionSelected || supersededRecoverySelected) {
    supersession = futureInput === undefined
      ? undefined
      : await (supersessionSelected
        ? readOwnerSupersessionAuthority
        : readOwnerSupersededRecoveryAuthority)(futureInput);
    if (supersession === undefined) {
      return report(
        waitingResult(
          "exact owner supersession custody is unavailable",
          current.snapshot,
          current.head,
        ),
      );
    }
  }
  if (
    supersession === undefined && futureInput !== undefined &&
    current.snapshot.hostedReleases.some((r) => r.phase === "owner_superseded")
  ) supersession = await readOwnerSupersededNormalAuthority(futureInput);
  if (
    supersession === undefined &&
    rollout.recoveries.some((row) =>
      row.fromRevision === pointer?.activeRevision &&
      row.fromGeneration === pointer.generation
    )
  ) {
    future = futureInput === undefined
      ? undefined
      : await readOwnerFutureRecoveryAuthority(futureInput);
    if (future === undefined) {
      return report(
        waitingResult(
          "exact future recovery custody is unavailable",
          current.snapshot,
          current.head,
        ),
      );
    }
  }
  const plan = planOwnerDevelopmentInstall(
    current.snapshot,
    now,
    recovery,
    startup,
    input?.queueRuntimeCapability,
    input?.existingPrRuntimeCapability,
    rollout,
    future,
    supersession,
  );
  if (plan.status === "waiting" || plan.status === "no_change") {
    return report({
      ...waitingResult(plan.detail, current.snapshot, current.head),
      status: plan.status,
    });
  }

  const move = plan.move;
  const repairBefore = custodyActive ? await state.readRepair() : null;
  const drainDeadline = Date.now() + 120_000;
  const revalidateDrain = async (): Promise<boolean> => {
    if (!custodyActive) return true;
    if (
      fenceRun === undefined || !repairBefore?.ok ||
      repairBefore.value.status !== "found"
    ) return false;
    const native = await readHostedWriterQuiescence({
      token: nativeToken,
      run: fenceRun,
      phase: "prepare",
      clock: { now: () => Date.now() },
      deadline: drainDeadline,
    }, custodyCapability);
    if (native.status !== "ready") return false;
    const [repair, release] = await Promise.all([
      state.readRepair(),
      state.readRelease(),
    ]);
    return repair.ok && repair.value.status === "found" &&
      repair.value.head === repairBefore.value.head &&
      canonicalStringify(repair.value.snapshot) ===
        canonicalStringify(repairBefore.value.snapshot) &&
      release.ok && release.value.status === "found" &&
      release.value.head === current.head &&
      canonicalStringify(release.value.snapshot) ===
        canonicalStringify(current.snapshot);
  };
  if (!await revalidateDrain()) {
    return report(
      waitingResult(
        "hosted writer compatibility drain unavailable",
        current.snapshot,
        current.head,
      ),
    );
  }
  if (plan.status === "install") {
    const verified = await verifyOwnerDevelopmentInstallRevision(
      nativeToken,
      move.nextRevision,
      startup?.run.launcherSha,
    );
    if (!verified.verified) {
      return report(
        waitingResult(verified.detail, current.snapshot, current.head),
      );
    }
  }
  if (startup !== undefined) {
    const controller = await ownerDevelopmentInstallApi(
      nativeToken,
      "GET",
      `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/commits/${startup.run.launcherSha}/check-runs?per_page=100`,
    );
    if (
      !controller.ok || controller.value.status !== 200 ||
      !testLocalCheckSucceeded(controller.value.value, startup.run.launcherSha)
    ) {
      return report(
        waitingResult(
          "startup controller CI is unavailable",
          current.snapshot,
          current.head,
        ),
      );
    }
  }
  if (recovery !== undefined) {
    const repair = await state.readRepair();
    if (
      !repair.ok || repair.value.status !== "found" ||
      repair.value.head !== recovery.repairHead ||
      repair.value.snapshot.githubCooldowns.some((row) =>
        row.retryNotBefore === null || Date.now() < row.retryNotBefore
      )
    ) {
      return report(
        waitingResult(
          "closed matrix recovery repair head changed before movement",
          current.snapshot,
          current.head,
        ),
      );
    }
  }

  let planned: ReleaseStateSnapshotV1;
  let files: OwnerDevelopmentInstallFilesV1;
  let message: string;
  try {
    const intendedAt = supersession === undefined ? now : Date.now();
    planned = buildOwnerDevelopmentInstallSnapshot(
      current.snapshot,
      current.head,
      move,
      intendedAt,
      recovery,
      startup,
      input?.queueRuntimeCapability,
      input?.existingPrRuntimeCapability,
      future,
      rollout,
      supersession,
    );
    const changedRelease = planned.hostedReleases.find((r) =>
      canonicalStringify(r) !==
        canonicalStringify(
          current.snapshot.hostedReleases.find((p) => p.id === r.id),
        )
    );
    files = await ownerDevelopmentInstallFiles(
      planned,
      current.head,
      changedRelease?.id,
    );
    message = ownerDevelopmentInstallCommitMessage({
      version: "v1",
      kind: "owner_development_install",
      authority: "owner",
      action: move.action,
      authorizedAt: intendedAt,
      priorRevision: move.priorRevision,
      priorGeneration: move.priorGeneration,
      nextRevision: move.nextRevision,
      nextGeneration: move.nextGeneration,
      stateHead: current.head,
      priorHealthyProof: move.priorHealthyProof,
      nonce: randomHex(NONCE_BYTES),
    });
  } catch {
    return report(failedResult("plan_invalid"));
  }

  const written = await writeOwnerDevelopmentInstallCommit(
    state,
    appToken,
    current.head,
    planned,
    files,
    message,
    !custodyActive && startup === undefined && future === undefined &&
      supersession === undefined
      ? undefined
      : async () =>
        await revalidateDrain() && (startup === undefined ||
          (await ownerStartupRepairUnchanged(state, startup) &&
            await ownerStartupNativeQuiescent(nativeToken, startup.run))) &&
        (future === undefined ||
          (futureInput !== undefined &&
            await ownerFutureRecoveryUnchanged(futureInput, future))) &&
        (supersession === undefined ||
          (futureInput !== undefined &&
            await ownerSupersessionUnchanged(futureInput, supersession))),
  );
  if (written.status !== "confirmed") {
    return report({
      ...waitingResult(written.detail, current.snapshot, current.head),
      status: "failed",
      action: move.action,
      priorRevision: move.priorRevision,
      priorGeneration: move.priorGeneration,
      candidateRevision: move.nextRevision,
      candidateGeneration: move.nextGeneration,
      stateCommit: written.commit,
    });
  }

  return report({
    kind: "owner_development_install",
    status: move.action === "install" ? "installed" : "rolled_back",
    action: move.action,
    priorRevision: move.priorRevision,
    priorGeneration: move.priorGeneration,
    candidateRevision: move.nextRevision,
    candidateGeneration: move.nextGeneration,
    stateHead: current.head,
    stateCommit: written.commit,
    detail: move.action === "install"
      ? "owner development install applied; runtime health is not yet proven"
      : "owner development rollback applied; runtime health is not yet proven",
  });
}
