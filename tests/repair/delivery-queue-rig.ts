/**
 * Several issue tasks of ONE repository with open pull requests, driven
 * through the REAL repair loop against a reviewer that always returns a clean,
 * task-accepted verdict, green CI on every head, and a merge that lands at
 * once and moves the base branch to the merge commit, exactly like
 * `development` (live ai.ubq.fi: 8 of the 17 PRs merged since
 * 2026-10-16T00:00Z needed four or more reviewed heads, each new head a
 * refresh after another merge).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  CarriedMergeV1,
  GitHubCheckV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  MergeOutcomeV1,
  PortResultV1,
  ReviewObservationV1,
} from "../../src/contracts/ports.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { MergeRequestV1 } from "../../src/contracts/merge-request.ts";
import type { ReviewTaskStatementV1 } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { REPO, SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeModel,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { MINUTE, seededState, sha } from "./review-round-cap-rig.ts";

interface PullV1 {
  number: number;
  branch: string;
  issue: number;
  mergeSha: GitSha | null;
}

/** One base branch, many candidate branches and pull requests. */
export class QueueGithub extends FakeGithub {
  remoteBase: GitSha = SHA1;
  readonly heads = new Map<string, GitSha>();
  readonly pulls = new Map<number, PullV1>();
  readonly merged: number[] = [];
  readonly reviewed: { pr: number; head: GitSha; base: GitSha }[] = [];
  /** Every carried merge the loop requested (PR and identity). */
  readonly carried: (CarriedMergeV1 & { pr: number })[] = [];
  /** Check runs per head; an unlisted head reads one green check. */
  readonly checksByHead = new Map<string, GitHubCheckV1[]>();
  /** Refreshed heads whose merge-base patch differs from the reviewed one. */
  readonly changedPatch = new Set<string>();
  /** Every prepared refresh, keyed by PR, head and observed base. */
  readonly preparedKeys: string[] = [];
  refreshes = 0;
  private readonly prepared = new Map<string, GitSha>();
  private readonly requested = new Map<
    string,
    { head: GitSha; base: GitSha; task: ReviewTaskStatementV1 | null }
  >();

  constructor(private readonly clock: FakeClock) {
    super({});
    this.prepareBaseRefresh = (request) => {
      const key =
        `${request.pullRequestNumber}:${request.expectedHead}:${request.expectedBase}`;
      let prepared = this.prepared.get(key);
      if (prepared === undefined) {
        this.refreshes++;
        this.preparedKeys.push(key);
        prepared = sha(0x5000 + this.refreshes);
        this.prepared.set(key, prepared);
      }
      return Promise.resolve(portOk(prepared));
    };
    // The patch proof git would derive: equal digests unless the refreshed
    // head is scripted as carrying a different patch.
    this.proveCarriedPatch = (request) =>
      Promise.resolve(portOk({
        reviewedMergeBase: request.reviewedBase,
        reviewedPatch: "a".repeat(64),
        refreshedMergeBase: request.base,
        refreshedPatch: this.changedPatch.has(request.head)
          ? "b".repeat(64)
          : "a".repeat(64),
      }));
  }

  override readChecks(head: GitSha) {
    return Promise.resolve(portOk({
      head,
      checks: this.checksByHead.get(head) ?? [{
        name: "validate",
        status: "completed" as const,
        conclusion: "success" as const,
        head,
        startedAt: T0,
        completedAt: T0 + 1000,
      }],
    }));
  }

  private pull(pr: PullV1): GitHubPullRequestV1 {
    const merged = pr.mergeSha !== null;
    return {
      number: pr.number,
      title: "Sentinel repair",
      body: `Resolves #${pr.issue}`,
      state: merged ? "merged" : "open",
      head: this.heads.get(pr.branch)!,
      base: this.remoteBase,
      mergeSha: pr.mergeSha,
      headRef: pr.branch,
      baseRef: "development",
      author: "sentinel-owner",
      createdAt: T0,
      updatedAt: T0,
      mergedAt: merged ? T0 : null,
      reviewDecision: "none",
    };
  }

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
    const head = this.heads.get(ref.replace(/^refs\/heads\//, ""));
    return Promise.resolve(
      portOk(head === undefined ? null : { ref, sha: head }),
    );
  }

  override readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    const pr = this.pulls.get(number);
    return Promise.resolve(portOk(pr === undefined ? null : this.pull(pr)));
  }

  override findPullRequestByHeadRef(
    headRef: string,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    const pr = [...this.pulls.values()].find((row) => row.branch === headRef);
    return Promise.resolve(portOk(pr === undefined ? null : this.pull(pr)));
  }

