/**
 * Owner-landing publication through the REAL preserver and its real Git
 * publication validator: a candidate changing a protected path is refused
 * unless its durable record names that path in its owner-landing flag; a
 * CI-executable protected path is refused even when the flag names it.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { PUBLICATION_PROTECTED_DETAIL } from "../../src/github/snapshot-policy.ts";
import { candidatePreservationRef } from "../../src/repair/keys.ts";
import { MemoryState } from "../repair/helpers.ts";
import { T0 } from "../state/helpers.ts";
import {
  BRANCH,
  candidateRecord,
  makeCandidateCtx,
  SELF_REPO,
  snapshot,
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

/** The fixture candidate commit adds exactly `candidate.txt`. */
const CANDIDATE_FILE = "candidate.txt";

async function attempt(
  protectedPaths: readonly string[],
  ownerLanding: WorkRecordV1["ownerLanding"],
) {
  const ctx = await makeCandidateCtx();
  const taskId = CANDIDATE_TASK_ID;
  const ref = await candidatePreservationRef(
    { ...SELF_REPO },
    taskId,
    CANDIDATE_OPERATION_KEY,
  );
  const base = candidateRecord(ctx, {
    target: {
      base: ctx.base,
      branch: BRANCH,
      checkpoint: null,
      head: ctx.head,
      pr: null,
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
  const record = ownerLanding === undefined ? base : { ...base, ownerLanding };
  const state = new MemoryState();
  state.repair = snapshot([record], [submittedReservation(record)]);
  const result = await preserveAttempt({
    ctx,
    state,
    taskId,
    sourcePath: await mirror(ctx),
    publishedHead: null,
    protectedPaths,
    candidate: await candidateFor(
      taskId,
      ctx.base,
      ctx.head,
      CANDIDATE_OPERATION_KEY,
    ),
    ensure: () => Promise.resolve(portOk(undefined)),
  });
  return { ctx, ref, result };
}

Deno.test("owner landing preserver: an unflagged protected change is refused before any push", async () => {
  const { ctx, ref, result } = await attempt([CANDIDATE_FILE], undefined);
  try {
    assert.ok(!result.result.ok);
    assert.equal(result.result.error.detail, PUBLICATION_PROTECTED_DETAIL);
    assert.equal(result.pushes.length, 0);
    assert.equal(await remoteSha(ctx, ref), null);
  } finally {
    await ctx.cleanup();
  }
});

Deno.test("owner landing preserver: the flagged protected change is preserved and published", async () => {
  const { ctx, ref, result } = await attempt(
    [CANDIDATE_FILE, ".github/workflows/"],
    { paths: [CANDIDATE_FILE], since: T0 },
  );
  try {
    assert.ok(result.result.ok, JSON.stringify(result.result));
    assert.equal(await remoteSha(ctx, ref), ctx.head);
  } finally {
    await ctx.cleanup();
  }
});
