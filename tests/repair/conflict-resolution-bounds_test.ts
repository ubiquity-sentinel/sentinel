/**
 * Bounds of the base-refresh conflict resolution through the REAL loop:
 * at most one charge per (task, base tip), a failed or unresolvable
 * resolution keeps the block with no loop and no refund, a protected path or
 * a merge missing the base never publishes, the round ceiling keeps today's
 * exact terminal block, a hosted run writes the uncharged pending resolution
 * and defers its admission to the trusted matrix planner, and a base that
 * moves before admission clears the pending intent with nothing charged.
 * Every snapshot written here parses under the generation-77 and generation-78
 * rollback runtimes.
 */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { createLocalRepositoryConfig } from "../../src/host/local-config.ts";
import {
  CONFLICT_RESOLUTION_REVIEW_ROUNDS,
  conflictMarker,
  conflictMarkerBase,
  HOSTED_CONFLICT_RESOLUTIONS,
} from "../../src/repair/conflict-resolution.ts";
import { baseRefreshIntentKey } from "../../src/repair/keys.ts";
import {
  isMatrixImplementationReadyV1,
  isModelStartAction,
} from "../../src/repair/loop-eligibility.ts";
import { HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS } from "../../ops/hosted-autonomy-policy.ts";
import {
  assertGen77Parses,
  assertGen78Parses,
  gen77Available,
  gen78Available,
} from "../state/gen77-contracts.ts";
import {
  BRANCH,
  conflictGithub,
  ConflictModel,
  conflictRig,
  makeConflictGit,
  PR,
  publishedCandidate,
  type ResolverOptionsV1,
} from "./conflict-resolution-rig.ts";

const POLL = 5 * 60_000;

async function scenario(
  resolver: ResolverOptionsV1,
  overrides: Partial<WorkRecordV1> = {},
  options: {
    externalImplementations?: boolean;
    extraBase?: Record<string, string>;
    runs?: number;
  } = {},
) {
  const ctx = await makeConflictGit({ extraBase: options.extraBase });
  const github = conflictGithub(ctx);
  const model = new ConflictModel(ctx, resolver);
  const rig = conflictRig(github, model, {
    externalImplementations: options.externalImplementations,
  });
  await rig.seed([await publishedCandidate(ctx, overrides)]);
  for (let run = 0; run < (options.runs ?? 1); run++) {
    const outcome = await rig.run();
    assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
    rig.clock.advance(POLL + 1000);
  }
  const state = await rig.snapshot();
  return { ctx, github, model, rig, state, work: state.work[0] };
}

function charges(state: RepairStateSnapshotV1) {
  return state.reservations.filter((row) =>
    row.purpose === "implementation" || row.purpose === "retry"
  );
}

Deno.test("conflict resolution: the hosted route is open, the round ceiling is the review ceiling and the decision files are protected", () => {
  assert.equal(HOSTED_CONFLICT_RESOLUTIONS, true);
  assert.equal(
    CONFLICT_RESOLUTION_REVIEW_ROUNDS,
    HOSTED_AUTONOMY_MAX_REVIEW_ROUNDS,
  );
  const protectedPaths = createLocalRepositoryConfig().protectedPaths;
  for (
    const path of [
      "src/repair/conflict-resolution.ts",
      "src/repair/loop-conflict-resolution.ts",
      "src/repair/model-port-checkout.ts",
      "ops/hosted-autonomy-conflict-retries.ts",
    ]
  ) assert.ok(protectedPaths.includes(path), path);
});

Deno.test(
  "conflict resolution: an incomplete session stays charged and blocked with the marker, never a second charge",
  async () => {
    const run = await scenario({ outcome: "failed" }, {}, { runs: 4 });
    try {
      assert.equal(run.work.nextStep, "blocked");
      assert.equal(run.model.requests.length, 1, "one start across cycles");
      const charged = charges(run.state);
      assert.equal(charged.length, 1);
      assert.equal(charged[0].outcome, "ambiguous", "charged, not refunded");
      assert.equal(run.work.intent?.kind, "implementation");
      assert.equal(
        conflictMarkerBase(run.work.intent),
        run.ctx.base,
        "the spent base tip stays on the retained intent",
      );
      assert.equal(run.work.target.head, run.ctx.head, "H is kept");
      assert.deepEqual(run.github.pushes, []);
      assert.deepEqual(run.github.preservationRequests, []);
      const config = run.rig.configs[0];
      assert.ok(
        !isMatrixImplementationReadyV1(
          run.work,
          run.state,
          config,
          run.rig.clock.now(),
          true,
          true,
        ),
      );
      assert.ok(!isModelStartAction(run.state, run.work, true, true));
    } finally {
      await run.ctx.cleanup();
    }
  },
);

