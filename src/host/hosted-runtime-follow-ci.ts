import {
  FOLLOW_REPOSITORY,
  FollowError,
  type HostedRuntimeFollowApi,
  positive,
  record,
} from "./hosted-runtime-follow-api.ts";
import { HOSTED_CONTROLLER_DEPLOYMENT } from "../contracts/hosted-controller-deployment.ts";

export const FOLLOW_CI_WORKFLOW_ID = HOSTED_CONTROLLER_DEPLOYMENT.ciWorkflowId;
/** W7's aggregate job must retain this stable required check name. */
export const FOLLOW_REQUIRED_CHECK = "test-local";

export interface FollowCiProof {
  runId: number;
  attempt: number;
  jobIds: number[];
}

export function sameRepository(raw: unknown, repositoryId: number): boolean {
  const value = record(raw);
  return value.full_name === FOLLOW_REPOSITORY && value.id === repositoryId;
}

function eligibleRun(
  row: Record<string, unknown>,
  revision: string,
  repositoryId: number,
): boolean {
  positive(row.id);
  positive(row.run_attempt);
  return row.workflow_id === FOLLOW_CI_WORKFLOW_ID &&
    row.path === HOSTED_CONTROLLER_DEPLOYMENT.ciWorkflowPath &&
    row.event === "push" &&
    row.head_branch === HOSTED_CONTROLLER_DEPLOYMENT.sourceBranch &&
    row.head_sha === revision && row.status === "completed" &&
    row.conclusion === "success" &&
    sameRepository(row.repository, repositoryId) &&
    sameRepository(row.head_repository, repositoryId);
}

/** Validate the explicit latest attempt and its complete attempt-specific jobs. */
export async function recheckFollowCi(
  api: HostedRuntimeFollowApi,
  revision: string,
  repositoryId: number,
  proof: Pick<FollowCiProof, "runId" | "attempt">,
): Promise<FollowCiProof | null> {
  const path = `/actions/runs/${proof.runId}`;
  const latest = record(await api.get(path));
  if (
    latest.id !== proof.runId || latest.run_attempt !== proof.attempt ||
    !eligibleRun(latest, revision, repositoryId)
  ) return null;
  const attempt = record(await api.get(`${path}/attempts/${proof.attempt}`));
  if (
    attempt.id !== proof.runId || attempt.run_attempt !== proof.attempt ||
    !eligibleRun(attempt, revision, repositoryId)
  ) return null;
  const jobs = await api.list(`${path}/attempts/${proof.attempt}/jobs`, "jobs");
  const required: number[] = [];
  for (const job of jobs) {
    if (
      job.run_id !== proof.runId || job.run_attempt !== proof.attempt ||
      job.head_sha !== revision || typeof job.name !== "string"
    ) {
      throw new FollowError("ci_job_identity_mismatch");
    }
    if (job.name === FOLLOW_REQUIRED_CHECK) {
      if (job.status !== "completed" || job.conclusion !== "success") {
        return null;
      }
      required.push(positive(job.id));
    }
  }
  if (required.length === 0) return null;
  return { ...proof, jobIds: required.sort((left, right) => left - right) };
}

export async function readFollowCi(
  api: HostedRuntimeFollowApi,
  revision: string,
  repositoryId: number,
): Promise<FollowCiProof | null> {
  const runs = await api.list(
    `/actions/workflows/${FOLLOW_CI_WORKFLOW_ID}/runs`,
    "workflow_runs",
    {
      head_sha: revision,
      event: "push",
      branch: HOSTED_CONTROLLER_DEPLOYMENT.sourceBranch,
    },
  );
  // The chain selects revisions. For multiple proofs of the SAME revision,
  // choose a stable immutable tuple; API ordering and timestamps are irrelevant.
  const eligible = runs.filter((run) =>
    eligibleRun(run, revision, repositoryId)
  )
    .sort((left, right) => (left.id as number) - (right.id as number));
  for (const run of eligible) {
    const proof = await recheckFollowCi(api, revision, repositoryId, {
      runId: positive(run.id),
      attempt: positive(run.run_attempt),
    });
    if (proof !== null) return proof;
  }
  return null;
}
