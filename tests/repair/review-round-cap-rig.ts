/**
 * Shared rig for the hard review-round ceiling: one issue task with an open
 * pull request run through the REAL repair loop against a scripted reviewer,
 * a scripted merge and a base branch the test can move. It reproduces the
 * live churn shapes of ai.ubq.fi 684 / PR 1059 (a reviewer that keeps ending
 * without a verdict, interleaved with base moves) and 698 / 880 (a base that
 * moves after every clean review, before the merge lands).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  GitHubPullRequestV1,
  GitHubRefV1,
  MergeOutcomeV1,
  PortResultV1,
  ReviewObservationV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { MergeRequestV1 } from "../../src/contracts/merge-request.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  deriveReservationId,
  RollingStartBudget,
} from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { reviewOperationKey } from "../../src/repair/keys.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import {
  REPO,
  reservation,
  reviewReceipt,
  SHA1,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";

/** The five fixed park messages, pinned literally (rollback tables match text). */
export const CAP_PREFIX = "review round ceiling reached: ";
export const CAP_UNREVIEWED =
  `${CAP_PREFIX}the current head has no completed review`;
export const CAP_REJECTED = `${CAP_PREFIX}unresolved P0/P1 findings remain`;
export const CAP_UNACCEPTED =
  `${CAP_PREFIX}the completed review carries no task acceptance`;
export const CAP_BASE_MOVED =
  `${CAP_PREFIX}the base moved after the last review`;
export const CAP_REVIEWED = `${CAP_PREFIX}the reviewed head awaits delivery`;

export const PR = 7;
export const MINUTE = 60_000;
export const REVIEWER = "chatgpt-codex-connector[bot]";

/** Deterministic distinct commit identity for a scripted head or base. */
export function sha(seed: number): GitSha {
  return seed.toString(16).padStart(8, "0").repeat(5) as GitSha;
}

export type ReviewMode =
  | "clean"
  | "no_verdict"
  | "pending"
  | "p0"
  | "p1"
  | "missing_acceptance";

interface RequestedReview {
  head: GitSha;
  base: GitSha;
  requestId: string;
}

/** A GitHub fake whose base, reviewer verdicts and merge outcome are scripted. */
export class ChurnGithub extends FakeGithub {
  remoteBase: GitSha = SHA1;
  remoteBranch: GitSha = SHA3;
  mergedSha: GitSha | null = null;
  reviewMode: ReviewMode = "clean";
  mergeMode: "blocked" | "merged" = "blocked";
  requests = 0;
  refreshes = 0;
  merges = 0;
  readonly requested = new Map<string, RequestedReview>();
  /** The live task every accepted verdict is bound to. */
  task: { issueNumber: number; digest: string } | null = null;

  constructor(private readonly clock: FakeClock, readonly branch: string) {
    super({});
    this.prepareBaseRefresh = () => {
      this.refreshes++;
      return Promise.resolve(portOk(sha(0x1000 + this.refreshes)));
    };
  }

  private pr(): GitHubPullRequestV1 {
    const merged = this.mergedSha !== null;
    return {
      number: PR,
      title: "Sentinel repair",
      body: "Resolves #1",
      state: merged ? "merged" : "open",
      head: this.remoteBranch,
      base: this.remoteBase,
      mergeSha: this.mergedSha,
      headRef: this.branch,
      baseRef: "development",
      author: "sentinel-owner",
      createdAt: T0,
      updatedAt: T0,
      mergedAt: merged ? T0 : null,
      reviewDecision: "none",
    };
  }

  /** The live issue is open with no native blockers, so model work may run. */
  override async readIssue(issueNumber: number) {
    const read = await super.readIssue(issueNumber);
    if (!read.ok || read.value === null) return read;
    return portOk({
      ...read.value,
      relations: { subIssueCount: 0, openBlockers: [] },
    });
  }

