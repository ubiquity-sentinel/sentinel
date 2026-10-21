import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { parseWorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import {
  hostedIssueKey,
  hostedRepositoryKey,
} from "../../ops/hosted-autonomy.ts";
import type { HostedAutonomyPullV1 } from "../../ops/hosted-autonomy.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import { reservation, reviewReceipt, SHA1, T0 } from "../state/helpers.ts";

export const HEAD = "ae6ff044280a04803958fcd1f6f9304bb894249e" as GitSha;
export const BASE = "f1b5a86b80ca4759ab37307484b223907bd1b1d6" as GitSha;
export const MERGE = "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293" as GitSha;
export const TARGET = "issue-ubiquity-sentinel-48" as WorkItemId;
export const RECEIPT_ID = `review-receipt:${"a".repeat(64)}`;
export const SELF_REPO = {
  owner: "Ubiquity-Sentinel",
  name: "sentinel",
  installationId: 0,
} as const;
/** The foreign target the durable snapshot also carries work for. */
export const FOREIGN_REPO = {
  owner: "ubiquity",
  name: "other-target",
  installationId: 7,
} as const;
/** The foreign repository's own default branch, never sentinel's. */
export const FOREIGN_BRANCH = "main";
export const FOREIGN_TARGET = "issue-ubiquity-ai.ubq.fi-120" as WorkItemId;
export const FOREIGN_PR = 375;
export const FOREIGN_RECEIPT_ID = `review-receipt:${"b".repeat(64)}`;
/** The same issue number in both repositories: the collision under test. */
export const SHARED_ISSUE_NUMBER = 120;
/** The exact trusted self issue statement every self receipt must bind. */
export const SELF_TASK_TITLE = "Deliver the reviewed sentinel candidate";
export const SELF_TASK_BODY =
  "The protected maintenance pass must deliver issue 48.";
export const SELF_TASK: ReviewTaskStatementV1 = {
  issueNumber: 48,
  title: SELF_TASK_TITLE,
  body: SELF_TASK_BODY,
  digest: await reviewTaskStatementDigest({
    issueNumber: 48,
    title: SELF_TASK_TITLE,
    body: SELF_TASK_BODY,
  }),
};
/** The exact trusted foreign issue statement its own receipt must bind. */
export const FOREIGN_TASK_TITLE = "Deliver the reviewed foreign candidate";
export const FOREIGN_TASK_BODY =
  "The foreign repository must deliver its issue 120.";
export const FOREIGN_TASK: ReviewTaskStatementV1 = {
  issueNumber: SHARED_ISSUE_NUMBER,
  title: FOREIGN_TASK_TITLE,
  body: FOREIGN_TASK_BODY,
  digest: await reviewTaskStatementDigest({
    issueNumber: SHARED_ISSUE_NUMBER,
    title: FOREIGN_TASK_TITLE,
    body: FOREIGN_TASK_BODY,
  }),
};

export const FOREIGN_TASK_2_TITLE =
  "Deliver the second reviewed foreign candidate";
export const FOREIGN_TASK_2_BODY =
  "The foreign repository must deliver its own issue 121.";
export const FOREIGN_TASK_2: ReviewTaskStatementV1 = {
  issueNumber: 121,
  title: FOREIGN_TASK_2_TITLE,
  body: FOREIGN_TASK_2_BODY,
  digest: await reviewTaskStatementDigest({
    issueNumber: 121,
    title: FOREIGN_TASK_2_TITLE,
    body: FOREIGN_TASK_2_BODY,
  }),
};

/** The trusted statement the live surface returns for one fixture issue. */
export function taskFor(issueNumber: number): ReviewTaskStatementV1 | null {
  if (issueNumber === SELF_TASK.issueNumber) return SELF_TASK;
  if (issueNumber === FOREIGN_TASK.issueNumber) return FOREIGN_TASK;
  return null;
}

/** sentinel's own issue 120: the same number, a different repository's task. */
export const SELF_TASK_120_TITLE =
  "Deliver the reviewed sentinel issue 120 candidate";
export const SELF_TASK_120_BODY =
  "Sentinel's own issue 120 is distinct from the foreign issue 120.";
export const SELF_TASK_120: ReviewTaskStatementV1 = {
  issueNumber: SHARED_ISSUE_NUMBER,
  title: SELF_TASK_120_TITLE,
  body: SELF_TASK_120_BODY,
  digest: await reviewTaskStatementDigest({
    issueNumber: SHARED_ISSUE_NUMBER,
    title: SELF_TASK_120_TITLE,
    body: SELF_TASK_120_BODY,
  }),
};

/**
 * The trusted statement one repository's own surface returns for one issue:
 * the same issue number in two repositories is two different tasks.
 */
export function repositoryTask(
  repository: RepositoryIdentityV1,
  issueNumber: number,
): ReviewTaskStatementV1 | null {
  if (
    repository.name === FOREIGN_REPO.name && repository.owner === "ubiquity"
  ) {
    return issueNumber === FOREIGN_TASK.issueNumber ? FOREIGN_TASK : null;
  }
  if (issueNumber === SELF_TASK.issueNumber) return SELF_TASK;
  if (issueNumber === FOREIGN_TASK.issueNumber) return SELF_TASK_120;
  return null;
}

/** The per-record trusted statement map `planHostedClosures` consumes. */
export function closureTasks(
  records: readonly WorkRecordV1[],
): Map<string, ReviewTaskStatementV1 | null | "unavailable"> {
  return new Map(records.map((record) => [
    record.id,
    record.related.issueNumber === null
      ? null
      : repositoryTask(record.repository, record.related.issueNumber),
  ]));
}

export const ENV: Record<string, string> = {
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  HOME: "/tmp",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "sentinel-test",
  GIT_AUTHOR_EMAIL: "sentinel-test@example.invalid",
  GIT_COMMITTER_NAME: "sentinel-test",
  GIT_COMMITTER_EMAIL: "sentinel-test@example.invalid",
};

export function deliveryRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return parseWorkRecordV1({
    version: "v1",
    kind: "work",
    repository: SELF_REPO,
    id: TARGET,
    source: { kind: "issue", id: "48", revision: SHA1 },
    related: { incidentId: null, issueNumber: 48 },
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
    controller: { sha: SHA1 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-48",
      checkpoint: null,
      head: HEAD,
      pr: 51,
    },
    nextStep: "delivery",
    wait: null,
    blocker: null,
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    evidence: [{ kind: "review_receipt", ref: `artifact:${RECEIPT_ID}` }],
    intent: null,
    firstSeenAt: T0,
    createdAt: T0 + 100,
    updatedAt: T0 + 2000,
    ...overrides,
  });
}

