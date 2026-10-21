/**
 * The launcher oracle: ONE real protected maintenance pass
 * (`runHostedAutonomy`, every phase in its production order: closure-delivery,
 * retry with its sub-passes, delivery, closure, follow-ups) over an in-memory
 * repair/release state and a fake repository surface that answers from an
 * abstract world. Nothing about the launcher's decisions is modeled here: the
 * checker only observes what the real pass wrote and which per-pass action
 * lines name the record.
 *
 * The matrix maintenance pre-pass needs matrix artifact deps the checker does
 * not provide, so it is inert here (`runHostedMatrixMaintenance` returns null
 * without `closedMatrix`/`historicalMatrix`); its classes are covered by
 * `census.ts`'s explicit matrix rows and listed in the limitations.
 */
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReviewTaskStatementV1 } from "../../src/contracts/review-receipt.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { renderHostedParkSummary } from "../../ops/hosted-autonomy-summary.ts";
import { anchor } from "./anchors.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy-runner.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyHeadRunV1,
  HostedAutonomyPullV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy-types.ts";
import { MemoryState } from "../repair/helpers.ts";
import {
  darkQueueCoordinatorFixture,
  darkQueueFixture,
} from "../host/hosted-autonomy-dark-queue-fixture.ts";
import {
  APP,
  BASE,
  candidateBranch,
  HEAD,
  preservationRefOf,
  releaseSnapshot,
  TIP,
} from "./world.ts";

/** The environment one launcher pass observes for every record. */
export interface LauncherWorldV1 {
  issueOpen: boolean;
  /** The record's own pull request as GitHub reports it. */
  pull: "open" | "closed_unmerged" | "merged" | "absent";
  /** The repository's base tip: still the record's base, or moved. */
  tip: "base" | "moved";
  /** Required CI on the record's head (a red head stays red: re-run spent). */
  headCi: "green" | "red";
  /** Required CI on the base tip. */
  tipCi: "green" | "red";
  /** GitHub's merge API accepts the merge. */
  mergeAccepts: boolean;
  /**
   * The record's candidate objects (managed branch, preservation ref,
   * candidate commit) are provably gone from the repository.
   */
  refsAbsent?: boolean;
  /** Heads whose required CI is red whatever `headCi` says. */
  redHeads?: ReadonlySet<string>;
  /** Pull requests GitHub refuses to merge on every attempt. */
  refuseMerge?: ReadonlySet<number>;
  /** Failed head runs still at attempt 1 whose re-run GitHub refuses. */
  rerunRefused?: boolean;
  /** Creation instant of the failed head runs (re-run window). */
  rerunCreatedAt?: number;
}

export const SUMMARY_ANCHOR = anchor(
  "launcher.parkSummary",
  "ops/hosted-autonomy-main.ts",
  `await emitHostedParkSummary(
            state,
            env("GITHUB_STEP_SUMMARY"),
            summaryActions,
          );`,
);

export const FAVORABLE: LauncherWorldV1 = {
  issueOpen: true,
  pull: "open",
  tip: "base",
  headCi: "green",
  tipCi: "green",
  mergeAccepts: true,
};

export function tipOf(world: LauncherWorldV1): GitSha {
  return world.tip === "base" ? BASE : TIP;
}

