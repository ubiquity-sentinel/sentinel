/** Shared fixtures only; this module registers no tests. */
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedExecutionIntentV1,
  parseHostedNotStartedProofV1,
  parseHostedReleaseRecordV1,
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedReleaseRecordV1,
  HostedRunProofV1,
  HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { tryParse } from "../../src/contracts/validation.ts";

export const T = 1786000000000;
export const SHA_A = "a".repeat(40) as GitSha;
export const SHA_B = "b".repeat(40) as GitSha;
export const SHA_C = "c".repeat(40) as GitSha;
export const DIGEST = "d".repeat(64);
export const SELF = {
  owner: "ubiquity-sentinel",
  name: "sentinel",
  installationId: 0,
};

export function execution(
  overrides: Record<string, unknown> = {},
): HostedExecutionIntentV1 {
  return parseHostedExecutionIntentV1({
    id: "1:1:repair",
    runId: 1,
    runAttempt: 1,
    launcherSha: SHA_C,
    purpose: "candidate",
    revision: SHA_B,
    generation: 2,
    releaseId: "release-1",
    createdAt: T,
    ...overrides,
  });
}

export function proof(
  overrides: Record<string, unknown> = {},
): HostedRunProofV1 {
  return parseHostedRunProofV1({
    execution: execution(),
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity-sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 9,
    startedAt: T + 1000,
    finishedAt: T + 2000,
    observedAt: T + 3000,
    outcome: "healthy",
    startupReady: true,
    settled: true,
    baseSha: SHA_A,
    terminalAt: T + 1500,
    logDigest: DIGEST,
    ...overrides,
  });
}

export function failedProof(
  executionIntent: HostedExecutionIntentV1,
): HostedRunProofV1 {
  return proof({
    execution: executionIntent,
    outcome: "failed",
    startupReady: false,
    baseSha: null,
    terminalAt: null,
  });
}

export function notStarted(
  executionIntent: HostedExecutionIntentV1,
  overrides: Record<string, unknown> = {},
) {
  return parseHostedNotStartedProofV1({
    execution: executionIntent,
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity-sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: null,
    finishedAt: T + 500,
    observedAt: T + 1000,
    outcome: "not_started",
    evidenceDigest: DIGEST,
    ...overrides,
  });
}

export function releaseRequest(overrides: Record<string, unknown> = {}) {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: "release-1",
    target: { repository: { ...SELF }, environment: "production" },
    revision: SHA_B,
    source: {
      pullRequest: 1,
      reviewRequestId: "review-req-1",
      reviewReceiptId: "review-receipt-1",
      head: SHA_B,
      base: SHA_A,
    },
    status: "open",
    failureReason: null,
    createdAt: T - 1000,
    ...overrides,
  });
}

/** Purpose-"prior" execution healthy proof for revision SHA_A. */
export function priorProof(): HostedRunProofV1 {
  return proof({
    execution: execution({ purpose: "prior", revision: SHA_A, generation: 1 }),
  });
}

export function hostedRelease(
  overrides: Record<string, unknown> = {},
): HostedReleaseRecordV1 {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: SHA_A,
    phase: "verifying",
    priorProof: priorProof(),
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T,
    updatedAt: T + 2000,
    ...overrides,
  });
}

export function runtime(
  overrides: Record<string, unknown> = {},
): HostedRuntimeRecordV1 {
  return parseHostedRuntimeRecordV1({
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: SHA_B,
    generation: 2,
    lastHealthyProof: null,
    lastExecutionProof: null,
    nextOrdinaryAt: T,
    execution: execution(),
    createdAt: T,
    updatedAt: T + 2000,
    ...overrides,
  });
}

export function releaseSnapshot(overrides: Record<string, unknown> = {}) {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T,
    releases: [],
    hostedRuntimes: [],
    hostedReleases: [],
    githubCooldowns: [],
    ...overrides,
  });
}

export function rejected<T>(
  parser: (input: unknown) => T,
  input: unknown,
): boolean {
  return tryParse(parser, input).ok === false;
}

export const BOOT_EXECUTION = execution({
  purpose: "bootstrap",
  revision: SHA_A,
  generation: 1,
  releaseId: null,
});
