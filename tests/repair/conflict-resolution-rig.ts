/**
 * Real-Git rig for the base-refresh conflict resolution. A temporary
 * repository holds an old base B0, a published candidate H on it and a moved
 * base B that genuinely conflicts with H. The fake GitHub port's base refresh
 * is the PRODUCTION adapter over the production executor (`git merge-tree`),
 * so the conflict is real. The fake model plays the model session only: it
 * resolves the conflict markers of a checkout of H with B merged in and
 * commits the merge the way the trusted host does (parents H and B). No
 * network, no model call, no credentials.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import { asWorkItemId, type GitSha } from "../../src/contracts/brands.ts";
import {
  type ImplementationPort,
  type ModelRunReceiptV1,
  type ModelRunRequestV1,
  portError,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import { createPrepareBaseRefresh } from "../../src/host/local-base-refresh.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  candidateBranch,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { runRepairCycle } from "../../src/repair/loop.ts";
import { gitRun, REPO, SHA1, T0, workRecord } from "../state/helpers.ts";
import {
  FakeClock,
  FakeGithub,
  FakeIncidents,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import { exactOpenPr } from "./loop-candidate-fixtures.ts";
import { ROOT, seededSnapshot } from "./loop-rig.ts";

export const TASK = asWorkItemId("issue-1");
export const BRANCH = candidateBranch(TASK);
export const PR = 7;
export const TRUSTED_AUTHOR = "ubiquity-sentinel[bot]";
export const PRODUCING = "cd".repeat(32);

const gitEnv = (home: string): Record<string, string> => ({
  PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "sentinel-test",
  GIT_AUTHOR_EMAIL: "sentinel-test@localhost",
  GIT_COMMITTER_NAME: "sentinel-test",
  GIT_COMMITTER_EMAIL: "sentinel-test@localhost",
});

export interface ConflictGitV1 {
  tmp: string;
  home: string;
  repo: string;
  env: Record<string, string>;
  /** Old base the candidate was built and published on. */
  b0: GitSha;
  /** Published candidate head. */
  head: GitSha;
  /** Moved base that conflicts with the candidate in `app.ts`. */
  base: GitSha;
  git(args: string[], cwd?: string): Promise<string>;
  parents(sha: string): Promise<string[]>;
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

/**
 * B0 -> H edits the line B0 -> B edits too. `extraBase` adds more files to
 * the moved base (e.g. a protected path changed only upstream).
 */
export async function makeConflictGit(
  options: { extraBase?: Record<string, string> } = {},
): Promise<ConflictGitV1> {
  const tmp = await Deno.makeTempDir({
    prefix: "sentinel-conflict-resolution-",
    dir: ROOT,
  });
  const home = `${tmp}/home`;
  const repo = `${tmp}/repo`;
  const env = gitEnv(home);
  await Deno.mkdir(home, { recursive: true });
  const git = async (args: string[], cwd = repo): Promise<string> => {
    const result = await gitRun(cwd, args, env);
    if (!result.ok) {
      throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    }
    return result.stdout;
  };
  try {
    await git(["init", "-q", repo], tmp);
    await git(["checkout", "-q", "-b", "development"]);
    const commit = async (
      files: Record<string, string>,
      message: string,
    ): Promise<GitSha> => {
      for (const [name, content] of Object.entries(files)) {
        const path = `${repo}/${name}`;
        await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
          recursive: true,
        });
        await Deno.writeTextFile(path, content);
      }
      await git(["add", "-A"]);
      await git(["commit", "-q", "-m", message]);
      return (await git(["rev-parse", "HEAD"])).trim() as GitSha;
    };
    const b0 = await commit({
      "src/app.ts": "export const value = 'shared';\n",
      "README.md": "fixture\n",
    }, "b0");
    await git(["checkout", "-q", "-b", "candidate"]);
    const head = await commit({
      "src/app.ts": "export const value = 'candidate';\n",
      "src/feature.ts": "export const feature = true;\n",
    }, "candidate");
    await git(["checkout", "-q", "development"]);
    const base = await commit({
      "src/app.ts": "export const value = 'upstream';\n",
      "src/upstream.ts": "export const upstream = 1;\n",
      ...(options.extraBase ?? {}),
    }, "upstream");
    return {
      tmp,
      home,
      repo,
      env,
      b0,
      head,
      base,
      git,
      parents: async (sha) =>
        (await git(["rev-list", "--parents", "-n", "1", sha])).trim().split(
          " ",
        ).slice(1),
      isAncestor: async (ancestor, descendant) =>
        (await gitRun(
          repo,
          ["merge-base", "--is-ancestor", ancestor, descendant],
          env,
        )).ok,
      cleanup: async () => {
        await Deno.remove(tmp, { recursive: true }).catch(() => {});
      },
    };
  } catch (error) {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
    throw error;
  }
}