/** A fake surface for one repository, answering every read from `world`. */
export function worldSurface(
  world: LauncherWorldV1,
  records: readonly WorkRecordV1[],
  tasks: ReadonlyMap<number, ReviewTaskStatementV1>,
  calls: { merges: number[]; reruns: number[] } = { merges: [], reruns: [] },
): HostedAutonomyGitHubV1 {
  const byPr = new Map<number, WorkRecordV1>();
  const byBranch = new Map<string, WorkRecordV1>();
  for (const record of records) {
    const pr = record.target.pr ?? prOf(record);
    byPr.set(pr, record);
    byBranch.set(candidateBranch(record.id), record);
    const ref = preservationRefOf(record);
    if (ref !== null) byBranch.set(ref.replace(/^refs\/heads\//, ""), record);
  }
  const merged = new Set<number>();
  const pull = (number: number): HostedAutonomyPullV1 | null => {
    const record = byPr.get(number);
    if (record === undefined || world.pull === "absent") return null;
    const isMerged = world.pull === "merged" || merged.has(number);
    return {
      number,
      state: world.pull === "open" && !isMerged ? "open" : "closed",
      merged: isMerged,
      mergeCommitSha: isMerged ? mergeSha(number) : null,
      headSha: record.target.head,
      baseRef: "development",
      baseSha: record.target.base,
      author: APP,
      mergedBy: isMerged ? APP : null,
      parents: isMerged ? [tipOf(world), record.target.head ?? HEAD] : [],
      revisionOnBaseBranch: isMerged,
      baseAncestorOfRevision: isMerged,
      mergeable: true,
    };
  };
  const heads = new Set<string>(
    records.map((record) => record.target.head ?? HEAD),
  );
  const headGreen = (sha: string) =>
    world.redHeads?.has(sha) === true ? false : world.headCi === "green";
  const green = (sha: string) =>
    Promise.resolve(
      sha === tipOf(world)
        ? world.tipCi === "green"
        : heads.has(sha) || sha === HEAD
        ? headGreen(sha)
        : false,
    );
  return {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch: string) => {
      if (branch === "development") return Promise.resolve(tipOf(world));
      const record = byBranch.get(branch);
      if (world.refsAbsent === true) return Promise.resolve(null);
      return Promise.resolve(record?.target.head ?? null);
    },
    hasSuccessfulCheck: green,
    hasAllChecksGreen: green,
    readPull: (number: number) => Promise.resolve(pull(number)),
    listPullsByHeadRef: (branch: string) => {
      const record = byBranch.get(branch);
      if (record === undefined || world.pull === "absent") {
        return Promise.resolve([]);
      }
      const facts = pull(prOf(record))!;
      return Promise.resolve([{
        number: facts.number,
        state: facts.state === "open" ? "open" as const : "closed" as const,
        merged: facts.merged,
        headSha: facts.headSha ?? HEAD,
        headRef: branch,
        baseRef: "development",
        author: APP,
      }]);
    },
    readIssueOpen: () => Promise.resolve(world.issueOpen),
    readIssueTask: (number: number) =>
      Promise.resolve(tasks.get(number) ?? null),
    readIssueOptedOut: () => Promise.resolve(false as boolean | null),
    baseAdvanced: () => Promise.resolve(true),
    merge: (number: number) => {
      calls.merges.push(number);
      if (!world.mergeAccepts || world.refuseMerge?.has(number) === true) {
        return Promise.resolve({ merged: false, sha: null });
      }
      merged.add(number);
      return Promise.resolve({ merged: true, sha: mergeSha(number) });
    },
    closeIssue: () => Promise.resolve(true),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(true),
    // The once-per-head re-run already happened (attempt 2): a red head's
    // flake re-run can no longer act, so it is settled for the planner.
    listHeadRuns: (head: string) =>
      Promise.resolve<readonly HostedAutonomyHeadRunV1[]>([{
        id: 7001,
        headSha: head,
        status: "completed",
        conclusion: headGreen(head) ? "success" : "failure",
        runAttempt: world.rerunRefused === true ? 1 : 2,
        createdAt: world.rerunCreatedAt ?? null,
      }]),
    rerunFailedJobs: (id: number) => {
      calls.reruns.push(id);
      return Promise.resolve(false);
    },
    mismatchDisposition: {
      readRefAbsent: () => Promise.resolve(world.refsAbsent === true),
      listPullsByHead: (branch: string) => {
        const record = byBranch.get(branch);
        if (
          record === undefined || world.pull === "absent" ||
          world.refsAbsent === true
        ) {
          return Promise.resolve([]);
        }
        const facts = pull(prOf(record))!;
        return Promise.resolve([{
          number: facts.number,
          state: facts.state,
          head: branch,
        }]);
      },
      readRunTerminal: () => Promise.resolve(true),
      readCommitAbsent: (sha: string) =>
        Promise.resolve(world.refsAbsent === true && sha === HEAD),
    },
  };
}

/** The deterministic pull request number a shape publishes as. */
export function prOf(record: WorkRecordV1): number {
  return 1000 + (record.related.issueNumber ?? 0);
}

export function mergeSha(pullRequest: number): string {
  return `${"e".repeat(36)}${pullRequest.toString(16).padStart(4, "0")}`;
}

export interface LauncherPassV1 {
  result: HostedAutonomyResultV1;
  after: RepairStateSnapshotV1;
  actions: string[];
  merges: number[];
  reruns: number[];
}

/**
 * Run one REAL maintenance pass at `now` and return what it wrote. The
 * runner's JSON progress lines are captured, not printed.
 */
export async function runLauncherPass(
  snapshot: RepairStateSnapshotV1,
  world: LauncherWorldV1,
  tasks: ReadonlyMap<number, ReviewTaskStatementV1>,
  now: number,
): Promise<LauncherPassV1> {
  const state = new MemoryState();
  state.repair = snapshot;
  state.repairHead = "1111111111111111111111111111111111111111" as GitSha;
  state.sequenceRule = false;
  state.setRelease(releaseSnapshot());
  const calls = { merges: [] as number[], reruns: [] as number[] };
  const surface = worldSurface(world, snapshot.work, tasks, calls);
  const queueDeps = { state, githubFor: () => surface };
  const log = console.log;
  console.log = () => {};
  let result: HostedAutonomyResultV1;
  try {
    result = await runHostedAutonomy({
      state,
      githubFor: () => surface,
      clock: { now: () => now },
      queueCustody: darkQueueFixture(queueDeps),
      queue: await darkQueueCoordinatorFixture(queueDeps),
    });
  } finally {
    console.log = log;
  }
  // The production main emits this same renderer after the pass. Keep the
  // mapping to record identity explicit: summary rows use issue links rather
  // than the maintenance log's internal work id.
  const summary = renderHostedParkSummary(state.repair!, result.actions);
  const summaryActions = state.repair!.work.filter((record) =>
    record.nextStep === "blocked" && summary.includes(
      record.related.issueNumber === null
        ? `| ${record.id} |`
        : `| ${record.repository.owner}/${record.repository.name}#${record.related.issueNumber} |`,
    )
  ).map((record) => `summary:${record.id}:blocked`);
  return {
    result,
    after: state.repair!,
    actions: [...result.actions, ...summaryActions],
    merges: calls.merges,
    reruns: calls.reruns,
  };
}

/** The persisted decision fields of one record (what a move changes). */
export function decisionView(record: WorkRecordV1 | undefined): string {
  if (record === undefined) return "absent";
  return JSON.stringify({
    nextStep: record.nextStep,
    blocker: record.blocker?.message ?? null,
    wait: record.wait === null
      ? null
      : { reason: record.wait.reason, until: record.wait.until },
    intent: record.intent?.kind ?? null,
    pr: record.target.pr,
    head: record.target.head,
    base: record.target.base,
  });
}