Deno.test(
  "conflict resolution: an aborted merge produces no candidate and keeps the block",
  async () => {
    const run = await scenario({ abort: true }, {}, { runs: 2 });
    try {
      assert.equal(run.work.nextStep, "blocked");
      assert.equal(run.model.requests.length, 1);
      assert.equal(charges(run.state).length, 1);
      assert.equal(conflictMarkerBase(run.work.intent), run.ctx.base);
      assert.deepEqual(run.github.pushes, []);
    } finally {
      await run.ctx.cleanup();
    }
  },
);

Deno.test(
  "conflict resolution: a resolution touching a protected path is charged and never published",
  async () => {
    const run = await scenario(
      { extra: { "src/handler.ts": "export const handled = true;\n" } },
      {},
      { runs: 2 },
    );
    try {
      assert.equal(run.work.nextStep, "blocked");
      assert.equal(
        run.work.blocker?.message,
        "candidate touches a protected path",
      );
      const charged = charges(run.state);
      assert.equal(charged.length, 1);
      assert.equal(charged[0].outcome, "submitted");
      assert.equal(conflictMarkerBase(run.work.intent), run.ctx.base);
      assert.equal(run.work.target.head, run.ctx.head);
      assert.deepEqual(run.github.pushes, []);
      assert.deepEqual(run.github.preservationRequests, []);
    } finally {
      await run.ctx.cleanup();
    }
  },
);

Deno.test(
  "conflict resolution: a protected path changed only by the base is not the candidate's",
  async () => {
    const run = await scenario(
      {},
      {},
      { extraBase: { "src/handler.ts": "export const upstream = 2;\n" } },
    );
    try {
      assert.equal(run.work.blocker, null, JSON.stringify(run.work.blocker));
      assert.equal(run.work.nextStep, "review");
      assert.equal(run.work.target.head, run.model.heads[0]);
      assert.equal(run.github.pushes.length, 1);
    } finally {
      await run.ctx.cleanup();
    }
  },
);

Deno.test(
  "conflict resolution: a merge missing the base is refused by preservation and never pushed",
  async () => {
    const run = await scenario({ skipMerge: true }, {}, { runs: 5 });
    try {
      assert.equal(run.work.nextStep, "blocked");
      assert.match(
        run.work.blocker?.message ?? "",
        /^base refresh failed 3 consecutive times: invalid /,
      );
      const charged = charges(run.state);
      assert.equal(charged.length, 1, "one charge, never a second");
      assert.equal(charged[0].outcome, "submitted");
      assert.equal(run.model.requests.length, 1);
      assert.ok(run.github.preservationRequests.length >= 1);
      assert.deepEqual(run.github.pushes, [], "nothing is ever published");
      assert.equal(run.work.target.head, run.ctx.head, "H is kept");
    } finally {
      await run.ctx.cleanup();
    }
  },
);

Deno.test(
  "conflict resolution: a spent review allowance keeps the exact terminal conflict block",
  async () => {
    const run = await scenario({}, {
      counters: {
        attempts: 1,
        retries: 0,
        reviewRounds: CONFLICT_RESOLUTION_REVIEW_ROUNDS,
      },
    });
    try {
      assert.equal(run.work.nextStep, "blocked");
      assert.equal(
        run.work.blocker?.message,
        `base refresh has conflicts at ${run.ctx.base}`,
      );
      assert.equal(run.work.target.pr, null);
      assert.equal(run.work.intent, null);
      assert.deepEqual(run.state.reservations, []);
      assert.equal(run.model.requests.length, 0);
    } finally {
      await run.ctx.cleanup();
    }
  },
);

