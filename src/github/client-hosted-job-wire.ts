// client hosted job wire.

import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import { expectHostedControllerRepository } from "../contracts/hosted-controller-deployment.ts";
import {
  expectArray,
  expectCount,
  expectEnum,
  expectNonEmptyString,
  expectNullable,
  expectNullableString,
  expectPositiveInt,
  expectRecord,
  fail,
  MaxText,
} from "../contracts/validation.ts";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS,
  HOSTED_SUPERVISOR_WORKFLOW_ID,
  HOSTED_SUPERVISOR_WORKFLOW_PATH,
} from "../contracts/hosted-supervisor.ts";
import { HOSTED_RUNTIME_STEP_NAME } from "../contracts/hosted-execution.ts";
import {
  expectIsoMs,
  type HostedAttemptV1,
  type HostedJobsV1,
  type HostedRuntimeStepV1,
} from "./client-hosted-revision-wire.ts";
import {
  HOSTED_EXECUTION_BRANCH,
  HOSTED_EXECUTION_JOBS_PAGE_SIZE,
  HOSTED_EXECUTION_MAX_JOB_STEPS,
  HOSTED_EXECUTION_MAX_JOBS,
} from "./client-hosted-policy.ts";

/** Exact attempt identity; completion instant required only when completed. */
export function parseHostedAttempt(
  value: unknown,
  intent: HostedExecutionIntentV1,
  observedAt: number,
): HostedAttemptV1 {
  const obj = expectRecord(value, "$");
  if (expectPositiveInt(obj.id, "$.id") !== intent.runId) {
    fail("$.id", "invalid_value", "attempt run id mismatch");
  }
  if (
    expectPositiveInt(obj.run_attempt, "$.run_attempt") !== intent.runAttempt
  ) {
    fail("$.run_attempt", "invalid_value", "attempt number mismatch");
  }
  if (
    expectPositiveInt(obj.workflow_id, "$.workflow_id") !==
      HOSTED_SUPERVISOR_WORKFLOW_ID
  ) {
    fail("$.workflow_id", "invalid_value", "unexpected workflow id");
  }
  if (
    expectNonEmptyString(obj.path, "$.path", MaxText.path) !==
      HOSTED_SUPERVISOR_WORKFLOW_PATH
  ) {
    fail("$.path", "invalid_value", "unexpected workflow path");
  }
  expectEnum(obj.event, ["workflow_dispatch"], "$.event");
  if (
    expectNonEmptyString(obj.head_branch, "$.head_branch", MaxText.branch) !==
      HOSTED_EXECUTION_BRANCH
  ) {
    fail("$.head_branch", "invalid_value", "unexpected workflow branch");
  }
  if (
    expectNonEmptyString(obj.head_sha, "$.head_sha", 40) !== intent.launcherSha
  ) {
    fail("$.head_sha", "invalid_value", "attempt launcher mismatch");
  }
  expectHostedControllerRepository(obj.repository, "$.repository");
  expectHostedControllerRepository(obj.head_repository, "$.head_repository");
  const status = expectEnum(
    obj.status,
    ["queued", "in_progress", "completed", "requested", "waiting", "pending"],
    "$.status",
  );
  const runStartedAt = expectNullable(
    obj.run_started_at,
    "$.run_started_at",
    expectIsoMs,
  );
  const completedAt = expectNullable(
    obj.updated_at,
    "$.updated_at",
    expectIsoMs,
  );
  if (
    completedAt !== null &&
    completedAt > observedAt + HOSTED_ACTIONS_CLOCK_TOLERANCE_MS
  ) {
    fail(
      "$.updated_at",
      "invalid_lifecycle",
      "attempt update is after the observation time",
    );
  }
  if (
    runStartedAt !== null && completedAt !== null &&
    runStartedAt > completedAt
  ) {
    fail(
      "$.updated_at",
      "invalid_lifecycle",
      "attempt times are inverted",
    );
  }
  if (
    status === "completed" && (runStartedAt === null || completedAt === null)
  ) {
    fail(
      "$.updated_at",
      "invalid_lifecycle",
      "a completed attempt requires its start and completion instants",
    );
  }
  return { status, completedAt };
}

