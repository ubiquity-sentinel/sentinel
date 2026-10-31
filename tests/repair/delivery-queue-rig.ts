/**
 * Several issue tasks of ONE repository with open pull requests, driven
 * through the REAL repair loop against a reviewer that always returns a clean,
 * task-accepted verdict, green CI on every head, and a merge that lands at
 * once and moves the base branch to the merge commit, exactly like
 * `development` (live ai.ubq.fi: 8 of the 17 PRs merged since
 * 2026-10-16T00:00Z needed four or more reviewed heads, each new head a
 * refresh after another merge).
 *
 * `livePolicy` makes the runtime's merge port answer as the real one does on
 * live ai.ubq.fi, whose `development` has no branch rules: every merge is
 * refused `protection_required` before any write. Merges are then made only
 * by the REAL launcher delivery pass (`launcher`, `drive(.., { launcher })`)
 * over the same state and this fake repository, as live.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
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
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { reviewTaskStatementDigest } from "../../src/contracts/review-receipt.ts";
import { missingExpectedChecks } from "../../src/repair/ci-coverage.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { runHostedDeliveryPass } from "../../ops/hosted-autonomy-delivery-pass.ts";
import { readHostedClosedIssues } from "../../ops/hosted-autonomy-retry-pass.ts";
import {
  createHostedAutonomyScopes,
  type HostedAutonomyPassContextV1,
} from "../../ops/hosted-autonomy-scopes.ts";
import {
  DORMANT_HOSTED_SUPERVISOR_POLICY,
  type HostedPolicyGraph,
  withHostedProductionPolicy,
} from "../host/hosted-supervisor-policy-fixture.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadRunV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy-types.ts";
import { releaseSnapshot } from "../host/hosted-autonomy-rig.ts";
import {
  darkQueueFixture,
  historicalDarkQueueFixture,
} from "../host/hosted-autonomy-dark-queue-fixture.ts";
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
  /** The base tip the launcher merged onto. */
  mergedOnto?: GitSha;
}

/** The fixed sentinel App: author, reviewer and merger of every PR here. */
export const APP = "ubiquity-sentinel[bot]";

/** Keep the private dormant production graph alive for the entire historical scenario. */
export function historicalDeliveryScenario(
  check: (graph: HostedPolicyGraph) => Promise<void>,
): () => Promise<void> {
  return () =>
    withHostedProductionPolicy(DORMANT_HOSTED_SUPERVISOR_POLICY, check);
}

/** One merge the launcher made, with its commit message evidence. */
export interface LauncherMergeV1 {
  pr: number;
  head: string;
  onto: GitSha;
  message: string | undefined;
}

/** One base branch, many candidate branches and pull requests. */
export class QueueGithub extends FakeGithub {
  override readonly reviewerIdentity: string;
  remoteBase: GitSha = SHA1;
  readonly heads = new Map<string, GitSha>();
  readonly pulls = new Map<number, PullV1>();
  readonly merged: number[] = [];
  readonly reviewed: { pr: number; head: GitSha; base: GitSha }[] = [];
  /** Merges the runtime's port refused under the live policy (PRs). */
  readonly refusedMerges: number[] = [];
  /** Every merge the launcher's delivery pass made. */
  readonly launcherMerges: LauncherMergeV1[] = [];
  /** Check runs per head; an unlisted head reads one green check. */
  readonly checksByHead = new Map<string, GitHubCheckV1[]>();
  /** Refreshed heads whose merge-base patch differs from the reviewed one. */
  readonly changedPatch = new Set<string>();
  /** Every prepared refresh, keyed by PR, head and observed base. */
  readonly preparedKeys: string[] = [];
  /** Each prepared head: the head it was made from and the tip it holds. */
  readonly refreshedFrom = new Map<string, { from: GitSha; onto: GitSha }>();
  /** When each prepared head was made (its default CI completes 1 s later). */
  readonly refreshedAt = new Map<string, number>();
  refreshes = 0;
  /** The runtime port answers as on live ai.ubq.fi (no branch rules). */
  livePolicy = false;
  private readonly prepared = new Map<string, GitSha>();
  private readonly requested = new Map<
    string,
    { head: GitSha; base: GitSha; task: ReviewTaskStatementV1 | null }
  >();

