/** Hosted actions-candidates-reconcile_test responsibility. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import { DenoReplayRuntime } from "../../src/replay/runtime.ts";
import { MemoryState } from "../repair/helpers.ts";
import { reservation, T0 } from "../state/helpers.ts";
import {
  BRANCH,
  candidateRecord,
  gitRun,
  makeCandidateCtx,
  SELF_REPO,
  snapshot,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";
import {
  CANDIDATE_OPERATION_KEY,
  CANDIDATE_TASK_ID,
  candidateFor,
  mirror,
  PRESERVATION_ID,
  preserveAttempt,
  remoteSha,
  submittedReservation,
  TruncatingFetchRuntime,
  UnsettledInitRuntime,
} from "./actions-candidates-preservation-fixture.ts";

Deno.test(
  "preserver: a lost push response reconciles with exactly one reread",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      // The real push APPLIES but its response is lost: the single authenticated
      // reread reconciles the exact head and no second push happens.
      let effects = 0;
      const lost = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        pushOverride: async (realPush, pushRef, sha, expected) => {
          const applied = await realPush(pushRef, sha, expected);
          assert.ok(applied.ok);
          effects++;
          return portOk("ambiguous");
        },
      });
      assert.ok(lost.result.ok, JSON.stringify(lost.result));
      assert.equal(effects, 1);
      assert.equal(lost.pushes.length, 1);
      assert.equal(await remoteSha(ctx, ref), ctx.head);

      // The ambiguous response did NOT apply: the reread proves absence and
      // no success is reported.
      const absentRef = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        `impl:${"d".repeat(64)}`,
      );
      const absentRecord = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: `impl:${"d".repeat(64)}`,
          startedAt: T0,
          branch: absentRef,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: "d".repeat(64),
          resultId: null,
        },
      });
      const absent = new MemoryState();
      absent.repair = snapshot([absentRecord], [
        reservation("d".repeat(64), {
          repository: { ...SELF_REPO },
          taskId: absentRecord.id,
          attempt: absentRecord.counters.attempts,
          head: ctx.base,
          purpose: "implementation",
          outcome: "submitted",
          settledAt: T0 + 5,
          proofRef: null,
        }),
      ]);
      const unconfirmed = await preserveAttempt({
        ctx,
        state: absent,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          `impl:${"d".repeat(64)}`,
        ),
        pushOverride: () => Promise.resolve(portOk("ambiguous")),
      });
      assert.equal(unconfirmed.result.ok, false);
      assert.equal(await remoteSha(ctx, absentRef), null);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: validator rejection does zero push",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      let ensured = 0;
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        // The candidate adds candidate.txt, which the base does not contain:
        // the protected entry changed and publication must be rejected.
        protectedPaths: ["candidate.txt"],
        ensure: () => {
          ensured++;
          return Promise.resolve(portOk(undefined));
        },
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(ensured, 1);
      assert.equal(attempt.pushes.length, 0);
      assert.equal(await remoteSha(ctx, ref), null);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: a truncated fresh-store fetch never reports preservation",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      const runtime = new TruncatingFetchRuntime(
        new DenoReplayRuntime(TRUSTED_PATH),
      );
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        runtime,
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(attempt.pushes.length, 1);
      assert.equal(
        await remoteSha(ctx, ref),
        ctx.head,
        "the ref exists but durability was not proved",
      );
      const leftovers = [...Deno.readDirSync(`${ctx.tmp}/home`)].filter(
        (entry) => entry.name.startsWith("sentinel-candidate-store-"),
      );
      assert.deepEqual(
        leftovers,
        [],
        "the failed proof still cleans its store",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: an unsettled proof child preserves its exact owned scratch",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key: CANDIDATE_OPERATION_KEY,
          startedAt: T0,
          branch: ref,
          expectedHead: ctx.head,
          observedBase: ctx.base,
          pr: null,
          requestId: PRESERVATION_ID,
          resultId: null,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record], [submittedReservation(record)]);
      const mirrorPath = await mirror(ctx);
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        runtime: new UnsettledInitRuntime(new DenoReplayRuntime(TRUSTED_PATH)),
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(attempt.pushes.length, 1);
      const kept = [...Deno.readDirSync(`${ctx.tmp}/home`)].filter(
        (entry) => entry.name.startsWith("sentinel-candidate-store-"),
      );
      assert.equal(
        kept.length,
        1,
        "an unproved child settlement preserves the exact owned store",
      );
      assert.equal(kept[0]!.isDirectory, true);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: a persisted base_refresh result keeps the original descriptor",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const work = `${ctx.tmp}/work`;
      assert.ok(
        (await gitRun(work, ["checkout", "-q", "development"], ctx.env)).ok,
      );
      await Deno.writeTextFile(`${work}/refresh-base.txt`, "new base\n");
      assert.ok((await gitRun(work, ["add", "-A"], ctx.env)).ok);
      assert.ok(
        (await gitRun(work, ["commit", "-q", "-m", "new base"], ctx.env)).ok,
      );
      const newBase = (await gitRun(work, ["rev-parse", "HEAD"], ctx.env))
        .stdout.trim() as GitSha;
      const executor = new DenoGitExecutor({
        localDir: work,
        remoteUrl: ctx.bare,
        gitHome: `${ctx.tmp}/home`,
      });
      const integrated = await executor.integrateBase(ctx.head, newBase);
      assert.ok(integrated.ok, JSON.stringify(integrated));
      const prepared = integrated.value;
      assert.ok(
        (await gitRun(
          work,
          ["branch", "-q", "sentinel-prepared", prepared],
          ctx.env,
        )).ok,
      );
      const mirrorPath = await mirror(ctx);
      const taskId = CANDIDATE_TASK_ID;
      const implRef = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const refreshKey = baseRefreshIntentKey(12, ctx.head, newBase);
      const refreshRef = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        refreshKey,
      );
      const preserved = {
        operationKey: CANDIDATE_OPERATION_KEY,
        base: ctx.base,
        head: ctx.head,
        ref: implRef,
      };
      const record = candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
          candidateState: { preserved, publishedHead: null },
        },
        intent: {
          kind: "base_refresh",
          key: refreshKey,
          startedAt: T0,
          branch: BRANCH,
          expectedHead: ctx.head,
          observedBase: newBase,
          pr: 12,
          requestId: null,
          resultId: prepared,
        },
      });
      const state = new MemoryState();
      state.repair = snapshot([record]);
      const durableBefore = structuredClone(state.repair);
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        candidate: {
          operationKey: refreshKey,
          base: newBase,
          head: prepared,
          ref: refreshRef,
        },
      });
      assert.ok(attempt.result.ok, JSON.stringify(attempt.result));
      assert.equal(await remoteSha(ctx, refreshRef), prepared);
      assert.deepEqual(
        state.repair,
        durableBefore,
        "the original descriptor and the old target binding are never rewritten",
      );
      assert.equal(
        await remoteSha(ctx, implRef),
        null,
        "the retained original ref is not replaced by the refresh",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);
