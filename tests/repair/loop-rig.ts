/** Shared real-Git and in-memory repair-loop rigs. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import {
  createReleaseStateStore,
  createRepairStateStore,
} from "../../src/state/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { GitHubIssueV1 } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { ReleaseStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { parseRepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import type { RepositoryConfigV1 } from "../../src/contracts/repository-config.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { runRepairEntrypoint } from "../../src/main.ts";
import {
  DEP_0,
  DEP_2,
  incidentEvidence,
  incidentSummary,
  makeRemoteCtx,
  monitoredReleaseRecord,
  SHA1,
  SHA2,
  SHA3,
  T0,
  testGitEnv,
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

export const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
export const ROOT = decodeURIComponent(HERE.pathname).replace(
  /\/tests\/repair\/loop-rig\.ts$/,
  "",
);

export const FINGERPRINT = "d".repeat(64);
export const FINGERPRINT_B = "1".repeat(64);
export const EVIDENCE_ID = "inc-a";
/** Second candidate head used by the P1 correction path. */
export const SHA4 = "7f0b28dc5c6f8a1a2b3c4d5e6f7a8b9c0d1e2f3a" as GitSha;

export function summaryFixture(): ReturnType<typeof incidentSummary> {
  return incidentSummary("inc-a", {
    fingerprint: FINGERPRINT,
    severity: "P1",
    failingRevision: SHA2,
    evidenceRef: {
      ref: `artifact://inbox/${EVIDENCE_ID}.pgp`,
      digest: "e".repeat(64),
    },
  });
}

export function evidenceFixture(): ReturnType<typeof incidentEvidence> {
  return incidentEvidence("inc-a", {
    incidentId: "inc-a",
    fingerprint: FINGERPRINT,
    failingRevision: SHA2,
    replay: {
      fixtureRef: "fixture://sentinel/regression.json",
      fixtureDigest: "f".repeat(64) as never,
      upstreamCaptured: true,
      commandId: "replay_capture",
      reproducedAt: T0,
    },
  });
}

