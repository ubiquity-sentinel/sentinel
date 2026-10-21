/** Bounded native facts for a hosted principal. These reads issue no authority. */
import type { HostedExecutionIntentV1 } from "../contracts/hosted-supervisor.ts";
import {
  HOSTED_ACTIONS_CLOCK_TOLERANCE_MS,
} from "../contracts/hosted-supervisor.ts";
import {
  type Clock,
  type GitHubCooldownGateV1,
  portError,
  portOk,
  type PortResultV1,
} from "../contracts/ports.ts";
import type { RepositoryIdentityV1 } from "../contracts/shared.ts";
import {
  HOSTED_CONTROLLER_API_PATH,
  isHostedControllerRepository,
} from "../contracts/hosted-controller-deployment.ts";
import {
  parseHostedAttempt,
  parseHostedJobs,
  parseHostedJobsPage,
  validHostedJobsNext,
} from "../github/client-hosted-job-wire.ts";
import {
  HOSTED_EXECUTION_JOBS_PAGE_SIZE,
  HOSTED_EXECUTION_MAX_JOB_STEPS,
  HOSTED_EXECUTION_MAX_JOBS,
} from "../github/client-hosted-policy.ts";
import {
  createDeadline,
  type DeadlineV1,
  headerMap,
  type HttpTransportV1,
} from "../github/http.ts";
import { classifyGitHubRateLimit } from "../github/rate-limit.ts";
import type { HostedRuntimeIdentityV1 } from "./hosted-runtime-identity.ts";
import type { HostedAppMintGrant } from "./hosted-app-grant.ts";

const api = "https://api.github.com";
const maximumBodyBytes = 1024 * 1024;
const refused = (): PortResultV1<never> =>
  portError("unavailable", "hosted App principal native evidence unavailable");

interface NativeReaderInput {
  http: HttpTransportV1;
  token: string;
  clock: Clock;
  gate: GitHubCooldownGateV1;
  deadline: number;
}

/** Source-profile names, never a workflow input or environment override. */
export interface HostedAppJobSteps {
  dependencyStep: string;
  mintStep: string;
  runtimeStep: string;
}

export interface HostedAppNativeJob {
  readonly jobId: number;
  readonly mintCompletedAt: number;
  readonly runtimeStartedAt: number;
  readonly observedAt: number;
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid native object");
  }
  return value as Record<string, unknown>;
}

function positive(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("invalid native identity");
  }
  return value;
}

function instant(value: unknown): number {
  if (typeof value !== "string" || value.length > 32) {
    throw new Error("invalid time");
  }
  const result = Date.parse(value);
  if (!Number.isSafeInteger(result)) throw new Error("invalid time");
  return result;
}

function boundedText(value: unknown, bound: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > bound) {
    throw new Error("invalid native text");
  }
  return value;
}