  override readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>> {
    if (ref === "refs/heads/development") {
      return Promise.resolve(portOk({ ref, sha: this.remoteBase }));
    }
    if (ref === `refs/heads/${this.branch}`) {
      return Promise.resolve(portOk({ ref, sha: this.remoteBranch }));
    }
    return Promise.resolve(portOk(null));
  }

  override readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    return Promise.resolve(portOk(number === PR ? this.pr() : null));
  }

  override findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    return Promise.resolve(portOk(headRef === this.branch ? this.pr() : null));
  }

  override pushHead(
    ref: string,
    next: GitSha,
    expected: GitSha | null,
  ): Promise<PortResultV1<"applied" | "ambiguous">> {
    this.pushes.push({ ref, sha: next, expected });
    if (expected === this.remoteBranch) this.remoteBranch = next;
    return Promise.resolve(portOk("applied"));
  }

  override async requestReview(request: unknown) {
    this.requests++;
    const identity = request as {
      operationKey: string;
      expectedHead: GitSha;
      expectedBase: GitSha;
    };
    const requestId = `review-req-${this.requests}`;
    this.requested.set(identity.operationKey, {
      head: identity.expectedHead,
      base: identity.expectedBase,
      requestId,
    });
    const answered = await super.requestReview(request);
    if (!answered.ok || answered.value.outcome !== "applied") return answered;
    return portOk({
      outcome: "applied" as const,
      requestId,
      requestedAt: this.clock.now(),
    });
  }

  /** Bind round `round` of `head` as already requested (a seeded journal). */
  bind(round: number, head: GitSha = SHA3, base: GitSha = SHA1): void {
    this.requested.set(reviewOperationKey(PR, head, round), {
      head,
      base,
      requestId: `seeded-req-${round}`,
    });
  }

  override observeReview(
    request: unknown,
  ): Promise<PortResultV1<ReviewObservationV1>> {
    const { operationKey } = request as { operationKey: string };
    this.observedReviewKeys.push(operationKey);
    const bound = this.requested.get(operationKey);
    const at = this.clock.now() - 1_000;
    if (bound === undefined) {
      // The transport's exact unbound receipt: no journal for this identity.
      return Promise.resolve(portOk({
        status: "unavailable",
        requestId: "unbound",
        reviewer: null,
        resultId: null,
        completedAt: null,
        observedHead: null,
        observedBase: null,
        findings: [],
        summary: null,
        receivedAt: at,
        taskAcceptance: null,
      }));
    }
    const common = {
      requestId: bound.requestId,
      observedHead: bound.head,
      observedBase: bound.base,
      receivedAt: at + 1,
    };
    if (this.reviewMode === "pending") {
      return Promise.resolve(portOk({
        ...common,
        status: "pending",
        reviewer: null,
        resultId: null,
        completedAt: null,
        findings: [],
        summary: null,
        taskAcceptance: null,
      }));
    }
    if (this.reviewMode === "no_verdict") {
      return Promise.resolve(portOk({
        ...common,
        status: "unavailable",
        reviewer: null,
        resultId: `result-${bound.requestId}`,
        completedAt: at,
        findings: [],
        summary:
          "structured review unavailable: the task acceptance is not bound to the supplied task statement",
        taskAcceptance: null,
      }));
    }
    const task = this.task;
    return Promise.resolve(portOk({
      ...common,
      status: "completed",
      reviewer: this.reviewerIdentity,
      resultId: `result-${bound.requestId}`,
      completedAt: at,
      findings: this.reviewMode === "p1" || this.reviewMode === "p0"
        ? [{
          id: "github-review-1-finding-0",
          fingerprint: "f".repeat(64),
          severity: this.reviewMode === "p0" ? "P0" : "P1",
          path: "src/app.ts",
          message: `${this.reviewMode.toUpperCase()} finding`,
          resolutionEvidence: null,
          resolved: false,
        }]
        : [],
      summary: null,
      taskAcceptance: task === null || this.reviewMode === "missing_acceptance"
        ? null
        : {
          issueNumber: task.issueNumber,
          taskDigest: task.digest,
          verdict: "fulfilled",
          evidence: ["The exact candidate change satisfies the task."],
        },
    } as ReviewObservationV1));
  }

  override mergePullRequest(
    request: MergeRequestV1,
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    this.calls.push("merge");
    this.merges++;
    if (this.mergeMode === "blocked") {
      return Promise.resolve(portOk({
        outcome: "blocked",
        reason: "checks_pending",
        head: request.expectedHead,
      }));
    }
    this.mergedSha = sha(0x9000 + this.merges);
    return Promise.resolve(portOk({
      outcome: "merged",
      head: request.expectedHead,
      mergeSha: this.mergedSha,
    }));
  }
}

