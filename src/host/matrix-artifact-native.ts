/** Exact native step markers, execution completion and custody readback. */
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS as TOLERANCE,
  HOSTED_RUNTIME_ID,
  HOSTED_SUPERVISOR_REF,
  HOSTED_SUPERVISOR_REPOSITORY as REPOSITORY,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../contracts/hosted-supervisor.ts";
import { canonicalStringify } from "../contracts/canonical.ts";
import { isGitSha } from "../contracts/brands.ts";
import type { MatrixRunIdentityV1 } from "../contracts/matrix.ts";
import {
  instant,
  type Json,
  positive,
  record,
  refuse,
  sameRun,
} from "./matrix-artifact-values.ts";
import type {
  MatrixArtifactOptionsV1,
  MatrixArtifactReaderV1,
  MatrixArtifactRecoveryInputV1,
} from "./matrix-artifact-context.ts";

const API = `https://api.github.com/repos/${REPOSITORY}/actions`;
const MARKER_KEYS = {
  sentinel_matrix_plan: [
    "kind",
    "waveId",
    "run",
    "runtimeSha",
    "generation",
    "planDigest",
    "prepared",
  ],
  sentinel_matrix_cell: [
    "kind",
    "run",
    "runtimeSha",
    "generation",
    "cellId",
    "reservationId",
    "resultDigest",
    "bundleDigest",
    "status",
  ],
};

/**
 * A completed native job whose log body, or whose marker in it, is not served
 * yet. Only the cell marker raises it, and the wave reader turns it into a
 * deferral or the plain refusal: it never leaves the transport.
 */
export class MatrixNativeLogUnserved extends Error {
  constructor() {
    super("matrix native job log not served yet");
  }
}
export function unservedLog(): never {
  throw new MatrixNativeLogUnserved();
}

export function createMatrixArtifactMarker(
  options: MatrixArtifactOptionsV1,
  download: MatrixArtifactReaderV1["download"],
  input: MatrixArtifactRecoveryInputV1,
) {
  const marker = async (
    job: Json,
    stepName: string,
    kind: keyof typeof MARKER_KEYS,
    run: MatrixRunIdentityV1,
    expectedRuntime: string | null = input.runtimeSha,
    unserved: () => never = refuse,
  ): Promise<Json> => {
    if (
      job.run_id !== run.runId || job.run_attempt !== run.runAttempt ||
      job.head_sha !== run.launcherSha || job.status !== "completed" ||
      !["success", "failure"].includes(String(job.conclusion)) ||
      !Array.isArray(job.steps)
    ) refuse();
    const steps = job.steps.map(record).filter((step) =>
      step.name === stepName
    );
    if (
      steps.length !== 1 || steps[0].status !== "completed" ||
      !["success", "failure"].includes(String(steps[0].conclusion))
    ) refuse();
    const step = steps[0],
      start = instant(step.started_at),
      end = instant(step.completed_at);
    if (
      end < start || end > options.clock.now() + TOLERANCE ||
      start + TOLERANCE < instant(job.started_at) ||
      end > instant(job.completed_at) + TOLERANCE
    ) refuse();
    const response = await download(
      `/jobs/${positive(job.id)}/logs`,
      false,
      unserved,
    );
    const found: Json[] = [];
    for (const line of response.bodyText.split("\n")) {
      const match = line.match(
        /^(\d{4}-\d{2}-\d{2}T\S+Z)\s+(\{.*\})\s*$/,
      );
      if (!match) continue;
      let value: Json;
      try {
        value = record(JSON.parse(match[2]));
      } catch {
        continue;
      }
      if (value.kind !== kind) continue;
      const at = instant(match[1]);
      if (
        at + TOLERANCE < start || at > end + TOLERANCE ||
        Object.keys(value).sort().join() !==
          [...MARKER_KEYS[kind]].sort().join()
      ) refuse();
      if (
        !sameRun(run, record(value.run)) ||
        !isGitSha(value.runtimeSha) ||
        (expectedRuntime !== null && value.runtimeSha !== expectedRuntime)
      ) refuse();
      positive(value.generation);
      found.push(value);
    }
    // A log without the marker yet is unserved; two markers are a conflict.
    if (found.length === 0) unserved();
    if (found.length !== 1) refuse();
    return found[0];
  };

  return marker;
}

export async function confirmMatrixArtifactCompletion(
  options: MatrixArtifactOptionsV1,
  input: MatrixArtifactRecoveryInputV1,
  completionCustody: string | null,
  reader: MatrixArtifactReaderV1,
) {
  const { json, pages } = reader;
  if (!input.completedExecution) refuse();
  const execution = input.completedExecution;
  const attempt = await json(
    `${API}/runs/${execution.runId}/attempts/${execution.runAttempt}`,
  );
  const repo = record(attempt.repository),
    headRepo = record(attempt.head_repository);
  if (
    attempt.id !== execution.runId ||
    attempt.run_attempt !== execution.runAttempt ||
    attempt.workflow_id !== HOSTED_SUPERVISOR_WORKFLOW_ID ||
    attempt.path !== HOSTED_SUPERVISOR_WORKFLOW_PATH ||
    attempt.event !== "workflow_dispatch" ||
    attempt.head_branch !==
      HOSTED_SUPERVISOR_REF.replace("refs/heads/", "") ||
    attempt.head_sha !== execution.launcherSha ||
    repo.full_name !== REPOSITORY ||
    headRepo.full_name !== REPOSITORY || attempt.status !== "completed"
  ) refuse();
  positive(repo.id);
  positive(headRepo.id);
  const start = instant(attempt.run_started_at);
  const end = instant(attempt.updated_at);
  if (
    end < start ||
    end < execution.createdAt ||
    end > options.clock.now() + TOLERANCE
  ) refuse();
  const jobs = await pages(
    `/runs/${execution.runId}/attempts/${execution.runAttempt}/jobs`,
    "jobs",
  );
  for (const job of jobs) {
    if (
      job.run_id !== execution.runId ||
      job.run_attempt !== execution.runAttempt ||
      job.head_sha !== execution.launcherSha ||
      job.status !== "completed" ||
      typeof job.conclusion !== "string" || job.conclusion.length === 0
    ) refuse();
    const finished = instant(job.completed_at);
    const started = job.started_at === null ? null : instant(job.started_at);
    // Skipped GitHub placeholders without runners have metadata times,
    // rather than an execution interval; both must remain in the attempt.
    const skippedWithoutRunner = job.conclusion === "skipped" &&
      job.runner_id === null && job.runner_name === null;
    if (
      finished > end + TOLERANCE ||
      finished > options.clock.now() + TOLERANCE ||
      (skippedWithoutRunner
        ? started === null || started < start || started > end ||
          finished < start || finished > end
        : started !== null && finished < started)
    ) refuse();
  }
  const fresh = await options.state.readRelease();
  if (
    !fresh.ok || fresh.value.status !== "found" ||
    canonicalStringify({
        head: fresh.value.head,
        runtime: fresh.value.snapshot.hostedRuntimes.find((row) =>
          row.id === HOSTED_RUNTIME_ID
        ),
      }) !== completionCustody
  ) refuse();
  return { recovered: [], rejected: [], completed: true };
}
