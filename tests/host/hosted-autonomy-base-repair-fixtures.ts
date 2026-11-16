/**
 * Fake GitHub targets for base-repair filing through the real maintenance
 * pass (`runHostedAutonomy`). ai.ubq.fi, uusd.ubq.fi and permit2-rpc-manager
 * each hold records on a red `development` tip, the live shape of
 * 2026-11-15. Each fake keeps what GitHub keeps: the tip, the failed checks
 * per commit, the App's pull requests (the held records' own, which the
 * runtime opened) and issues, open or closed, each with its title, first
 * body line and creation instant. A test may move the tip, close or edit an
 * issue, or break a listing the way the review did.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { RED_BASE_RECHECK_MS } from "../../src/repair/ci-first-policy.ts";
import { candidateBranch } from "../../src/repair/keys.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy-runner.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
} from "../../ops/hosted-autonomy-types.ts";
import { SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  snapshotOf,
  TransitionState,
  withDarkQueueAuthority,
} from "./hosted-autonomy-preservation-fixtures.ts";

export const NOW = T0 + 6 * 60 * 60_000;
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
export const AI = "ai.ubq.fi";
export const UUSD = "uusd.ubq.fi";
export const PERMIT2 = "permit2-rpc-manager";
export const APP = "ubiquity-sentinel[bot]";
/** Each target's red `development` tip. */
export const TIPS: Readonly<Record<string, string>> = {
  [AI]: "a1".repeat(20),
  [UUSD]: "b2".repeat(20),
  [PERMIT2]: "c3".repeat(20),
};
export const OLD_TIP = "d4".repeat(20);
export const H1 = "11".repeat(20);
export const H2 = "12".repeat(20);
export const U1 = "21".repeat(20);
export const P1 = "31".repeat(20);
export const TAG = "base-repair:ubiquity/ai.ubq.fi";
export const TITLE = "CI is failing on development";

/** The first body line of the base-repair issue of `tip`. */
export function marker(tip: string, branch = "development"): string {
  return `<!-- sentinel:base-repair:${branch}@${tip} -->`;
}
export const MARKER = marker(TIPS[AI]);

/** The pull request the runtime opened for issue `issue`. */
export const pullOf = (issue: number) => 5000 + issue;

/** The CI-first gate's red-base hold at `now`, as a live poll re-arms it. */
export function redBaseHold(now = NOW) {
  return {
    reason: "backoff",
    since: now - 60_000,
    until: now - 60_000 + RED_BASE_RECHECK_MS,
  };
}

/**
 * A record of `name` issue `issue` held on its target's red tip (or `base`)
 * at `now`, its head `head` published on `pullOf(issue)`.
 */
export function held(
  name: string,
  issue: number,
  head: string,
  options: { base?: string; now?: number } = {},
): WorkRecordV1 {
  const id = `issue-ubiquity-${name}-${issue}`;
  return workRecord(id, {
    repository: { owner: "ubiquity", name, installationId: 7 },
    source: { kind: "issue", id: String(issue), revision: SHA1 },
    related: { incidentId: null, issueNumber: issue },
    nextStep: "work",
    wait: redBaseHold(options.now),
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    target: {
      base: options.base ?? TIPS[name],
      branch: candidateBranch(id as never),
      checkpoint: null,
      head,
      pr: pullOf(issue),
    },
  });
}

export const LIVE =
  () => [held(AI, 1176, H1), held(UUSD, 40, U1), held(PERMIT2, 31, P1)];

/** One issue or pull request as GitHub holds it. */
export interface FakeItem {
  number: number;
  author: string;
  state: "open" | "closed";
  pullRequest: boolean;
  title: string;
  firstLine: string;
  createdAt: number;
}

/** An App issue: open, base-repair shaped by default, filed a day ago. */
export function appIssue(
  number: number,
  firstLine: string,
  overrides: Partial<FakeItem> = {},
): FakeItem {
  return {
    number,
    author: APP,
    state: "open",
    pullRequest: false,
    title: TITLE,
    firstLine,
    createdAt: NOW - DAY,
    ...overrides,
  };
}