/** Each authenticated page is bounded by the native API page size. */
export function parseHostedJobsPage(
  value: unknown,
): { total: number; jobs: unknown[] } {
  const obj = expectRecord(value, "$");
  const total = expectCount(obj.total_count, "$.total_count");
  if (total > HOSTED_EXECUTION_MAX_JOBS) {
    fail(
      "$.total_count",
      "bound_exceeded",
      "native job count exceeds workflow",
    );
  }
  const jobs = expectArray(
    obj.jobs,
    "$.jobs",
    HOSTED_EXECUTION_JOBS_PAGE_SIZE,
    (item) => item,
  );
  return { total, jobs };
}

/** A next page must stay on this exact authenticated attempt and advance once. */
export function validHostedJobsNext(
  apiBaseUrl: string,
  path: string,
  next: string,
  page: number,
): boolean {
  try {
    const url = new URL(next);
    return url.origin === new URL(apiBaseUrl).origin &&
      url.username === "" && url.password === "" && url.hash === "" &&
      url.pathname === path &&
      [...url.searchParams.keys()].length === 2 &&
      url.searchParams.get("per_page") ===
        String(HOSTED_EXECUTION_JOBS_PAGE_SIZE) &&
      url.searchParams.get("page") === String(page);
  } catch {
    return false;
  }
}

