/** Temporary matrix runtime model, Git, budget and state fixtures; no test registrations. */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
} from "../../src/contracts/matrix.ts";
import type {
  GitHubIssueV1,
  ImplementationPort,
  ModelRunReceiptV1,
  ModelRunRequestV1,
  PortResultV1,
} from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop.ts";
import { createRunBounds } from "../../src/repair/loop.ts";
import type {
  MatrixIngestOptionsV1,
  MatrixPlanOptionsV1,
} from "../../src/host/matrix.ts";
import {
  createGitBundleExporter,
  createGitBundleImporter,
  type MatrixBundleExporterV1,
} from "../../src/host/matrix-git.ts";
import { scopeLocalRepairIssues } from "../../src/host/local.ts";
import { createRepairStateStore } from "../../src/state/mod.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeReplay,
  repairConfigs,
} from "../repair/helpers.ts";
import {
  gitRun,
  makeRemoteCtx,
  SHA2,
  T0,
  testGitEnv,
  workRecord,
} from "../state/helpers.ts";

export const HERE = new URL(import.meta.url);
if (HERE.protocol !== "file:") throw new Error("expected a file: test module");
export const ROOT = decodeURIComponent(
  new URL("../../", import.meta.url).pathname,
).replace(/\/$/, "");

export const WAVE = "wave-test-1";
export const LAUNCHER = "1".repeat(40) as GitSha;
export const RUN = { runId: 41, runAttempt: 1, launcherSha: LAUNCHER };
export const ACTUAL = { run: RUN, runtimeSha: LAUNCHER, generation: 1 };
export const PROVIDER = "sentinel-host";

export const DEADLINE = T0 + 60 * 60_000;

export function issueRow(number: number): GitHubIssueV1 {
  return {
    number,
    title: `matrix issue ${number}`,
    body: `body ${number}`,
    state: "open",
    author: null,
    labels: [],
    createdAt: T0 - 10_000,
    updatedAt: T0 - 10_000,
    closedAt: null,
    relations: { openBlockers: [], subIssueCount: 0 },
  };
}

export class ListedGithub extends FakeGithub {
  listed: GitHubIssueV1[] = [];
  latest = new Map<number, GitHubIssueV1 | null>();

  override listOpenIssues(): Promise<PortResultV1<GitHubIssueV1[]>> {
    this.calls.push("listOpenIssues");
    return Promise.resolve(portOk(this.listed));
  }

  override readIssue(
    issueNumber: number,
  ): Promise<PortResultV1<GitHubIssueV1 | null>> {
    this.calls.push(`readIssue:${issueNumber}`);
    return Promise.resolve(portOk(this.latest.get(issueNumber) ?? null));
  }
}

/** One model port per cell repository; holds calls until `target` overlap. */
export class OverlappingModel implements ImplementationPort {
  readonly modelId = "gpt-reserve";
  readonly requests: ModelRunRequestV1[] = [];
  active = 0;
  maxActive = 0;
  private release: (() => void) | null = null;
  private readonly gate: Promise<void>;

  constructor(
    private readonly target: number,
    private readonly repos: Map<string, string>,
    private readonly env: Record<string, string>,
  ) {
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    this.requests.push(request);
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.active >= this.target && this.release !== null) {
      this.release();
      this.release = null;
    }
    await this.gate;
    this.active--;
    const repo = this.repos.get(request.taskId);
    if (repo === undefined) throw new Error("no cell repository for task");
    const index = this.requests.length;
    await Deno.writeTextFile(`${repo}/candidate-${index}.txt`, `candidate\n`);
    assert.ok((await gitRun(repo, ["add", "-A"], this.env)).ok);
    const committed = await gitRun(
      repo,
      ["commit", "-q", "-m", `candidate ${index}`],
      this.env,
    );
    assert.ok(committed.ok, committed.stderr);
    const rev = await gitRun(repo, ["rev-parse", "HEAD"], this.env);
    assert.ok(rev.ok, rev.stderr);
    const head = rev.stdout.trim() as GitSha;
    return portOk({
      invocationId: `matrix-invoke-${index}`,
      outcome: "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: PROVIDER,
        threadId: `thread-${index}`,
        turnId: `turn-${index}`,
        terminalOrigin: "runtime",
        observedTerminalStatus: "completed",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
        durationMs: 100,
        outputChars: 500,
      },
      candidate: {
        head,
        checkpointSha: null,
        changedPaths: [`candidate-${index}.txt`],
      },
      error: null,
    });
  }
}

