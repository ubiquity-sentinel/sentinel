/**
 * Rig for the HOSTED conflict-resolution route over real Git (no test
 * registrations). It composes the real hosted pieces around the real-Git
 * conflict of `conflict-resolution-rig.ts`: the hosted repair loop (matrix
 * mode, no in-process model), the trusted matrix planner, one matrix cell
 * whose model port is the trusted merge preparer, committer and resolver
 * around a scripted session, the bundle exporter, and the ingest into the
 * trusted mirror (the candidate repository itself) with its ancestry checks.
 * Every snapshot any step writes is captured in `written`.
 */
import assert from "node:assert/strict";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import type {
  MatrixCellPlanV1,
  MatrixCellResultV1,
  MatrixPlanV1,
} from "../../src/contracts/matrix.ts";
import {
  type CandidatePreservationRequestV1,
  type ImplementationPort,
  type ModelRunReceiptV1,
  type ModelRunRequestV1,
  portError,
  type PortErrorKindV1,
  portOk,
  type PortResultV1,
} from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { prepareMergeCheckout } from "../../src/host/local-checkout.ts";
import {
  ingestMatrixResults,
  type MatrixIngestReportV1,
  type MatrixPlanReportV1,
  planMatrixWave,
  runMatrixCell,
} from "../../src/host/matrix.ts";
import {
  createGitBundleExporter,
  createGitBundleImporter,
} from "../../src/host/matrix-git.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import type { RepairCycleDepsV1 } from "../../src/repair/loop.ts";
import { createRunBounds } from "../../src/repair/loop.ts";
import {
  LocalMergeCommitter,
  LocalMergeResolver,
} from "../../src/repair/model-port-checkout.ts";
import {
  applyHostedRetries,
  planHostedRetries,
} from "../../ops/hosted-autonomy.ts";
import { hostedRepositoryKey } from "../../ops/hosted-autonomy-policy.ts";
import { gitRun, REPO, SHA1 } from "../state/helpers.ts";
import {
  type FakeGithub,
  FakeIncidents,
  FakeReplay,
} from "../repair/helpers.ts";
import {
  conflictGithub,
  type ConflictGitV1,
  conflictRig,
  makeConflictGit,
  publishedCandidate,
} from "../repair/conflict-resolution-rig.ts";

export const WAVE = "wave-conflict-79";
export const RUN = { runId: 79, runAttempt: 1, launcherSha: SHA1 };
export const GENERATION = 79;
export const ACTUAL = { run: RUN, runtimeSha: SHA1, generation: GENERATION };
export const PROVIDER = "sentinel-host";
export const RESOLVED =
  "export const value = 'candidate';\nexport const upstreamValue = 'upstream';\n";
const HOUR = 60 * 60_000;

/** A hosted run never starts a model in process. */
export const NO_MODEL: ImplementationPort = {
  runModel: () => {
    throw new Error("a hosted run never starts a model in process");
  },
};

export interface CellOptionsV1 {
  /** Report an incomplete session: no candidate, nothing committed. */
  failed?: boolean;
  /** Extra files the session writes besides the resolution. */
  extra?: Record<string, string>;
}

/**
 * The cell's isolated implementation port: the TRUSTED merge preparation of
 * the requested (H, B) in a fresh checkout of H, a scripted session that only
 * edits files, then the TRUSTED merge committer and resolver (the exact
 * composition `LocalCheckoutModelPort` uses for a merge request).
 */
export class TrustedMergeCell implements ImplementationPort {
  readonly requests: ModelRunRequestV1[] = [];
  conflicted: readonly string[] = [];
  constructor(
    private readonly ctx: ConflictGitV1,
    readonly dir: string,
    private readonly options: CellOptionsV1 = {},
  ) {}

