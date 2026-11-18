/**
 * Rollback behavior of the OPEN hosted conflict-resolution route against
 * generation 78. A failed generation 79 restores R78 (474f87eb6), whose
 * hosted route stays closed, and R78's OWN hosted repair loop and matrix
 * planner (extracted from the pinned commit) then run over whatever
 * generation 79 left in state. Each state below is produced by this tree's
 * hosted route (`matrix-conflict-hosted-rig.ts`) over real Git:
 *
 * - pending (marked refresh intent, PR kept): R78 runs it as an ordinary
 *   refresh that conflicts and writes its terminal block, uncharged and
 *   unpushed; its planner grants no cell;
 * - in flight (marked implementation intent, `reserved` charge), fresh or
 *   stale: R78's loop and planner leave it exactly as found;
 * - resolved (refresh intent with result M and marker): R78 publishes M like
 *   generation 79 does (preserved, lease-pushed over H, advanced, reviewed),
 *   also from a fresh job's EMPTY mirror, by reconciling the operation ref
 *   generation 79's ingest preserved M under before consuming the receipt;
 * - advanced, and every charged failure (incomplete, never started, protected
 *   path): R78 writes nothing.
 *
 * The cases are ignored in a checkout without R78.
 */
import assert from "node:assert/strict";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { parseRepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { STALE_IMPLEMENTATION_INTENT_TTL_MS } from "../../src/repair/loop-eligibility.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import { REPO, SHA1 } from "../state/helpers.ts";
import { gen78Available, loadGen78Modules } from "../state/gen77-contracts.ts";
import { FakeIncidents, FakeReplay } from "./helpers.ts";
import { BRANCH, PR, TASK, TRUSTED_AUTHOR } from "./conflict-resolution-rig.ts";
import {
  type CellOptionsV1,
  chargedCell,
  composeMirrorPreservation,
  hostedConflictRig,
  type HostedConflictRigV1,
  ingestIn,
  jobMirror,
  type JobV1,
  launcherRetries,
  moveBase,
  NO_MODEL,
  present,
  remoteRef,
  resolveHosted,
} from "../host/matrix-conflict-hosted-rig.ts";

const available = await gen78Available();
const HOUR = 60 * 60_000;

/** R78's own hosted loop and planner over one rig's state and GitHub. */
async function loadR78() {
  const loaded = await loadGen78Modules([
    "src/repair/loop.ts",
    "src/budget/mod.ts",
    "src/repair/github-cooldown.ts",
    "src/host/local-base-refresh.ts",
    "src/github/git-executor.ts",
    "src/host/matrix.ts",
    "src/repair/conflict-resolution.ts",
  ]);
  const [loop, budget, cooldown, refresh, executor, matrix, conflict] =
    // deno-lint-ignore no-explicit-any
    loaded.modules as any[];
  const deps = (rig: HostedConflictRigV1) => {
    const { ctx, github } = rig;
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
    const { clock, state, configs } = rig.hosted;
    return {
      clock,
      state,
      configs,
      controllerSha: SHA1,
      github,
      githubCooldown: new cooldown.DurableGitHubCooldownGate({ state, clock }),
      incidents: new FakeIncidents({ summaries: [], evidence: null }),
      replay: new FakeReplay(),
      model: NO_MODEL,
      budget: new budget.RollingStartBudget({ clock, state, configs }),
      externalImplementations: true,
    };
  };
  return {
    hostedRouteOpen: conflict.HOSTED_CONFLICT_RESOLUTIONS as boolean,
    dispose: loaded.dispose,
    /** One R78 hosted loop run, then one R78 hosted planner wave. */
    async run(rig: HostedConflictRigV1) {
      const r78 = deps(rig);
      const outcome = await loop.runRepairCycle(r78, {
        deadline: r78.clock.now() + HOUR,
        stepLimit: 16,
      });
      assert.notEqual(outcome.status, "state_error", JSON.stringify(outcome));
      const afterLoop = await rig.hosted.snapshot();
      const report = await matrix.planMatrixWave(r78, {
        waveId: "wave-rollback-78",
        run: { runId: 80, runAttempt: 1, launcherSha: SHA1 },
        runtimeSha: SHA1,
        generation: 80,
        plannedAt: r78.clock.now(),
        deadline: r78.clock.now() + HOUR,
      });
      const afterPlan = await rig.hosted.snapshot();
      return { afterLoop, afterPlan, cells: report.plan.cells.length };
    },
  };
}

type R78 = Awaited<ReturnType<typeof loadR78>>;

function charges(state: RepairStateSnapshotV1) {
  return state.reservations.filter((row) =>
    row.purpose === "implementation" || row.purpose === "retry"
  );
}

/** R78 leaves the state generation 79 wrote exactly as found. */
async function assertUntouched(r78: R78, rig: HostedConflictRigV1) {
  const before = await rig.hosted.snapshot();
  const pushes = rig.github.pushes.length;
  const { afterLoop, afterPlan, cells } = await r78.run(rig);
  assert.deepEqual(afterLoop, before, "R78's loop writes nothing");
  assert.deepEqual(afterPlan, before, "R78's planner writes nothing");
  assert.equal(cells, 0, "R78 grants no cell");
  assert.equal(rig.github.pushes.length, pushes, "R78 pushes nothing");
}

Deno.test({
  name:
    "rollback to generation 78: R78 keeps the hosted route closed and terminal-blocks a pending resolution uncharged",
  ignore: !available,
  async fn() {
    const r78 = await loadR78();
    const rig = await hostedConflictRig();
    try {
      assert.equal(r78.hostedRouteOpen, false, "R78 keeps it closed");
      await rig.runLoop();
      const pending = (await rig.hosted.snapshot()).work[0];
      assert.equal(pending.intent?.kind, "base_refresh");
      assert.equal(pending.intent?.resultId, null);
      const { afterLoop, afterPlan, cells } = await r78.run(rig);
      const work = afterLoop.work[0];
      assert.equal(work.nextStep, "blocked");
      assert.equal(
        work.blocker?.message,
        `base refresh has conflicts at ${rig.ctx.base}`,
      );
      assert.equal(work.intent, null);
      assert.equal(work.target.pr, null);
      assert.equal(work.target.head, rig.ctx.head, "H is retained");
      assert.deepEqual(afterLoop.reservations, [], "nothing charged");
      assert.deepEqual(rig.github.pushes, [], "nothing pushed");
      assert.equal(cells, 0);
      assert.deepEqual(afterPlan, afterLoop, "R78's planner writes nothing");
      parseRepairStateSnapshotV1(structuredClone(afterLoop));
    } finally {
      await rig.cleanup();
      await r78.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 78: R78 leaves an in-flight resolution (fresh or stale) and its reserved charge untouched",
  ignore: !available,
  async fn(t) {
    const r78 = await loadR78();
    try {
      for (const stale of [false, true]) {
        await t.step(stale ? "stale" : "fresh", async () => {
          const rig = await hostedConflictRig();
          try {
            await rig.runLoop();
            const planned = await rig.plan();
            assert.equal(planned.plan.cells.length, 1);
            const inFlight = await rig.hosted.snapshot();
            assert.equal(inFlight.work[0].intent?.kind, "implementation");
            assert.equal(inFlight.reservations[0].outcome, "reserved");
            if (stale) {
              rig.hosted.clock.advance(
                STALE_IMPLEMENTATION_INTENT_TTL_MS + 60_000,
              );
            }
            await assertUntouched(r78, rig);
          } finally {
            await rig.cleanup();
          }
        });
      }
    } finally {
      await r78.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 78: R78 publishes a resolved merge exactly like generation 79 (preserve, lease-push over H, advance, review)",
  ignore: !available,
  async fn() {
    const r78 = await loadR78();
    const rig = await hostedConflictRig();
    try {
      await resolveHosted(rig);
      const resolved = (await rig.hosted.snapshot()).work[0];
      const merged = resolved.intent?.resultId;
      assert.ok(typeof merged === "string");
      // Generation 79's ingest preserved M before consuming the receipt; R78
      // reconciles that exact operation.
      const ingested = rig.github.preservationRequests.length;
      assert.equal(ingested, 1);
      const { afterLoop, cells } = await r78.run(rig);
      const key = baseRefreshIntentKey(PR, rig.ctx.head, rig.ctx.base);
      assert.equal(rig.github.preservationRequests.length, ingested + 1);
      assert.deepEqual(
        rig.github.preservationRequests[ingested],
        rig.github.preservationRequests[0],
      );
      assert.deepEqual(
        rig.github.preservationRequests[ingested].candidate.head,
        merged,
      );
      assert.equal(
        rig.github.preservationRequests[ingested].candidate.operationKey,
        key,
      );
      assert.deepEqual(rig.github.pushes, [{
        ref: `refs/heads/${BRANCH}`,
        sha: merged,
        expected: rig.ctx.head,
      }]);
      const work = afterLoop.work[0];
      assert.equal(work.blocker, null, JSON.stringify(work.blocker));
      assert.equal(work.nextStep, "review");
      assert.equal(work.target.head, merged);
      assert.equal(work.target.base, rig.ctx.base);
      assert.equal(work.target.pr, PR);
      assert.equal(rig.github.reviewRequestIdentities.length, 1);
      assert.equal(rig.github.reviewRequestIdentities[0].expectedHead, merged);
      assert.equal(charges(afterLoop).length, 1, "no further charge");
      assert.equal(charges(afterLoop)[0].outcome, "submitted");
      assert.equal(cells, 0);
      parseRepairStateSnapshotV1(structuredClone(afterLoop));
    } finally {
      await rig.cleanup();
      await r78.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 78: R78 publishes from an EMPTY mirror the merge generation 79's ingest preserved",
  ignore: !available,
  async fn() {
    const r78 = await loadR78();
    const rig = await hostedConflictRig();
    try {
      const ingestJob = await jobMirror(rig, "mirror-ingest-79");
      const rollbackJob = await jobMirror(rig, "mirror-rollback-78");
      const job = { current: { dir: ingestJob } as JobV1 };
      composeMirrorPreservation(rig, job);
      const cell = await chargedCell(rig);
      const report = await ingestIn(rig, ingestJob, cell);
      assert.equal(report.ingested, 1, JSON.stringify(report));
      const ref = await candidatePreservationRef(
        REPO,
        TASK,
        baseRefreshIntentKey(PR, rig.ctx.head, rig.ctx.base),
      );
      assert.equal(await remoteRef(rig, ref), cell.merge);
      // The failed generation 79 rolls back: R78 runs in a fresh job.
      job.current = { dir: rollbackJob };
      assert.equal(await present(rig, rollbackJob, cell.merge), false);
      const { afterLoop } = await r78.run(rig);
      const work = afterLoop.work[0];
      assert.equal(work.blocker, null, JSON.stringify(work.blocker));
      assert.equal(work.target.head, cell.merge, "R78 published M");
      assert.equal(work.target.base, rig.ctx.base);
      assert.equal(work.target.pr, PR);
      assert.ok(await present(rig, rollbackJob, cell.merge));
      assert.deepEqual(rig.github.pushes, [{
        ref: `refs/heads/${BRANCH}`,
        sha: cell.merge,
        expected: rig.ctx.head,
      }]);
      assert.equal(charges(afterLoop).length, 1, "no further charge");
      assert.equal(charges(afterLoop)[0].outcome, "submitted");
    } finally {
      await rig.cleanup();
      await r78.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 78: R78 writes nothing for an advanced merge or a charged, blocked resolution",
  ignore: !available,
  async fn(t) {
    const r78 = await loadR78();
    try {
      const cases: [string, CellOptionsV1 & { notStarted?: boolean }][] = [
        ["advanced", {}],
        ["incomplete session", { failed: true }],
        ["never started", { notStarted: true }],
        ["protected path", {
          extra: { "src/handler.ts": "export const handled = true;\n" },
        }],
      ];
      for (const [name, options] of cases) {
        await t.step(name, async () => {
          const rig = await hostedConflictRig();
          try {
            await resolveHosted(rig, options);
            rig.hosted.clock.advance(60_000);
            const outcome = await rig.runLoop();
            assert.notEqual(outcome.status, "state_error");
            const written = (await rig.hosted.snapshot()).work[0];
            assert.equal(
              written.nextStep,
              name === "advanced" ? "review" : "blocked",
              JSON.stringify(written),
            );
            await assertUntouched(r78, rig);
          } finally {
            await rig.cleanup();
          }
        });
      }
    } finally {
      await r78.dispose();
    }
  },
});

Deno.test({
  name:
    "rollback to generation 78: the launcher's re-pend at a moved tip is an ordinary refresh under R78, terminal and uncharged",
  ignore: !available,
  async fn() {
    const r78 = await loadR78();
    const rig = await hostedConflictRig();
    try {
      await resolveHosted(rig, { failed: true });
      await rig.runLoop();
      const spent = await rig.hosted.snapshot();
      const moved = await moveBase(rig);
      assert.equal((await launcherRetries(rig, moved)).plans.length, 1);
      const { afterLoop, cells } = await r78.run(rig);
      const work = afterLoop.work[0];
      assert.equal(work.nextStep, "blocked");
      assert.equal(
        work.blocker?.message,
        `base refresh has conflicts at ${moved}`,
      );
      assert.equal(work.intent, null);
      assert.equal(work.target.head, rig.ctx.head, "H is retained");
      assert.deepEqual(afterLoop.reservations, spent.reservations, "uncharged");
      assert.deepEqual(rig.github.pushes, []);
      assert.equal(cells, 0);
    } finally {
      await rig.cleanup();
      await r78.dispose();
    }
  },
});
