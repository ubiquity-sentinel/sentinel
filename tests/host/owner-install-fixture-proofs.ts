import type { GitSha } from "../../src/contracts/brands.ts";
import { parseGitHubCooldownV1 } from "../../src/contracts/github-cooldown.ts";
import type { GitHubCooldownV1 } from "../../src/contracts/github-cooldown.ts";
import {
  HOSTED_RUNTIME_ID,
  parseHostedExecutionIntentV1,
  parseHostedNotStartedProofV1,
  parseHostedReleaseRecordV1,
  parseHostedRunProofV1,
  parseHostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionPurposeV1,
  HostedNotStartedProofV1,
  HostedReleaseRecordV1,
  HostedRunProofV1,
  HostedRuntimeRecordV1,
} from "../../src/contracts/hosted-supervisor.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import { parseReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import {
  OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
  OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
} from "../../src/host/owner-development-install.ts";
import {
  AGGREGATE,
  DIGEST,
  LAUNCHER,
  ORIGINAL,
  PRIOR_STATE_HEAD,
  T0,
} from "./owner-install-fixture-constants.ts";

export function hostedProof(input: {
  runId: number;
  purpose: HostedExecutionPurposeV1;
  releaseId: string | null;
  revision: GitSha;
  generation: number;
  outcome: "healthy" | "failed";
}): HostedRunProofV1 {
  const failed = input.outcome === "failed";
  return parseHostedRunProofV1({
    execution: parseHostedExecutionIntentV1({
      id: `${input.runId}:1:repair`,
      runId: input.runId,
      runAttempt: 1,
      launcherSha: LAUNCHER,
      purpose: input.purpose,
      revision: input.revision,
      generation: input.generation,
      releaseId: input.releaseId,
      createdAt: T0,
    }),
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity-sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 9,
    startedAt: T0 + 1000,
    finishedAt: T0 + 2000,
    observedAt: T0 + 3000,
    outcome: input.outcome,
    startupReady: !failed,
    settled: true,
    baseSha: failed ? null : input.revision,
    terminalAt: failed ? null : T0 + 1500,
    logDigest: DIGEST,
  });
}

export function healthyProof(
  revision: GitSha,
  generation: number,
  runId = 31,
): HostedRunProofV1 {
  return hostedProof({
    runId,
    purpose: "ordinary",
    releaseId: null,
    revision,
    generation,
    outcome: "healthy",
  });
}

export function failedProof(
  revision: GitSha,
  generation: number,
  runId = 32,
): HostedRunProofV1 {
  return hostedProof({
    runId,
    purpose: "ordinary",
    releaseId: null,
    revision,
    generation,
    outcome: "failed",
  });
}

export function notStartedProof(
  revision: GitSha,
  generation: number,
): HostedNotStartedProofV1 {
  return parseHostedNotStartedProofV1({
    execution: parseHostedExecutionIntentV1({
      id: "33:1:repair",
      runId: 33,
      runAttempt: 1,
      launcherSha: LAUNCHER,
      purpose: "ordinary",
      revision,
      generation,
      releaseId: null,
      createdAt: T0,
    }),
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity-sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 9,
    finishedAt: T0 + 2000,
    observedAt: T0 + 3000,
    outcome: "not_started",
    evidenceDigest: DIGEST,
  });
}

export function executionIntent(
  revision: GitSha,
  generation: number,
): HostedRuntimeRecordV1["execution"] {
  return parseHostedExecutionIntentV1({
    id: "34:1:repair",
    runId: 34,
    runAttempt: 1,
    launcherSha: LAUNCHER,
    purpose: "ordinary",
    revision,
    generation,
    releaseId: null,
    createdAt: T0,
  });
}

export function runtimeRecord(input: {
  revision: GitSha;
  generation: number;
  healthyProof?: HostedRunProofV1 | null;
  executionProof?: HostedRuntimeRecordV1["lastExecutionProof"];
  execution?: HostedRuntimeRecordV1["execution"];
}): HostedRuntimeRecordV1 {
  return parseHostedRuntimeRecordV1({
    version: "v1",
    kind: "hosted_runtime",
    id: HOSTED_RUNTIME_ID,
    activeRevision: input.revision,
    generation: input.generation,
    lastHealthyProof: input.healthyProof ?? null,
    lastExecutionProof: input.executionProof ?? null,
    nextOrdinaryAt: T0,
    execution: input.execution ?? null,
    createdAt: T0,
    updatedAt: T0 + 3000,
  });
}

export function cooldown(retryNotBefore: number | null): GitHubCooldownV1 {
  return parseGitHubCooldownV1({
    installationId: 0,
    retryNotBefore,
    observedAt: T0,
    observationId: DIGEST,
    secondaryBackoff: 0,
  });
}

export function releaseSnapshot(input: {
  runtime?: HostedRuntimeRecordV1 | null;
  hostedReleases?: HostedReleaseRecordV1[];
  cooldowns?: GitHubCooldownV1[];
  sequence?: number;
}): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: PRIOR_STATE_HEAD,
    sequence: input.sequence ?? 10,
    updatedAt: T0 + 3000,
    releases: [],
    hostedRuntimes: input.runtime === undefined || input.runtime === null
      ? []
      : [input.runtime],
    hostedReleases: input.hostedReleases ?? [],
    githubCooldowns: input.cooldowns ?? [],
  });
}

export function releaseRequest() {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: "release-1",
    target: {
      repository: {
        owner: "ubiquity-sentinel",
        name: "sentinel",
        installationId: 0,
      },
      environment: "production",
    },
    revision: AGGREGATE,
    source: {
      pullRequest: 1,
      reviewRequestId: "review-request-1",
      reviewReceiptId: "review-receipt-1",
      head: AGGREGATE,
      base: ORIGINAL,
    },
    status: "open",
    failureReason: null,
    createdAt: T0 - 3000,
  });
}

export function requestedRelease(): HostedReleaseRecordV1 {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: ORIGINAL,
    phase: "requested",
    priorProof: null,
    candidateProof: null,
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T0 - 2000,
    updatedAt: T0,
  });
}

export function acceptedRelease(): HostedReleaseRecordV1 {
  return parseHostedReleaseRecordV1({
    version: "v1",
    kind: "hosted_release",
    id: "release-1",
    request: releaseRequest(),
    priorRevision: ORIGINAL,
    phase: "accepted",
    priorProof: hostedProof({
      runId: 41,
      purpose: "prior",
      releaseId: "release-1",
      revision: ORIGINAL,
      generation: OWNER_DEVELOPMENT_INSTALL_ORIGINAL_GENERATION,
      outcome: "healthy",
    }),
    candidateProof: hostedProof({
      runId: 42,
      purpose: "candidate",
      releaseId: "release-1",
      revision: AGGREGATE,
      generation: OWNER_DEVELOPMENT_INSTALL_AGGREGATE_GENERATION,
      outcome: "healthy",
    }),
    rollbackProof: null,
    pointerIntent: null,
    createdAt: T0 - 2000,
    updatedAt: T0 + 3000,
  });
}

export async function rawSha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
