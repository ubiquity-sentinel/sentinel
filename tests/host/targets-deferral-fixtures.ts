/**
 * Shared fixtures of the all-unavailable target deferral tests: fake GitHub
 * answers for the production target resolvers, the previous execution's
 * settled repair-job log as Actions serves it, and output capture. No test
 * registrations.
 */
import assert from "node:assert/strict";
import {
  HOSTED_CONTROLLER_API_PATH,
  HOSTED_CONTROLLER_REPOSITORY,
} from "../../src/contracts/hosted-controller-deployment.ts";
import type { HostedExecutionSettlementV1 } from "../../src/contracts/hosted-supervisor.ts";
import { sha256Hex } from "../../src/github/client-hosted-revision-wire.ts";
import type {
  HttpRequestV1,
  HttpResponseV1,
  HttpTransportV1,
} from "../../src/github/http.ts";
import { scanStepLines } from "../../src/repair/step-line.ts";
import { TARGETS_DEFERRAL_KIND } from "../../src/repair/targets-deferral-line.ts";
import type { rig } from "./matrix-actions-fixtures.ts";

export type DeferralRig = Awaited<ReturnType<typeof rig>>;

/** The production target resolvers, over the transport each test supplies. */
export const PRODUCTION = {
  resolveRepository: undefined,
  resolveTreeFacts: undefined,
};

export type Answer = (request: HttpRequestV1) => Promise<HttpResponseV1>;

export const reply =
  (status: number, headers: Record<string, string> = {}, body = "{}") =>
  (): Promise<HttpResponseV1> =>
    Promise.resolve({ status, headers: new Headers(headers), bodyText: body });

/** GitHub failures a later run can outlast. */
export const TRANSIENT: readonly (readonly [string, Answer])[] = [
  ["a thrown request", () => Promise.reject(new TypeError("connection reset"))],
  ["502", reply(502)],
  ["503", reply(503)],
  ["429", reply(429)],
  ["403 with retry-after", reply(403, { "retry-after": "60" })],
  ["403 with no quota left", reply(403, { "x-ratelimit-remaining": "0" })],
  [
    "403 secondary rate limit",
    reply(403, {}, '{"message":"You have exceeded a secondary rate limit."}'),
  ],
];

/** Credential or access failures no later run outlasts by itself. */
export const NOT_TRANSIENT: readonly (readonly [string, Answer])[] = [
  ["401", reply(401, {}, '{"message":"Bad credentials"}')],
  ["404", reply(404, {}, '{"message":"Not Found"}')],
  [
    "403 without rate-limit evidence",
    reply(403, {}, '{"message":"Resource not accessible by integration"}'),
  ],
  ["403 with quota left", reply(403, { "x-ratelimit-remaining": "17" })],
];

export const UNAVAILABLE_503 = reply(503);

/**
 * Every listed target unreadable: the named Sentinel target fails `branch`
 * at its default-branch read, and the generic prospector target, whose
 * default branch reads, fails `facts` at the head read of its tree facts.
 * Every other request reaches `http`.
 */
export function unreadable(
  http: HttpTransportV1,
  branch: Answer,
  facts: Answer = branch,
): HttpTransportV1 {
  return (request) => {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") return http(request);
    if (path === HOSTED_CONTROLLER_API_PATH) return branch(request);
    if (path === "/repos/ubiquity/prospector") {
      return reply(200, {}, '{"default_branch":"main","private":false}')();
    }
    if (path === "/repos/ubiquity/prospector/commits/main") {
      return facts(request);
    }
    return http(request);
  };
}

export const TARGET_READS = [
  `GET ${HOSTED_CONTROLLER_API_PATH}`,
  "GET /repos/ubiquity/prospector",
  "GET /repos/ubiquity/prospector/commits/main",
];

export const LISTED = JSON.stringify([
  HOSTED_CONTROLLER_REPOSITORY,
  "ubiquity/prospector",
]);