  constructor(private readonly clock: FakeClock, reviewer?: string) {
    super({});
    this.reviewerIdentity = reviewer ?? "chatgpt-codex-connector[bot]";
    this.prepareBaseRefresh = (request) => {
      const key =
        `${request.pullRequestNumber}:${request.expectedHead}:${request.expectedBase}`;
      let prepared = this.prepared.get(key);
      if (prepared === undefined) {
        this.refreshes++;
        this.preparedKeys.push(key);
        prepared = sha(0x5000 + this.refreshes);
        this.prepared.set(key, prepared);
        this.refreshedFrom.set(prepared, {
          from: request.expectedHead,
          onto: request.expectedBase,
        });
        this.refreshedAt.set(prepared, this.clock.now());
      }
      return Promise.resolve(portOk(prepared));
    };
    // The patch proof git would derive: equal digests unless the refreshed
    // head is scripted as carrying a different patch; the refreshed-from head
    // and the first-parent distance from the reviewed head, as git reads them.
    this.proveCarriedPatch = (request) =>
      Promise.resolve(portOk({
        reviewedMergeBase: request.reviewedBase,
        reviewedPatch: "a".repeat(64),
        refreshedMergeBase: request.base,
        refreshedPatch: this.changedPatch.has(request.head)
          ? "b".repeat(64)
          : "a".repeat(64),
        refreshedFrom: this.refreshedFrom.get(request.head)?.from ?? null,
        refreshes: this.distance(request.reviewedHead, request.head),
      }));
  }

  /** A launcher merge commit's parents: the tip it landed on, the head. */
  readCommitParents(
    commit: GitSha,
  ): Promise<PortResultV1<GitSha[] | null>> {
    const pr = [...this.pulls.values()].find((row) => row.mergeSha === commit);
    return Promise.resolve(portOk(
      pr?.mergedOnto === undefined
        ? null
        : [pr.mergedOnto, this.heads.get(pr.branch)!],
    ));
  }

  /** First-parent refreshes from `reviewed` to `head` (1000: unrelated). */
  private distance(reviewed: GitSha, head: GitSha): number {
    let count = 0;
    let at: GitSha = head;
    while (at !== reviewed) {
      const step = this.refreshedFrom.get(at);
      if (step === undefined || count >= 1000) return 1000;
      at = step.from;
      count++;
    }
    return count;
  }

  /**
   * The checks of `head`: the scripted ones, else one green `validate` run
   * that finished 1 s after the head was made (a refresh) or after T0.
   */
  private checksOf(head: string): GitHubCheckV1[] {
    const madeAt = this.refreshedAt.get(head) ?? T0;
    return this.checksByHead.get(head) ?? [{
      name: "validate",
      status: "completed" as const,
      conclusion: "success" as const,
      head: head as GitSha,
      startedAt: madeAt,
      completedAt: madeAt + 1000,
    }];
  }

  /** Every check on `head` completed successfully (and there is one). */
  private green(head: string): boolean {
    const checks = this.checksOf(head);
    return checks.length > 0 &&
      checks.every((check) =>
        check.status === "completed" && check.conclusion === "success"
      );
  }