/** Durable review charges for attempts 1..n of one task (all submitted). */
export function reviewCharges(
  taskId: string,
  rounds: number,
  options: {
    head?: GitSha;
    repository?: unknown;
    outcome?: (
      attempt: number,
    ) => "submitted" | "ambiguous" | "confirmed_not_submitted" | "reserved";
  } = {},
): BudgetReservationV1[] {
  return Array.from({ length: rounds }, (_, index) => {
    const attempt = index + 1;
    const settled = options.outcome?.(attempt) ?? "submitted";
    return reservation(`${taskId}-review-${attempt}`, {
      repository: options.repository ?? REPO,
      taskId,
      attempt,
      head: options.head ?? SHA3,
      purpose: "review_request",
      createdAt: T0 - 10 * MINUTE + attempt,
      outcome: settled,
      settledAt: settled === "reserved" ? null : T0 - 10 * MINUTE + attempt + 1,
      proofRef: settled === "confirmed_not_submitted"
        ? `artifact:review-refund/${taskId}-${attempt}`
        : null,
    });
  });
}

/**
 * The same charges under the ids the budget derives for their identities, so
 * a later admission of the same identity is the exact `duplicate` the runtime
 * reconciles (completing a still-reserved one) instead of a collision.
 */
export function withDerivedIds(
  rows: readonly BudgetReservationV1[],
): Promise<BudgetReservationV1[]> {
  return Promise.all(
    rows.map(async (row) => ({ ...row, id: await deriveReservationId(row) })),
  );
}

/** A completed receipt of `head` on PR 7 under `round`'s identity. */
export function completedReceipt(
  round: number,
  head: GitSha,
  verdict: "clean" | "p1" | "unaccepted",
  options: { base?: GitSha; completedAt?: number; issueNumber?: number } = {},
): ReviewReceiptV1 {
  const completedAt = options.completedAt ?? T0 - MINUTE;
  return reviewReceipt(`receipt-${round}-${verdict}`, {
    pullRequest: { number: PR, head, base: options.base ?? SHA1 },
    outcome: "completed",
    observedReviewer: REVIEWER,
    resultId: `result-${round}`,
    findings: verdict === "p1"
      ? [{
        id: "github-review-1-finding-0",
        fingerprint: "e".repeat(64),
        severity: "P1",
        path: "src/app.ts",
        message: "P1 finding",
        resolutionEvidence: null,
        resolved: false,
      }]
      : [],
    unresolvedSeverities: verdict === "p1" ? ["P1"] : [],
    taskAcceptance: verdict === "clean"
      ? {
        issueNumber: options.issueNumber ?? 1,
        taskDigest: "d".repeat(64),
        verdict: "fulfilled",
        evidence: ["The exact candidate change satisfies the task."],
      }
      : null,
    submittedAt: completedAt - MINUTE,
    completedAt,
    observedAt: completedAt + 1,
  });
}

export interface CapRigOptionsV1 {
  id?: string;
  issueNumber?: number;
  repository?: unknown;
  reviewRounds?: number;
  nextStep?: WorkRecordV1["nextStep"];
  wait?: WorkRecordV1["wait"];
  head?: GitSha | null;
  blocker?: WorkRecordV1["blocker"];
  reservations?: BudgetReservationV1[];
  reviews?: ReviewReceiptV1[];
  /** The legacy review cutoff the runtime runs under (none by default). */
  legacyReviewCutoff?: number;
  /** Overrides applied to the seeded record after the defaults. */
  record?: Record<string, unknown>;
}