export function blockedRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return deliveryRecord({
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: "model run ended without a trusted receipt",
      since: T0 + 3000,
    },
    ...overrides,
  });
}

/** The live zombie record: issue 61 closed, pull request 63 closed unmerged. */
export const ZOMBIE = "issue-ubiquity-sentinel-61" as WorkItemId;

export function zombieRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return deliveryRecord({
    id: ZOMBIE,
    source: { kind: "issue", id: "61", revision: SHA1 },
    related: { incidentId: null, issueNumber: 61 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-61",
      checkpoint: null,
      head: HEAD,
      pr: 63,
    },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    ...overrides,
  });
}

/** The settled implementation intent and charge the zombie record carries. */
export function zombieIntent() {
  return {
    kind: "implementation",
    key: "implementation:z-2",
    startedAt: T0 + 1000,
    branch: "sentinel/repair/issue-ubiquity-sentinel-61",
    expectedHead: null,
    observedBase: BASE,
    pr: null,
    requestId: "z-2",
    resultId: null,
  };
}

export function zombieCharges() {
  return [
    reservation("z-2", {
      taskId: ZOMBIE,
      head: BASE,
      attempt: 2,
      purpose: "implementation",
      outcome: "submitted",
      settledAt: T0 + 2000,
    }),
  ];
}

/** The same zombie already parked on the transient retryable blocker. */
export function blockedZombie(): WorkRecordV1 {
  return blockedRecord({
    id: ZOMBIE,
    source: { kind: "issue", id: "61", revision: SHA1 },
    related: { incidentId: null, issueNumber: 61 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-sentinel-61",
      checkpoint: null,
      head: HEAD,
      pr: 63,
    },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    intent: zombieIntent(),
  });
}

/**
 * The attempt identities the loop charges at one base: attempt 1 as
 * `implementation` and every later attempt as `retry`.
 */
export function chargedAttempts(base: GitSha = BASE) {
  return [1, 2, 3, 4].map((attempt) =>
    reservation(`charged-${attempt}`, {
      taskId: TARGET,
      head: base,
      attempt,
      purpose: attempt === 1 ? "implementation" : "retry",
      outcome: "submitted",
      settledAt: T0 + 2000,
    })
  );
}

export function finding(severity: "P1" | "P2") {
  return {
    id: "github-review-1-finding-0",
    fingerprint: "f".repeat(64),
    severity,
    path: "src/github/text.ts",
    message: `${severity} finding`,
    resolutionEvidence: null,
    resolved: false,
  };
}

export function authorizingReceipt(overrides: Record<string, unknown> = {}) {
  return reviewReceipt(RECEIPT_ID, {
    repository: SELF_REPO,
    expectedReviewer: "ubiquity-sentinel[bot]",
    observedReviewer: "ubiquity-sentinel[bot]",
    pullRequest: { number: 51, head: HEAD, base: BASE },
    outcome: "completed",
    resultId: "msg_0123456789abcdef",
    completedAt: T0 + 3000,
    unresolvedSeverities: [],
    observedAt: T0 + 4000,
    taskAcceptance: {
      issueNumber: SELF_TASK.issueNumber,
      taskDigest: SELF_TASK.digest,
      verdict: "fulfilled",
      evidence: ["the reviewed candidate satisfies the source issue"],
    },
    ...overrides,
  });
}