/** The App's pull request `number`, opened three days before `NOW`. */
export function appPull(number: number): FakeItem {
  return appIssue(number, "", {
    pullRequest: true,
    title: `Fix #${number - 5000}`,
    createdAt: NOW - 3 * DAY,
  });
}

/** The App pull requests of `LIVE` and of a second ai.ubq.fi record. */
const PULLS: Readonly<Record<string, readonly number[]>> = {
  [AI]: [pullOf(1176), pullOf(1210)],
  [UUSD]: [pullOf(40)],
  [PERMIT2]: [pullOf(31)],
};

export type CreateMode = "ok" | "lost" | "refused" | "throws";

export interface FakeTarget {
  readonly surface: HostedAutonomyGitHubV1;
  /** Every issue and pull request GitHub holds here, any author. */
  readonly items: FakeItem[];
  /** The App-created issues (never a pull request) GitHub holds. */
  readonly issues: readonly FakeItem[];
  readonly created: { title: string; body: string }[];
  /** Every failed-check read and issue listing this target answered. */
  readonly reads: string[];
  /** The tip, the failed checks per commit and GitHub's clock: mutable. */
  tip: string;
  failed: Record<string, readonly string[] | null>;
  now: number;
  /** What the App listing answers instead of every App item (a fault). */
  appListing?: (app: FakeItem[]) => FakeItem[] | null;
  /** What the created-since listing answers instead (a fault). */
  dayListing?: (all: FakeItem[]) => FakeItem[] | null;
}

/**
 * One target's fake GitHub. A create of mode `ok` or `lost` adds the issue
 * on GitHub at its clock; `lost` answers without proof (null), `refused`
 * adds nothing and answers null, `throws` adds nothing and rejects.
 */
export function fakeTarget(
  name: string,
  options: {
    failed: Readonly<Record<string, readonly string[] | null>>;
    create?: CreateMode;
    issues?: readonly FakeItem[];
    pulls?: readonly number[];
    branch?: string;
  },
): FakeTarget {
  const items: FakeItem[] = [
    ...(options.pulls ?? PULLS[name] ?? []).map(appPull),
    ...(options.issues ?? []).map((item) => ({ ...item })),
  ];
  const created: { title: string; body: string }[] = [];
  const reads: string[] = [];
  let next = 9000;
  const target: FakeTarget = {
    items,
    get issues() {
      return items.filter((item) => item.author === APP && !item.pullRequest);
    },
    created,
    reads,
    tip: TIPS[name],
    failed: { ...options.failed },
    now: NOW,
    surface: {} as HostedAutonomyGitHubV1,
  };
  const listed = (item: FakeItem) => ({
    number: item.number,
    state: item.state,
    pullRequest: item.pullRequest,
    title: item.title,
    firstLine: item.firstLine,
    createdAt: item.createdAt,
  });
  (target as { surface: HostedAutonomyGitHubV1 }).surface = {
    readDefaultBranch: () => Promise.resolve(options.branch ?? "development"),
    readBaseTip: () => Promise.resolve(target.tip),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: () => Promise.resolve(true),
    readIssueTask: () => Promise.resolve(null),
    readIssueOptedOut: () => Promise.resolve(false),
    merge: () => Promise.reject(new Error("nothing merges in these passes")),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    failedChecks: (commit: string) => {
      reads.push(`checks:${commit}`);
      const failed = target.failed[commit];
      return Promise.resolve(failed === null ? null : [...(failed ?? [])]);
    },
    baseRepairIssues: {
      // Oldest first, as `direction=asc` pages it.
      listAppAuthored: () => {
        reads.push("issues");
        const app = items.filter((item) => item.author === APP)
          .sort((a, b) => a.createdAt - b.createdAt || a.number - b.number);
        const answer = target.appListing === undefined
          ? app
          : target.appListing(app);
        return Promise.resolve(answer === null ? null : answer.map(listed));
      },
      // Newest first, every author; one page holds them all.
      listCreatedSince: () => {
        reads.push("created_since");
        const all = [...items].sort((a, b) =>
          b.createdAt - a.createdAt || b.number - a.number
        );
        const answer = target.dayListing === undefined
          ? all
          : target.dayListing(all);
        return Promise.resolve(
          answer === null ? null : answer.map((item) => ({
            number: item.number,
            author: item.author,
            createdAt: item.createdAt,
            pullRequest: item.pullRequest,
            title: item.title,
            firstLine: item.firstLine,
          })),
        );
      },
      create: (input: { title: string; body: string }) => {
        created.push(input);
        const mode = options.create ?? "ok";
        if (mode === "throws") {
          return Promise.reject(new Error("connection reset"));
        }
        if (mode === "refused") return Promise.resolve(null);
        const number = next++;
        items.push(
          appIssue(number, input.body.split("\n")[0], {
            title: input.title,
            createdAt: target.now,
          }),
        );
        return Promise.resolve(mode === "lost" ? null : number);
      },
    },
  } as unknown as HostedAutonomyGitHubV1;
  return target;
}