/**
 * Fake GitHub port over the exact candidate lifecycle and the real adapter.
 * Its preservation re-checks the ancestry the production publication
 * validator proves (the descriptor base and the published head are both
 * ancestors of the preserved head) and refuses like it does.
 */
export function conflictGithub(
  ctx: ConflictGitV1,
  options: { baseSha?: GitSha } = {},
): FakeGithub {
  const github = new FakeGithub({
    baseSha: options.baseSha ?? ctx.base,
    candidateLifecycle: {
      refs: { [`refs/heads/${BRANCH}`]: ctx.head },
      pullRequests: [{
        ...exactOpenPr(PR, ctx.head, BRANCH, ctx.b0),
        author: TRUSTED_AUTHOR,
      }],
      preserveCandidate: async (request) => {
        const { base, head } = request.candidate;
        const published = request.publishedHead;
        return await ctx.isAncestor(base, head) &&
            (published === null || await ctx.isAncestor(published, head))
          ? portOk(undefined)
          : portError("invalid", "candidate publication base is stale");
      },
    },
  });
  github.prepareBaseRefresh = createPrepareBaseRefresh({
    git: new DenoGitExecutor({
      localDir: ctx.repo,
      remoteUrl: `file://${ctx.repo}`,
      gitHome: ctx.home,
    }),
    observer: {
      readPullRequest: (number) => github.readPullRequest(number),
      readRef: (ref) => github.readRef(ref),
    },
    baseBranch: "development",
    trustedPrAuthor: TRUSTED_AUTHOR,
  });
  return github;
}

/**
 * The published, preserved candidate H on B0 with its open PR, exactly the
 * shape a conflict-blocked record has once its PR identity is restored.
 */
export async function publishedCandidate(
  ctx: ConflictGitV1,
  overrides: Partial<WorkRecordV1> = {},
): Promise<WorkRecordV1> {
  const operationKey = implementationIntentKey(PRODUCING);
  return workRecord(TASK, {
    repository: REPO,
    source: { kind: "issue", id: "1", revision: SHA1 },
    related: { incidentId: null, issueNumber: 1 },
    target: {
      base: ctx.b0,
      branch: BRANCH,
      checkpoint: null,
      head: ctx.head,
      pr: PR,
      candidateState: {
        preserved: {
          operationKey,
          base: ctx.b0,
          head: ctx.head,
          ref: await candidatePreservationRef(REPO, TASK, operationKey),
        },
        publishedHead: ctx.head,
      },
    },
    nextStep: "work",
    counters: { attempts: 1, retries: 0, reviewRounds: 1 },
    firstSeenAt: T0 - 5000,
    createdAt: T0 - 4000,
    updatedAt: T0,
    ...overrides,
  });
}

export interface ResolverOptionsV1 {
  /** Resolved content per conflicted path (default keeps both changes). */
  resolve?: (path: string, conflicted: string) => string;
  /** Extra files the "model" writes besides the resolution. */
  extra?: Record<string, string>;
  /** Abort the merge instead of resolving it (no merge commit). */
  abort?: boolean;
  /** Commit the edit on H alone, never merging the base. */
  skipMerge?: boolean;
  /** Report a failed (incomplete) session. */
  outcome?: ModelRunReceiptV1["outcome"];
}

/**
 * Model double: the session edits a checkout of H with the base merged in;
 * committing (parents H and B), the changed-path read against B and the
 * import into the repository are the host's trusted side, done here with
 * plain Git so the loop's behavior is observed with nothing else faked.
 */