export async function makeCtx(prefix: string) {
  const tmp = await Deno.makeTempDir({
    prefix: `sentinel-repair-test-${prefix}-`,
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });
  const remote = await makeRemoteCtx(tmp, env);
  return {
    tmp,
    env,
    bare: remote.bare,
    work: remote.work,
    remoteUrl: remote.remoteUrl,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

export interface RigV1 {
  ctx: Awaited<ReturnType<typeof makeCtx>>;
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  releaseStore: ReturnType<typeof createReleaseStateStore>;
  github: FakeGithub;
  incidents: FakeIncidents;
  replay: FakeReplay;
  model: FakeModel;
  run(deadlineMs?: number): Promise<Awaited<ReturnType<typeof runRepairCycle>>>;
  entry(
    deadlineMs?: number,
  ): Promise<Awaited<ReturnType<typeof runRepairEntrypoint>>>;
  snapshot(): Promise<RepairStateSnapshotV1>;
  sequence(): Promise<number>;
  acceptRelease(requestId: string): Promise<void>;
}

export async function makeRig(
  prefix: string,
  options: {
    summaries?: boolean;
    github?: ConstructorParameters<typeof FakeGithub>[0];
    /** Exact fake port instance (e.g. one that serves native relations). */
    githubPort?: FakeGithub;
    model?: ConstructorParameters<typeof FakeModel>[0];
    replay?: ConstructorParameters<typeof FakeReplay>[0];
    incidents?: ConstructorParameters<typeof FakeIncidents>[0];
    configOverrides?: Record<string, unknown>;
    /**
     * Also configure the explicit local Sentinel scope (installationId 0), so
     * local-scope delivery records are eligible and their consumer is real.
     */
    localScope?: boolean;
    /** Run the cycle as a hosted (matrix) run does. */
    externalImplementations?: boolean;
    /** The legacy review cutoff the launcher would hand the runtime. */
    legacyReviewCutoff?: number;
  } = {},
): Promise<RigV1> {
  const ctx = await makeCtx(prefix);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${ctx.tmp}/scratch`,
    remoteUrl: ctx.remoteUrl,
  });
  const releaseStore = createReleaseStateStore({
    scratchDir: `${ctx.tmp}/release-scratch`,
    remoteUrl: ctx.remoteUrl,
  });
  const githubCooldown = new DurableGitHubCooldownGate({ state: store, clock });
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
    ...options.configOverrides,
  });
  if (options.localScope === true) {
    configs.push(localScopeConfig(configs[0]));
  }
  const budget = new RollingStartBudget({ clock, state: store, configs });
  const github = options.githubPort ??
    new FakeGithub({ baseSha: SHA1, ...options.github });
  const incidents = new FakeIncidents({
    summaries: options.summaries === false
      ? []
      : [{ ...summaryFixture(), repository: configs[0].repository }],
    evidence: options.summaries === false
      ? null
      : { ...evidenceFixture(), repository: configs[0].repository },
    ...options.incidents,
  });
  const replay = new FakeReplay(options.replay);
  const model = new FakeModel({
    head: SHA3,
    changedPaths: ["src/app.ts"],
    ...options.model,
  });
  // Positive rigs need the declared review bound (10 min) plus the five-minute
  // operation margin to fit INSIDE the loop deadline: a 10-minute caller
  // deadline leaves no review window at all. 60 minutes stays under the fixed
  // 120-minute ceiling and the 90-minute model cutoff; the clock is fake, so
  // this costs no real time.
  const run = (deadlineMs = 60 * 60_000) =>
    runRepairCycle({
      clock,
      state: store,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents,
      replay,
      model,
      budget,
      ...(options.externalImplementations === undefined
        ? {}
        : { externalImplementations: options.externalImplementations }),
      ...(options.legacyReviewCutoff === undefined
        ? {}
        : { legacyReviewCutoff: options.legacyReviewCutoff }),
    }, { deadline: clock.now() + deadlineMs, stepLimit: 16 });
  // The actual production entrypoint: the hosted receipt capability is only
  // reachable through this path, exactly as the hosted Actions host wires it.
  const entry = (deadlineMs = 60 * 60_000) =>
    runRepairEntrypoint({
      clock,
      state: store,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents,
      replay,
      model,
      budget,
      ...(options.legacyReviewCutoff === undefined
        ? {}
        : { legacyReviewCutoff: options.legacyReviewCutoff }),
    }, { deadline: clock.now() + deadlineMs, stepLimit: 16 });
  const snapshot = async () => {
    const read = await store.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  const sequence = async () => (await snapshot()).sequence;
  const acceptRelease = async (requestId: string) => {
    // Coherent accepted record bound to the exact candidate identity (SHA3).
    const releaseState: ReleaseStateSnapshotV1 = {
      version: "v1",
      kind: "release_state_snapshot",
      stateHead: null,
      sequence: 1,
      updatedAt: T0 + 2000,
      hostedRuntimes: [],
      hostedReleases: [],
      githubCooldowns: [],
      releases: [monitoredReleaseRecord("rel-1", "accepted", {
        repository: configs[0].repository,
        requestId,
        requestRevision: SHA3,
        candidate: { identity: DEP_2, buildTransactionId: "txn-rel-1" },
        observed: {
          identity: DEP_2,
          domain: "https://ai.ubq.fi",
          verified: true,
          at: T0 + 3000,
        },
        acceptance: {
          identity: DEP_2,
          windowMs: 1800000,
          sampleIntervalMs: 30000,
          continuous: true,
          baseline: [{
            identity: DEP_0,
            windowStart: T0,
            windowEnd: T0 + 30_000,
            sampledAt: T0 + 30_000,
            domain: "https://ai.ubq.fi",
            requestCount: 1000,
            fiveXxCount: 0,
            timeoutCount: 0,
            streamFailureCount: 0,
            upstreamWideFault: false,
            coverage: { status: "complete" },
          }],
          samples: [{
            identity: DEP_2,
            windowStart: T0 + 33_000 - 30_000,
            windowEnd: T0 + 33_000,
            sampledAt: T0 + 33_000,
            domain: "https://ai.ubq.fi",
            requestCount: 100,
            fiveXxCount: 0,
            timeoutCount: 0,
            streamFailureCount: 0,
            upstreamWideFault: false,
            coverage: { status: "complete" },
          }],
          thresholdResults: [{
            metric: "five_xx_rate",
            observedRate: 0,
            baselineRate: 0,
            maxRate: 0.01,
            maxIncrease: 0.01,
            passed: true,
          }],
          passed: true,
        },
      })],
    };
    const written = await releaseStore.writeRelease(releaseState, null);
    assert.ok(written.ok && written.value.status === "applied");
  };
  return {
    ctx,
    clock,
    store,
    releaseStore,
    github,
    incidents,
    replay,
    model,
    run,
    entry,
    snapshot,
    sequence,
    acceptRelease,
  };
}

/** One full open-issue fixture (the frozen GitHubIssueV1 shape). */
export function issueRecord(
  number: number,
  overrides: Partial<GitHubIssueV1> = {},
): GitHubIssueV1 {
  return {
    number,
    title: `issue ${number}`,
    body: "",
    state: "open",
    author: null,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    ...overrides,
  };
}

/**
 * Native-relation fake GitHub port. `listed` is what intake sees and `latest`
 * is what every model-admission re-read sees, so a test can change the source
 * between the intake listing and the admission read.
 */
export class RelationsFakeGithub extends FakeGithub {
  listed: GitHubIssueV1[] = [];
  latest = new Map<number, GitHubIssueV1 | null>();
  override listOpenIssues() {
    this.calls.push("listOpenIssues");
    return Promise.resolve(portOk(this.listed));
  }
  override readIssue(issueNumber: number) {
    this.calls.push(`readIssue:${issueNumber}`);
    return Promise.resolve(portOk(this.latest.get(issueNumber) ?? null));
  }
}

/**
 * Cheap in-memory issue-only loop rig: MemoryState plus fake ports. Unlike the
 * real-Git `makeRig`, no temp directory or Git command is touched.
 */
export function makeMemoryRig(github: FakeGithub) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    adapter: { kind: "github" },
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state, configs });
  const githubCooldown = new DurableGitHubCooldownGate({ state, clock });
  const incidents = new FakeIncidents({ summaries: [], evidence: null });
  const replay = new FakeReplay();
  const model = new FakeModel({
    head: SHA3,
    changedPaths: ["src/app.ts"],
  });
  const run = (stepLimit = 16) =>
    runRepairCycle({
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents,
      replay,
      model,
      budget,
    }, { deadline: clock.now() + 60 * 60_000, stepLimit });
  const snapshot = async () => {
    const read = await state.readRepair();
    assert.ok(read.ok && read.value.status === "found");
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  return { clock, state, github, model, configs, run, snapshot };
}

/** Seeded snapshot for focused delivery/merge cases (sequence 1). */
export function seededSnapshot(
  work: WorkRecordV1[],
  extra: Partial<RepairStateSnapshotV1> = {},
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
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests: [],
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
    ...extra,
  };
}

export const LOCAL_SENTINEL_REPO = {
  owner: "Ubiquity-Sentinel",
  name: "sentinel",
  installationId: 0,
} as const;

/**
 * The local scope (installationId 0) configuration: the explicit no-App local
 * credential scope uses the github adapter, so the same synthetic command
 * registry is reused with only the repository identity and adapter kind
 * changed. Built through the frozen parser, never a cast.
 */
export function localScopeConfig(
  base: RepositoryConfigV1,
): RepositoryConfigV1 {
  return parseRepositoryConfigV1({
    ...base,
    repository: LOCAL_SENTINEL_REPO,
    adapter: { kind: "github" },
  });
}
