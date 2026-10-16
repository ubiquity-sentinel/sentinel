/**
 * Generation-77 rollback behavior of the conflict-resolution states. A failed
 * generation 78 restored R77 (ab3613e02) once, and R77's OWN repair loop then
 * executes whatever a later runtime left: a pending resolution and a resolved
 * merge both run as an ordinary refresh that conflicts again and writes R77's
 * terminal block, with nothing charged and nothing pushed. R77's strict
 * matrix parser refuses a conflict-resolution cell, which is why generation
 * 78 kept the hosted route closed; generation 79 opens it with generation 78
 * as its rollback target (`conflict-resolution-gen78_test.ts`).
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { MatrixPlanV1 } from "../../src/contracts/matrix.ts";
import { parseMatrixPlanV1 } from "../../src/contracts/matrix.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import { baseRefreshIntentKey } from "../../src/repair/keys.ts";
import { REPO, SHA1, SHA2, T0 } from "../state/helpers.ts";
import {
  gen77Available,
  loadGen77Modules,
  loadGen77Parsers,
} from "../state/gen77-contracts.ts";
import {
  FakeClock,
  type FakeGithub,
  FakeIncidents,
  FakeReplay,
  MemoryState,
  repairConfigs,
} from "./helpers.ts";
import {
  BRANCH,
  conflictGithub,
  type ConflictGitV1,
  ConflictModel,
  conflictRig,
  makeConflictGit,
  PR,
  publishedCandidate,
  TRUSTED_AUTHOR,
} from "./conflict-resolution-rig.ts";
import { seededSnapshot } from "./loop-rig.ts";

const available = await gen77Available();

/** R77's own loop, budget, cooldown gate and refresh adapter over one rig. */
async function gen77Loop() {
  const loaded = await loadGen77Modules([
    "src/repair/loop.ts",
    "src/budget/mod.ts",
    "src/repair/github-cooldown.ts",
    "src/host/local-base-refresh.ts",
    "src/github/git-executor.ts",
  ]);
  // deno-lint-ignore no-explicit-any
  const [loop, budget, cooldown, refresh, executor] = loaded.modules as any[];
  return {
    dispose: loaded.dispose,
    async run(
      ctx: ConflictGitV1,
      github: FakeGithub,
      seed: WorkRecordV1,
    ): Promise<RepairStateSnapshotV1> {
      github.prepareBaseRefresh = refresh.createPrepareBaseRefresh({
        git: new executor.DenoGitExecutor({
          localDir: ctx.repo,
          remoteUrl: `file://${ctx.repo}`,
          gitHome: ctx.home,
        }),
        observer: {
          readPullRequest: (number: number) => github.readPullRequest(number),
          readRef: (ref: string) => github.readRef(ref),
        },
        baseBranch: "development",
        trustedPrAuthor: TRUSTED_AUTHOR,
      });
      const clock = new FakeClock(T0);
      const state = new MemoryState();
      const configs = repairConfigs({
        sessionBound: { maxDurationMs: 240_000, maxOutputChars: 200_000 },
      });
      const seeded = await state.writeRepair(seededSnapshot([seed]), null);
      assert.ok(seeded.ok);
      const outcome = await loop.runRepairCycle({
        clock,
        state,
        configs,
        controllerSha: SHA1,
        github,
        githubCooldown: new cooldown.DurableGitHubCooldownGate({
          state,
          clock,
        }),
        incidents: new FakeIncidents({ summaries: [], evidence: null }),
        replay: new FakeReplay(),
        model: new ConflictModel(ctx),
        budget: new budget.RollingStartBudget({ clock, state, configs }),
      }, { deadline: clock.now() + 60 * 60_000, stepLimit: 16 });
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const read = await state.readRepair();
      if (!read.ok || read.value.status !== "found") {
        throw new Error("no repair state");
      }
      return read.value.snapshot;
    },
  };
}

function refreshIntent(
  ctx: ConflictGitV1,
  record: WorkRecordV1,
  resultId: GitSha | null,
): WorkRecordV1 {
  return {
    ...record,
    intent: {
      kind: "base_refresh",
      key: baseRefreshIntentKey(PR, ctx.head, ctx.base),
      startedAt: record.updatedAt,
      branch: BRANCH,
      expectedHead: ctx.head,
      observedBase: ctx.base,
      pr: PR,
      requestId: null,
      resultId,
      failure: conflictMarker(ctx.base, record.updatedAt),
    },
  };
}

function assertTerminalConflict(
  ctx: ConflictGitV1,
  github: FakeGithub,
  state: RepairStateSnapshotV1,
): void {
  const work = state.work[0];
  assert.equal(work.nextStep, "blocked");
  assert.equal(
    work.blocker?.message,
    `base refresh has conflicts at ${ctx.base}`,
  );
  assert.equal(work.intent, null);
  assert.equal(work.target.pr, null);
  assert.equal(work.target.head, ctx.head, "the candidate H is retained");
  assert.equal(work.target.base, ctx.b0);
  assert.deepEqual(state.reservations, [], "nothing charged");
  assert.deepEqual(github.pushes, [], "nothing pushed");
  assert.equal(
    github.candidateRefs.get(`refs/heads/${BRANCH}`),
    ctx.head,
    "the published branch still carries H",
  );
}