export class ConflictModel implements ImplementationPort {
  readonly requests: ModelRunRequestV1[] = [];
  readonly heads: GitSha[] = [];
  constructor(
    private readonly ctx: ConflictGitV1,
    private readonly options: ResolverOptionsV1 = {},
  ) {}

  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    this.requests.push(request);
    const fields = request as unknown as Record<string, unknown>;
    const head = fields.checkoutBase as GitSha | undefined;
    const mergeBase = fields.mergeBase as GitSha | undefined;
    const completed = this.options.outcome === undefined ||
      this.options.outcome === "completed";
    let candidate: ModelRunReceiptV1["candidate"] = null;
    if (completed && head !== undefined && mergeBase !== undefined) {
      candidate = await this.resolveMerge(head, mergeBase);
    }
    return portOk({
      invocationId: `invoke-${this.requests.length}`,
      outcome: this.options.outcome ?? "completed",
      actual: {
        evidenceKind: "request-runtime",
        provider: "sentinel-host",
        threadId: "thread-1",
        turnId: "turn-1",
        terminalOrigin: "runtime",
        observedTerminalStatus: this.options.outcome ?? "completed",
        observedModel: "gpt-reserve",
        observedReasoning: "max",
        durationMs: 100,
        outputChars: 500,
      },
      candidate,
      error: null,
    });
  }

  private async resolveMerge(
    head: GitSha,
    mergeBase: GitSha,
  ): Promise<ModelRunReceiptV1["candidate"]> {
    const dir = `${this.ctx.tmp}/checkout-${this.requests.length}`;
    const git = this.ctx.git;
    await git(
      ["clone", "-q", "--no-checkout", this.ctx.repo, dir],
      this.ctx.tmp,
    );
    await git(["checkout", "-q", "--detach", head], dir);
    if (this.options.skipMerge === true) {
      await Deno.writeTextFile(
        `${dir}/src/app.ts`,
        "export const value = 'candidate-only';\n",
      );
      return await this.commitResolution(dir, mergeBase);
    }
    const merged = await gitRun(
      dir,
      ["merge", "--no-ff", "--no-commit", mergeBase],
      this.ctx.env,
    );
    assert.equal(merged.code, 1, "the base merge conflicts");
    const conflicted = (await git(
      ["diff", "--name-only", "--diff-filter=U"],
      dir,
    )).split("\n").filter((line) => line.length > 0);
    assert.ok(conflicted.length > 0, "conflicted paths are left in the tree");
    if (this.options.abort === true) {
      await git(["merge", "--abort"], dir);
      return null;
    }
    for (const path of conflicted) {
      const text = await Deno.readTextFile(`${dir}/${path}`);
      await Deno.writeTextFile(
        `${dir}/${path}`,
        this.options.resolve?.(path, text) ??
          "export const value = 'candidate';\nexport const upstreamValue = 'upstream';\n",
      );
    }
    for (const [path, content] of Object.entries(this.options.extra ?? {})) {
      const full = `${dir}/${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, content);
    }
    return await this.commitResolution(dir, mergeBase);
  }

  private async commitResolution(
    dir: string,
    mergeBase: GitSha,
  ): Promise<ModelRunReceiptV1["candidate"]> {
    const git = this.ctx.git;
    await git(["add", "-A"], dir);
    await git(["commit", "-q", "--no-verify", "-m", "resolve"], dir);
    const resolved = (await git(["rev-parse", "HEAD"], dir)).trim() as GitSha;
    await git(["fetch", "-q", dir, resolved]);
    this.heads.push(resolved);
    const changedPaths = (await git([
      "diff",
      "--no-renames",
      "--name-only",
      `${mergeBase}..${resolved}`,
    ])).split("\n").filter((line) => line.length > 0);
    return { head: resolved, checkpointSha: null, changedPaths };
  }
}

/** In-memory repair loop over the given ports (one in-process cycle per run). */
export function conflictRig(
  github: FakeGithub,
  model: ImplementationPort,
  options: { externalImplementations?: boolean } = {},
) {
  const clock = new FakeClock(T0);
  const state = new MemoryState();
  const configs = repairConfigs({
    sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
  });
  const budget = new RollingStartBudget({ clock, state, configs });
  const githubCooldown = new DurableGitHubCooldownGate({ state, clock });
  const written: RepairStateSnapshotV1[] = [];
  const write = state.writeRepair.bind(state);
  state.writeRepair = (next, expected) => {
    written.push(structuredClone(next));
    return write(next, expected);
  };
  const run = (stepLimit = 16) =>
    runRepairCycle({
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown,
      incidents: new FakeIncidents({ summaries: [], evidence: null }),
      replay: new FakeReplay(),
      model,
      budget,
      ...(options.externalImplementations === undefined
        ? {}
        : { externalImplementations: options.externalImplementations }),
    }, { deadline: clock.now() + 60 * 60_000, stepLimit });
  const snapshot = async (): Promise<RepairStateSnapshotV1> => {
    const read = await state.readRepair();
    if (!read.ok || read.value.status !== "found") {
      throw new Error("no repair state");
    }
    return read.value.snapshot;
  };
  const seed = async (
    work: WorkRecordV1[],
    extra: Partial<RepairStateSnapshotV1> = {},
  ) => {
    const seeded = await state.writeRepair(seededSnapshot(work, extra), null);
    assert.ok(seeded.ok && seeded.value.status === "applied");
  };
  return { clock, state, configs, github, run, snapshot, seed, written };
}
