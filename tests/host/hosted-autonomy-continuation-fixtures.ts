/**
 * Shared fixtures for one maintenance pass that continues after a write: a
 * conflict-parked ai.ubq.fi candidate the retry pass re-admits, a reviewed
 * self delivery the delivery pass merges and records, and a closed-issue
 * record the closure pass retires. Repair state is the expected-head CAS
 * store with the real snapshot and transition rules (`TransitionState`),
 * recording every write it accepts.
 */
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import {
  parseRepairStateSnapshotV1,
  type ReleaseStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type {
  PortResultV1,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy.ts";
import { runHostedAutonomyMain } from "../../ops/hosted-autonomy.ts";
import type { HostedRefreshRearmRuntimeV1 } from "../../ops/hosted-autonomy-types.ts";
import {
  gitRun,
  REPO,
  SHA1,
  SHA2,
  SHA3,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  assertGen78Parses,
  gen77Available,
  gen78Available,
  loadGen77Modules,
  loadGen78Modules,
} from "../state/gen77-contracts.ts";
import { scanChildStatusRecords } from "../../src/host/hosted-runtime-status.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  ENV,
  HEAD,
  MERGE,
  pullFacts,
  SELF_REPO,
  taskFor,
} from "./hosted-autonomy-fixtures.ts";
import {
  releaseAt,
  TransitionState,
} from "./hosted-autonomy-preservation-fixtures.ts";

const ROOT = decodeURIComponent(new URL("../..", import.meta.url).pathname)
  .replace(/\/$/, "");

export const HOUR = 60 * 60 * 1000;
export const NOW = T0 + 6 * HOUR;
/** The pinned generation-79 conflict-resolution runtime of these fixtures. */
export const OPENER = "9".repeat(40) as GitSha;
export const PIN: HostedRefreshRearmRuntimeV1[] = [
  { revision: OPENER, activatedNotBefore: T0 + HOUR },
];
export const CONFLICT = "issue-ubiquity-ai.ubq.fi-640";
export const GONE = "issue-ubiquity-ai.ubq.fi-641";
export const CONFLICT_BRANCH = candidateBranch(CONFLICT as never);
export const SELF_ID = deliveryRecord().id as string;

/** One gen-79 release whose healthy proof is also its last settled one. */
export function release79(): ReleaseStateSnapshotV1 {
  return releaseAt({
    revision: OPENER,
    generation: 79,
    healthy: {
      revision: OPENER,
      generation: 79,
      createdAt: T0 + 2 * HOUR,
      observedAt: T0 + 3 * HOUR,
    },
  });
}

/** A published candidate parked on a refresh conflict before the pin. */
export async function conflictBlocked(
  repository: RepositoryIdentityV1 = REPO,
): Promise<WorkRecordV1> {
  const operationKey = implementationIntentKey("ef".repeat(32));
  return workRecord(CONFLICT, {
    repository,
    source: { kind: "issue", id: "640", revision: SHA1 },
    related: { incidentId: null, issueNumber: 640 },
    nextStep: "blocked",
    blocker: {
      kind: "other",
      message: `base refresh has conflicts at ${SHA3}`,
      since: T0,
    },
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    target: {
      base: SHA1,
      branch: CONFLICT_BRANCH,
      checkpoint: null,
      head: SHA2,
      pr: null,
      candidateState: {
        preserved: {
          operationKey,
          base: SHA1,
          head: SHA2,
          ref: await candidatePreservationRef(
            repository,
            CONFLICT as never,
            operationKey,
          ),
        },
        publishedHead: SHA2,
      },
    },
  });
}

/** A live record whose source issue (641) is closed: the closure retires it. */
export function goneRecord(): WorkRecordV1 {
  return workRecord(GONE, {
    source: { kind: "issue", id: "641", revision: SHA1 },
    related: { incidentId: null, issueNumber: 641 },
    nextStep: "work",
  });
}

export function snapshotWith(
  records: WorkRecordV1[],
  reservations: unknown[] = [],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 5,
    updatedAt: T0 + 1000,
    incidents: [],
    evidence: [],
    work: [...records].sort((a, b) => a.id < b.id ? -1 : 1),
    reservations,
    reviews: [authorizingReceipt()],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

export interface WriteLogV1 {
  expected: GitSha | null;
  prior: RepairStateSnapshotV1;
  next: RepairStateSnapshotV1;
  status: "applied" | "conflict";
  head: GitSha;
}

/**
 * The CAS store recording each write it accepted or refused, with the head
 * and snapshot it built on, and every repair read after the last write.
 */
export class RecordingState extends TransitionState {
  readonly log: WriteLogV1[] = [];
  readsSinceWrite = 0;
  /** Forced outcome for the n-th write call (1-based), before any check. */
  refuse = new Set<number>();
  /** Moves the head as a foreign writer would, on the n-th read after a write. */
  moveHeadOnRead: number | null = null;
  constructor(snapshot: RepairStateSnapshotV1) {
    super(snapshot, release79());
  }
  override readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    this.readsSinceWrite++;
    if (this.writes > 0 && this.readsSinceWrite === this.moveHeadOnRead) {
      this.head = "f".repeat(40) as GitSha;
    }
    return super.readRepair();
  }
  override async writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    const prior = structuredClone(this.snapshot);
    this.readsSinceWrite = 0;
    if (this.refuse.has(this.writes + 1)) {
      this.writes++;
      this.log.push({
        expected: expectedHead,
        prior,
        next: structuredClone(next),
        status: "conflict",
        head: this.head,
      });
      return {
        ok: true,
        value: { status: "conflict", currentHead: this.head },
      };
    }
    const result = await super.writeRepair(next, expectedHead);
    this.log.push({
      expected: expectedHead,
      prior,
      next: structuredClone(next),
      status: result.ok && result.value.status === "applied"
        ? "applied"
        : "conflict",
      head: this.head,
    });
    return result;
  }
}