Deno.test(
  "conflict resolution: a hosted run writes the uncharged pending resolution and never starts a model in process",
  async () => {
    const run = await scenario({}, {}, { externalImplementations: true });
    try {
      assert.equal(run.work.nextStep, "work");
      assert.equal(run.work.blocker, null, JSON.stringify(run.work.blocker));
      assert.equal(run.work.target.pr, PR, "the PR identity is kept");
      assert.equal(run.work.target.head, run.ctx.head);
      assert.equal(run.work.intent?.kind, "base_refresh");
      assert.equal(run.work.intent?.resultId, null);
      assert.equal(conflictMarkerBase(run.work.intent), run.ctx.base);
      assert.deepEqual(run.state.reservations, [], "nothing charged");
      assert.equal(run.model.requests.length, 0, "the matrix admits it");
      assert.deepEqual(run.github.pushes, []);
      for (const snapshot of run.rig.written) {
        if (await gen78Available()) await assertGen78Parses(snapshot);
      }
    } finally {
      await run.ctx.cleanup();
    }
  },
);

/** A record carrying the marked refresh intent of (PR, H, B). */
async function marked(
  ctx: Awaited<ReturnType<typeof makeConflictGit>>,
  resultId: GitSha | null,
): Promise<WorkRecordV1> {
  const record = await publishedCandidate(ctx);
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

Deno.test(
  "conflict resolution: a hosted run defers a pending resolution to the matrix planner, writing nothing",
  async () => {
    const ctx = await makeConflictGit();
    try {
      const github = conflictGithub(ctx);
      const model = new ConflictModel(ctx);
      const rig = conflictRig(github, model, { externalImplementations: true });
      const pending = await marked(ctx, null);
      await rig.seed([pending]);
      const outcome = await rig.run();
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const state = await rig.snapshot();
      assert.deepEqual(state.work[0], pending, "left for the planner");
      assert.deepEqual(state.reservations, []);
      assert.equal(model.requests.length, 0);
      assert.deepEqual(github.pushes, []);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "conflict resolution: a resolved merge whose pull request was closed keeps the terminal conflict block",
  async () => {
    const ctx = await makeConflictGit();
    try {
      const github = conflictGithub(ctx);
      const pull = github.candidatePullRequests.get(PR)!;
      github.candidatePullRequests.set(PR, { ...pull, state: "closed" });
      const rig = conflictRig(github, new ConflictModel(ctx));
      await rig.seed([await marked(ctx, "e".repeat(40) as GitSha)]);
      await rig.run();
      const state = await rig.snapshot();
      assert.equal(state.work[0].nextStep, "blocked");
      assert.equal(
        state.work[0].blocker?.message,
        `base refresh has conflicts at ${ctx.base}`,
      );
      assert.equal(state.work[0].target.pr, null);
      assert.equal(state.work[0].target.head, ctx.head);
      assert.deepEqual(github.pushes, []);
      assert.deepEqual(github.preservationRequests, []);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "conflict resolution: a base that moves before admission clears the pending intent with nothing charged",
  async () => {
    const ctx = await makeConflictGit();
    try {
      // The pending resolution was planned against B, but the configured base
      // already moved on to B2.
      const moved = "b2".repeat(20) as GitSha;
      const github = conflictGithub(ctx, { baseSha: moved });
      const model = new ConflictModel(ctx);
      const rig = conflictRig(github, model);
      await rig.seed([await marked(ctx, null)]);
      const outcome = await rig.run(1);
      assert.notEqual(outcome.status, "state_error");
      const state = await rig.snapshot();
      assert.equal(state.work[0].intent, null, "only the intent is cleared");
      assert.equal(state.work[0].nextStep, "work");
      assert.equal(state.work[0].target.pr, PR);
      assert.equal(state.work[0].target.head, ctx.head);
      assert.deepEqual(state.reservations, [], "nothing charged");
      assert.equal(model.requests.length, 0);
      for (const snapshot of rig.written) {
        if (await gen77Available()) await assertGen77Parses(snapshot);
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test({
  name:
    "rollback: every bounded conflict-resolution snapshot parses under the generation-77 and generation-78 runtimes",
  ignore: !(await gen77Available()),
  fn: async () => {
    const cases: [ResolverOptionsV1, number][] = [
      [{ outcome: "failed" }, 2],
      [{ extra: { "src/handler.ts": "export const handled = true;\n" } }, 2],
      [{ skipMerge: true }, 5],
    ];
    for (const [resolver, runs] of cases) {
      const run = await scenario(resolver, {}, { runs });
      try {
        assert.ok(run.rig.written.length > 0);
        for (const snapshot of run.rig.written) {
          await assertGen77Parses(snapshot);
          if (await gen78Available()) await assertGen78Parses(snapshot);
        }
      } finally {
        await run.ctx.cleanup();
      }
    }
  },
});
