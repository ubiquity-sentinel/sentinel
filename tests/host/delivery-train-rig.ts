/**
 * Delivery-train rig (sentinel #330): a temporary target repository whose
 * reviewed heads each branch off the reviewed base B0, a tip that moved past
 * it, the production train composer (`createTrainComposerFor`: its own bare
 * object store, exact-commit fetch, deterministic executor, train ref push
 * and lease-guarded ref deletion) against a temporary bare "GitHub"
 * repository, the train ledger (in memory, or the real git sidecar store on a
 * temporary state remote) and a fake GitHub surface whose squash merges,
 * trees and CI read that same bare repository. No network, credential or
 * model call.
 */
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import {
  reviewTaskStatementDigest,
  type ReviewTaskStatementV1,
} from "../../src/contracts/review-receipt.ts";
import { GitDeliveryTrainStore } from "../../src/state/delivery-train-store.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
} from "../../ops/hosted-autonomy.ts";
import type { HostedAutonomyHeadRunV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  createTrainComposerFor,
  type TrainGitOptionsV1,
} from "../../ops/hosted-autonomy-train-git.ts";
import {
  type DeliveryTrainJournalV1,
  type DeliveryTrainLedgerV1,
  EMPTY_DELIVERY_TRAIN_LEDGER,
  type HostedDeliveryTrainDepsV1,
  parseDeliveryTrainLedgerV1,
} from "../../ops/hosted-autonomy-train-types.ts";
import {
  ENV,
  FOREIGN_BRANCH,
  FOREIGN_REPO,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
} from "./hosted-autonomy-fixtures.ts";
import { T0 } from "../state/helpers.ts";

const GIT_ENV: Record<string, string> = {
  ...ENV,
  GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_DATE: "1700000000 +0000",
};