  /**
   * The launcher's view of this repository (`HostedAutonomyGitHubV1`), over
   * the same branches, pull requests, checks and refreshes the runtime sees.
   * Its merge lands at once and moves `development` to the merge commit.
   */
  launcherSurface(): HostedAutonomyGitHubV1 {
    const pullOf = (pr: PullV1): HostedAutonomyPullV1 => {
      const merged = pr.mergeSha !== null;
      const head = this.heads.get(pr.branch)!;
      return {
        number: pr.number,
        state: merged ? "closed" : "open",
        merged,
        mergeCommitSha: pr.mergeSha,
        headSha: head,
        baseRef: "development",
        baseSha: merged ? pr.mergedOnto! : this.remoteBase,
        author: APP,
        mergedBy: merged ? APP : null,
        parents: merged ? [pr.mergedOnto!, head] : [],
        revisionOnBaseBranch: merged,
        baseAncestorOfRevision: merged,
        mergeable: true,
      };
    };
    return {
      readDefaultBranch: () => Promise.resolve("development"),
      readBaseTip: () => Promise.resolve(this.remoteBase),
      hasSuccessfulCheck: (head) => Promise.resolve(this.green(head)),
      // With the base the head is tested against, every check name of each
      // base suite the head shares a name with must exist on the head too.
      hasAllChecksGreen: (head, base) =>
        Promise.resolve(
          this.green(head) &&
            (base === undefined ||
              missingExpectedChecks(this.checksOf(head), this.checksOf(base))
                  .length === 0),
        ),
      readPull: (number) => {
        const pr = this.pulls.get(number);
        return Promise.resolve(pr === undefined ? null : pullOf(pr));
      },
      readIssueOpen: () => Promise.resolve(true),
      readIssueTask: async (number) => {
        const text = {
          issueNumber: number,
          title: `issue ${number}`,
          body: "",
        };
        return { ...text, digest: await reviewTaskStatementDigest(text) };
      },
      readIssueOptedOut: () => Promise.resolve(false),
      baseAdvanced: (base, tip) =>
        Promise.resolve(this.refreshedFrom.get(tip)?.onto === base),
      comparePatchDigest: (_base, head) =>
        Promise.resolve(
          this.changedPatch.has(head) ? "b".repeat(64) : "a".repeat(64),
        ),
      // The exact change set git trees give: one reviewed path, its new blob
      // different for a refreshed head scripted as carrying another patch,
      // against the merge base the refresh holds (else the asked base).
      mergeBaseTreeChanges: (base, head) =>
        Promise.resolve({
          mergeBase: this.refreshedFrom.get(head)?.onto ?? base,
          changes: [{
            path: "src/app.ts",
            oldMode: "100644",
            oldSha: "1".repeat(40),
            newMode: "100644",
            newSha: (this.changedPatch.has(head) ? "3" : "2").repeat(40),
          }],
        }),
      merge: (number, head, message) => {
        const pr = this.pulls.get(number);
        if (
          pr === undefined || pr.mergeSha !== null ||
          this.heads.get(pr.branch) !== head
        ) return Promise.resolve({ merged: false, sha: null });
        const onto = this.remoteBase;
        pr.mergedOnto = onto;
        pr.mergeSha = sha(0x9000 + this.merged.length + 1);
        this.merged.push(number);
        this.remoteBase = pr.mergeSha;
        this.launcherMerges.push({ pr: number, head, onto, message });
        return Promise.resolve({ merged: true, sha: pr.mergeSha });
      },
      closeIssue: () => Promise.resolve(true),
      listParkedRuns: () => Promise.resolve([]),
      approveRun: () => Promise.resolve(true),
      listHeadRuns: (head) =>
        Promise.resolve(
          this.green(head)
            ? [{
              id: 7001,
              headSha: head,
              status: "completed",
              conclusion: "success",
              runAttempt: 1,
              createdAt: T0,
            } as HostedAutonomyHeadRunV1]
            : [],
        ),
    };
  }

