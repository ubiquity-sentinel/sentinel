import { isGitSha } from "../contracts/brands.ts";
import type { GitSha } from "../contracts/brands.ts";
import { parseHostedRunProofV1 } from "../contracts/hosted-supervisor.ts";
import type { HostedRunProofV1 } from "../contracts/hosted-supervisor.ts";
import type { StateReadView } from "../contracts/ports.ts";
import { tryParse } from "../contracts/validation.ts";
import {
  isOwnerStartupRecoveryHealthyProof,
} from "./owner-startup-recovery.ts";
import type {
  OwnerStartupRecoveryAuthorityV1,
} from "./owner-startup-recovery.ts";
import { OWNER_DEVELOPMENT_INSTALL_REPOSITORY } from "./owner-install-pins.ts";
import type {
  OwnerDevelopmentInstallStateReadV1,
} from "./owner-install-types.ts";
import {
  isRecord,
  ownerDevelopmentInstallApi,
  ownerMatrixMetadataList,
  readNestedSha,
} from "./owner-install-api.ts";

/** Fixed credential-free source checks retain the existing git-only run grant. */
export async function ownerStartupSourceHead(): Promise<GitSha | null> {
  const outputs: string[] = [];
  for (
    const args of [["rev-parse", "HEAD"], [
      "status",
      "--porcelain",
      "--untracked-files=all",
    ]]
  ) {
    const result = await new Deno.Command("git", {
      args: ["-c", "core.hooksPath=/dev/null", ...args],
      cwd: Deno.cwd(),
      clearEnv: true,
      env: {
        PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
        HOME: Deno.cwd(),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "piped",
      stderr: "null",
      signal: AbortSignal.timeout(10_000),
    }).output();
    if (!result.success || result.stdout.length > 65_536) return null;
    outputs.push(new TextDecoder().decode(result.stdout).trim());
  }
  return isGitSha(outputs[0]) && outputs[1] === "" ? outputs[0] : null;
}

export async function ownerStartupRepairUnchanged(
  state: StateReadView,
  authority: OwnerStartupRecoveryAuthorityV1,
): Promise<boolean> {
  const read = await state.readRepair();
  return read.ok && read.value.status === "found" &&
    read.value.head === authority.repairHead &&
    !read.value.snapshot.githubCooldowns.some((row) =>
      row.retryNotBefore === null || Date.now() < row.retryNotBefore
    );
}

/** Exact historical custody plus native completion; no proof is synthesized. */
export async function readOwnerStartupRecoveryAuthority(
  state: StateReadView,
  token: string,
  current: Extract<OwnerDevelopmentInstallStateReadV1, { status: "found" }>,
  run: OwnerStartupRecoveryAuthorityV1["run"],
  witnessHead: GitSha,
): Promise<OwnerStartupRecoveryAuthorityV1 | undefined> {
  if (!state.readReleaseAt) return undefined;
  const witness = await state.readReleaseAt({
    commit: witnessHead,
    expectedHead: current.head,
  });
  const repair = await state.readRepair();
  if (
    !witness.ok || witness.value.status !== "found" ||
    !repair.ok || repair.value.status !== "found"
  ) return undefined;
  const prior = witness.value.snapshot.hostedRuntimes[0]?.lastHealthyProof;
  const pointer = current.snapshot.hostedRuntimes.length === 1
    ? current.snapshot.hostedRuntimes[0]
    : undefined;
  const failed = tryParse(parseHostedRunProofV1, pointer?.lastExecutionProof);
  if (
    !pointer || pointer.execution !== null ||
    !isOwnerStartupRecoveryHealthyProof(prior) ||
    !failed.ok || failed.value.outcome !== "failed" ||
    !await ownerStartupNativeProof(token, prior) ||
    !await ownerStartupNativeProof(token, failed.value) ||
    !await ownerStartupNativeQuiescent(token, run)
  ) return undefined;
  const authority: OwnerStartupRecoveryAuthorityV1 = {
    releaseHead: current.head,
    repairHead: repair.value.head,
    witnessHead,
    healthyProof: prior,
    nativeQuiescent: true,
    nativeProofsVerified: true,
    run,
  };
  return await ownerStartupRepairUnchanged(state, authority)
    ? authority
    : undefined;
}

export async function ownerStartupNativeProof(
  token: string,
  proof: HostedRunProofV1,
): Promise<boolean> {
  const root =
    `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}/actions/runs/${proof.execution.runId}/attempts/${proof.execution.runAttempt}`;
  const response = await ownerDevelopmentInstallApi(token, "GET", root);
  if (
    !response.ok || response.value.status !== 200 ||
    !isRecord(response.value.value)
  ) return false;
  const run = response.value.value;
  if (
    run.id !== proof.execution.runId ||
    run.run_attempt !== proof.execution.runAttempt ||
    run.head_sha !== proof.execution.launcherSha ||
    run.workflow_id !== proof.workflowId ||
    run.head_branch !== "sentinel-supervisor" || run.status !== "completed"
  ) return false;
  const jobs = await ownerMatrixMetadataList(token, `${root}/jobs`, "jobs");
  const job = jobs?.find((row) => row.id === proof.jobId);
  return jobs !== null && jobs.length > 0 &&
    jobs.every((row) => row.status === "completed") &&
    job?.name === "repair" && job.head_sha === proof.execution.launcherSha &&
    (proof.outcome === "healthy"
      ? job.conclusion === "success"
      : job.conclusion === "failure" || job.conclusion === "timed_out");
}

/** Fail closed on any competing protected execution or stale controller ref. */
export async function ownerStartupNativeQuiescent(
  token: string,
  expected: OwnerStartupRecoveryAuthorityV1["run"],
): Promise<boolean> {
  const root = `/repos/${OWNER_DEVELOPMENT_INSTALL_REPOSITORY}`;
  const ref = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `${root}/git/ref/heads/sentinel-supervisor`,
  );
  if (
    !ref.ok || ref.value.status !== 200 ||
    readNestedSha(ref.value.value, "object") !== expected.launcherSha
  ) return false;
  const response = await ownerDevelopmentInstallApi(
    token,
    "GET",
    `${root}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`,
  );
  if (
    !response.ok || response.value.status !== 200 ||
    !isRecord(response.value.value)
  ) return false;
  const run = response.value.value;
  if (
    run.id !== expected.runId || run.run_attempt !== expected.runAttempt ||
    run.head_sha !== expected.launcherSha ||
    run.head_branch !== "sentinel-supervisor" ||
    run.workflow_id !== 357012162 || run.status !== "in_progress"
  ) return false;
  const jobs = await ownerMatrixMetadataList(
    token,
    `${root}/actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs`,
    "jobs",
  );
  if (
    !jobs ||
    jobs.filter((job) =>
        job.name === "prepare" && job.status === "in_progress" &&
        job.head_sha === expected.launcherSha
      ).length !== 1 ||
    jobs.some((job) =>
      job.status !== "completed" &&
      !(job.name === "prepare" && job.status === "in_progress") &&
      !(job.status === "queued" && job.started_at === null &&
        (job.runner_id === 0 || job.runner_id === null))
    )
  ) return false;
  for (const workflow of ["supervisor.yml", "repair.yml", "release.yml"]) {
    const runs = await ownerMatrixMetadataList(
      token,
      `${root}/actions/workflows/${workflow}/runs?status=in_progress`,
      "workflow_runs",
    );
    if (
      !runs || runs.some((row) =>
        row.status !== "in_progress" ||
        workflow !== "supervisor.yml" || row.id !== expected.runId ||
        row.run_attempt !== expected.runAttempt ||
        row.head_sha !== expected.launcherSha
      )
    ) return false;
  }
  return true;
}