  async runModel(
    request: ModelRunRequestV1,
  ): Promise<PortResultV1<ModelRunReceiptV1>> {
    this.requests.push(request);
    const head = request.checkoutBase as GitSha;
    const mergeBase = request.mergeBase as GitSha;
    const { ctx, dir } = this;
    await ctx.git(["clone", "-q", "--no-checkout", ctx.repo, dir], ctx.tmp);
    await ctx.git(["checkout", "-q", "--detach", head], dir);
    await Deno.mkdir(`${ctx.tmp}/cell-scratch`, { recursive: true });
    const merge = await prepareMergeCheckout({
      checkout: dir,
      head,
      mergeBase,
      sourcePath: ctx.repo,
      stateRoot: ctx.tmp,
      scratch: `${ctx.tmp}/cell-scratch`,
      trustedPath: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    });
    assert.ok(merge.ok, "the trusted merge leaves the conflicts in the tree");
    this.conflicted = merge.conflictedPaths;
    let candidate: ModelRunReceiptV1["candidate"] = null;
    if (this.options.failed !== true) {
      for (const path of merge.conflictedPaths) {
        await Deno.writeTextFile(`${dir}/${path}`, RESOLVED);
      }
      for (const [path, content] of Object.entries(this.options.extra ?? {})) {
        await Deno.writeTextFile(`${dir}/${path}`, content);
      }
      const planned = {
        head,
        mergeBase,
        conflictedPaths: merge.conflictedPaths,
      };
      const committer = new LocalMergeCommitter(dir, planned);
      assert.ok(await committer.commit(head), String(committer.refusalCode));
      candidate = await new LocalMergeResolver(dir, planned).resolve();
      assert.ok(candidate !== null);
    }
    const outcome = this.options.failed === true ? "failed" : "completed";
    return portOk({
      invocationId: `invoke-conflict-${this.requests.length}`,
      outcome,
      actual: {
        evidenceKind: "request-runtime",
        provider: PROVIDER,
        threadId: "thread-1",
        turnId: "turn-1",
        terminalOrigin: "runtime",
        observedTerminalStatus: outcome,
        observedModel: request.model,
        observedReasoning: request.reasoning,
        durationMs: 100,
        outputChars: 500,
      },
      candidate,
      error: null,
    });
  }
}

export interface HostedConflictRigV1 {
  ctx: ConflictGitV1;
  github: FakeGithub;
  hosted: ReturnType<typeof conflictRig>;
  deps: RepairCycleDepsV1;
  /** One hosted repair loop run (matrix mode). */
  runLoop(): ReturnType<ReturnType<typeof conflictRig>["run"]>;
  /** The trusted hosted planner's wave at the current clock. */
  plan(): Promise<MatrixPlanReportV1>;
  /** One cell over the granted conflict request; the bundle reaches the mirror. */
  runCell(
    plan: MatrixPlanV1,
    cell: MatrixCellPlanV1,
    options?: CellOptionsV1 & { notStarted?: boolean },
  ): Promise<{ result: MatrixCellResultV1; model: TrustedMergeCell }>;
  /** Ingest into the trusted mirror (the candidate repository). */
  ingest(
    plan: MatrixPlanV1,
    results: readonly MatrixCellResultV1[],
  ): Promise<MatrixIngestReportV1>;
  cleanup(): Promise<void>;
}

export async function hostedConflictRig(
  overrides: Partial<WorkRecordV1> = {},
): Promise<HostedConflictRigV1> {
  const ctx = await makeConflictGit();
  const github = conflictGithub(ctx);
  const hosted = conflictRig(github, NO_MODEL, {
    externalImplementations: true,
  });
  await hosted.seed([await publishedCandidate(ctx, overrides)]);
  const deps: RepairCycleDepsV1 = {
    clock: hosted.clock,
    state: hosted.state,
    configs: hosted.configs,
    controllerSha: SHA1,
    github,
    githubCooldown: new DurableGitHubCooldownGate({
      state: hosted.state,
      clock: hosted.clock,
    }),
    incidents: new FakeIncidents({ summaries: [], evidence: null }),
    replay: new FakeReplay(),
    model: NO_MODEL,
    budget: new RollingStartBudget({
      clock: hosted.clock,
      state: hosted.state,
      configs: hosted.configs,
    }),
    externalImplementations: true,
  };
  const mirrorBundles = `${ctx.tmp}/mirror-bundles`;
  await Deno.mkdir(mirrorBundles, { recursive: true });
  let cells = 0;
  return {
    ctx,
    github,
    hosted,
    deps,
    runLoop: () => hosted.run(),
    plan: () =>
      planMatrixWave(deps, {
        waveId: WAVE,
        run: RUN,
        runtimeSha: SHA1,
        generation: GENERATION,
        plannedAt: hosted.clock.now(),
        deadline: hosted.clock.now() + HOUR,
      }),
    runCell: async (plan, cell, options = {}) => {
      const claim = ++cells;
      const dir = `${ctx.tmp}/cell-checkout-${claim}`;
      const bundles = `${ctx.tmp}/cell-bundles-${claim}`;
      const model = new TrustedMergeCell(ctx, dir, options);
      const bounds = createRunBounds(deps, {
        deadline: hosted.clock.now() + HOUR,
        runStartedAt: hosted.clock.now(),
      });
      const result = await runMatrixCell(
        {
          clock: hosted.clock,
          bounds: options.notStarted === true
            ? { ...bounds, modelCutoff: hosted.clock.now() - 1 }
            : bounds,
          sessionBound: hosted.configs[0]!.sessionBound!,
          state: hosted.state,
          github,
          model,
          bundle: createGitBundleExporter({
            repositoryDir: dir,
            outputDir: bundles,
          }),
        },
        { waveId: plan.waveId, run: plan.run, cell },
        ACTUAL,
        hosted.clock.now(),
      );
      if (result.bundle !== null) {
        await Deno.copyFile(
          `${bundles}/${result.bundle.file}`,
          `${mirrorBundles}/${result.bundle.file}`,
        );
      }
      return { result, model };
    },
    ingest: (plan, results) =>
      ingestMatrixResults(deps, plan, results, {
        deadline: hosted.clock.now() + HOUR,
        expectedProvider: PROVIDER,
        bundleImporter: createGitBundleImporter({
          repositoryDir: ctx.repo,
          bundlesDir: mirrorBundles,
        }),
      }),
    cleanup: () => ctx.cleanup(),
  };
}