/** Exactly one complete native listing with at most one total repair job. */
export function parseHostedJobs(
  value: unknown,
  intent: HostedExecutionIntentV1,
): HostedJobsV1 {
  const obj = expectRecord(value, "$");
  const total = expectCount(obj.total_count, "$.total_count");
  const jobs = expectArray(
    obj.jobs,
    "$.jobs",
    HOSTED_EXECUTION_MAX_JOBS,
    (item) => item,
  );
  if (total > HOSTED_EXECUTION_MAX_JOBS || jobs.length !== total) {
    fail("$.total_count", "bound_exceeded", "job list is not a complete page");
  }
  const matches: Array<{ job: Record<string, unknown>; path: string }> = [];
  const ids = new Set<number>();
  let allCompleted = true;
  for (const [index, item] of jobs.entries()) {
    const path = `$.jobs[${index}]`;
    const job = expectRecord(item, path);
    const id = expectPositiveInt(job.id, `${path}.id`);
    if (
      ids.has(id) ||
      expectPositiveInt(job.run_id, `${path}.run_id`) !== intent.runId ||
      expectPositiveInt(job.run_attempt, `${path}.run_attempt`) !==
        intent.runAttempt ||
      expectNonEmptyString(job.head_sha, `${path}.head_sha`, 40) !==
        intent.launcherSha
    ) {
      fail(
        path,
        "invalid_value",
        "native job identity is duplicate or foreign",
      );
    }
    ids.add(id);
    if (job.status !== "completed") allCompleted = false;
    // Fixed job names are short, but a native matrix cell carries its full
    // 64-hex cell id in the job name (`matrix_cell (<cellId>)`, 78 chars),
    // so the 64-char label bound cannot apply to the native job list.
    if (
      expectNonEmptyString(job.name, `${path}.name`, MaxText.name) !== "repair"
    ) {
      continue;
    }
    matches.push({ job, path });
  }
  if (matches.length > 1) {
    fail("$.jobs", "invalid_value", "expected at most one repair job");
  }
  if (matches.length === 0) return { repair: null, allCompleted };
  const { job, path } = matches[0]!;
  const id = expectPositiveInt(job.id, `${path}.id`);
  if (
    expectPositiveInt(job.run_id, `${path}.run_id`) !== intent.runId ||
    expectPositiveInt(job.run_attempt, `${path}.run_attempt`) !==
      intent.runAttempt ||
    expectNonEmptyString(job.head_sha, `${path}.head_sha`, 40) !==
      intent.launcherSha
  ) {
    fail(`${path}.run_id`, "invalid_value", "repair job identity mismatch");
  }
  const status = expectEnum(
    job.status,
    ["queued", "in_progress", "completed", "requested", "waiting", "pending"],
    `${path}.status`,
  );
  const conclusion = expectNullableString(
    job.conclusion,
    `${path}.conclusion`,
    MaxText.token,
  );
  const startedAt = expectNullable(
    job.started_at,
    `${path}.started_at`,
    expectIsoMs,
  );
  const completedAt = expectNullable(
    job.completed_at,
    `${path}.completed_at`,
    expectIsoMs,
  );
  // A completed job always carries its authenticated completion instant; a
  // skipped job may legitimately have no start timestamp.
  if (status === "completed" && completedAt === null) {
    fail(
      `${path}.completed_at`,
      "invalid_lifecycle",
      "a completed repair job requires its completion instant",
    );
  }
  // A completed/skipped repair job carries provider bookkeeping timestamps
  // that may invert by clock skew; it published no runtime, so no chronology
  // is asserted from them. Every other lifecycle keeps the strict check.
  if (
    startedAt !== null && completedAt !== null && startedAt > completedAt &&
    !(status === "completed" && conclusion === "skipped")
  ) {
    fail(
      `${path}.completed_at`,
      "invalid_lifecycle",
      "repair job times are inverted",
    );
  }
  const steps = expectArray(
    job.steps,
    `${path}.steps`,
    HOSTED_EXECUTION_MAX_JOB_STEPS,
    (item) => item,
  );
  const stepMatches: Array<{ step: Record<string, unknown>; path: string }> =
    [];
  for (const [index, item] of steps.entries()) {
    const stepPath = `${path}.steps[${index}]`;
    const step = expectRecord(item, stepPath);
    if (
      expectNonEmptyString(step.name, `${stepPath}.name`, MaxText.path) ===
        HOSTED_RUNTIME_STEP_NAME
    ) {
      stepMatches.push({ step, path: stepPath });
    }
  }
  if (stepMatches.length > 1) {
    fail(`${path}.steps`, "invalid_value", "expected at most one runtime step");
  }
  let runtimeStep: HostedRuntimeStepV1 | null = null;
  if (stepMatches.length === 1) {
    const { step, path: stepPath } = stepMatches[0]!;
    const stepStatus = expectNullableString(
      step.status,
      `${stepPath}.status`,
      MaxText.token,
    );
    const stepConclusion = expectNullableString(
      step.conclusion,
      `${stepPath}.conclusion`,
      MaxText.token,
    );
    const stepStartedAt = expectNullable(
      step.started_at,
      `${stepPath}.started_at`,
      expectIsoMs,
    );
    const stepCompletedAt = expectNullable(
      step.completed_at,
      `${stepPath}.completed_at`,
      expectIsoMs,
    );
    // Only an actual non-skipped run needs full start/finish evidence.
    if (
      stepStatus === "completed" && stepConclusion !== "skipped" &&
      (stepStartedAt === null || stepCompletedAt === null)
    ) {
      fail(
        `${stepPath}.completed_at`,
        "invalid_lifecycle",
        "a completed non-skipped runtime step requires its timestamps",
      );
    }
    if (
      stepStartedAt !== null && stepCompletedAt !== null &&
      stepStartedAt > stepCompletedAt
    ) {
      fail(
        `${stepPath}.completed_at`,
        "invalid_lifecycle",
        "runtime step times are inverted",
      );
    }
    runtimeStep = {
      status: stepStatus,
      conclusion: stepConclusion,
      startedAt: stepStartedAt,
      completedAt: stepCompletedAt,
    };
  }
  return {
    repair: { id, status, conclusion, startedAt, completedAt, runtimeStep },
    allCompleted,
  };
}
