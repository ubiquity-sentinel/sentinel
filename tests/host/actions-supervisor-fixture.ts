/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseHostedExecutionIntentV1,
  parseHostedNotStartedProofV1,
  parseHostedRunProofV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type {
  HostedExecutionIntentV1,
  HostedExecutionSettlementV1,
} from "../../src/contracts/hosted-supervisor.ts";
import type { Clock, PortResultV1 } from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { parseReleaseRequestV1 } from "../../src/contracts/release.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import {
  parseReviewReceiptV1,
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  runHostedSupervisorFinalize,
  runHostedSupervisorPrepare,
} from "../../src/host/actions-supervisor.ts";
import type {
  HostedSupervisorEvidencePortV1,
  HostedSupervisorInputV1,
  HostedSupervisorOutcomeV1,
  HostedSupervisorRunIdentityV1,
} from "../../src/host/actions-supervisor.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import {
  makeRemoteCtx,
  pushRawTree,
  sha256Hex,
  T0,
  testGitEnv,
} from "../state/helpers.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { parseHostedRuntimeRollout } from "../../src/host/hosted-runtime-rollout.ts";

const HERE = new URL(import.meta.url);

if (HERE.protocol !== "file:") throw new Error("expected a file: test module");

export const ROOT = decodeURIComponent(
  new URL("../..", import.meta.url).pathname,
).replace(/\/$/, "");

export const LAUNCHER = "1".repeat(40) as GitSha;

export const CANDIDATE = "2".repeat(40) as GitSha;

export const DIGEST = "a".repeat(64);

// Counterfactual pre-activation policies for synthetic legacy lifecycle tests.
// Active-floor tests override the relevant explicit policy through existing ports.
export const DORMANT_HOSTED_POLICIES = {
  queueRuntimeCapability: {
    proofActivated: false,
    revisions: [],
    ownerInstallMigrations: [],
  },
  existingPrRuntimeCapability: {
    custodyActivated: false,
    revisions: [],
    ownerInstallMigrations: [],
  },
  runtimeRollout: parseHostedRuntimeRollout({
    version: 1,
    installs: [],
    ciCorrection: [],
    refreshRearm: [],
    conflictResolution: [],
    ciFirst: [],
    ciFirstFix: [],
    acceptanceCorrection: [],
    legacyReview: [],
    recoveries: [],
    ownerSupersessions: [],
    ownerSuccessorTaskBindings: [],
  }),
} as const satisfies Pick<
  HostedSupervisorInputV1,
  "queueRuntimeCapability" | "existingPrRuntimeCapability" | "runtimeRollout"
>;

export const RECOVERY_REVISION =
  "c79b2b87a6a2dd0adc201895af10806ef7a9c600" as GitSha;

export const RECOVERY_OLD_LAUNCHER =
  "6468457a7b293ec489b6e00fa9fef062f7914abe" as GitSha;

export const RECOVERY_HEALTH_LAUNCHER =
  "bf1d0300f9634feb6541f2d7e96cbfe4bba7dfe0" as GitSha;

export const RECOVERY_HEALTH_DIGEST =
  "c031f4a39f3eac1ff64c8f6bce28eb733ff4dfe1ea5d813dcfb31d08ffce1cf3";

export const SELF = CONTROLLER.repository;

/** The exact source issue the fixture release request delivers. */
export const ISSUE = 48;

export const TASK_TITLE = "Deliver the reviewed hosted supervisor candidate";

export const TASK_BODY =
  "The protected supervisor must select this release request.";

export const TASK_DIGEST = await reviewTaskStatementDigest({
  issueNumber: ISSUE,
  title: TASK_TITLE,
  body: TASK_BODY,
});