/**
 * Drive the open hosted route from the conflict to the ingested cell: one
 * hosted loop run (pending), the planner's single charged cell, the cell
 * (`options`) and its ingest. Returns the plan, the cell result and model.
 */
export async function resolveHosted(
  rig: HostedConflictRigV1,
  options: CellOptionsV1 & { notStarted?: boolean } = {},
) {
  const first = await rig.runLoop();
  assert.notEqual(first.status, "state_error", JSON.stringify(first));
  const planned = await rig.plan();
  assert.equal(planned.plan.cells.length, 1, JSON.stringify(planned));
  const { result, model } = await rig.runCell(
    planned.plan,
    planned.plan.cells[0],
    options,
  );
  const ingested = await rig.ingest(planned.plan, [result]);
  return { plan: planned.plan, result, model, ingested };
}

/**
 * Move the configured base past the spent resolution: a new real commit B2 on
 * `development` that edits the same line again, so H conflicts with B2 too.
 */
export async function moveBase(rig: HostedConflictRigV1): Promise<GitSha> {
  const { ctx } = rig;
  await Deno.writeTextFile(
    `${ctx.repo}/src/app.ts`,
    "export const value = 'upstream-2';\n",
  );
  await ctx.git(["add", "-A"]);
  await ctx.git(["commit", "-q", "-m", "upstream 2"]);
  const moved = (await ctx.git(["rev-parse", "HEAD"])).trim() as GitSha;
  (rig.github as unknown as { options: { baseSha?: GitSha } }).options
    .baseSha = moved;
  return moved;
}

/**
 * The launcher's ordinary retry table over the rig's state at base `tip`
 * (its conflict-marker guard), applied and written like the retry pass does.
 * Returns the plans and the reported denials.
 */
export async function launcherRetries(
  rig: HostedConflictRigV1,
  tip: GitSha,
) {
  const read = await rig.hosted.state.readRepair();
  assert.ok(read.ok && read.value.status === "found");
  if (!read.ok || read.value.status !== "found") throw new Error("no state");
  const denials: string[] = [];
  const now = rig.hosted.clock.now();
  const plans = planHostedRetries(
    read.value.snapshot,
    now,
    SHA1,
    new Map([[hostedRepositoryKey(REPO), tip]]),
    new Set(),
    (denial) => denials.push(denial.reason),
  );
  if (plans.length > 0) {
    const next = applyHostedRetries(
      read.value.snapshot,
      read.value.head,
      plans,
      now,
    );
    const written = await rig.hosted.state.writeRepair(next, read.value.head);
    assert.ok(written.ok && written.value.status === "applied");
  }
  return { plans, denials };
}

/** One job's trusted mirror: a clone of the remote without M. */
export async function jobMirror(rig: HostedConflictRigV1, name: string) {
  const dir = `${rig.ctx.tmp}/${name}`;
  await rig.ctx.git(
    ["clone", "-q", "--no-hardlinks", rig.ctx.repo, dir],
    rig.ctx.tmp,
  );
  return dir;
}

