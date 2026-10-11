/** Hosted actions-candidates-preserve_test responsibility. */
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { CandidatePreservationV1 } from "../../src/contracts/work-record.ts";
import { GitReviewSnapshot } from "../../src/github/review-snapshot.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import { MemoryState } from "../repair/helpers.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import {
  BRANCH,
  candidateRecord,
  gitRun,
  makeCandidateCtx,
  objectPresent,
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
} from "./actions-candidates-preservation-fixture.ts";

Deno.test(
  "preserver: stores the exact candidate in a create-only ref and proves a fresh empty store",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const publishedHead = ctx.base;
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
          candidateState: { preserved: null, publishedHead },
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
      const durableBefore = structuredClone(state.repair);
      const mirrorPath = await mirror(ctx);
      const ensured: { taskId: string; head: GitSha }[] = [];
      const attempt = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: mirrorPath,
        publishedHead,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        ensure: (id, head) => {
          ensured.push({ taskId: id, head });
          return Promise.resolve(portOk(undefined));
        },
      });
      assert.ok(attempt.result.ok, JSON.stringify(attempt.result));
      assert.equal(await remoteSha(ctx, ref), ctx.head);
      assert.equal(await remoteSha(ctx, `refs/heads/${BRANCH}`), ctx.head);
      assert.equal(await remoteSha(ctx, "refs/heads/development"), ctx.base);
      assert.deepEqual(ensured, [{ taskId, head: ctx.head }]);
      assert.deepEqual(
        state.repair,
        durableBefore,
        "preservation never rewrites durable state",
      );
      assert.equal(attempt.pushes.length, 1);
      assert.deepEqual(attempt.pushes[0], {
        ref,
        sha: ctx.head,
        expected: null,
      });
      assert.ok(attempt.http.paths.length > 0);
      assert.ok(
        attempt.http.paths.every((path) => path.includes("/git/ref/")),
        "preservation never reads a PR/task/review surface",
      );
      // Exactly one candidate ref exists: the deterministic operation ref.
      const candidateRefs = await gitRun(
        ctx.bare,
        [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/sentinel-candidates",
        ],
        ctx.env,
      );
      assert.ok(candidateRefs.ok);
      assert.deepEqual(
        candidateRefs.stdout.trim().split("\n").filter(Boolean),
        [
          ref,
        ],
      );
      // The exact task-owned fresh store was cleaned up after settling.
      const leftovers = [...Deno.readDirSync(`${ctx.tmp}/home`)].filter(
        (entry) => entry.name.startsWith("sentinel-candidate-store-"),
      );
      assert.deepEqual(leftovers, []);

      // Recovery: delete the producer checkout and the source mirror, then run
      // the REAL preserver again from a NEW empty source with the original
      // unchanged state and intent. The exact operation ref already exists, so
      // the run must reconcile it without a push and without any
      // producer-loader call; the fresh-store durability proof still runs real.
      await Deno.remove(`${ctx.tmp}/work`, { recursive: true });
      await Deno.remove(mirrorPath, { recursive: true });
      const emptySource = `${ctx.tmp}/recovered.git`;
      await Deno.mkdir(emptySource, { recursive: true });
      assert.ok(
        (await gitRun(emptySource, ["init", "-q", "--bare"], ctx.env)).ok,
      );
      assert.equal(await objectPresent(emptySource, ctx.env, ctx.head), false);
      assert.equal(
        await objectPresent(emptySource, ctx.env, publishedHead),
        false,
      );
      const loaderCalls = ensured.length;
      const recovery = await preserveAttempt({
        ctx,
        state,
        taskId,
        sourcePath: emptySource,
        publishedHead,
        candidate: await candidateFor(
          taskId,
          ctx.base,
          ctx.head,
          CANDIDATE_OPERATION_KEY,
        ),
        ensure: (id, head) => {
          ensured.push({ taskId: id, head });
          return Promise.resolve(portOk(undefined));
        },
      });
      assert.ok(recovery.result.ok, JSON.stringify(recovery.result));
      const publication = await new GitReviewSnapshot({
        trustedPath: TRUSTED_PATH,
        repositoryDir: emptySource,
        gitExecutable: "git",
      }).validatePublication({
        base: ctx.base,
        head: ctx.head,
        publishedHead,
        protectedPaths: [],
      });
      assert.ok(
        publication.ok,
        `the resumed publication mirror must validate the retained candidate: ${
          JSON.stringify(publication)
        }`,
      );
      assert.equal(await objectPresent(emptySource, ctx.env, ctx.head), true);
      assert.equal(
        await objectPresent(emptySource, ctx.env, publishedHead),
        true,
      );
      assert.equal(
        recovery.pushes.length,
        0,
        "the exact existing operation ref is reconciled, never pushed again",
      );
      assert.equal(
        ensured.length,
        loaderCalls,
        "already durable objects need no producer-loader call",
      );
      assert.deepEqual(
        state.repair,
        durableBefore,
        "recovery never rewrites durable state",
      );
      const recoveredLeftovers = [...Deno.readDirSync(`${ctx.tmp}/home`)]
        .filter((entry) => entry.name.startsWith("sentinel-candidate-store-"));
      assert.deepEqual(
        recoveredLeftovers,
        [],
        "the successful real fresh-store proof cleans its store",
      );
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: missing or mismatched bindings write nothing",
  async () => {
    const ctx = await makeCandidateCtx();
    try {
      const taskId = CANDIDATE_TASK_ID;
      const ref = await candidatePreservationRef(
        { ...SELF_REPO },
        taskId,
        CANDIDATE_OPERATION_KEY,
      );
      const valid = await candidateFor(
        taskId,
        ctx.base,
        ctx.head,
        CANDIDATE_OPERATION_KEY,
      );
      const mirrorPath = await mirror(ctx);
      const preservationRecord = (overrides: Record<string, unknown> = {}) =>
        candidateRecord(ctx, {
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
          ...overrides,
        });
      const stateFor = (
        record: ReturnType<typeof candidateRecord>,
        entries = [submittedReservation(record)],
      ) => {
        const state = new MemoryState();
        state.repair = snapshot([record], entries);
        return state;
      };
      const noRecord = new MemoryState();
      noRecord.repair = snapshot([]);
      const legacy = stateFor(candidateRecord(ctx, {
        target: {
          base: ctx.base,
          branch: BRANCH,
          checkpoint: null,
          head: ctx.head,
          pr: 12,
        },
        intent: null,
      }));
      const record = preservationRecord();
      const wrongReservationOutcome = stateFor(
        record,
        [submittedReservation(record, {
          outcome: "reserved",
          settledAt: null,
        })],
      );
      const wrongReservationAttempt = stateFor(
        record,
        [submittedReservation(record, { attempt: 2 })],
      );
      const variants: {
        name: string;
        state: MemoryState;
        candidate: CandidatePreservationV1;
        publishedHead?: GitSha | null;
      }[] = [
        { name: "no record", state: noRecord, candidate: valid },
        {
          name: "legacy record without candidate state",
          state: legacy,
          candidate: valid,
        },
        {
          name: "unknown operation",
          state: stateFor(preservationRecord({
            intent: {
              kind: "implementation",
              key: CANDIDATE_OPERATION_KEY,
              startedAt: T0,
              branch: BRANCH,
              expectedHead: null,
              observedBase: ctx.base,
              pr: null,
              requestId: PRESERVATION_ID,
              resultId: null,
            },
          })),
          candidate: valid,
        },
        {
          name: "wrong operation key",
          state: stateFor(record),
          candidate: await candidateFor(
            taskId,
            ctx.base,
            ctx.head,
            `impl:${"b".repeat(64)}`,
          ),
        },
        {
          name: "wrong ref",
          state: stateFor(record),
          candidate: {
            ...valid,
            ref: await candidatePreservationRef(
              { ...SELF_REPO },
              taskId,
              `impl:${"c".repeat(64)}`,
            ),
          },
        },
        {
          name: "wrong head",
          state: stateFor(record),
          candidate: { ...valid, head: ctx.base },
        },
        {
          name: "published head mismatch",
          state: stateFor(record),
          candidate: valid,
          publishedHead: SHA1,
        },
        {
          name: "unsubmitted reservation",
          state: wrongReservationOutcome,
          candidate: valid,
        },
        {
          name: "attempt mismatch",
          state: wrongReservationAttempt,
          candidate: valid,
        },
      ];
      for (const variant of variants) {
        const attempt = await preserveAttempt({
          ctx,
          state: variant.state,
          taskId,
          sourcePath: mirrorPath,
          candidate: variant.candidate,
          publishedHead: variant.publishedHead,
        });
        assert.equal(attempt.result.ok, false, variant.name);
        assert.equal(attempt.pushes.length, 0, `${variant.name}: no push`);
        assert.equal(
          await remoteSha(ctx, variant.candidate.ref),
          null,
          `${variant.name}: no ref write`,
        );
      }
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: an existing different operation head conflicts and is never overwritten",
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
      // The same operation destination already carries a DIFFERENT exact SHA.
      assert.ok(
        (await gitRun(
          `${ctx.tmp}/work`,
          ["push", "-q", "origin", `${ctx.base}:${ref}`],
          ctx.env,
        )).ok,
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
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(
        attempt.result.ok ? null : attempt.result.error.kind,
        "conflict",
      );
      assert.equal(attempt.pushes.length, 0);
      assert.equal(await remoteSha(ctx, ref), ctx.base);
    } finally {
      await ctx.cleanup();
    }
  },
);

Deno.test(
  "preserver: a create race cannot overwrite the raced ref",
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
      // After the create-only guard validated the expected absence, another
      // writer creates the ref: the atomic receive-pack transaction must reject
      // our push and the raced SHA must survive.
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
        gitExtra: {
          // The nested push must actually create the raced ref: the outer
          // guard's hooks path is disabled for it, and a failure fails the
          // hook (no `|| true`) so a silent non-race can never pass.
          prePushHookExtra:
            `git -c core.hooksPath=/dev/null push 'file://${ctx.bare}' '${ctx.base}:${ref}' >/dev/null 2>&1`,
        },
      });
      assert.equal(attempt.result.ok, false);
      assert.equal(attempt.pushes.length, 1);
      assert.equal(await remoteSha(ctx, ref), ctx.base);
    } finally {
      await ctx.cleanup();
    }
  },
);