const TASK: ReviewTaskStatementV1 = {
  issueNumber: ISSUE,
  title: TASK_TITLE,
  body: TASK_BODY,
  digest: TASK_DIGEST,
};

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export class FakeEvidence implements HostedSupervisorEvidencePortV1 {
  readonly settlements = new Map<string, HostedExecutionSettlementV1 | null>();
  readonly revisions = new Set<string>();
  readonly requests = new Set<string>();
  /** Per-issue trusted statements; an absent entry is the bound fixture task. */
  readonly tasks = new Map<number, ReviewTaskStatementV1 | null>();
  readFail = false;
  revisionFail = false;
  requestFail = false;
  taskFail = false;
  taskCalls = 0;
  readonly matrixCalls: GitSha[] = [];
  completed = true;
  readonly completionCalls: HostedExecutionIntentV1[] = [];

  confirmCompletedExecution(intent: HostedExecutionIntentV1): Promise<boolean> {
    this.completionCalls.push(intent);
    return Promise.resolve(this.completed);
  }

  readExecution(
    savedIntent: HostedExecutionIntentV1,
  ): Promise<PortResultV1<HostedExecutionSettlementV1 | null>> {
    if (this.readFail) {
      return Promise.resolve(portError("unavailable", "evidence unavailable"));
    }
    return Promise.resolve(
      portOk(this.settlements.get(savedIntent.id) ?? null),
    );
  }

  verifyRevision(revision: GitSha): Promise<PortResultV1<boolean>> {
    if (this.revisionFail) {
      return Promise.resolve(portError("unavailable", "revision unavailable"));
    }
    return Promise.resolve(portOk(this.revisions.has(revision)));
  }

  verifyMatrixOrdinaryRevision(
    revision: GitSha,
  ): Promise<PortResultV1<boolean>> {
    this.matrixCalls.push(revision);
    return Promise.resolve(portOk(true));
  }

  verifyRequest(request: ReleaseRequestV1): Promise<PortResultV1<boolean>> {
    if (this.requestFail) {
      return Promise.resolve(portError("unavailable", "request unavailable"));
    }
    return Promise.resolve(portOk(this.requests.has(request.id)));
  }

  readIssueTask(
    issueNumber: number,
  ): Promise<PortResultV1<ReviewTaskStatementV1 | null>> {
    this.taskCalls++;
    if (this.taskFail) {
      return Promise.resolve(portError("unavailable", "issue unavailable"));
    }
    const task = this.tasks.get(issueNumber);
    return Promise.resolve(portOk(task === undefined ? TASK : task));
  }
}

export function execution(
  overrides: Record<string, unknown> = {},
): HostedExecutionIntentV1 {
  return parseHostedExecutionIntentV1({
    id: "1:1:repair",
    runId: 1,
    runAttempt: 1,
    launcherSha: LAUNCHER,
    purpose: "bootstrap",
    revision: LAUNCHER,
    generation: 1,
    releaseId: null,
    createdAt: T0,
    ...overrides,
  });
}

export function runProof(
  intent: HostedExecutionIntentV1,
  outcome: "healthy" | "failed",
  overrides: Record<string, unknown> = {},
) {
  const healthy = outcome === "healthy";
  return parseHostedRunProofV1({
    execution: intent,
    workflowId: CONTROLLER.workflowId,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: CONTROLLER.fullName,
    ref: "refs/heads/sentinel-supervisor",
    jobId: 7,
    startedAt: intent.createdAt + 1000,
    finishedAt: intent.createdAt + 2000,
    observedAt: intent.createdAt + 3000,
    outcome,
    startupReady: healthy,
    settled: true,
    baseSha: healthy ? intent.revision : null,
    terminalAt: healthy ? intent.createdAt + 1500 : null,
    logDigest: DIGEST,
    ...overrides,
  });
}

/** A run that reached its startup-ready marker and then failed (#191). */
export function startedFailureProof(intent: HostedExecutionIntentV1) {
  return runProof(intent, "failed", {
    startupReady: true,
    baseSha: intent.revision,
    terminalAt: intent.createdAt + 1500,
  });
}

export function skippedProof(intent: HostedExecutionIntentV1) {
  return parseHostedNotStartedProofV1({
    execution: intent,
    workflowId: CONTROLLER.workflowId,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: CONTROLLER.fullName,
    ref: "refs/heads/sentinel-supervisor",
    jobId: null,
    finishedAt: intent.createdAt + 500,
    observedAt: intent.createdAt + 1000,
    outcome: "not_started",
    evidenceDigest: DIGEST,
  });
}

