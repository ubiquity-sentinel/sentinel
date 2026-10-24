/** Shared credential-free hosted test fixtures; this module registers no tests. */
import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type {
  GitHubIssueV1,
  GitHubPullRequestV1,
  GitHubRefV1,
  PortResultV1,
  StateReadResultV1,
  StateReadView,
} from "../../src/contracts/ports.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type { ReviewReceiptV1 } from "../../src/contracts/review-receipt.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { createLegacyBaseRefreshLossProver } from "../../src/host/actions-candidates.ts";
import { localCheckoutKey } from "../../src/host/local.ts";
import {
  baseRefreshIntentKey,
  candidateBranch,
} from "../../src/repair/keys.ts";
import type {
  ReplayCommandInputV1,
  ReplayCommandResultV1,
  ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { MemoryState } from "../repair/helpers.ts";
import {
  reservation,
  reviewReceipt,
  SHA1,
  T0,
  workRecord,
} from "../state/helpers.ts";
import {
  CANDIDATE_TASK_ID,
  mirror,
} from "./actions-candidates-preservation-fixture.ts";
import {
  commitIn,
  FakeGate,
  gitRun,
  makeCandidateCtx,
  SELF_REPO,
  snapshot,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";
import type { CandidateCtxV1 } from "./actions-candidates-fixture.ts";

// ---------------------------------------------------------------------------
// Legacy base-refresh candidate loss: the REAL prover factory, the REAL
// createLocalCandidateLoader and REAL bounded Git fetch into a new empty store.
// Only the authenticated GitHub read port is scripted; nothing is written.
// ---------------------------------------------------------------------------

export const LEGACY_TASK_ID = CANDIDATE_TASK_ID;

export const LEGACY_BRANCH = candidateBranch(CANDIDATE_TASK_ID);

export const LEGACY_PR = 12;

export const LEGACY_AUTHOR = "sentinel[bot]";

const LEGACY_REVIEWER = "chatgpt-codex-connector[bot]";

const LEGACY_STORE_PREFIX = "sentinel-legacy-loss-store-";

/** Scripted read-only GitHub port over explicit observations. */
export class LegacyLossPort {
  readonly reviewerIdentity = LEGACY_REVIEWER;
  readonly calls: string[] = [];
  issue: PortResultV1<GitHubIssueV1 | null>;
  pull: PortResultV1<GitHubPullRequestV1 | null>;
  ref: PortResultV1<GitHubRefV1 | null>;

  constructor(init: {
    issue: PortResultV1<GitHubIssueV1 | null>;
    pull: PortResultV1<GitHubPullRequestV1 | null>;
    ref: PortResultV1<GitHubRefV1 | null>;
  }) {
    this.issue = init.issue;
    this.pull = init.pull;
    this.ref = init.ref;
  }

  readIssue(issueNumber: number): Promise<PortResultV1<GitHubIssueV1 | null>> {
    this.calls.push(`issue:${issueNumber}`);
    return Promise.resolve(this.issue);
  }

  readPullRequest(
    number: number,
  ): Promise<PortResultV1<GitHubPullRequestV1 | null>> {
    this.calls.push(`pr:${number}`);
    return Promise.resolve(this.pull);
  }

  readRef(ref: string): Promise<PortResultV1<GitHubRefV1 | null>> {
    this.calls.push(`ref:${ref}`);
    return Promise.resolve(this.ref);
  }
}

/** Bounded runtime that records every git argv and never spawns. */
export class CountingRuntime implements ReplayRuntimeV1 {
  calls = 0;
  run(_input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.calls++;
    return Promise.resolve({
      outcome: "spawn_failed",
      exitCode: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      truncated: false,
      settled: true,
      detail: "unexpected legacy-loss git run",
    });
  }
}

/** Real runtime wrapper that records every git argv. */
export class RecordingRuntime implements ReplayRuntimeV1 {
  readonly calls: string[][] = [];
  constructor(private readonly delegate: ReplayRuntimeV1) {}
  run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.calls.push([...input.args]);
    return this.delegate.run(input);
  }
}

/** Real state wrapper whose SECOND read reports a different authoritative head. */
export class DriftingLossState implements StateReadView {
  reads = 0;
  constructor(
    private readonly inner: MemoryState,
    private readonly secondHead: GitSha,
  ) {}
  readRepair(): Promise<
    PortResultV1<StateReadResultV1<RepairStateSnapshotV1>>
  > {
    this.reads++;
    return this.inner.readRepair().then((result) => {
      if (this.reads === 1 || !result.ok || result.value.status !== "found") {
        return result;
      }
      return portOk({ ...result.value, head: this.secondHead });
    });
  }
  readRelease(): Promise<PortResultV1<StateReadResultV1<never>>> {
    return this.inner.readRelease();
  }
}

/** Real loader whose calls are counted (the loader itself is unchanged). */
export function countingCandidateLoader(): {
  load: (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>>;
  calls: { taskId: string; head: GitSha }[];
} {
  const calls: { taskId: string; head: GitSha }[] = [];
  return {
    calls,
    load: (taskId, head) => {
      calls.push({ taskId, head });
      return Promise.resolve(portError("not_found", "candidate is absent"));
    },
  };
}

export function legacyIssue(
  overrides: Partial<GitHubIssueV1> = {},
): GitHubIssueV1 {
  return {
    number: 1,
    title: "legacy loss",
    body: "<!-- sentinel:repair -->\n",
    state: "open",
    author: null,
    labels: [],
    createdAt: T0,
    updatedAt: T0,
    closedAt: null,
    relations: { openBlockers: [], subIssueCount: 0 },
    ...overrides,
  };
}

export function legacyPull(input: {
  predecessor: GitSha;
  base?: GitSha;
  overrides?: Partial<GitHubPullRequestV1>;
}): GitHubPullRequestV1 {
  return {
    number: LEGACY_PR,
    title: "legacy loss",
    body: "",
    state: "open",
    head: input.predecessor,
    base: input.base ?? SHA1,
    mergeSha: null,
    headRef: LEGACY_BRANCH,
    baseRef: "development",
    author: LEGACY_AUTHOR,
    createdAt: T0,
    updatedAt: T0,
    mergedAt: null,
    reviewDecision: "none",
    ...input.overrides,
  };
}

export function legacyReview(input: {
  id: string;
  head: GitSha;
  base: GitSha;
  overrides?: Record<string, unknown>;
}): ReviewReceiptV1 {
  return reviewReceipt(input.id, {
    expectedReviewer: LEGACY_REVIEWER,
    observedReviewer: LEGACY_REVIEWER,
    repository: { ...SELF_REPO },
    pullRequest: { number: LEGACY_PR, head: input.head, base: input.base },
    outcome: "completed",
    resultId: "result-1",
    summary: null,
    findings: [{
      id: "finding-1",
      severity: "P0",
      path: null,
      message: "correction required",
      fingerprint: "a".repeat(64),
      resolved: false,
      resolutionEvidence: null,
    }],
    findingsUncounted: 0,
    unresolvedSeverities: ["P0"],
    submittedAt: T0 + 1000,
    completedAt: T0 + 2000,
    observedAt: T0 + 3000,
    ...input.overrides,
  });
}

/** Exact covered legacy record; overrides stay explicit per test. */
export function legacyRecord(input: {
  lost: GitSha;
  base: GitSha;
  observedBase: GitSha;
  nextStep?: "work" | "blocked" | "review" | "delivery";
  blocker?: unknown;
  dependencies?: string[];
  target?: Record<string, unknown>;
  intent?: Record<string, unknown>;
  workOverrides?: Record<string, unknown>;
}): WorkRecordV1 {
  return workRecord(CANDIDATE_TASK_ID, {
    repository: { ...SELF_REPO },
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    dependencies: input.dependencies ?? [],
    target: {
      base: input.base,
      branch: LEGACY_BRANCH,
      checkpoint: null,
      head: input.lost,
      pr: LEGACY_PR,
      ...input.target,
    },
    nextStep: input.nextStep ?? "work",
    blocker: input.blocker ?? null,
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(LEGACY_PR, input.lost, input.observedBase),
      startedAt: T0,
      branch: LEGACY_BRANCH,
      expectedHead: input.lost,
      observedBase: input.observedBase,
      pr: LEGACY_PR,
      requestId: null,
      resultId: null,
      ...input.intent,
    },
    updatedAt: T0 + 1000,
    ...input.workOverrides,
  });
}

/** Exact submitted implementation reservation for one legacy attempt. */
const LEGACY_RESERVATION_ID = "a".repeat(64);

export function legacyReservation(
  record: WorkRecordV1,
  overrides: Record<string, unknown> = {},
) {
  return reservation(LEGACY_RESERVATION_ID, {
    repository: { ...SELF_REPO },
    taskId: record.id,
    attempt: record.counters.attempts,
    head: record.target.base,
    purpose: "implementation",
    outcome: "submitted",
    settledAt: T0 + 5,
    proofRef: null,
    ...overrides,
  });
}

/** Parsed durable snapshot with explicit reviews and distinct heads. */
export function legacyState(
  work: RepairStateSnapshotV1["work"],
  reservations: RepairStateSnapshotV1["reservations"],
  reviews: RepairStateSnapshotV1["reviews"] = [],
  heads: { snapshotHead?: GitSha; readHead?: GitSha } = {},
): MemoryState {
  const state = new MemoryState();
  const parsed = snapshot(work, reservations);
  parsed.reviews = reviews;
  parsed.stateHead = heads.snapshotHead ?? SHA1;
  state.repair = parsed;
  state.repairHead = heads.readHead ?? SHA1;
  return state;
}

/** Real fixture: B0, moved base B1, reviewed predecessor H0 on the exact task
 * branch, and a lost correction H1 that exists in no trusted store. */
export async function makeLegacyLossCtx(): Promise<{
  ctx: CandidateCtxV1;
  branch: string;
  movedBase: GitSha;
  lost: GitSha;
  sourcePath: string;
  stateRoot: string;
  producer: string;
}> {
  const ctx = await makeCandidateCtx();
  try {
    const work = `${ctx.tmp}/work`;
    const branch = LEGACY_BRANCH;
    assert.ok(
      (await gitRun(
        work,
        ["push", "-q", "origin", `${ctx.head}:refs/heads/${branch}`],
        ctx.env,
      )).ok,
    );
    // The configured base advances to B1 while B0 stays H0's parent.
    assert.ok(
      (await gitRun(work, ["checkout", "-q", "development"], ctx.env)).ok,
    );
    const movedBase = await commitIn(work, ctx.env, "moved-base");
    assert.ok(
      (await gitRun(work, ["push", "-q", "origin", "development"], ctx.env)).ok,
    );
    // H1 is produced in a disposable clone and published nowhere; the clone is
    // deleted, so H1 exists in no trusted store afterwards.
    const lostDir = `${ctx.tmp}/lost`;
    assert.ok(
      (await gitRun(
        ctx.tmp,
        ["clone", "-q", "--no-hardlinks", `file://${ctx.bare}`, lostDir],
        ctx.env,
      )).ok,
    );
    assert.ok(
      (await gitRun(lostDir, ["checkout", "-q", ctx.base], ctx.env)).ok,
    );
    const lost = await commitIn(lostDir, ctx.env, "lost-correction");
    await Deno.remove(lostDir, { recursive: true });
    assert.notEqual(lost, ctx.base);
    assert.notEqual(lost, ctx.head);
    assert.notEqual(lost, movedBase);
    // The trusted source mirror and the exact mapped producer checkout are
    // real repositories that both lack H1.
    const sourcePath = await mirror(ctx);
    const stateRoot = `${ctx.tmp}/state`;
    const key = await localCheckoutKey(CANDIDATE_TASK_ID);
    const checkouts = `${stateRoot}/checkouts`;
    await Deno.mkdir(checkouts, { recursive: true });
    const producer = `${checkouts}/${key}`;
    const cloned = await gitRun(
      ctx.tmp,
      ["clone", "-q", "--no-hardlinks", work, producer],
      ctx.env,
    );
    assert.ok(cloned.ok, cloned.stderr);
    await Deno.writeTextFile(
      `${checkouts}/${key}.json`,
      JSON.stringify({
        version: "v1",
        kind: "local_checkout",
        taskId: CANDIDATE_TASK_ID,
        key,
        base: ctx.base,
      }),
    );
    return {
      ctx,
      branch,
      movedBase,
      lost,
      sourcePath,
      stateRoot,
      producer,
    };
  } catch (error) {
    await ctx.cleanup();
    throw error;
  }
}

/** The real prover factory over one real fixture remote. */
export function legacyProver(input: {
  ctx: CandidateCtxV1;
  state: StateReadView;
  port: LegacyLossPort;
  ensure: (taskId: WorkItemId, head: GitSha) => Promise<PortResultV1<void>>;
  gate?: FakeGate;
  runtime?: ReplayRuntimeV1;
  scratch?: string;
  remoteUrl?: string;
}) {
  return createLegacyBaseRefreshLossProver({
    state: input.state,
    port: input.port,
    gate: input.gate ?? new FakeGate(),
    token: "dummy-token",
    scratch: input.scratch ?? `${input.ctx.tmp}/home`,
    trustedPath: TRUSTED_PATH,
    gitExecutable: "git",
    baseBranch: "development",
    trustedPrAuthor: LEGACY_AUTHOR,
    ensureLocalCandidate: input.ensure,
    runtime: input.runtime,
    remoteUrl: input.remoteUrl ?? `file://${input.ctx.bare}`,
  });
}

export function legacyStoreLeftovers(scratch: string): string[] {
  return [...Deno.readDirSync(scratch)]
    .filter((entry) => entry.name.startsWith(LEGACY_STORE_PREFIX))
    .map((entry) => entry.name)
    .sort();
}
