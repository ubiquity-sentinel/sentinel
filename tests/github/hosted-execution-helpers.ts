// hosted execution helpers.

import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  Clock,
  GitHubCooldownGateV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import type { GitHubRateLimitV1 } from "../../src/contracts/github-cooldown.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { GitHubApiClient } from "../../src/github/client.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseHostedExecutionIntentV1 } from "../../src/contracts/hosted-supervisor.ts";
import assert from "node:assert/strict";
import { CONTROLLER } from "../host/controller-identity-fixture.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";

export const API_BASE = "https://api.github.com";

export const REPO = CONTROLLER.fullName;

export const LAUNCHER = "1".repeat(40) as GitSha;

export const REVISION = "2".repeat(40) as GitSha;

export const PR_HEAD = "3".repeat(40) as GitSha;

export const PR_BASE = "4".repeat(40) as GitSha;

export const RUN_ID = 900;

export const RUN_ATTEMPT = 2;

export const JOB_ID = 901;

export const PR_NUMBER = 55;

export const SIGNED_URL =
  "https://productionresultssa17.blob.core.windows.net/logs/abc?sv=1&sig=x";

export const SIGNED_PATH = "/logs/abc";

export const T0 = 1_786_000_000_000;

export const JOB_STARTED = T0 + 500;

export const STEP_STARTED = T0 + 900;

export const TERM_STARTED = T0 + 1000;

export const TERM_AT = T0 + 1200;

export const TERM_FINISHED = T0 + 1500;

export const STEP_FINISHED = T0 + 2000;

export const JOB_FINISHED = T0 + 2500;

export const OBSERVED = T0 + 4000;

export const ATTEMPT_PATH =
  `/repos/${REPO}/actions/runs/${RUN_ID}/attempts/${RUN_ATTEMPT}`;

export const JOBS_PATH = `${ATTEMPT_PATH}/jobs`;

export const JOB_LOG_PATH = `/repos/${REPO}/actions/jobs/${JOB_ID}/logs`;

export const COMPARE_PATH = `/repos/${REPO}/compare/${REVISION}...development`;

export const PULL_PATH = `/repos/${REPO}/pulls/${PR_NUMBER}`;

export const COMMIT_PATH = `/repos/${REPO}/commits/${REVISION}`;

export class LocalClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
}

export class FakeGate implements GitHubCooldownGateV1 {
  readonly admissions: number[] = [];
  readonly recorded: GitHubRateLimitV1[] = [];
  deny = false;
  beforeRequest(installationId: number): Promise<PortResultV1<void>> {
    this.admissions.push(installationId);
    return Promise.resolve(
      this.deny
        ? portError("rate_limited", "installation is cooling down")
        : portOk(undefined),
    );
  }
  recordRateLimit(
    _installationId: number,
    rateLimit: GitHubRateLimitV1,
  ): Promise<PortResultV1<void>> {
    this.recorded.push(rateLimit);
    return Promise.resolve(portOk(undefined));
  }
}

export type Handler = (
  request: HttpRequestV1,
) => HttpResponseV1 | Promise<HttpResponseV1>;

export class ScriptedHttp {
  readonly calls: HttpRequestV1[] = [];
  private readonly routes = new Map<string, Handler>();
  on(method: string, path: string, handler: Handler): void {
    this.routes.set(`${method} ${path}`, handler);
  }
  readonly transport: HttpTransportV1 = (request) => {
    this.calls.push(request);
    const url = new URL(request.url);
    const handler = this.routes.get(`${request.method} ${url.pathname}`);
    if (handler === undefined) return Promise.reject(new Error("unscripted"));
    return Promise.resolve(handler(request));
  };
  callsTo(path: string): HttpRequestV1[] {
    return this.calls.filter((call) => new URL(call.url).pathname === path);
  }
}