export interface SurfacesV1 {
  githubFor: (repository: RepositoryIdentityV1) => HostedAutonomyGitHubV1;
  /** The write count the store held at each merge. */
  merges: number[];
  /** Every self-surface call made by the delivery pass's approval loop. */
  approvals: number;
  closed: number[];
}

/**
 * The self surface delivers the reviewed sentinel head end to end; the
 * ai.ubq.fi surface proves the conflict candidate's open pull and branch.
 */
export function surfaces(
  state: { writes: number },
  options: {
    checkGreen?: boolean;
    /** Thrown from the trusted issue read once the store took a write. */
    throwAfterWrite?: () => Error;
  } = {},
): SurfacesV1 {
  const out: SurfacesV1 = {
    githubFor: () => {
      throw new Error("unrouted");
    },
    merges: [],
    approvals: 0,
    closed: [],
  };
  let merged = false;
  const self = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: () => Promise.resolve(BASE),
    hasSuccessfulCheck: () => Promise.resolve(options.checkGreen ?? true),
    hasAllChecksGreen: () => Promise.resolve(options.checkGreen ?? true),
    readPull: () =>
      Promise.resolve(
        merged ? pullFacts() : pullFacts({
          state: "open",
          merged: false,
          mergeCommitSha: null,
        }),
      ),
    get readIssueTask() {
      if (options.throwAfterWrite && state.writes > 0) {
        throw options.throwAfterWrite();
      }
      return (number: number) => Promise.resolve(taskFor(number));
    },
    readIssueOpen: () => Promise.resolve(true),
    closeIssue: (number: number) => {
      out.closed.push(number);
      return Promise.resolve(true);
    },
    listParkedRuns: () => {
      out.approvals++;
      return Promise.resolve([]);
    },
    approveRun: () => Promise.resolve(false),
    merge: () => {
      out.merges.push(state.writes);
      merged = true;
      return Promise.resolve({ merged: true, sha: MERGE });
    },
  } as unknown as HostedAutonomyGitHubV1;
  const gateway = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: (branch: string) =>
      Promise.resolve(
        branch === "development"
          ? SHA3
          : branch === CONFLICT_BRANCH
          ? SHA2
          : null,
      ),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: (number: number) => Promise.resolve(number !== 641),
    readIssueTask: () => Promise.resolve(null),
    merge: () => {
      throw new Error("the gateway candidate is never merged here");
    },
    closeIssue: (number: number) => {
      out.closed.push(number);
      return Promise.resolve(false);
    },
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
    listPullsByHeadRef: () =>
      Promise.resolve([{
        number: 1012,
        state: "open",
        merged: false,
        headSha: SHA2,
        headRef: CONFLICT_BRANCH,
        baseRef: "development",
        author: "ubiquity-sentinel[bot]",
      }]),
  } as unknown as HostedAutonomyGitHubV1;
  out.githubFor = (repository) =>
    repository.name === SELF_REPO.name ? self : gateway;
  return out;
}

/** The pass's own deps over one store and one pair of surfaces. */
export async function passDeps(
  state: RecordingState,
  github: SurfacesV1,
  now: () => number = () => NOW,
): Promise<HostedAutonomyDepsV1> {
  return await withDarkQueueAuthority({
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: github.githubFor,
    clock: { now },
    conflictResolutionRuntimes: PIN,
  });
}