/** A foreign record for its OWN repository, carrying the shared issue number. */
export function foreignRecord(
  overrides: Record<string, unknown> = {},
): WorkRecordV1 {
  return deliveryRecord({
    repository: FOREIGN_REPO,
    id: FOREIGN_TARGET,
    source: {
      kind: "issue",
      id: String(SHARED_ISSUE_NUMBER),
      revision: SHA1,
    },
    related: { incidentId: null, issueNumber: SHARED_ISSUE_NUMBER },
    target: {
      base: BASE,
      branch: `sentinel/repair/${FOREIGN_TARGET}`,
      checkpoint: null,
      head: HEAD,
      pr: FOREIGN_PR,
    },
    ...overrides,
  });
}

/** A second foreign record: a distinct issue and pull in the same repository. */
export function foreignRecord2(): WorkRecordV1 {
  return foreignRecord({
    id: "issue-ubiquity-ai.ubq.fi-121" as WorkItemId,
    related: { incidentId: null, issueNumber: 121 },
    target: {
      base: BASE,
      branch: "sentinel/repair/issue-ubiquity-ai.ubq.fi-121",
      checkpoint: null,
      head: HEAD,
      pr: FOREIGN_PR + 1,
    },
  });
}

/** The completed receipt bound to the second record's PR/head/base. */
export const FOREIGN_RECEIPT_2 = foreignReceipt({
  id: `review-receipt:${"e".repeat(64)}`,
  pullRequest: { number: FOREIGN_PR + 1, head: HEAD, base: BASE },
  taskAcceptance: {
    issueNumber: 121,
    taskDigest: FOREIGN_TASK_2.digest,
    verdict: "fulfilled",
    evidence: ["the second reviewed candidate satisfies the foreign issue"],
  },
});

/** The completed receipt bound to the foreign repository/PR/head/base. */
export function foreignReceipt(overrides: Record<string, unknown> = {}) {
  return reviewReceipt(FOREIGN_RECEIPT_ID, {
    repository: FOREIGN_REPO,
    expectedReviewer: "ubiquity-sentinel[bot]",
    observedReviewer: "ubiquity-sentinel[bot]",
    pullRequest: { number: FOREIGN_PR, head: HEAD, base: BASE },
    outcome: "completed",
    resultId: "msg_0123456789abcdef",
    completedAt: T0 + 3000,
    unresolvedSeverities: [],
    observedAt: T0 + 4000,
    taskAcceptance: {
      issueNumber: FOREIGN_TASK.issueNumber,
      taskDigest: FOREIGN_TASK.digest,
      verdict: "fulfilled",
      evidence: ["the reviewed candidate satisfies the foreign issue"],
    },
    ...overrides,
  });
}

/** A foreign pull: its OWN repository's base ref, trusted author. */
export function foreignPullFacts(
  overrides: Partial<HostedAutonomyPullV1> = {},
): HostedAutonomyPullV1 {
  return pullFacts({
    number: FOREIGN_PR,
    baseRef: FOREIGN_BRANCH,
    ...overrides,
  });
}

/** Base tips keyed by the self repository scope, as the planner consumes them. */
export function selfTips(
  value: string | null,
): ReadonlyMap<string, string | null> {
  return new Map([[hostedRepositoryKey(SELF_REPO), value]]);
}

/** Closed-issue identities scoped to the self repository. */
export function selfClosed(...numbers: number[]): ReadonlySet<string> {
  return new Set(numbers.map((number) => hostedIssueKey(SELF_REPO, number)));
}

/** One check-run payload as the GitHub check-runs endpoint reports it. */
let nextCheckRunId = 1000;
export function checkRun(
  name: string,
  overrides: Record<string, unknown> = {},
) {
  nextCheckRunId++;
  return {
    id: nextCheckRunId,
    name,
    head_sha: HEAD,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

/** One complete check-runs page: the endpoint reports both fields. */
export function checkRunPage(runs: unknown[], totalCount: number) {
  return { total_count: totalCount, check_runs: runs };
}

export function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

/** True when a request URL addresses the foreign fixture repository. */
export function isForeignPath(url: string): boolean {
  return url.includes("/repos/ubiquity/other-target");
}

/** True when a request URL addresses the sentinel self repository. */
export function isSelfPath(url: string): boolean {
  return url.includes("/repos/Ubiquity-Sentinel/sentinel");
}

/** True for the sentinel self repository identity. */
export function isSelfRepository(repository: RepositoryIdentityV1): boolean {
  return repository.installationId === SELF_REPO.installationId &&
    repository.owner === SELF_REPO.owner &&
    repository.name === SELF_REPO.name;
}

export function pullFacts(
  overrides: Partial<HostedAutonomyPullV1> = {},
): HostedAutonomyPullV1 {
  return {
    number: 51,
    state: "closed",
    merged: true,
    mergeCommitSha: MERGE,
    headSha: HEAD,
    baseRef: "development",
    baseSha: BASE,
    author: "github-actions[bot]",
    parents: [BASE, HEAD],
    revisionOnBaseBranch: true,
    baseAncestorOfRevision: false,
    ...overrides,
  };
}
