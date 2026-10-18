import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import { createCandidatePreserver } from "../../src/host/actions-candidates.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import { QUEUE_REPO } from "../github/merge-queue-fixtures.ts";
import { inactiveNativeQueueFixture } from "../github/native-queue-fixture.ts";
import { FakeClock, MemoryState } from "../repair/helpers.ts";
import { T0 } from "../state/helpers.ts";
import {
  BRANCH,
  candidateRecord,
  FakeGate,
  makeCandidateCtx,
  snapshot,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";
import {
  CANDIDATE_OPERATION_KEY,
  CANDIDATE_TASK_ID,
  PRESERVATION_ID,
  submittedReservation,
} from "./actions-candidates-preservation-fixture.ts";

Deno.test("native host preserver binds queue custody to the work record before operation-ref push", async (t) => {
  const ctx = await makeCandidateCtx();
  try {
    for (
      const phase of ["entry", "before_push", "capability_missing"] as const
    ) {
      await t.step(phase, async () => {
        const ref = await candidatePreservationRef(
          QUEUE_REPO,
          CANDIDATE_TASK_ID,
          CANDIDATE_OPERATION_KEY,
        );
        const record = candidateRecord(ctx, {
          repository: QUEUE_REPO,
          target: {
            base: ctx.base,
            head: ctx.head,
            branch: BRANCH,
            checkpoint: null,
            pr: 7,
            candidateState: { preserved: null, publishedHead: ctx.base },
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
        state.repair = snapshot([record], [
          submittedReservation(record, { repository: QUEUE_REPO }),
        ]);
        const before = structuredClone(state.repair);
        let member = phase === "entry";
        let pushes = 0;
        let reads = 0;
        const preserve = createCandidatePreserver({
          state,
          gate: new FakeGate(),
          token: "dummy-token",
          clock: new FakeClock(T0),
          http: () => Promise.reject(new Error("unexpected HTTP")),
          repository: QUEUE_REPO,
          sourcePath: `${ctx.tmp}/work`,
          scratch: `${ctx.tmp}/home`,
          trustedPath: TRUSTED_PATH,
          gitExecutable: "git",
          remoteUrl: `file://${ctx.bare}`,
          protectedPaths: [],
          ensureLocalCandidate: () => {
            member = true;
            return Promise.resolve(portOk(undefined));
          },
          port: {
            ...(phase === "capability_missing" ? {} : {
              nativeQueue: {
                ...inactiveNativeQueueFixture(),
                inspect: (input) => {
                  assert.deepEqual(input.record, record);
                  assert.equal(input.expectedHead, ctx.base);
                  return Promise.resolve(
                    member
                      ? {
                        status: "hold" as const,
                        reason: "member" as const,
                        pull: null,
                      }
                      : {
                        status: "allow" as const,
                        basis: "native_absent" as const,
                      },
                  );
                },
              },
            }),
            readRef: () => {
              reads++;
              return Promise.resolve(portOk(null));
            },
            pushHead: () => {
              pushes++;
              return Promise.resolve(portOk("applied" as const));
            },
          },
        });
        const result = await preserve({
          taskId: record.id,
          candidate: {
            operationKey: CANDIDATE_OPERATION_KEY,
            base: ctx.base,
            head: ctx.head,
            ref,
          },
          publishedHead: ctx.base,
        });
        assert.equal(result.ok, false);
        if (!result.ok) {
          assert.match(result.error.detail, /^native queue custody/);
        }
        assert.equal(pushes, 0);
        assert.equal(reads, phase === "before_push" ? 1 : 0);
        assert.deepEqual(state.repair, before);
      });
    }
  } finally {
    await ctx.cleanup();
  }
});
