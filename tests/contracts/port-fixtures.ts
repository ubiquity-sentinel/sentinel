/** Shared fixtures only; this module registers no tests. */
import type {
  CommandId,
  FixtureDigest,
  GitSha,
  WorkItemId,
} from "../../src/contracts/brands.ts";
import type {
  DenoReleasePort,
  GitHubPort,
  IsolatedReplayResultV1,
  PortResultV1,
  ReplayPort,
  ReplayRunRequestV1,
  StateStore,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { Clock } from "../../src/contracts/ports.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import { parseReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";

export const SHA: GitSha = "aafb7ee0598699bb7fb8a72ea133693ed64462da" as GitSha;
export const REVIEWER = "chatgpt-codex-connector[bot]";

/** Minimal valid completed review receipt, parsed by the frozen parser. */
export function completedReview(
  overrides: Record<string, unknown> = {},
): ReviewReceiptV1 {
  return parseReviewReceiptV1({
    version: "v1",
    kind: "review_receipt",
    id: "review-1",
    requestId: "req-1",
    expectedReviewer: REVIEWER,
    observedReviewer: REVIEWER,
    repository: { owner: "ubiquity", name: "ai.ubq.fi", installationId: 1 },
    pullRequest: { number: 1, head: SHA, base: SHA },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [],
    findingsUncounted: 0,
    unresolvedSeverities: [],
    submittedAt: 1786000000000,
    completedAt: 1786000001000,
    observedAt: 1786000002000,
    ...overrides,
  });
}

/** The exact new merge request shape the GitHub fake now requires. */
export function mergeRequest(): Parameters<GitHubPort["mergePullRequest"]>[0] {
  return {
    pullRequestNumber: 1,
    expectedHead: SHA,
    expectedBase: SHA,
    review: completedReview(),
  };
}

/** Test helpers: mark strings with the exact contract brands. */
export function digest(hex: string): FixtureDigest {
  return hex as FixtureDigest;
}
export function workId(value: string): WorkItemId {
  return value as WorkItemId;
}
export function commandId(value: string): CommandId {
  return value as CommandId;
}

/** Resolves a canned port result for non-async fake methods. */
export function resolved<T>(result: PortResultV1<T>): Promise<PortResultV1<T>> {
  return Promise.resolve(result);
}

export class FakeClock implements Clock {
  private current: number;
  constructor(start: number) {
    this.current = start;
  }
  now(): number {
    return this.current;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

/** Records every call; no product logic. */
export class RecordingReplayPort implements ReplayPort {
  readonly requests: ReplayRunRequestV1[] = [];
  private readonly result: PortResultV1<IsolatedReplayResultV1>;
  constructor(result: PortResultV1<IsolatedReplayResultV1>) {
    this.result = result;
  }
  runReplay(
    request: ReplayRunRequestV1,
  ): Promise<PortResultV1<IsolatedReplayResultV1>> {
    this.requests.push(request);
    return resolved(this.result);
  }
}

/** In-memory expected-head CAS per branch; no product logic. */
export class FakeStateStore implements StateStore {
  private repair: RepairStateSnapshotV1 | null = null;
  private repairHead: GitSha | null = null;
  private release: ReleaseStateSnapshotV1 | null = null;
  private releaseHead: GitSha | null = null;
  repairWrites = 0;
  releaseWrites = 0;
  /** When set, the next repair write reports an ambiguous network outcome. */
  ambiguousRepairNext = false;
  private seq = 0;

  readRepair(): Promise<
    PortResultV1<
      | {
        status: "found";
        snapshot: RepairStateSnapshotV1;
        head: GitSha;
        ref: string | null;
      }
      | { status: "absent"; currentHead: GitSha | null; ref: string | null }
    >
  > {
    if (this.repair === null) {
      return resolved(
        portOk({
          status: "absent",
          currentHead: this.repairHead,
          ref: "refs/heads/sentinel-state/repair",
        }),
      );
    }
    return resolved(
      portOk({
        status: "found",
        snapshot: this.repair,
        head: this.repairHead ?? SHA,
        ref: "refs/heads/sentinel-state/repair",
      }),
    );
  }
  writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.repairWrites++;
    if (this.ambiguousRepairNext) {
      this.ambiguousRepairNext = false;
      return resolved(
        portOk({ status: "ambiguous", currentHead: this.repairHead }),
      );
    }
    if (this.repairHead !== expectedHead) {
      return resolved(
        portOk({ status: "conflict", currentHead: this.repairHead }),
      );
    }
    const newHead = nextHead(this.seq++);
    this.repair = next;
    this.repairHead = newHead;
    return resolved(portOk({ status: "applied", head: newHead }));
  }
  readRelease(): Promise<
    PortResultV1<
      | {
        status: "found";
        snapshot: ReleaseStateSnapshotV1;
        head: GitSha;
        ref: string | null;
      }
      | { status: "absent"; currentHead: GitSha | null; ref: string | null }
    >
  > {
    if (this.release === null) {
      return resolved(
        portOk({
          status: "absent",
          currentHead: this.releaseHead,
          ref: "refs/heads/sentinel-state/release",
        }),
      );
    }
    return resolved(
      portOk({
        status: "found",
        snapshot: this.release,
        head: this.releaseHead ?? SHA,
        ref: "refs/heads/sentinel-state/release",
      }),
    );
  }
  writeRelease(
    next: ReleaseStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    this.releaseWrites++;
    if (this.releaseHead !== expectedHead) {
      return resolved(
        portOk({ status: "conflict", currentHead: this.releaseHead }),
      );
    }
    const newHead = nextHead(this.seq++);
    this.release = next;
    this.releaseHead = newHead;
    return resolved(portOk({ status: "applied", head: newHead }));
  }
}

export function nextHead(n: number): GitSha {
  const hex = `00000000000000000000000000000000000000${
    n.toString(16).padStart(2, "0")
  }`.slice(0, 40);
  return hex as GitSha;
}

export const MINIMAL_WORK: WorkRecordV1 = {
  version: "v1",
  kind: "work",
  repository: {
    owner: "ubiquity",
    name: "ai.ubq.fi",
    installationId: 1,
  },
  id: workId("i:1"),
  source: { kind: "issue", id: "1", revision: SHA },
  related: { incidentId: null, issueNumber: 1 },
  fingerprint: null,
  failingRevision: null,
  sourceSnapshotDigest: null,
  classification: { severity: "P3", priority: null },
  urgency: {
    activeProduction: false,
    reproducible5xx: false,
    severeSecurityOrDataLoss: false,
  },
  dependencies: [],
  controller: { sha: SHA },
  target: { base: SHA, branch: null, checkpoint: null, head: null, pr: null },
  nextStep: "work",
  wait: null,
  blocker: null,
  counters: { attempts: 0, retries: 0, reviewRounds: 0 },
  evidence: [],
  intent: null,
  firstSeenAt: null,
  createdAt: 1786000000000,
  updatedAt: 1786000000000,
};

export const _releaseFake: DenoReleasePort = {
  findBuiltCandidate(
    _projectId: string,
    _revision: string,
    _buildTransactionId: string,
    _revisionId: string,
  ) {
    return resolved(portOk({ status: "none" }));
  },
  readCurrentDeployment() {
    return resolved(portOk({
      projectId: "p",
      identity: null,
      domain: null,
      status: "unknown",
      updatedAt: null,
    }));
  },
  promote() {
    return resolved(
      portOk({
        outcome: "ambiguous",
        statusCode: null,
        detail: "response lost",
      }),
    );
  },
  sampleHealth() {
    return resolved(portOk({
      at: 1786000000000,
      status: "unreachable",
      httpStatus: null,
      bodyMarkerPresent: null,
      headersMatch: null,
      identity: null,
      domain: null,
    }));
  },
  sampleMetrics() {
    return resolved(portOk({
      identity: {
        gitSha: SHA,
        revisionId: "dep-0001",
      },
      windowStart: 1786000070000,
      windowEnd: 1786000100000,
      sampledAt: 1786000100000,
      domain: null,
      requestCount: null,
      fiveXxCount: null,
      timeoutCount: null,
      streamFailureCount: null,
      upstreamWideFault: null,
      coverage: { status: "complete" },
    }));
  },
};

// Compile-time shape guard: a minimal GitHubPort fake type-checks with the
// deterministic-head PR lookup and identity-bound review submission.
export const _githubFake: GitHubPort = {
  reviewerIdentity: "sentinel-reviewer[bot]",
  listOpenIssues() {
    return resolved(portOk([]));
  },
  readIssue() {
    return resolved(portOk(null));
  },
  findPullRequestByHeadRef() {
    return resolved(portOk(null));
  },
  readPullRequest() {
    return resolved(portOk(null));
  },
  readChecks() {
    return resolved(portOk({ head: SHA, checks: [] }));
  },
  readProtections() {
    return resolved(portOk({
      branch: "development",
      protected: false,
      requiredStatusChecks: [],
      requiredApprovingReviewCount: 0,
      requireBranchUpToDate: false,
      enforceAdmins: false,
    }));
  },
  readRef() {
    return resolved(portOk(null));
  },
  preserveCandidate() {
    return resolved(
      portError("unavailable", "candidate preservation is not composed"),
    );
  },
  pushHead() {
    return resolved(portOk("applied"));
  },
  createPullRequest() {
    return resolved(portOk({ outcome: "ambiguous", number: null, head: null }));
  },
  requestReview() {
    return resolved(
      portOk({
        outcome: "applied",
        requestId: "req-1",
        requestedAt: 1786000000000,
      }),
    );
  },
  observeReview() {
    return resolved(portOk({
      status: "pending",
      requestId: "req-1",
      reviewer: null,
      resultId: null,
      completedAt: null,
      observedHead: null,
      observedBase: null,
      findings: [],
      summary: null,
      receivedAt: 1786000000000,
      taskAcceptance: null,
    }));
  },
  mergePullRequest() {
    return resolved(
      portOk({ outcome: "blocked", reason: "protection_required", head: SHA }),
    );
  },
  closeIssue() {
    return resolved(portOk("already_closed"));
  },
  assignIssue() {
    return resolved(portOk(undefined));
  },
  drainReviews() {
    return resolved(portOk({
      ok: true,
      operations: [],
      faults: [],
      deadline: 1786000000000,
      interrupted: true,
      completedAt: 1786000000000,
    }));
  },
};