export function releaseRequest(
  overrides: Record<string, unknown> = {},
): ReleaseRequestV1 {
  return parseReleaseRequestV1({
    version: "v1",
    kind: "release_request",
    id: "release-1",
    target: { repository: { ...SELF }, environment: "production" },
    revision: CANDIDATE,
    source: {
      pullRequest: 5,
      reviewRequestId: "review-req-1",
      reviewReceiptId: "review-receipt-1",
      head: CANDIDATE,
      base: LAUNCHER,
    },
    status: "open",
    failureReason: null,
    createdAt: T0 - 5000,
    ...overrides,
  });
}

export function reviewReceipt(
  request: ReleaseRequestV1,
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: request.source.reviewReceiptId,
    requestId: request.source.reviewRequestId,
    expectedReviewer: "ubiquity-sentinel[bot]",
    observedReviewer: "ubiquity-sentinel[bot]",
    repository: { ...SELF },
    pullRequest: {
      number: request.source.pullRequest,
      head: request.source.head,
      base: request.source.base,
    },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: T0 - 2000,
    completedAt: T0 - 1000,
    observedAt: T0 - 500,
    taskAcceptance: {
      issueNumber: ISSUE,
      taskDigest: TASK_DIGEST,
      verdict: "fulfilled",
      evidence: ["the reviewed candidate satisfies the source issue"],
    },
    ...overrides,
  });
}

/**
 * The exact EXISTING work record that published the request. The supervisor
 * binds the trusted issue read to this record's own source issue; without it
 * no release is selectable.
 */
export function workRecordFor(
  request: ReleaseRequestV1,
  overrides: Record<string, unknown> = {},
) {
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: { ...SELF },
    id: `issue-ubiquity-sentinel-${ISSUE}`,
    source: { kind: "issue", id: String(ISSUE), revision: LAUNCHER },
    related: { incidentId: null, issueNumber: ISSUE },
    fingerprint: null,
    failingRevision: null,
    sourceSnapshotDigest: null,
    classification: { severity: "P2", priority: null },
    urgency: {
      activeProduction: false,
      reproducible5xx: false,
      severeSecurityOrDataLoss: false,
    },
    dependencies: [],
    controller: { sha: LAUNCHER },
    target: {
      base: request.source.base,
      branch: `sentinel/repair/issue-ubiquity-sentinel-${ISSUE}`,
      checkpoint: null,
      head: request.source.head,
      pr: request.source.pullRequest,
    },
    nextStep: "delivery",
    wait: null,
    blocker: null,
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    evidence: [{
      kind: "review_receipt",
      ref: `artifact:${request.source.reviewReceiptId ?? "none"}`,
    }],
    intent: null,
    firstSeenAt: T0,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  });
}

export function run(runId: number): HostedSupervisorRunIdentityV1 {
  return { runId, runAttempt: 1, launcherSha: LAUNCHER };
}

export interface RigV1 {
  clock: FakeClock;
  evidence: FakeEvidence;
  release: ReturnType<typeof createReleaseStateStore>;
  repair: ReturnType<typeof createRepairStateStore>;
  prepare(
    run: HostedSupervisorRunIdentityV1,
  ): Promise<HostedSupervisorOutcomeV1>;
  finalize(
    run: HostedSupervisorRunIdentityV1,
  ): Promise<HostedSupervisorOutcomeV1>;
  snapshot(): Promise<ReleaseStateSnapshotV1>;
  seedCapturedRelease(snapshot: ReleaseStateSnapshotV1): Promise<void>;
  seedRepair(
    requests: ReleaseRequestV1[],
    reviews: ReviewReceiptV1[],
    overrides?: Record<string, unknown>,
  ): Promise<void>;
  cleanup(): Promise<void>;
}

