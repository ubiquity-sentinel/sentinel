import type { GitSha } from "../contracts/brands.ts";
import type { HostedRunProofV1 } from "../contracts/hosted-supervisor.ts";
import type { StateReadView } from "../contracts/ports.ts";
import type { ClosedCWaveBindingV1 } from "./modern-matrix-recovery.ts";
import { closedCWaveChargeReadbackVerified } from "./modern-matrix-recovery.ts";
import { OWNER_DEVELOPMENT_INSTALL_REPOSITORY } from "./owner-install-pins.ts";
import type {
  OwnerDevelopmentInstallStateReadV1,
  OwnerMatrixRecoveryEvidenceV1,
} from "./owner-install-types.ts";
import {
  isRecord,
  ownerDevelopmentInstallApi,
  ownerMatrixMetadataList,
} from "./owner-install-api.ts";

/** Metadata never substitutes for bytes: the durable real consumer readback supplies ingestion. */
export async function readOwnerMatrixRecoveryEvidence(
  state: StateReadView,
  token: string,
  current: Extract<OwnerDevelopmentInstallStateReadV1, { status: "found" }>,
  candidate: GitSha,
  binding: ClosedCWaveBindingV1,
): Promise<OwnerMatrixRecoveryEvidenceV1 | undefined> {
  if (!state.readRepairAt || !state.readReleaseAt) return undefined;
  const repair = await state.readRepair();
  if (
    !repair.ok || repair.value.status !== "found" ||
    repair.value.snapshot.githubCooldowns.some((row) =>
      row.retryNotBefore === null || Date.now() < row.retryNotBefore
    )
  ) return undefined;
  const pointer = current.snapshot.hostedRuntimes[0];
  const initialInstall = pointer?.activeRevision === binding.runtimeSha &&
    pointer.generation === binding.generation;
  const witness = await state.readReleaseAt({
    commit: binding.releaseCommit,
    expectedHead: current.head,
  });
  if (!witness.ok || witness.value.status !== "found") return undefined;
  if (initialInstall) {
    const original = await state.readRepairAt({
      commit: binding.repairCommit,
      expectedHead: repair.value.head,
    });
    if (
      !original.ok || original.value.status !== "found" ||
      !closedCWaveChargeReadbackVerified(
        original.value.snapshot,
        repair.value.snapshot,
        binding,
      )
    ) return undefined;
  }
  const runtime = witness.value.snapshot.hostedRuntimes[0];
  if (
    !runtime?.lastHealthyProof || !runtime.lastExecutionProof ||
    runtime.lastExecutionProof.outcome !== "failed"
  ) return undefined;
  if (
    initialInstall &&
    !await ownerMatrixNativeCustody(
      token,
      runtime.lastExecutionProof,
      binding,
      true,
    )
  ) return undefined;
  const liveFailure = current.snapshot.hostedRuntimes[0]?.lastExecutionProof;
  if (
    pointer?.activeRevision === candidate &&
    pointer.generation === binding.generation + 1 &&
    liveFailure?.outcome === "failed" &&
    liveFailure.execution.revision === candidate &&
    !await ownerMatrixNativeCustody(token, liveFailure, binding, false)
  ) return undefined;
  const [freshRepair, freshRelease] = await Promise.all([
    state.readRepair(),
    state.readRelease(),
  ]);
  if (
    !freshRepair.ok || freshRepair.value.status !== "found" ||
    freshRepair.value.head !== repair.value.head || !freshRelease.ok ||
    freshRepair.value.snapshot.githubCooldowns.some((row) =>
      row.retryNotBefore === null || Date.now() < row.retryNotBefore
    ) ||
    freshRelease.value.status !== "found" ||
    freshRelease.value.head !== current.head
  ) return undefined;
  return {
    candidate,
    repairHead: repair.value.head,
    releaseHead: current.head,
    ownHealthyProof: runtime.lastHealthyProof,
    failedOrdinaryProof: runtime.lastExecutionProof,
    nativeQuiescent: true,
    artifactCustody: true,
    chargesVerified: true,
    binding,
  };
}

export async function ownerMatrixNativeCustody(
  token: string,
  proof: HostedRunProofV1,
  binding: ClosedCWaveBindingV1,
  artifacts: boolean,
): Promise<boolean> {
  const root =
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/actions/runs/${proof.execution.runId}`;
  const run = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `${root}/attempts/${proof.execution.runAttempt}`,
  );
  if (!run.ok || run.value.status !== 200 || !isRecord(run.value.value)) {
    return false;
  }
  const native = run.value.value;
  if (
    native.id !== proof.execution.runId ||
    native.run_attempt !== proof.execution.runAttempt ||
    native.head_sha !== proof.execution.launcherSha ||
    native.workflow_id !== proof.workflowId ||
    native.head_branch !== "sentinel-supervisor" ||
    native.status !== "completed"
  ) return false;
  const jobs = await ownerMatrixMetadataList(
    token,
    `${root}/attempts/${proof.execution.runAttempt}/jobs`,
    "jobs",
  );
  if (
    !jobs || jobs.length === 0 || !jobs.some((row) => row.id === proof.jobId) ||
    jobs.some((row) => row.status !== "completed")
  ) return false;
  if (!artifacts) return true;
  const rows = await ownerMatrixMetadataList(
    token,
    `${root}/artifacts`,
    "artifacts",
  );
  if (!rows) return false;
  const planName =
    `sentinel-matrix-plan-${binding.run.runId}-${binding.run.runAttempt}`;
  const required = [
    planName,
    ...binding.cells.map((cell) =>
      `sentinel-matrix-cell-${binding.run.runId}-${binding.run.runAttempt}-${cell.cellId}`
    ),
  ];
  if (
    binding.cells.some((cell) => cell.cellId === undefined) ||
    new Set(rows.map((row) => row.name)).size !== rows.length
  ) return false;
  return required.every((name) => {
    const row = rows.find((item) => item.name === name);
    return row !== undefined && row.expired === false &&
      typeof row.digest === "string" &&
      /^sha256:[0-9a-f]{64}$/.test(row.digest) &&
      (name !== planName || binding.planZipDigest === undefined ||
        row.digest === `sha256:${binding.planZipDigest}`);
  });
}