export interface CellContextV1 {
  cell: MatrixCellPlanV1;
  repositoryDir: string;
  deps: {
    clock: FakeClock;
    bounds: { runDeadline: number; modelCutoff: number };
    sessionBound: { maxDurationMs: number; maxOutputChars: number };
    state: RigV1["store"];
    github: ListedGithub;
    model: OverlappingModel;
    bundle: MatrixBundleExporterV1;
  };
  bundlesDir: string;
}

export interface RigV1 {
  clock: FakeClock;
  store: ReturnType<typeof createRepairStateStore>;
  github: ListedGithub;
  model: OverlappingModel;
  deps: RepairCycleDepsV1;
  base: GitSha;
  mirrorRepo: string;
  mirrorBundles: string;
  env: Record<string, string>;
  tmp: string;
  planOptions(): MatrixPlanOptionsV1;
  ingestOptions(): MatrixIngestOptionsV1;
  claimCell(cell: MatrixCellPlanV1): Promise<CellContextV1>;
  transfer(
    results: readonly MatrixCellResultV1[],
    ctxs: readonly CellContextV1[],
  ): Promise<void>;
  objectPresent(sha: GitSha): Promise<boolean>;
  cleanup(): Promise<void>;
}

export function seedSnapshot(work: WorkRecordV1[]): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
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
  });
}

