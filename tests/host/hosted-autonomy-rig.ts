import { MemoryState } from "../repair/helpers.ts";
import { CONTROLLER } from "./controller-identity-fixture.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  PortResultV1,
  RepairStateWriter,
  StateReadResultV1,
  StateReadView,
  StateWriteResultV1,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import {
  parseReleaseStateSnapshotV1,
  parseRepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type {
  ReleaseStateSnapshotV1,
  RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { ReviewTaskStatementV1 } from "../../src/contracts/review-receipt.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import {
  runHostedAutonomy,
  runHostedAutonomyMain,
} from "../../ops/hosted-autonomy.ts";
import type {
  HostedAutonomyDepsV1,
  HostedAutonomyGitHubV1,
  HostedAutonomyPullV1,
  HostedAutonomyResultV1,
} from "../../ops/hosted-autonomy.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { ReleaseRequestV1 } from "../../src/contracts/release.ts";
import { gitRun, makeRemoteCtx, SHA1, T0 } from "../state/helpers.ts";
import { persistHostedReceipt } from "./hosted-receipt-fixture.ts";
import {
  darkQueueCoordinatorFixture,
  darkQueueFixture,
} from "./hosted-autonomy-dark-queue-fixture.ts";
import {
  authorizingReceipt,
  BASE,
  deliveryRecord,
  ENV,
  MERGE,
  pullFacts,
  taskFor,
} from "./hosted-autonomy-fixtures.ts";

/** Capture the real protected main result while retaining its native checkout gate. */
export async function captureHostedAutonomyMain(
  deps: HostedAutonomyDepsV1,
  head: string,
  runMain: typeof runHostedAutonomyMain = runHostedAutonomyMain,
): Promise<{ exit: number; result: HostedAutonomyResultV1 }> {
  let result: HostedAutonomyResultV1 | null = null;
  const originalLog = console.log;
  console.log = (...values: unknown[]) => {
    originalLog(...values);
    if (typeof values[0] !== "string") return;
    const parsed = JSON.parse(values[0]);
    if (parsed.kind === "hosted_autonomy") result = parsed;
  };
  let exit: number;
  try {
    exit = await runMain({
      env: {
        GITHUB_REPOSITORY: CONTROLLER.fullName,
        GITHUB_REF: "refs/heads/sentinel-supervisor",
        GITHUB_JOB: "maintenance",
        GITHUB_RUN_ID: "900",
        GITHUB_RUN_ATTEMPT: "1",
        GITHUB_WORKFLOW_REF: CONTROLLER.workflowRef,
        GITHUB_SHA: head,
        GITHUB_WORKFLOW_SHA: head,
        GITHUB_TOKEN: "offline-native-token",
      },
      deps,
    });
  } finally {
    console.log = originalLog;
  }
  if (result === null) {
    throw new Error("native main must report its actual disposition");
  }
  return { exit, result };
}

export function repairSnapshot(
  records: WorkRecordV1[] = [deliveryRecord()],
  reviews: unknown[] = [authorizingReceipt()],
  releaseRequests: unknown[] = [],
  reservations: unknown[] = [],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    incidents: [],
    evidence: [],
    work: records,
    reservations,
    reviews,
    replays: [],
    releaseRequests,
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

export function releaseSnapshot(
  hostedReleases: unknown[] = [],
  runtimeSha: GitSha | null = SHA1,
): ReleaseStateSnapshotV1 {
  return parseReleaseStateSnapshotV1({
    version: "v1",
    kind: "release_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T0,
    releases: [],
    hostedRuntimes: runtimeSha === null ? [] : [{
      version: "v1",
      kind: "hosted_runtime",
      id: HOSTED_RUNTIME_ID,
      activeRevision: runtimeSha,
      generation: 1,
      lastHealthyProof: null,
      lastExecutionProof: null,
      nextOrdinaryAt: T0,
      execution: null,
      createdAt: T0,
      updatedAt: T0,
    }],
    hostedReleases,
    githubCooldowns: [],
  });
}

export interface RigV1 {
  readonly tmp: string;
  readonly state: StateReadView & RepairStateWriter;
  /**
   * Per-repository surface resolver. The default returns the one fake surface
   * for every identity; a test that exercises routing replaces it.
   */
  githubFor: (
    repository: RepositoryIdentityV1,
  ) => HostedAutonomyGitHubV1 | null;
  writes: number;
  merges: number;
  closed: number[];
}

/** Minimal valid healthy candidate proof for an accepted hosted release. */
export function healthyProof(
  revision: string,
  generation: number,
  releaseId: string,
  purpose: "prior" | "candidate" = "candidate",
) {
  return {
    execution: {
      id: "35273273110:1:repair",
      runId: 35273273110,
      runAttempt: 1,
      launcherSha: SHA1,
      purpose,
      revision,
      generation,
      releaseId,
      createdAt: T0 + 3000,
    },
    workflowId: CONTROLLER.workflowId,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: CONTROLLER.fullName,
    ref: "refs/heads/sentinel-supervisor",
    jobId: 1,
    startedAt: T0 + 3100,
    finishedAt: T0 + 3200,
    observedAt: T0 + 3300,
    outcome: "healthy" as const,
    startupReady: true,
    settled: true,
    baseSha: BASE,
    terminalAt: T0 + 3200,
    logDigest: "d".repeat(64),
  };
}

/**
 * Test-local adapter over the shared MemoryState. The historical rigs persist
 * ONLY their repair half through this adapter: it keeps the real store's
 * expected-head CAS, snapshot validation and sequence/time rules, answers with
 * a promise like the real store, and hands out/accepts independent copies so no
 * consumer can mutate the fixture's authoritative snapshot in place. It is
 * deliberately repair-only (MemoryState also lacks the real store's
 * validateRepairTransition parity); the explicit small real-Git recovery plus
 * sibling case proves connected persistence transitions. Release reads never
 * come from here; the real Git release store stays authoritative.
 */
export class CopyingRepairState
  implements Pick<StateReadView, "readRepair">, RepairStateWriter {
  private readonly inner = new MemoryState();

  async readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    const read = await this.inner.readRepair();
    if (!read.ok || read.value.status !== "found") return read;
    return portOk({
      ...read.value,
      snapshot: structuredClone(read.value.snapshot),
    });
  }

  async writeRepair(
    next: RepairStateSnapshotV1,
    expectedHead: GitSha | null,
  ): Promise<PortResultV1<StateWriteResultV1>> {
    // The real store rejects a snapshot whose stateHead is not the expected
    // remote head before any transition check; MemoryState omits that check, so
    // this adapter applies it with the identical typed diagnostic.
    if (next.stateHead !== expectedHead) {
      return portError(
        "invalid",
        "snapshot stateHead must equal the expected remote head",
      );
    }
    return await this.inner.writeRepair(
      structuredClone(next),
      expectedHead,
    );
  }
}

/**
 * Test-local read-through view of immutable snapshots from the REAL Git store.
 * Every read first proves the actual current authoritative remote head with a
 * cheap native `git ls-remote` against the fixture's own real bare remote, and
 * returns the cloned cached snapshot only when that fresh head exactly equals
 * the head the cached full read observed. Otherwise it reads the real store and
 * caches that actual snapshot/head. A ref-read error, malformed/missing
 * identity or a moved head always falls through to the real read, so a stale
 * cache is never returned; writes and readReleaseAt stay fully real/uncached.
 */
function snapshotReadThrough<T>(
  delegate: () => Promise<PortResultV1<StateReadResultV1<T>>>,
  remoteUrl: string,
  ref: string,
): () => Promise<PortResultV1<StateReadResultV1<T>>> {
  let cached: {
    head: GitSha;
    value: Awaited<ReturnType<typeof delegate>>;
  } | null = null;
  return async () => {
    const probe = await gitRun(
      remoteUrl,
      ["ls-remote", remoteUrl, ref],
      ENV,
    );
    const nativeHead = probe.ok
      ? (probe.stdout.trim().split(/\s+/)[0] ?? "")
      : "";
    const proven = /^[0-9a-f]{40}$/.test(nativeHead)
      ? nativeHead as GitSha
      : null;
    if (proven !== null && cached !== null && cached.head === proven) {
      return structuredClone(cached.value);
    }
    const read = await delegate();
    if (
      proven !== null && read.ok && read.value.status === "found" &&
      read.value.head === proven
    ) {
      cached = { head: proven, value: structuredClone(read) };
    }
    return read;
  };
}

export function releaseReadThrough(
  delegate: StateReadView["readRelease"],
  remoteUrl: string,
): StateReadView["readRelease"] {
  return snapshotReadThrough(
    delegate,
    remoteUrl,
    "refs/heads/sentinel-state/release",
  );
}

/** Real repair writes and every fresh native head probe remain uncached. */
export function repairReadThrough(
  delegate: StateReadView["readRepair"],
  remoteUrl: string,
): StateReadView["readRepair"] {
  return snapshotReadThrough(
    delegate,
    remoteUrl,
    "refs/heads/sentinel-state/repair",
  );
}

export async function makeRig(
  prefix: string,
  options: {
    repair?: RepairStateSnapshotV1;
    /**
     * Test-local repair persistence override. When present it replaces only the
     * repair half (memory CAS); the release store and every release read stay
     * the real Git authority.
     */
    repairState?: Pick<StateReadView, "readRepair"> & RepairStateWriter;
    /**
     * Multiwave rigs only: compose the read-through release view here, so the
     * returned rig value stays immutable and every other closure keeps binding
     * the same instance.
     */
    releaseReadThrough?: boolean;
    /** Cache only immutable snapshots after a fresh exact repair-ref read. */
    repairReadThrough?: boolean;
    /** Scoped archive fixtures use the repository's existing CI read scope. */
    fixtureDir?: string;
    release?: ReleaseStateSnapshotV1;
    pull?: HostedAutonomyPullV1 | null;
    baseTip?: string | null;
    /** Per-branch tip override; absent means `baseTip` for every branch. */
    branchTip?: (branch: string) => string | null;
    checkGreen?: boolean;
    foreignCheckGreen?: boolean;
    defaultBranch?: string | null;
    issueOpen?: boolean | null;
    /** Trusted source-issue statement override, e.g. for body drift. */
    issueTask?: (
      number: number,
    ) => Promise<ReviewTaskStatementV1 | null>;
    mergeResult?: { merged: boolean; sha: string | null } | null;
    afterMerge?: HostedAutonomyPullV1 | null;
    resolver?: (
      repository: RepositoryIdentityV1,
    ) => HostedAutonomyGitHubV1 | null;
    /**
     * Drive the REAL release store to an accepted receipt for this exact
     * reviewed request through the shared legal-lifecycle fixture; no phase,
     * proof or pointer intent is ever hand-written into the store.
     */
    hostedReceipt?: {
      request: ReleaseRequestV1;
      priorRevision: GitSha;
    };
  } = {},
): Promise<{ rig: RigV1; github: HostedAutonomyGitHubV1 }> {
  if (options.repairReadThrough && options.repairState !== undefined) {
    throw new Error("repair read-through requires the real Git state store");
  }
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-${prefix}-`,
    dir: options.fixtureDir,
  });
  const ctx = await makeRemoteCtx(tmp, ENV);
  const repair = createRepairStateStore({
    scratchDir: `${tmp}/repair`,
    remoteUrl: ctx.remoteUrl,
  });
  const release = createReleaseStateStore({
    scratchDir: `${tmp}/release`,
    remoteUrl: ctx.remoteUrl,
  });
  // Historical fixtures persist their repair TRANSITIONS in memory with the real
  // store's CAS/sequence/validation rules so the six legacy cases fit their
  // bounded window; the release half stays the real Git store, so every
  // readRelease/readReleaseAt authority and custody gate is unchanged.
  const seedSnapshot = options.repair ?? repairSnapshot();
  // The real repair branch is ALWAYS initialized with that exact seed: the
  // fixture's real checkout/clone, native launcher identity and source paths
  // bind to this honest commit, never to a fabricated one.
  const realSeed = await repair.writeRepair(seedSnapshot, null);
  if (!realSeed.ok || realSeed.value.status !== "applied") {
    throw new Error(
      `repair fixture seed failed: ${JSON.stringify(realSeed)}`,
    );
  }
  const repairState: Pick<StateReadView, "readRepair"> & RepairStateWriter =
    options.repairState ?? repair;
  const repairSeed = options.repairState === undefined
    ? realSeed
    : await repairState.writeRepair(seedSnapshot, null);
  if (!repairSeed.ok || repairSeed.value.status !== "applied") {
    throw new Error(
      `repair fixture seed failed: ${JSON.stringify(repairSeed)}`,
    );
  }
  const releaseSeed = await release.writeRelease(
    options.release ?? releaseSnapshot(),
    null,
  );
  if (!releaseSeed.ok || releaseSeed.value.status !== "applied") {
    throw new Error(
      `release fixture seed failed: ${JSON.stringify(releaseSeed)}`,
    );
  }
  if (options.hostedReceipt !== undefined) {
    // The shared fixture runs the ACTUAL supervisor core over this same real
    // release store until it persists `accepted`, so the consumers below read
    // a genuinely reachable receipt instead of a hand-written phase.
    let receiptNow = T0;
    await persistHostedReceipt({
      release,
      clock: {
        now: () => receiptNow,
        advance: (ms: number) => {
          receiptNow += ms;
        },
      },
      request: options.hostedReceipt.request,
      priorRevision: options.hostedReceipt.priorRevision,
      phase: "accepted",
    });
  }
  const realReadRelease = () => release.readRelease();
  const rig: RigV1 = {
    tmp,
    state: {
      readRepair: options.repairReadThrough
        ? repairReadThrough(() => repairState.readRepair(), ctx.remoteUrl)
        : () => repairState.readRepair(),
      readRelease: options.releaseReadThrough
        ? releaseReadThrough(realReadRelease, `${tmp}/remote.git`)
        : realReadRelease,
      readReleaseAt: (input: { commit: GitSha; expectedHead: GitSha }) =>
        release.readReleaseAt!(input),
      writeRepair: (
        next: RepairStateSnapshotV1,
        expectedHead: GitSha | null,
      ) => {
        rig.writes++;
        return repairState.writeRepair(next, expectedHead);
      },
    } as unknown as StateReadView & RepairStateWriter,
    githubFor: () => github,
    writes: 0,
    merges: 0,
    closed: [],
  };
  let mergedNow = false;
  const github: HostedAutonomyGitHubV1 = {
    readDefaultBranch: () =>
      Promise.resolve(
        options.defaultBranch === undefined ? "main" : options.defaultBranch,
      ),
    readBaseTip: (branch: string): Promise<string | null> => {
      if (options.branchTip !== undefined) {
        return Promise.resolve(options.branchTip(branch));
      }
      const tip = options.baseTip === undefined ? BASE : options.baseTip;
      return Promise.resolve(tip);
    },
    hasSuccessfulCheck: () => Promise.resolve(options.checkGreen ?? true),
    hasAllChecksGreen: () => Promise.resolve(options.foreignCheckGreen ?? true),
    readPull: () =>
      Promise.resolve(
        mergedNow && options.afterMerge !== undefined
          ? options.afterMerge
          : options.pull === undefined
          ? pullFacts()
          : options.pull,
      ),
    closeIssue: (number: number) => {
      rig.closed.push(number);
      return Promise.resolve(true);
    },
    readIssueOpen: () =>
      Promise.resolve(
        options.issueOpen === undefined ? true : options.issueOpen,
      ),
    readIssueTask: (number: number) =>
      Promise.resolve(
        options.issueTask === undefined
          ? taskFor(number)
          : options.issueTask(number),
      ),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(true),
    merge: () => {
      rig.merges++;
      mergedNow = true;
      const result = options.mergeResult === undefined
        ? { merged: true, sha: MERGE }
        : options.mergeResult;
      return Promise.resolve(result);
    },
  };
  if (options.resolver !== undefined) rig.githubFor = options.resolver;
  return { rig, github };
}

export async function run(
  rig: RigV1,
  github?: HostedAutonomyGitHubV1,
): Promise<HostedAutonomyResultV1> {
  return await runHostedAutonomy({
    state: rig.state,
    githubFor: github === undefined ? rig.githubFor : () => github,
    queueCustody: darkQueueFixture(
      github === undefined ? rig : { ...rig, githubFor: () => github },
    ),
    queue: await darkQueueCoordinatorFixture(
      github === undefined ? rig : { ...rig, githubFor: () => github },
    ),
    clock: { now: () => T0 + 5_000_000 },
  });
}

export async function readRequests(rig: RigV1) {
  const read = await rig.state.readRepair();
  if (!read.ok || read.value.status !== "found") throw new Error("unreadable");
  return read.value.snapshot.releaseRequests;
}