/** The applied CAS chain: each write expects exactly the head before it. */
export function assertCasChain(log: readonly WriteLogV1[], initial: GitSha) {
  let head = initial;
  for (const [index, write] of log.entries()) {
    assert.equal(write.expected, head, `write ${index} expected head`);
    assert.equal(write.next.stateHead, head, `write ${index} stateHead`);
    if (write.status === "applied") head = write.head;
  }
}

/** Every applied write also parses and validates under R78 when present. */
export async function assertRollbackReads(log: readonly WriteLogV1[]) {
  if (!await gen78Available()) return;
  const loaded = await loadGen78Modules([
    "src/state/state-repair-transition.ts",
  ]);
  try {
    const [transition] = loaded.modules as [{
      validateRepairTransition(
        prior: RepairStateSnapshotV1,
        next: RepairStateSnapshotV1,
      ): string | null;
    }];
    for (const write of log.filter((row) => row.status === "applied")) {
      await assertGen78Parses(write.next);
      assert.equal(
        transition.validateRepairTransition(
          JSON.parse(JSON.stringify(write.prior)),
          JSON.parse(JSON.stringify(write.next)),
        ),
        null,
      );
    }
  } finally {
    await loaded.dispose();
  }
}

/**
 * The real protected main over a clean throwaway checkout: every stdout line
 * it printed, parsed, and its exit code.
 */
export async function captureMain(
  deps: HostedAutonomyDepsV1,
  runMain: typeof runHostedAutonomyMain = runHostedAutonomyMain,
): Promise<{ exit: number; lines: Record<string, unknown>[] }> {
  // Inside the repository: the CI test tier reads only `.`, /usr and /bin.
  const checkout = await Deno.makeTempDir({
    prefix: "sentinel-continue-",
    dir: ROOT,
  });
  const previous = Deno.cwd();
  const original = console.log;
  const lines: Record<string, unknown>[] = [];
  try {
    for (
      const args of [
        ["init", "-q"],
        ["commit", "-q", "--allow-empty", "-m", "launcher"],
      ]
    ) assert.ok((await gitRun(checkout, args, ENV)).ok);
    const head = await gitRun(checkout, ["rev-parse", "HEAD"], ENV);
    assert.ok(head.ok);
    Deno.chdir(checkout);
    console.log = (...values: unknown[]) => {
      lines.push(JSON.parse(String(values[0])));
    };
    const sha = head.stdout.trim();
    const exit = await runMain({
      env: {
        GITHUB_REPOSITORY: "ubiquity/sentinel",
        GITHUB_REF: "refs/heads/sentinel-supervisor",
        GITHUB_JOB: "maintenance",
        GITHUB_RUN_ID: "900",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW_REF:
          "ubiquity/sentinel/.github/workflows/supervisor.yml@refs/heads/sentinel-supervisor",
        GITHUB_SHA: sha,
        GITHUB_WORKFLOW_SHA: sha,
        GITHUB_TOKEN: "offline-native-token",
      },
      deps,
    });
    return { exit, lines };
  } finally {
    console.log = original;
    Deno.chdir(previous);
    await Deno.remove(checkout, { recursive: true });
  }
}

/** The one `hosted_autonomy` result line main printed. */
export function resultLine(
  lines: readonly Record<string, unknown>[],
): HostedAutonomyResultV1 {
  const results = lines.filter((line) => line.kind === "hosted_autonomy");
  assert.equal(results.length, 1, JSON.stringify(lines));
  return results[0] as unknown as HostedAutonomyResultV1;
}

/**
 * The launcher's (R79's) status scanner, and R78's and R77's own when their
 * trees are present, each find exactly the one result record in the pass's
 * stdout: every other line carries no `status` key.
 */
export async function assertStatusScans(
  lines: readonly Record<string, unknown>[],
): Promise<void> {
  const stdout = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
  type Scan = (stdout: string) => { kind: string; value?: unknown };
  const scans: Scan[] = [scanChildStatusRecords];
  const loaded = [];
  if (await gen78Available()) {
    loaded.push(await loadGen78Modules(["src/host/hosted-runtime-status.ts"]));
  }
  if (await gen77Available()) {
    loaded.push(await loadGen77Modules(["src/host/hosted-runtime-status.ts"]));
  }
  try {
    for (const tree of loaded) {
      scans.push(
        (tree.modules[0] as { scanChildStatusRecords: Scan })
          .scanChildStatusRecords,
      );
    }
    for (const scan of scans) {
      const found = scan(stdout);
      assert.equal(found.kind, "one");
      assert.equal(
        (found.value as { kind?: unknown }).kind,
        "hosted_autonomy",
      );
    }
  } finally {
    for (const tree of loaded) await tree.dispose();
  }
}

export { BASE, HEAD, MERGE, SELF_REPO, SHA1, SHA2, T0 };