export function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponseV1 {
  return {
    status,
    headers: new Headers(headers),
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
  };
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export interface RigV1 {
  http: ScriptedHttp;
  gate: FakeGate;
  client: GitHubApiClient;
}

export function makeRig(clockAt = OBSERVED): RigV1 {
  const http = new ScriptedHttp();
  const gate = new FakeGate();
  const client = new GitHubApiClient({
    repository: CONTROLLER.repository,
    apiBaseUrl: API_BASE,
    http: http.transport,
    auth: {
      authorizationHeader: () => Promise.resolve(portOk("Bearer test-token")),
    },
    cooldownGate: gate,
    clock: new LocalClock(clockAt),
  });
  return { http, gate, client };
}

export function intent(
  overrides: Record<string, unknown> = {},
): HostedExecutionIntentV1 {
  return parseHostedExecutionIntentV1({
    id: `${RUN_ID}:${RUN_ATTEMPT}:repair`,
    runId: RUN_ID,
    runAttempt: RUN_ATTEMPT,
    launcherSha: LAUNCHER,
    purpose: "ordinary",
    revision: REVISION,
    generation: 2,
    releaseId: null,
    createdAt: T0,
    ...overrides,
  });
}

export function attemptBody(
  overrides: {
    status?: string;
    conclusion?: string | null;
    runId?: number;
    attempt?: number;
    workflowId?: number;
    path?: string;
    headSha?: string;
    branch?: string;
    repo?: string;
    updatedAt?: number;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.runId ?? RUN_ID,
    run_attempt: overrides.attempt ?? RUN_ATTEMPT,
    workflow_id: overrides.workflowId ?? CONTROLLER.workflowId,
    path: overrides.path ?? ".github/workflows/supervisor.yml",
    head_sha: overrides.headSha ?? LAUNCHER,
    head_branch: overrides.branch ?? "sentinel-supervisor",
    event: "workflow_dispatch",
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined
      ? "success"
      : overrides.conclusion,
    repository: { full_name: overrides.repo ?? REPO },
    head_repository: { full_name: overrides.repo ?? REPO },
    run_started_at: iso(JOB_STARTED),
    updated_at: iso(overrides.updatedAt ?? JOB_FINISHED),
  };
}

export function runtimeStep(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: "Run selected Sentinel runtime",
    status: "completed",
    conclusion: "success",
    started_at: iso(STEP_STARTED),
    completed_at: iso(STEP_FINISHED),
    ...overrides,
  };
}

export function jobBody(
  overrides: {
    id?: number;
    name?: string;
    runId?: number;
    attempt?: number;
    headSha?: string;
    status?: string;
    conclusion?: string | null;
    startedAt?: number;
    completedAt?: number;
    steps?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? JOB_ID,
    name: overrides.name ?? "repair",
    run_id: overrides.runId ?? RUN_ID,
    run_attempt: overrides.attempt ?? RUN_ATTEMPT,
    head_sha: overrides.headSha ?? LAUNCHER,
    status: overrides.status ?? "completed",
    conclusion: overrides.conclusion === undefined
      ? "success"
      : overrides.conclusion,
    started_at: iso(overrides.startedAt ?? JOB_STARTED),
    completed_at: iso(overrides.completedAt ?? JOB_FINISHED),
    steps: overrides.steps ?? [runtimeStep()],
  };
}

export function jobsBody(jobs: unknown[], total = jobs.length): unknown {
  return { total_count: total, jobs };
}

export function terminalRecord(
  executionIntent: HostedExecutionIntentV1 = intent(),
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: "v1",
    kind: "hosted_runtime_terminal",
    execution: executionIntent,
    controllerSha: REVISION,
    startedAt: TERM_STARTED,
    finishedAt: TERM_FINISHED,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: LAUNCHER,
    ...overrides,
  };
}

export function logText(
  records: Array<Record<string, unknown>>,
  at: number = TERM_AT,
): string {
  return `2026-09-12T21:59:59.0000000Z Starting job\n${
    records.map((record) => `${iso(at)} ${JSON.stringify(record)}`).join("\n")
  }\n`;
}

export function scriptLog(
  rig: RigV1,
  text: string,
  location = SIGNED_URL,
): void {
  rig.http.on(
    "GET",
    JOB_LOG_PATH,
    () => response(302, "", { location }),
  );
  rig.http.on("GET", SIGNED_PATH, () => response(200, text));
}