export async function present(
  rig: HostedConflictRigV1,
  dir: string,
  sha: string,
): Promise<boolean> {
  return (await gitRun(dir, ["cat-file", "-e", `${sha}^{commit}`], rig.ctx.env))
    .ok;
}

export async function remoteRef(
  rig: HostedConflictRigV1,
  ref: string,
): Promise<string | null> {
  const read = await gitRun(
    rig.ctx.repo,
    ["rev-parse", "--verify", "--quiet", ref],
    rig.ctx.env,
  );
  return read.ok ? read.stdout.trim() : null;
}

export interface JobV1 {
  /** This job's mirror. */
  dir: string;
  /** Injected failure kind for every preservation of this job. */
  fail?: PortErrorKindV1;
}

/**
 * The preservation capability over the rig's remote (`ctx.repo`) and the
 * CURRENT job's mirror (each hosted job has its own), with the production
 * preserver's split: an absent operation ref needs the candidate objects in
 * THIS job's mirror and is created from it; an existing ref holding the exact
 * head is reconciled and its graph imported into this job's mirror. The
 * ancestry checks are the publication validator's.
 */
export function composeMirrorPreservation(
  rig: HostedConflictRigV1,
  job: { current: JobV1 },
) {
  const calls: CandidatePreservationRequestV1[] = [];
  const preserve = async (
    request: CandidatePreservationRequestV1,
  ): Promise<PortResultV1<void>> => {
    calls.push(structuredClone(request));
    const { dir, fail } = job.current;
    if (fail !== undefined) {
      return portError(fail, "injected preservation failure");
    }
    const { head, base, ref } = request.candidate;
    const existing = await remoteRef(rig, ref);
    if (existing !== null) {
      if (existing !== head) {
        return portError("conflict", "operation ref holds another head");
      }
      // Reconciliation imports the proved graph into this job's mirror.
      const fetched = await gitRun(
        dir,
        ["fetch", "-q", rig.ctx.repo, ref],
        rig.ctx.env,
      );
      if (!fetched.ok) {
        return portError("unavailable", "reconcile fetch failed");
      }
    } else {
      if (!await present(rig, dir, head)) {
        return portError(
          "unavailable",
          "candidate objects are not in this mirror",
        );
      }
      const pushed = await gitRun(dir, [
        "push",
        "-q",
        rig.ctx.repo,
        `${head}:${ref}`,
      ], rig.ctx.env);
      if (!pushed.ok) {
        return portError("unavailable", "create-only push failed");
      }
    }
    const ancestor = async (a: string) =>
      (await gitRun(dir, ["merge-base", "--is-ancestor", a, head], rig.ctx.env))
        .ok;
    if (!await ancestor(base)) return portError("invalid", "stale base");
    if (
      request.publishedHead !== null && !await ancestor(request.publishedHead)
    ) {
      return portError("invalid", "stale published head");
    }
    return portOk(undefined);
  };
  (rig.github as unknown as {
    lifecycle: { preserveCandidate: typeof preserve };
  }).lifecycle.preserveCandidate = preserve;
  return calls;
}

/** Pending, one charged cell, its run; nothing ingested yet. */
export async function chargedCell(rig: HostedConflictRigV1) {
  const first = await rig.runLoop();
  assert.notEqual(first.status, "state_error", JSON.stringify(first));
  const planned = await rig.plan();
  assert.equal(planned.plan.cells.length, 1, JSON.stringify(planned));
  const { result } = await rig.runCell(planned.plan, planned.plan.cells[0]);
  assert.equal(result.status, "completed");
  return {
    plan: planned.plan,
    result,
    merge: result.receipt!.candidate!.head!,
  };
}

export function ingestIn(
  rig: HostedConflictRigV1,
  dir: string,
  cell: {
    plan: MatrixPlanV1;
    result: MatrixCellResultV1;
  },
) {
  return ingestMatrixResults(rig.deps, cell.plan, [cell.result], {
    deadline: rig.hosted.clock.now() + HOUR,
    expectedProvider: PROVIDER,
    bundleImporter: createGitBundleImporter({
      repositoryDir: dir,
      bundlesDir: `${rig.ctx.tmp}/mirror-bundles`,
    }),
  });
}