export async function makeRig(): Promise<RigV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-hosted-core-",
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  const release = createReleaseStateStore({
    scratchDir: `${tmp}/release-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const repair = createRepairStateStore({
    scratchDir: `${tmp}/repair-scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const clock = new FakeClock(T0);
  const evidence = new FakeEvidence();
  return {
    clock,
    evidence,
    release,
    repair,
    prepare: (identity) =>
      runHostedSupervisorPrepare({
        ...DORMANT_HOSTED_POLICIES,
        clock,
        state: release,
        run: identity,
        evidence,
      }),
    finalize: (identity) =>
      runHostedSupervisorFinalize({
        ...DORMANT_HOSTED_POLICIES,
        clock,
        state: release,
        run: identity,
        evidence,
      }),
    snapshot: async () => {
      const read = await release.readRelease();
      assert.ok(read.ok && read.value.status === "found");
      if (!read.ok || read.value.status !== "found") {
        throw new Error("missing release state");
      }
      return read.value.snapshot;
    },
    seedCapturedRelease: async (snapshot) => {
      const seed = await release.writeRelease({
        ...snapshot,
        hostedRuntimes: [],
      }, null);
      assert.ok(
        seed.ok && seed.value.status === "applied",
        JSON.stringify(seed),
      );
      // Restore a captured historical tree in disposable Git only. The real
      // writer correctly refuses introducing generation 63 as a new runtime.
      const files: Record<string, string> = {
        "manifest.json": canonicalStringify({
          version: "v1",
          kind: "release_state_manifest",
          sequence: 2,
          updatedAt: snapshot.updatedAt,
          stateHead: seed.value.head,
        }) + "\n",
      };
      for (const row of snapshot.hostedRuntimes) {
        files[`hostedRuntimes/${await sha256Hex(row.id)}.json`] =
          canonicalStringify(row) + "\n";
      }
      const restored = await pushRawTree(
        remote,
        seed.value.head,
        "refs/heads/sentinel-state/release",
        files,
        env,
      );
      assert.ok(restored.ok, restored.stderr);
    },
    seedRepair: async (requests, reviews, overrides = {}) => {
      const current = await repair.readRepair();
      const existing: RepairStateSnapshotV1 | null =
        current.ok && current.value.status === "found"
          ? current.value.snapshot
          : null;
      const head: GitSha | null = current.ok && current.value.status === "found"
        ? current.value.head
        : null;
      const sequence = (existing?.sequence ?? 0) + 1;
      // Real repair writers only append or update records in place. Seeding
      // preserves every durable record and replaces a record only under its
      // own id, so the store's immutable-identity and terminal-state guards
      // stay in force instead of being bypassed.
      const mergeById = <T extends { id: string }>(
        prior: readonly T[],
        next: readonly T[],
      ): T[] => {
        const merged = [...prior];
        for (const record of next) {
          const at = merged.findIndex((item) => item.id === record.id);
          if (at === -1) merged.push(record);
          else merged[at] = record;
        }
        return merged;
      };
      const seed = parseRepairStateSnapshotV1({
        version: "v1",
        kind: "repair_state_snapshot",
        stateHead: head,
        sequence,
        updatedAt: T0 + sequence,
        incidents: existing?.incidents ?? [],
        evidence: existing?.evidence ?? [],
        work: mergeById(
          existing?.work ?? [],
          requests.map((request) => workRecordFor(request, overrides)),
        ),
        reservations: existing?.reservations ?? [],
        reviews: mergeById(existing?.reviews ?? [], reviews),
        replays: existing?.replays ?? [],
        releaseRequests: mergeById(existing?.releaseRequests ?? [], requests),
        githubCooldowns: existing?.githubCooldowns ?? [],
        attemptMemory: [],
        lessons: [],
      });
      const written = await repair.writeRepair(seed, head);
      if (!written.ok) {
        throw new Error(
          `repair seed transport failed: ${written.error.kind}: ${written.error.detail}`,
        );
      }
      assert.equal(
        written.value.status,
        "applied",
        `repair seed refused: ${JSON.stringify(written.value)}`,
      );
    },
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

export function requireRun(
  outcome: HostedSupervisorOutcomeV1,
): HostedExecutionIntentV1 {
  assert.equal(outcome.status, "run", JSON.stringify(outcome));
  if (outcome.status !== "run") throw new Error("expected a run decision");
  return outcome.execution;
}