export function scriptAttemptAndJobs(
  rig: RigV1,
  attempt: Record<string, unknown>,
  jobs: unknown,
  headers: Record<string, string> = {},
): void {
  rig.http.on("GET", ATTEMPT_PATH, () => response(200, attempt));
  rig.http.on("GET", JOBS_PATH, () => response(200, jobs, headers));
}

export function settlementProof(
  result: PortResultV1<HostedExecutionSettlementV1 | null>,
): Extract<HostedExecutionSettlementV1, { outcome: "healthy" | "failed" }> {
  assert.ok(result.ok, JSON.stringify(result));
  if (!result.ok) throw new Error("expected settlement");
  assert.ok(result.value !== null);
  if (result.value === null || result.value.outcome === "not_started") {
    throw new Error("expected a run proof");
  }
  return result.value;
}

/**
 * Real GitHub post-action step names exceed the 64-char label bound; the step
 * name alone uses the wider path bound while the job name keeps the label one.
 */
export function postStep(name: string): Record<string, unknown> {
  return {
    name,
    status: "completed",
    conclusion: "success",
    started_at: iso(STEP_FINISHED + 100),
    completed_at: iso(STEP_FINISHED + 200),
  };
}

/** Real compare API shape: no head_commit; counters match the status. */
export function compareBody(overrides: Record<string, unknown> = {}): unknown {
  const status = typeof overrides.status === "string"
    ? overrides.status
    : "ahead";
  const counters = status === "identical"
    ? { ahead_by: 0, behind_by: 0, total_commits: 0 }
    : status === "behind"
    ? { ahead_by: 0, behind_by: 2, total_commits: 2 }
    : status === "diverged"
    ? { ahead_by: 2, behind_by: 1, total_commits: 3 }
    : { ahead_by: 3, behind_by: 0, total_commits: 3 };
  return {
    status,
    base_commit: { sha: REVISION },
    merge_base_commit: { sha: REVISION },
    ...counters,
    ...overrides,
  };
}

export function requestFixture(
  overrides: Record<string, unknown> = {},
): ReleaseRequestV1 {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: "release-hosted-1",
    target: {
      repository: CONTROLLER.repository,
      environment: "production",
    },
    revision: REVISION,
    source: {
      pullRequest: PR_NUMBER,
      reviewRequestId: "review-req-1",
      reviewReceiptId: "review-receipt-1",
      head: PR_HEAD,
      base: PR_BASE,
    },
    status: "open",
    failureReason: null,
    createdAt: T0,
    ...overrides,
  });
}

export const MATRIX_ROOT_SHA = "5".repeat(40);

export const MATRIX_SRC_SHA = "6".repeat(40);

export const MATRIX_HOST_SHA = "7".repeat(40);

export const MATRIX_COMMIT_PATH = "/repos/" + REPO + "/git/commits/" + REVISION;

export const matrixTreePath = (sha: string) =>
  "/repos/" + REPO + "/git/trees/" + sha;

export function scriptMatrixCapability(rig: RigV1, capable = true): void {
  rig.http.on("GET", MATRIX_COMMIT_PATH, () =>
    response(200, {
      sha: REVISION,
      tree: { sha: MATRIX_ROOT_SHA },
    }));
  rig.http.on("GET", matrixTreePath(MATRIX_ROOT_SHA), () =>
    response(200, {
      sha: MATRIX_ROOT_SHA,
      truncated: false,
      tree: [{
        path: "src",
        type: "tree",
        mode: "040000",
        sha: MATRIX_SRC_SHA,
      }],
    }));
  rig.http.on("GET", matrixTreePath(MATRIX_SRC_SHA), () =>
    response(200, {
      sha: MATRIX_SRC_SHA,
      truncated: false,
      tree: [{
        path: "host",
        type: "tree",
        mode: "040000",
        sha: MATRIX_HOST_SHA,
      }],
    }));
  rig.http.on("GET", matrixTreePath(MATRIX_HOST_SHA), () =>
    response(200, {
      sha: MATRIX_HOST_SHA,
      truncated: false,
      tree: capable
        ? [{
          path: "matrix-actions.ts",
          type: "blob",
          mode: "100644",
          sha: "8".repeat(40),
        }]
        : [],
    }));
}