export function freshIssue(number: number, base: GitSha): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: base },
    related: { incidentId: null, issueNumber: number },
    target: {
      base,
      branch: `sentinel/repair/issue-${number}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
    firstSeenAt: T0 - 60_000,
  });
}

export function parkedNonReady(
  number: number,
  step: "review" | "delivery",
  base: GitSha,
): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: base },
    related: { incidentId: null, issueNumber: number },
    target: {
      base,
      branch: `sentinel/repair/issue-${number}`,
      checkpoint: null,
      head: SHA2,
      pr: 7,
    },
    nextStep: step,
    wait: null,
    firstSeenAt: T0 - 70_000,
  });
}

export function activeIntent(
  number: number,
  reservationId: string,
  base: GitSha,
): WorkRecordV1 {
  return workRecord(`issue-${number}`, {
    source: { kind: "issue", id: String(number), revision: base },
    related: { incidentId: null, issueNumber: number },
    target: {
      base,
      branch: `sentinel/repair/issue-${number}`,
      checkpoint: null,
      head: null,
      pr: null,
    },
    nextStep: "work",
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(reservationId),
      startedAt: T0,
      branch: `sentinel/repair/issue-${number}`,
      expectedHead: null,
      observedBase: base,
      pr: null,
      requestId: reservationId,
      resultId: null,
    },
  });
}

export async function makeRig(
  issueNumbers: number[],
  overlap: number,
  sessionBound = { maxDurationMs: 240_000, maxOutputChars: 200_000 },
): Promise<RigV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-matrix-runtime-",
    dir: ROOT,
  });
  const env = testGitEnv(`${tmp}/git-home`);
  await Deno.mkdir(`${tmp}/git-home`, { recursive: true });

  // A distinct trusted ingester mirror with the planned base commit; every
  // cell gets its own clone (its own isolated checkout).
  const mirrorRepo = `${tmp}/mirror`;
  await Deno.mkdir(mirrorRepo, { recursive: true });
  assert.ok((await gitRun(mirrorRepo, ["init", "-q"], env)).ok);
  await Deno.writeTextFile(`${mirrorRepo}/base.txt`, "base\n");
  assert.ok((await gitRun(mirrorRepo, ["add", "-A"], env)).ok);
  assert.ok((await gitRun(mirrorRepo, ["commit", "-q", "-m", "base"], env)).ok);
  const baseRev = await gitRun(mirrorRepo, ["rev-parse", "HEAD"], env);
  assert.ok(baseRev.ok, baseRev.stderr);
  const base = baseRev.stdout.trim() as GitSha;
  const mirrorBundles = `${tmp}/mirror-bundles`;
  await Deno.mkdir(mirrorBundles, { recursive: true });

  const github = new ListedGithub({
    baseSha: base,
    // The trusted preservation capability the real host composes: a completed
    // candidate becomes durable before publication. Without it the records
    // park on the preservation wait and never publish.
    candidateLifecycle: {
      preserveCandidate: () => Promise.resolve(portOk(undefined)),
    },
  });
  scopeLocalRepairIssues(github);
  for (const number of issueNumbers) {
    const row = issueRow(number);
    github.listed.push(row);
    github.latest.set(number, row);
  }
  const remote = await makeRemoteCtx(tmp, env);
  const clock = new FakeClock(T0);
  const store = createRepairStateStore({
    scratchDir: `${tmp}/scratch`,
    remoteUrl: remote.remoteUrl,
  });
  const configs = repairConfigs({
    adapter: { kind: "github" },
    liveStartLimits: { perHour: null, perSevenDays: null },
    sessionBound,
  });
  const budget = new RollingStartBudget({ clock, state: store, configs });
  const githubCooldown = new DurableGitHubCooldownGate({ state: store, clock });
  const repos = new Map<string, string>();
  let claimCounter = 0;
  const model = new OverlappingModel(overlap, repos, env);
  const deps: RepairCycleDepsV1 = {
    clock,
    state: store,
    configs,
    controllerSha: LAUNCHER,
    github,
    githubCooldown,
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model,
    budget,
  };
  const importer = createGitBundleImporter({
    repositoryDir: mirrorRepo,
    bundlesDir: mirrorBundles,
  });
  return {
    clock,
    store,
    github,
    model,
    deps,
    base,
    mirrorRepo,
    mirrorBundles,
    env,
    tmp,
    planOptions: () => ({
      waveId: WAVE,
      run: RUN,
      runtimeSha: LAUNCHER,
      generation: 1,
      plannedAt: T0,
      deadline: DEADLINE,
    }),
    ingestOptions: () => ({
      deadline: DEADLINE,
      expectedProvider: PROVIDER,
      bundleImporter: importer,
    }),
    claimCell: async (cell) => {
      // Every claim is a fresh isolated runner: a unique checkout and artifact
      // directory, never a populated path reused or overwritten.
      const claim = ++claimCounter;
      const repo = `${tmp}/cell-${cell.taskId}-${claim}`;
      assert.ok((await gitRun(tmp, ["clone", "-q", mirrorRepo, repo], env)).ok);
      assert.ok((await gitRun(repo, ["checkout", "-q", base], env)).ok);
      repos.set(cell.taskId, repo);
      const bundlesDir = `${tmp}/bundles-${cell.taskId}-${claim}`;
      await Deno.mkdir(bundlesDir, { recursive: true });
      return {
        cell,
        repositoryDir: repo,
        deps: {
          clock,
          bounds: createRunBounds(deps, {
            deadline: DEADLINE,
            runStartedAt: T0,
          }),
          sessionBound: configs[0]!.sessionBound!,
          state: store,
          github,
          model,
          bundle: createGitBundleExporter({
            repositoryDir: repo,
            outputDir: bundlesDir,
          }),
        },
        bundlesDir,
      };
    },
    transfer: async (results, ctxs) => {
      for (const result of results) {
        const ctx = ctxs.find((item) => item.cell.cellId === result.cellId);
        if (ctx === undefined || result.bundle === null) continue;
        await Deno.copyFile(
          `${ctx.bundlesDir}/${result.bundle.file}`,
          `${mirrorBundles}/${result.bundle.file}`,
        );
      }
    },
    objectPresent: async (sha) =>
      (await gitRun(mirrorRepo, ["cat-file", "-e", `${sha}^{commit}`], env)).ok,
    cleanup: async () => {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    },
  };
}

export async function snapshot(rig: RigV1): Promise<RepairStateSnapshotV1> {
  const read = await rig.store.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") {
    throw new Error("no repair state");
  }
  return read.value.snapshot;
}

export function completedReceipt(
  result: MatrixCellResultV1,
): ModelRunReceiptV1 {
  if (result.receipt === null) throw new Error("expected a completed receipt");
  return result.receipt;
}