  override readChecks(head: GitSha) {
    return Promise.resolve(portOk({ head, checks: this.checksOf(head) }));
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
  ): Promise<PortResultV1<MergeOutcomeV1>> {
    this.calls.push("merge");
    const pr = this.pulls.get(request.pullRequestNumber)!;
    if (this.livePolicy) {
      // The real port on a branch with no rules: refused before any write.
      this.refusedMerges.push(pr.number);
      return Promise.resolve(portOk({
        outcome: "blocked",
        reason: "protection_required",
        head: request.expectedHead,
      }));
    }
    if (
      this.heads.get(pr.branch) !== request.expectedHead ||
      (request.expectedBase !== null &&
        request.expectedBase !== this.remoteBase)
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
      head: request.expectedHead,
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
    /** The trusted reviewer identity (the sentinel App for `livePolicy`). */
    reviewer?: string;
    /** The runtime port refuses every merge, as on live ai.ubq.fi. */
    livePolicy?: boolean;
    /** The one repository (default ai.ubq.fi). */
    repository?: RepositoryIdentityV1;
    /** Explicit historical direct-delivery policy; absent retains canonical behavior. */
    historicalLauncher?: HostedPolicyGraph;
  } = {},
) {
  const repository = options.repository ?? REPO;
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    repository,
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    liveStartLimits: { perHour: 1_000, perSevenDays: 10_000 },
  });
  const github = new QueueGithub(clock, options.reviewer);
  github.livePolicy = options.livePolicy === true;
  const records: WorkRecordV1[] = [];
  for (let index = 1; index <= count; index++) {
    const id = `issue-${index}`;
    const branch = `sentinel/repair/${id}`;
    const head = sha(0x100 + index);
    const pr = 100 + index;
    github.heads.set(branch, head);
    github.pulls.set(pr, { number: pr, branch, issue: index, mergeSha: null });
    records.push(workRecord(id, {
      repository,
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
  /** Every action line the launcher's delivery passes reported. */
  const launcherActions: string[] = [];
  /**
   * One REAL launcher delivery pass (`runHostedDeliveryPass`) over the same
   * state and repository, as the maintenance job runs it before the runtime.
   */
  // Each historical scenario owns its graph; all launcher passes share its consumers.
  let historical:
    | Promise<
      readonly [
        typeof import("../../ops/hosted-autonomy-delivery-pass.ts"),
        typeof import("../../ops/hosted-autonomy-retry-pass.ts"),
        typeof import("../../ops/hosted-autonomy-scopes.ts"),
      ]
    >
    | undefined;
  const launcher = async (): Promise<string[]> => {
    const graph = options.historicalLauncher;
    const [delivery, closed, scopes] = graph === undefined
      ? [{ runHostedDeliveryPass }, { readHostedClosedIssues }, {
        createHostedAutonomyScopes,
      }]
      : await (historical ??= Promise.all([
        graph.deliveryPass(),
        graph.closedIssues(),
        graph.scopes(),
      ]));
    const read = await state.readRepair();
    if (!read.ok || read.value.status !== "found") throw new Error("state");
    const surface = github.launcherSurface();
    const hosted = {
      state,
      githubFor: () => surface,
      clock,
      queueCustody:
        (graph === undefined ? darkQueueFixture : historicalDarkQueueFixture)({
          state,
          githubFor: () => surface,
        }),
    } as unknown as HostedAutonomyDepsV1;
    const context = {
      deps: hosted,
      actions: [] as string[],
      revisions: [],
      snapshot: read.value.snapshot,
      observedHead: read.value.head,
      initialHead: read.value.head,
      releaseSnapshot: releaseSnapshot(),
      closedIssues: new Set<string>(),
      foreignMerged: new Map(),
      dedicatedReservations: new Set<string>(),
      ...scopes.createHostedAutonomyScopes(hosted),
    } as unknown as HostedAutonomyPassContextV1;
    await closed.readHostedClosedIssues(context);
    await delivery.runHostedDeliveryPass(context);
    launcherActions.push(...context.actions);
    return context.actions;
  };
  /**
   * Runs the loop until every PR merged or `limit` runs passed; with
   * `launcher`, one launcher delivery pass precedes every runtime run.
   */
  const drive = async (
    limit: number,
    driveOptions: { launcher?: boolean; each?: (run: number) => void } = {},
  ) => {
    for (let run = 0; run < limit && github.merged.length < count; run++) {
      if (driveOptions.launcher === true) await launcher();
      await runRepairCycle(deps, {
        deadline: clock.now() + 60 * MINUTE,
        stepLimit: 16,
      });
      clock.advance(16 * MINUTE);
      driveOptions.each?.(run);
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
    launcher,
    launcherActions,
    writes,
  };
}