export const NO_MODEL = {
  modelId: "synthetic-model",
  runModel: () => {
    throw new Error("a deferred pass never starts a model");
  },
};

export async function quietly<T>(
  body: () => Promise<T>,
): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { value: await body(), lines };
  } finally {
    console.log = original;
  }
}

/** Records every request; `http` answers it. */
export function observed(http: HttpTransportV1) {
  const requests: string[] = [];
  const transport: HttpTransportV1 = (request) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
    return http(request);
  };
  return { requests, http: transport };
}

export function deferralLines(lines: readonly string[]) {
  return scanStepLines(lines.join("\n")).filter((line) =>
    line.kind === TARGETS_DEFERRAL_KIND
  );
}

export const EXPECTED_LINE = {
  kind: TARGETS_DEFERRAL_KIND,
  reasonCode: "targets_unavailable",
  listed: 2,
  branchUnavailable: 1,
  factsUnavailable: 1,
  transient: 2,
};

/** One repair job's log as Actions serves it: each line timestamped. */
export function jobLog(lines: readonly string[]): string {
  return lines.map((line) => `2026-11-16T02:05:00.0000000Z ${line}`).join(
    "\n",
  ) + "\n";
}

/** The job log the launcher leaves for a child's stdout: its step lines. */
export function launcherJobLog(stdout: readonly string[]): string {
  return jobLog(
    scanStepLines(stdout.join("\n")).map((line) => JSON.stringify(line)),
  );
}

/** A previous pass that read its targets: no deferral line. */
export const QUIET_LOG = jobLog([
  "##[group]Run selected Sentinel runtime",
  JSON.stringify({ kind: "sentinel_run_window", originAt: 1, deadlineAt: 2 }),
  "##[endgroup]",
]);

export const JOB_LOGS = `${HOSTED_CONTROLLER_API_PATH}/actions/jobs/`;
const SIGNED_HOST = "productionresultssa7.blob.core.windows.net";

/**
 * Serve settled repair-job logs as GitHub does: the API answers a 302 to a
 * signed blob URL, which answers the log. An unknown job is a 404.
 */
export function servingJobLogs(
  http: HttpTransportV1,
  logs: ReadonlyMap<number, string>,
): HttpTransportV1 {
  return (request) => {
    const url = new URL(request.url);
    if (request.method !== "GET") return http(request);
    if (
      url.hostname === "api.github.com" && url.pathname.startsWith(JOB_LOGS) &&
      url.pathname.endsWith("/logs")
    ) {
      const jobId = Number(url.pathname.slice(JOB_LOGS.length, -5));
      return logs.has(jobId)
        ? reply(302, {
          location: `https://${SIGNED_HOST}/actions-results/${jobId}?sig=x`,
        })()
        : reply(404)();
    }
    if (url.hostname === SIGNED_HOST) {
      const log = logs.get(Number(url.pathname.split("/").pop()));
      return log === undefined ? reply(404)() : reply(200, {}, log)();
    }
    return http(request);
  };
}

/**
 * Settle the rig's current run as repair job `jobId` whose log is `log`, as
 * the supervisor does from that job's evidence, and start run `next`.
 */
export async function advanceWithLog(
  r: DeferralRig,
  next: number,
  log: string,
  jobId: number,
  maintenance?: () => Promise<void>,
): Promise<void> {
  const logDigest = await sha256Hex(log);
  await r.advanceRun(next, (settlement) => ({
    ...settlement,
    jobId,
    logDigest,
  }), maintenance);
}

/** The rig's current settled previous execution. */
export async function previousSettlement(
  r: DeferralRig,
): Promise<HostedExecutionSettlementV1 | null> {
  const read = await r.release.readRelease();
  assert.ok(read.ok && read.value.status === "found");
  return read.value.snapshot.hostedRuntimes[0]!.lastExecutionProof;
}