export async function git(dir: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd: dir,
    env: GIT_ENV,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/** One reviewed member: the file its head writes (or overwrites). */
export interface MemberSpecV1 {
  file: string;
  content: string;
}

export interface TrainMemberV1 {
  id: WorkItemId;
  issue: number;
  pr: number;
  head: GitSha;
  record: WorkRecordV1;
  receipt: ReturnType<typeof foreignReceipt>;
  task: ReviewTaskStatementV1;
}

/** The in-memory CAS ledger store, one document per repository. */
export function memoryJournal(): DeliveryTrainJournalV1 & {
  ledger(): DeliveryTrainLedgerV1;
  writes: number;
} {
  let head: string | null = null;
  let stored: DeliveryTrainLedgerV1 = EMPTY_DELIVERY_TRAIN_LEDGER;
  let sequence = 0;
  const journal = {
    writes: 0,
    ledger: () => stored,
    read: () =>
      Promise.resolve({
        head,
        ledger: parseDeliveryTrainLedgerV1(structuredClone(stored))!,
      }),
    write: (input: {
      expectedHead: string | null;
      ledger: DeliveryTrainLedgerV1;
    }) => {
      if (input.expectedHead !== head) {
        return Promise.resolve({ status: "conflict" as const, head });
      }
      const parsed = parseDeliveryTrainLedgerV1(structuredClone(input.ledger));
      if (parsed === null) throw new Error("invalid ledger written");
      journal.writes++;
      sequence++;
      head = sequence.toString(16).padStart(40, "0");
      stored = parsed;
      return Promise.resolve({ status: "applied" as const, head });
    },
  };
  return journal;
}

export interface TrainWorldV1 {
  dir: string;
  bare: string;
  base: GitSha;
  /** The moved tip B1 every train is composed on. */
  initialTip: string;
  tip: () => string;
  members: TrainMemberV1[];
  merges: number[];
  /** Train (non-head) commits whose CI was read. */
  ciReads: Set<string>;
  journal: DeliveryTrainJournalV1;
  /** The repository's ledger as the journal reads it now. */
  ledger(): Promise<DeliveryTrainLedgerV1>;
  trainDeps: HostedDeliveryTrainDepsV1;
  surface: (base: HostedAutonomyGitHubV1) => HostedAutonomyGitHubV1;
  trainRefs(): Promise<string[]>;
  /** Called after every landed merge with its 1-based count. */
  onMerge?: (count: number) => void;
  /** Train CI override: null unreadable, "pending" not yet complete. */
  ci?: (sha: string) => boolean | null | "pending";
}

/**
 * Members branch off B0; the tip is B1 (B0 plus `tip.txt` and a changed
 * `shared.txt`). A train commit is red when its tree holds `broken.txt`.
 */
export async function makeTrainWorld(
  tmp: string,
  specs: readonly MemberSpecV1[],
  options: {
    ledger?: "memory" | "git";
    baseWorkflow?: string;
    now?: () => number;
    onPreparedWorkflowReader?: TrainGitOptionsV1["onPreparedWorkflowReader"];
  } = {},
): Promise<TrainWorldV1> {
  const dir = `${tmp}/target`;
  const bare = `${tmp}/target-remote.git`;
  await Deno.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", FOREIGN_BRANCH);
  await Deno.writeTextFile(`${dir}/README.md`, "target\n");
  await Deno.writeTextFile(`${dir}/shared.txt`, "one\ntwo\nthree\n");
  if (options.baseWorkflow !== undefined) {
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/ci.yml`,
      options.baseWorkflow,
    );
  }
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "B0");
  const base = await git(dir, "rev-parse", "HEAD") as GitSha;
  const members: TrainMemberV1[] = [];
  for (const [index, spec] of specs.entries()) {
    await git(dir, "checkout", "-q", "-b", `m${index}`, base);
    await Deno.writeTextFile(`${dir}/${spec.file}`, spec.content);
    await git(dir, "add", "-A");
    await git(dir, "commit", "-q", "-m", `member ${index}`);
    const head = await git(dir, "rev-parse", "HEAD") as GitSha;
    const issue = 200 + index;
    const pr = 500 + index;
    const id = `issue-ubiquity-ai.ubq.fi-${issue}` as WorkItemId;
    const title = `Deliver train member ${index}`;
    const body = `The train must deliver issue ${issue}.`;
    const task: ReviewTaskStatementV1 = {
      issueNumber: issue,
      title,
      body,
      digest: await reviewTaskStatementDigest({
        issueNumber: issue,
        title,
        body,
      }),
    };
    const record = foreignRecord({
      id,
      related: { incidentId: null, issueNumber: issue },
      source: { kind: "issue", id: String(issue), revision: "1".repeat(40) },
      createdAt: T0 + 100 + index,
      target: {
        base,
        branch: `sentinel/repair/${id}`,
        checkpoint: null,
        head,
        pr,
      },
    });
    const receipt = foreignReceipt({
      id: `review-receipt:${(index + 1).toString(16).repeat(64).slice(0, 64)}`,
      pullRequest: { number: pr, head, base },
      taskAcceptance: {
        issueNumber: issue,
        taskDigest: task.digest,
        verdict: "fulfilled",
        evidence: [`member ${index} satisfies its issue`],
      },
    });
    members.push({ id, issue, pr, head, record, receipt, task });
  }
  await git(dir, "checkout", "-q", FOREIGN_BRANCH);
  await Deno.writeTextFile(`${dir}/tip.txt`, "moved\n");
  await Deno.writeTextFile(`${dir}/shared.txt`, "one\ntwo\nthree\nfour\n");
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", "B1");
  let tip = await git(dir, "rev-parse", "HEAD");
  await git(tmp, "init", "-q", "--bare", bare);
  await git(dir, "push", "-q", bare, "--all");

  let journal: DeliveryTrainJournalV1 = memoryJournal();
  if (options.ledger === "git") {
    const stateRemote = `${tmp}/state-remote.git`;
    await git(tmp, "init", "-q", "--bare", stateRemote);
    journal = new GitDeliveryTrainStore({
      scratchDir: `${tmp}/ledger-scratch`,
      remoteUrl: stateRemote,
    });
  }
  const composerFor = createTrainComposerFor({
    scratch: `${tmp}/train-scratch`,
    tokenFor: () => "fixture-token",
    remoteUrlFor: () => `file://${bare}`,
    now: options.now,
    onPreparedWorkflowReader: options.onPreparedWorkflowReader,
  });
  const byPr = new Map(members.map((m) => [m.pr, m]));
  const mergedAs = new Map<number, { sha: string; parents: string[] }>();
  const ciReads = new Set<string>();
  const heads = new Set<string>(members.map((m) => m.head));
  const red = async (sha: string) =>
    (await git(bare, "ls-tree", "--name-only", sha)).split("\n").includes(
      "broken.txt",
    );
  const world: TrainWorldV1 = {
    dir,
    bare,
    base,
    initialTip: tip,
    tip: () => tip,
    members,
    merges: [],
    ciReads,
    journal,
    ledger: async () => (await journal.read(FOREIGN_REPO))!.ledger,
    trainDeps: { journal, composerFor },
    trainRefs: async () =>
      (await git(dir, "ls-remote", bare, "refs/heads/sentinel-trains/*"))
        .split("\n").filter((line) => line.length > 0),
    surface: (fallback) => ({
      ...fallback,
      readDefaultBranch: () => Promise.resolve(FOREIGN_BRANCH),
      readBaseTip: () => Promise.resolve(tip),
      readIssueTask: (number: number) =>
        Promise.resolve(
          members.find((m) => m.issue === number)?.task ?? null,
        ),
      readPull: (number: number): Promise<HostedAutonomyPullV1 | null> => {
        const member = byPr.get(number);
        if (member === undefined) return Promise.resolve(null);
        const merged = mergedAs.get(number);
        return Promise.resolve(foreignPullFacts({
          number,
          state: merged === undefined ? "open" : "closed",
          merged: merged !== undefined,
          mergeCommitSha: merged?.sha ?? null,
          headSha: member.head,
          baseSha: base,
          parents: merged?.parents ?? [],
          mergedBy: merged === undefined ? null : "ubiquity-sentinel[bot]",
          revisionOnBaseBranch: merged !== undefined,
        }));
      },
      readCommitTree: async (sha: string) => {
        try {
          return await git(bare, "rev-parse", `${sha}^{tree}`);
        } catch {
          return null;
        }
      },
      hasAllChecksGreen: async (sha: string) => {
        if (heads.has(sha)) return true;
        ciReads.add(sha);
        const forced = world.ci?.(sha);
        if (forced !== undefined) return forced === "pending" ? false : forced;
        return !await red(sha);
      },
      failedChecks: async (sha: string) =>
        world.ci?.(sha) === "pending"
          ? []
          : await red(sha)
          ? ["unit tests"]
          : [],
      listHeadRuns: async (sha: string) => {
        const failed = await red(sha);
        const run: HostedAutonomyHeadRunV1 = {
          id: 7000 + ciReads.size,
          headSha: sha,
          status: "completed",
          conclusion: failed ? "failure" : "success",
          runAttempt: 1,
          createdAt: null,
        };
        return [run];
      },
      merge: async (number: number, head: string) => {
        const member = byPr.get(number);
        if (
          member === undefined || member.head !== head ||
          mergedAs.has(number)
        ) return null;
        // GitHub's squash: the head merged into the current tip, one parent.
        const tree = (await git(bare, "merge-tree", "--write-tree", tip, head))
          .split("\n")[0];
        const sha = await git(
          bare,
          "commit-tree",
          tree,
          "-p",
          tip,
          "-m",
          `squash #${number}`,
        );
        mergedAs.set(number, { sha, parents: [tip] });
        tip = sha;
        world.merges.push(number);
        world.onMerge?.(world.merges.length);
        return { merged: true, sha };
      },
    }),
  };
  return world;
}