Deno.test({
  name:
    "rollback: R77 runs a pending resolution as an ordinary refresh that terminal-blocks uncharged",
  ignore: !available,
  fn: async () => {
    const ctx = await makeConflictGit();
    const r77 = await gen77Loop();
    try {
      const github = conflictGithub(ctx);
      const pending = refreshIntent(ctx, await publishedCandidate(ctx), null);
      assertTerminalConflict(ctx, github, await r77.run(ctx, github, pending));
    } finally {
      await r77.dispose();
      await ctx.cleanup();
    }
  },
});

Deno.test({
  name:
    "rollback: R77 never publishes a resolved merge (it regenerates, conflicts and terminal-blocks)",
  ignore: !available,
  fn: async () => {
    const ctx = await makeConflictGit();
    const r77 = await gen77Loop();
    try {
      // A real resolved merge M produced by generation 78 before the rollback.
      const source = conflictRig(conflictGithub(ctx), new ConflictModel(ctx));
      await source.seed([await publishedCandidate(ctx)]);
      await source.run();
      const resolved = source.written.map((snapshot) => snapshot.work[0])
        .find((work) =>
          work.intent?.kind === "base_refresh" && work.intent.resultId !== null
        );
      assert.ok(resolved !== undefined, "generation 78 resolved the merge");
      const github = conflictGithub(ctx);
      const state = await r77.run(ctx, github, resolved);
      assertTerminalConflict(ctx, github, state);
      assert.deepEqual(github.preservationRequests, []);
    } finally {
      await r77.dispose();
      await ctx.cleanup();
    }
  },
});

Deno.test({
  name:
    "rollback: R77 terminal-blocks the pending resolution a hosted run of this tree writes",
  ignore: !available,
  fn: async () => {
    const ctx = await makeConflictGit();
    const r77 = await gen77Loop();
    try {
      const hosted = conflictRig(conflictGithub(ctx), new ConflictModel(ctx), {
        externalImplementations: true,
      });
      await hosted.seed([await publishedCandidate(ctx)]);
      await hosted.run();
      const pending = (await hosted.snapshot()).work[0];
      assert.equal(pending.intent?.kind, "base_refresh");
      assert.equal(pending.intent?.resultId, null);
      assert.equal(pending.intent?.failure?.kind, "conflict");
      const github = conflictGithub(ctx);
      assertTerminalConflict(ctx, github, await r77.run(ctx, github, pending));
    } finally {
      await r77.dispose();
      await ctx.cleanup();
    }
  },
});

/** One plan carrying one conflict-resolution cell request. */
function conflictPlan(request: Record<string, unknown>): unknown {
  return {
    version: "v1",
    kind: "matrix_plan",
    waveId: "1:1:repair",
    run: { runId: 1, runAttempt: 1, launcherSha: SHA1 },
    plannedAt: T0,
    cells: [{
      cellId: "a".repeat(64),
      taskId: "issue-1",
      repository: REPO,
      reservationId: "b".repeat(64),
      intentKey: `impl:${"b".repeat(64)}`,
      expectedBase: SHA1,
      runtimeSha: SHA1,
      generation: 78,
      requestDigest: "c".repeat(64),
      request: {
        taskId: "issue-1",
        repository: REPO,
        base: SHA1,
        issue: { number: 1, title: "issue 1", body: "" },
        evidence: [],
        model: "gpt-reserve",
        reasoning: "max",
        maxDurationMs: 240_000,
        maxOutputChars: 200_000,
        ...request,
      },
    }],
  };
}

const MERGE_HEAD = "d".repeat(40);

Deno.test("matrix model: a conflict-resolution request names a distinct candidate and base", () => {
  const plan: MatrixPlanV1 = parseMatrixPlanV1(
    conflictPlan({ checkoutBase: SHA2, mergeBase: MERGE_HEAD }),
  );
  assert.equal(plan.cells[0].request.mergeBase, MERGE_HEAD);
  assert.equal(plan.cells[0].request.checkoutBase, SHA2);
  for (
    const invalid of [
      { mergeBase: MERGE_HEAD },
      { checkoutBase: SHA2, mergeBase: SHA1 },
      { checkoutBase: SHA2, mergeBase: SHA2 },
      { checkoutBase: SHA2, mergeBase: "not-a-sha" },
    ]
  ) {
    assert.throws(
      () => parseMatrixPlanV1(conflictPlan(invalid)),
      JSON.stringify(invalid),
    );
  }
});

Deno.test({
  name:
    "rollback: R77's strict matrix parser refuses a conflict-resolution cell (why generation 78 kept the hosted route closed)",
  ignore: !available,
  fn: async () => {
    const r77 = await loadGen77Parsers();
    const ordinary = conflictPlan({ checkoutBase: SHA2 });
    assert.doesNotThrow(() => r77.parseMatrixPlanV1(ordinary));
    assert.throws(
      () =>
        r77.parseMatrixPlanV1(
          conflictPlan({ checkoutBase: SHA2, mergeBase: MERGE_HEAD }),
        ),
      /mergeBase/,
    );
  },
});