/** Every read uses the same fixed origin and the caller's actual credential. */
async function read(
  input: NativeReaderInput,
  path: string,
  installationId: number,
  deadline: DeadlineV1,
): Promise<{ body: unknown; headers: Headers } | null> {
  const remaining = input.deadline - input.clock.now();
  if (
    !Number.isSafeInteger(remaining) || remaining <= 0 ||
    input.token.trim() === ""
  ) return null;
  const admission = await deadline.race(
    input.gate.beforeRequest(installationId),
  );
  if (!admission.ok || input.clock.now() >= input.deadline) return null;
  const response = await deadline.race(input.http({
    method: "GET",
    url: `${api}${path}`,
    headers: headerMap({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${input.token}`,
      "user-agent": "sentinel-hosted-principal",
      "x-github-api-version": "2022-11-28",
    }),
    body: null,
    redirect: "error",
    deadlineMs: Math.min(30_000, remaining),
  }));
  if (response.status !== 200) {
    const limit = await classifyGitHubRateLimit(response, input.clock.now());
    if (limit !== null) {
      await deadline.race(input.gate.recordRateLimit(installationId, limit));
    }
    return null;
  }
  if (
    input.clock.now() >= input.deadline ||
    response.bodyText.length > maximumBodyBytes ||
    new TextEncoder().encode(response.bodyText).length > maximumBodyBytes
  ) return null;
  return { body: JSON.parse(response.bodyText), headers: response.headers };
}

function nextPage(headers: Headers, path: string, page: number): boolean {
  const link = headers.get("link");
  if (link === null) return false;
  if (link.length > 4096) throw new Error("invalid pagination");
  const next: string[] = [];
  for (const part of link.split(",")) {
    const match = /^\s*<([^>]+)>;\s*rel="(next|prev|first|last)"\s*$/.exec(
      part,
    );
    if (match === null) throw new Error("invalid pagination");
    if (match[2] === "next") next.push(match[1]);
  }
  if (
    next.length > 1 ||
    (next.length === 1 && !validHostedJobsNext(api, path, next[0], page + 1))
  ) {
    throw new Error("invalid pagination");
  }
  return next.length === 1;
}

function liveJob(
  rows: unknown[],
  identity: HostedRuntimeIdentityV1,
  names: HostedAppJobSteps,
  observedAt: number,
): HostedAppNativeJob | null {
  const matches = rows.map(object).filter((row) => row.name === identity.job);
  if (matches.length !== 1) return null;
  const job = matches[0];
  if (
    job.status !== "in_progress" || job.conclusion !== null ||
    job.completed_at !== null
  ) return null;
  const startedAt = instant(job.started_at);
  if (
    !Array.isArray(job.steps) ||
    job.steps.length > HOSTED_EXECUTION_MAX_JOB_STEPS
  ) return null;
  const steps = job.steps.map(object);
  const numbers = steps.map((step) => positive(step.number));
  if (new Set(numbers).size !== steps.length) return null;
  const select = (name: string) => {
    const selected = steps.filter((step) => step.name === name);
    return selected.length === 1 ? selected[0] : null;
  };
  const dependency = select(names.dependencyStep);
  const mint = select(names.mintStep);
  const runtime = select(names.runtimeStep);
  if (dependency === null || mint === null || runtime === null) return null;
  if (
    dependency.status !== "completed" || dependency.conclusion !== "success" ||
    mint.status !== "completed" || mint.conclusion !== "success" ||
    runtime.status !== "in_progress" || runtime.conclusion !== null ||
    runtime.completed_at !== null ||
    positive(dependency.number) >= positive(mint.number) ||
    positive(mint.number) >= positive(runtime.number)
  ) return null;
  const dependencyStart = instant(dependency.started_at);
  const dependencyEnd = instant(dependency.completed_at);
  const mintStart = instant(mint.started_at);
  const mintCompletedAt = instant(mint.completed_at);
  const runtimeStartedAt = instant(runtime.started_at);
  if (
    startedAt > dependencyStart || dependencyStart > dependencyEnd ||
    dependencyEnd > mintStart ||
    mintStart > mintCompletedAt || mintCompletedAt > runtimeStartedAt ||
    runtimeStartedAt > observedAt + HOSTED_ACTIONS_CLOCK_TOLERANCE_MS
  ) return null;
  for (const step of steps) {
    boundedText(step.name, 256);
    if (
      positive(step.number) > positive(runtime.number) &&
      step.status === "in_progress"
    ) return null;
  }
  return {
    jobId: positive(job.id),
    mintCompletedAt,
    runtimeStartedAt,
    observedAt,
  };
}

/** Unlike readHostedExecution, this proves only one currently running mint consumer. */
export async function readHostedAppNativeJob(
  input: NativeReaderInput & {
    identity: HostedRuntimeIdentityV1;
    execution: HostedExecutionIntentV1;
    steps: HostedAppJobSteps;
  },
): Promise<PortResultV1<HostedAppNativeJob>> {
  const remaining = input.deadline - input.clock.now();
  if (
    !Number.isSafeInteger(input.deadline) ||
    !Number.isSafeInteger(remaining) || remaining <= 0 ||
    (input.identity.job !== "repair" && input.identity.job !== "matrix_plan") ||
    input.execution.purpose !== "ordinary" ||
    input.execution.runId !== input.identity.runId ||
    input.execution.runAttempt !== input.identity.runAttempt ||
    input.execution.launcherSha !== input.identity.launcherSha
  ) return refused();
  const timer = createDeadline(Math.min(30_000, remaining));
  try {
    const attemptPath =
      `${HOSTED_CONTROLLER_API_PATH}/actions/runs/${input.identity.runId}/attempts/${input.identity.runAttempt}`;
    const before = await read(input, attemptPath, 0, timer);
    if (
      before === null ||
      parseHostedAttempt(before.body, input.execution, input.clock.now())
          .status !== "in_progress"
    ) return refused();
    const path = `${attemptPath}/jobs`;
    const jobs: unknown[] = [];
    let total: number | null = null;
    for (
      let page = 1;
      page <=
        Math.ceil(HOSTED_EXECUTION_MAX_JOBS / HOSTED_EXECUTION_JOBS_PAGE_SIZE);
      page++
    ) {
      const value = await read(
        input,
        `${path}?per_page=${HOSTED_EXECUTION_JOBS_PAGE_SIZE}&page=${page}`,
        0,
        timer,
      );
      if (value === null) return refused();
      const parsed = parseHostedJobsPage(value.body);
      if (total !== null && total !== parsed.total) return refused();
      total = parsed.total;
      jobs.push(...parsed.jobs);
      if (jobs.length > total) return refused();
      if (!nextPage(value.headers, path, page)) break;
      if (
        jobs.length >= total ||
        parsed.jobs.length !== HOSTED_EXECUTION_JOBS_PAGE_SIZE
      ) return refused();
    }
    if (total === null || jobs.length !== total) return refused();
    // Reuse the existing complete identity checks; never change its settlement API.
    parseHostedJobs({ total_count: total, jobs }, input.execution);
    const after = await read(input, attemptPath, 0, timer);
    if (
      after === null ||
      parseHostedAttempt(after.body, input.execution, input.clock.now())
          .status !== "in_progress"
    ) return refused();
    const result = liveJob(
      jobs,
      input.identity,
      input.steps,
      input.clock.now(),
    );
    return result === null ? refused() : portOk(result);
  } catch {
    return refused();
  } finally {
    timer.dispose();
  }
}

export interface HostedAppRepositoryScope {
  readonly id: number;
  readonly nodeId: string;
  readonly owner: string;
  readonly name: string;
}

function repositoryRow(value: unknown): HostedAppRepositoryScope {
  const row = object(value);
  const owner = boundedText(object(row.owner).login, 100);
  const name = boundedText(row.name, 100);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(owner) ||
    !/^[A-Za-z0-9._-]+$/.test(name) || row.full_name !== `${owner}/${name}`
  ) throw new Error("invalid repository identity");
  return {
    id: positive(row.id),
    nodeId: boundedText(row.node_id, 128),
    owner,
    name,
  };
}

/** Scope200 does not independently attest App identity or current Contents-write. */
export async function readHostedAppRepositoryScope(
  input: NativeReaderInput & {
    repository: RepositoryIdentityV1;
    grant: HostedAppMintGrant;
  },
): Promise<PortResultV1<HostedAppRepositoryScope>> {
  const remaining = input.deadline - input.clock.now();
  const { repository, grant } = input;
  if (
    !Number.isSafeInteger(input.deadline) ||
    !Number.isSafeInteger(remaining) || remaining <= 0 ||
    grant.expiresAt <= input.clock.now() ||
    (!isHostedControllerRepository(repository) &&
      repository.owner !== "ubiquity") ||
    (repository.installationId !== grant.installationId &&
      !isHostedControllerRepository(repository))
  ) return refused();
  const timer = createDeadline(Math.min(30_000, remaining));
  try {
    const path = "/installation/repositories";
    const repositories: HostedAppRepositoryScope[] = [];
    let total: number | null = null;
    for (let page = 1; page <= 10; page++) {
      const value = await read(
        input,
        `${path}?per_page=100&page=${page}`,
        repository.installationId,
        timer,
      );
      if (value === null) return refused();
      const body = object(value.body);
      if (
        !Number.isSafeInteger(body.total_count) ||
        (body.total_count as number) < 0 ||
        (body.total_count as number) > 1000 ||
        !Array.isArray(body.repositories) || body.repositories.length > 100
      ) return refused();
      if (total !== null && total !== body.total_count) return refused();
      total = body.total_count as number;
      repositories.push(...body.repositories.map(repositoryRow));
      if (repositories.length > total) return refused();
      if (!nextPage(value.headers, path, page)) break;
      if (repositories.length >= total || body.repositories.length !== 100) {
        return refused();
      }
    }
    if (
      total === null || repositories.length !== total ||
      new Set(repositories.map((row) => row.id)).size !== total ||
      new Set(repositories.map((row) => row.nodeId)).size !== total
    ) return refused();
    const found = repositories.filter((row) =>
      row.owner === repository.owner && row.name === repository.name
    );
    if (found.length !== 1) return refused();
    const target = found[0];
    if (
      (grant.repositoryIds !== undefined &&
        !grant.repositoryIds.includes(target.id)) ||
      (grant.repositoryNames !== undefined &&
        !grant.repositoryNames.includes(target.name))
    ) return refused();
    const observed = await read(
      input,
      `/repos/${repository.owner}/${repository.name}`,
      repository.installationId,
      timer,
    );
    if (observed === null) return refused();
    const current = repositoryRow(observed.body);
    if (
      current.id !== target.id || current.nodeId !== target.nodeId ||
      current.owner !== target.owner || current.name !== target.name ||
      grant.expiresAt <= input.clock.now()
    ) return refused();
    return portOk(current);
  } catch {
    return refused();
  } finally {
    timer.dispose();
  }
}