/** The live shape: every target red on its tip and on its held heads. */
export function redTargets(
  ai: Partial<Parameters<typeof fakeTarget>[1]> = {},
): Record<string, FakeTarget> {
  return {
    [AI]: fakeTarget(AI, {
      failed: {
        [TIPS[AI]]: ["validate"],
        [H1]: ["validate"],
        [H2]: ["validate"],
      },
      ...ai,
    }),
    [UUSD]: fakeTarget(UUSD, {
      failed: { [TIPS[UUSD]]: ["build"], [U1]: ["build"] },
    }),
    [PERMIT2]: fakeTarget(PERMIT2, {
      failed: { [TIPS[PERMIT2]]: ["test"], [P1]: ["test"] },
    }),
  };
}

/**
 * The deps of one maintenance run at `now` over `records`, each target routed
 * to its own fake (one `githubFor` per run, as the hosted main builds it).
 */
export async function maintenanceDeps(
  records: WorkRecordV1[],
  targets: Readonly<Record<string, FakeTarget>>,
  now = NOW,
): Promise<{ deps: HostedAutonomyDepsV1; state: TransitionState }> {
  for (const target of Object.values(targets)) target.now = now;
  const state = new TransitionState(snapshotOf(records, []));
  const deps = await withDarkQueueAuthority({
    ciMinutes: INACTIVE_CI_MINUTES,
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: (repository) => targets[repository.name]?.surface ?? null,
    clock: { now: () => now },
  });
  return { deps, state };
}

/**
 * One whole maintenance pass of `deps`. Returns the pass's base-repair
 * actions and the phase progress lines it logged.
 */
export async function runMaintenance(
  deps: HostedAutonomyDepsV1,
  state: TransitionState,
) {
  const progress: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    try {
      const line = JSON.parse(String(args[0]));
      if (line?.kind === "sentinel_maintenance_progress") {
        progress.push(`${line.phase}:${line.event}`);
      }
    } catch {
      // Not a JSON line.
    }
  };
  try {
    const result = await runHostedAutonomy(deps);
    return {
      result,
      baseRepair: result.actions.filter((action) =>
        action.startsWith("base-repair:")
      ),
      progress,
      writes: state.writes,
    };
  } finally {
    console.log = log;
  }
}

/** One whole maintenance run at `now` over `records` (fresh deps). */
export async function maintain(
  records: WorkRecordV1[],
  targets: Readonly<Record<string, FakeTarget>>,
  now = NOW,
) {
  const { deps, state } = await maintenanceDeps(records, targets, now);
  return await runMaintenance(deps, state);
}