export function seededState(
  work: WorkRecordV1[],
  reservations: BudgetReservationV1[] = [],
  reviews: ReviewReceiptV1[] = [],
): RepairStateSnapshotV1 {
  return {
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work,
    reservations,
    reviews,
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  };
}

/** One issue task with its published head and open PR 7 (or no head yet). */
export async function capRig(options: CapRigOptionsV1 = {}) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    repository: options.repository ?? REPO,
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    // The shared start budget never decides these cases: only the ceiling may.
    liveStartLimits: { perHour: 1_000, perSevenDays: 10_000 },
  });
  const issueNumber = options.issueNumber ?? 1;
  const id = options.id ?? `issue-${issueNumber}`;
  const branch = `sentinel/repair/${id}`;
  const github = new ChurnGithub(clock, branch);
  // The blanket fake's live issue text ("issue N", empty body).
  github.task = {
    issueNumber,
    digest: await reviewTaskStatementDigest({
      issueNumber,
      title: `issue ${issueNumber}`,
      body: "",
    }),
  };
  const model = new FakeModel({ head: SHA3, changedPaths: ["src/app.ts"] });
  const deps = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model,
    budget: new RollingStartBudget({ clock, state, configs }),
    ...(options.legacyReviewCutoff === undefined
      ? {}
      : { legacyReviewCutoff: options.legacyReviewCutoff }),
  };
  const head = options.head === undefined ? SHA3 : options.head;
  const record = workRecord(id, {
    repository: options.repository ?? REPO,
    source: { kind: "issue", id: String(issueNumber), revision: SHA1 },
    related: { incidentId: null, issueNumber },
    target: {
      base: SHA1,
      branch,
      checkpoint: null,
      head,
      pr: head === null ? null : PR,
    },
    nextStep: options.nextStep ?? "work",
    wait: options.wait ?? null,
    blocker: options.blocker ?? null,
    counters: {
      attempts: 1,
      retries: 0,
      reviewRounds: options.reviewRounds ?? 0,
    },
    firstSeenAt: T0 - 5000,
    createdAt: T0 - 4000,
    updatedAt: T0,
    ...options.record,
  });
  const written = await state.writeRepair(
    seededState([record], options.reservations, options.reviews),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  const run = () =>
    runRepairCycle(deps, {
      deadline: clock.now() + 60 * MINUTE,
      stepLimit: 16,
    });
  const snapshot = async () => {
    const read = await state.readRepair();
    if (!read.ok || read.value.status !== "found") throw new Error("state");
    return read.value.snapshot;
  };
  const work = async () => (await snapshot()).work[0]!;
  const charges = async () =>
    (await snapshot()).reservations.filter((row) =>
      row.purpose === "review_request" && row.taskId === record.id
    );
  return {
    clock,
    state,
    deps,
    github,
    model,
    record,
    run,
    snapshot,
    work,
    charges,
  };
}

export type CapRigV1 = Awaited<ReturnType<typeof capRig>>;

/** A record parked by the ceiling with `message`, its head and PR kept. */
export async function assertParked(
  rig: CapRigV1,
  message: string,
  head: GitSha | null = SHA3,
  pr: number | null = head === null ? null : PR,
): Promise<WorkRecordV1> {
  const work = await rig.work();
  assert.equal(work.nextStep, "blocked", JSON.stringify(work.blocker));
  assert.equal(work.blocker?.kind, "other");
  assert.equal(work.blocker?.message, message);
  assert.equal(work.target.head, head, "the head is kept");
  assert.equal(work.target.pr, pr, "the pull request is kept");
  assert.equal(work.wait, null);
  return work;
}