  override pushHead(
    ref: string,
    next: GitSha,
    expected: GitSha | null,
  ): Promise<PortResultV1<"applied" | "ambiguous">> {
    this.pushes.push({ ref, sha: next, expected });
    const branch = ref.replace(/^refs\/heads\//, "");
    if (expected === null || this.heads.get(branch) === expected) {
      this.heads.set(branch, next);
    }
    return Promise.resolve(portOk("applied"));
  }

  override async requestReview(request: unknown) {
    const identity = request as {
      operationKey: string;
      prNumber: number;
      expectedHead: GitSha;
      expectedBase: GitSha;
      task?: ReviewTaskStatementV1 | null;
    };
    this.requested.set(identity.operationKey, {
      head: identity.expectedHead,
      base: identity.expectedBase,
      task: identity.task ?? null,
    });
    this.reviewed.push({
      pr: identity.prNumber,
      head: identity.expectedHead,
      base: identity.expectedBase,
    });
    const answered = await super.requestReview(request);
    if (!answered.ok || answered.value.outcome !== "applied") return answered;
    return portOk({
      outcome: "applied" as const,
      requestId: `review-req-${this.reviewed.length}`,
      requestedAt: this.clock.now(),
    });
  }

  override observeReview(
    request: unknown,
  ): Promise<PortResultV1<ReviewObservationV1>> {
    const { operationKey } = request as { operationKey: string };
    const bound = this.requested.get(operationKey);
    const at = this.clock.now() - 1_000;
    if (bound === undefined) {
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
    const index = [...this.requested.keys()].indexOf(operationKey) + 1;
    return Promise.resolve(portOk({
      status: "completed",
      requestId: `review-req-${index}`,
      reviewer: this.reviewerIdentity,
      resultId: `result-${index}`,
      completedAt: at,
      observedHead: bound.head,
      observedBase: bound.base,
      findings: [],
      summary: null,
      receivedAt: at + 1,
      taskAcceptance: bound.task === null ? null : {
        issueNumber: bound.task.issueNumber,
        taskDigest: bound.task.digest,
        verdict: "fulfilled",
        evidence: ["The exact candidate change satisfies the task."],
      },
    } as ReviewObservationV1));
  }

  override mergePullRequest(
    request: MergeRequestV1,
    _execution?: unknown,
    carried?: CarriedMergeV1,
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    this.calls.push("merge");
    const pr = this.pulls.get(request.pullRequestNumber)!;
    const head = carried?.head ?? request.expectedHead;
    const base = carried?.base ?? request.expectedBase;
    if (carried !== undefined) {
      this.carried.push({ ...carried, pr: request.pullRequestNumber });
    }
    if (
      this.heads.get(pr.branch) !== head ||
      (base !== null && base !== this.remoteBase) ||
      (carried !== undefined && this.changedPatch.has(carried.head))
    ) {
      return Promise.resolve(portOk({
        outcome: "blocked",
        reason: "checks_pending",
        head: request.expectedHead,
      }));
    }
    pr.mergeSha = sha(0x9000 + this.merged.length + 1);
    this.merged.push(pr.number);
    this.remoteBase = pr.mergeSha;
    return Promise.resolve(portOk({
      outcome: "merged",
      head,
      mergeSha: pr.mergeSha,
    }));
  }
}

/**
 * `count` published candidates on one base, each with its open PR; `shape`
 * may rewrite the seeded records (same ids, branches and pull requests) and
 * `tip` moves the base branch before the first run.
 */
export async function queueRig(
  count: number,
  options: {
    shape?: (records: WorkRecordV1[]) => WorkRecordV1[];
    tip?: GitSha;
    reservations?: BudgetReservationV1[];
    reviews?: ReviewReceiptV1[];
  } = {},
) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    repository: REPO,
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    liveStartLimits: { perHour: 1_000, perSevenDays: 10_000 },
  });
  const github = new QueueGithub(clock);
  const records: WorkRecordV1[] = [];
  for (let index = 1; index <= count; index++) {
    const id = `issue-${index}`;
    const branch = `sentinel/repair/${id}`;
    const head = sha(0x100 + index);
    const pr = 100 + index;
    github.heads.set(branch, head);
    github.pulls.set(pr, { number: pr, branch, issue: index, mergeSha: null });
    records.push(workRecord(id, {
      repository: REPO,
      source: { kind: "issue", id: String(index), revision: SHA1 },
      related: { incidentId: null, issueNumber: index },
      target: { base: SHA1, branch, checkpoint: null, head, pr },
      counters: { attempts: 1, retries: 0, reviewRounds: 0 },
      firstSeenAt: T0 - 5000,
      createdAt: T0 - 4000 + index,
      updatedAt: T0,
    }));
  }
  if (options.tip !== undefined) github.remoteBase = options.tip;
  const seeded = options.shape?.(records) ?? records;
  const written = await state.writeRepair(
    seededState(seeded, options.reservations, options.reviews),
    null,
  );
  assert.ok(written.ok && written.value.status === "applied");
  // Every snapshot the loop writes from here on, exactly as written.
  const writes: RepairStateSnapshotV1[] = [];
  const write = state.writeRepair.bind(state);
  state.writeRepair = (snapshot, expectedHead) => {
    writes.push(structuredClone(snapshot));
    return write(snapshot, expectedHead);
  };
  const deps = {
    clock,
    state,
    configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({ state, clock }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: new FakeModel({ head: SHA1, changedPaths: ["src/app.ts"] }),
    budget: new RollingStartBudget({ clock, state, configs }),
  };
  const snapshot = async (): Promise<RepairStateSnapshotV1> => {
    const read = await state.readRepair();
    if (!read.ok || read.value.status !== "found") throw new Error("state");
    return read.value.snapshot;
  };
  /** Runs the loop until every PR merged or `limit` runs passed. */
  const drive = async (limit: number) => {
    for (let run = 0; run < limit && github.merged.length < count; run++) {
      await runRepairCycle(deps, {
        deadline: clock.now() + 60 * MINUTE,
        stepLimit: 16,
      });
      clock.advance(16 * MINUTE);
    }
  };
  return {
    clock,
    state,
    deps,
    github,
    records: seeded,
    snapshot,
    drive,
    writes,
  };
}
