/**
 * The REAL hosted preserver's binding of an in-flight conflict resolution
 * (real bare remote, real port push/CAS, real publication validator; only the
 * HTTP transport is fake and reads the same real remote refs).
 *
 * The hosted ingest preserves the trusted merge M of the published candidate
 * H and the marked base B under the deterministic refresh binding of
 * (PR, H, B) BEFORE it consumes the cell's receipt: the record still holds
 * the marked implementation intent and its one `reserved` charge. The
 * preserver accepts exactly that binding and nothing near it. Once the
 * receipt became the resolved refresh intent, a job with an EMPTY mirror
 * reconciles the same operation ref and imports M from the remote; without
 * that earlier preservation it cannot (M lives in no ref).
 */
import assert from "node:assert/strict";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import type {
  IncompleteOperationV1,
  WorkRecordV1,
} from "../../src/contracts/work-record.ts";
import { conflictMarker } from "../../src/repair/conflict-resolution.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import { MemoryState } from "../repair/helpers.ts";
import { reservation, T0 } from "../state/helpers.ts";
import {
  BRANCH,
  type CandidateCtxV1,
  candidateRecord,
  commitIn,
  gitRun,
  makeCandidateCtx,
  objectPresent,
  SELF_REPO,
  snapshot,
} from "./actions-candidates-fixture.ts";
import {
  candidateFor,
  mirror,
  preserveAttempt,
  remoteSha,
} from "./actions-candidates-preservation-fixture.ts";

const TASK = "candidates-1" as WorkItemId;
const PR = 12;
const CHARGE = "c".repeat(64);
const PRIOR = implementationIntentKey("d".repeat(64));

interface ConflictCtxV1 {
  ctx: CandidateCtxV1;
  /** The moved base the candidate H conflicts with. */
  moved: GitSha;
  /** The trusted merge M of H and B (parents H, B), in no remote ref. */
  merge: GitSha;
}

/** B on the remote's development; M = merge(H, B) only in the producer. */
async function conflictCtx(): Promise<ConflictCtxV1> {
  const ctx = await makeCandidateCtx();
  const work = `${ctx.tmp}/work`;
  const run = async (args: string[]) => {
    const result = await gitRun(work, args, ctx.env);
    assert.ok(result.ok, `${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await run(["checkout", "-q", "development"]);
  const moved = await commitIn(work, ctx.env, "upstream");
  await run(["push", "-q", "origin", "development"]);
  await run(["checkout", "-q", BRANCH]);
  await run(["merge", "-q", "--no-ff", "--no-edit", moved]);
  const merge = await run(["rev-parse", "HEAD"]) as GitSha;
  assert.deepEqual(
    (await run(["rev-list", "--parents", "-n", "1", merge])).split(" ").slice(
      1,
    ),
    [ctx.head, moved],
  );
  return { ctx, moved, merge };
}

async function published(ctx: CandidateCtxV1, intent: IncompleteOperationV1) {
  return candidateRecord(ctx, {
    target: {
      base: ctx.base,
      branch: BRANCH,
      checkpoint: null,
      head: ctx.head,
      pr: PR,
      candidateState: {
        preserved: {
          operationKey: PRIOR,
          base: ctx.base,
          head: ctx.head,
          ref: await candidatePreservationRef({ ...SELF_REPO }, TASK, PRIOR),
        },
        publishedHead: ctx.head,
      },
    },
    nextStep: "work",
    counters: { attempts: 2, retries: 0, reviewRounds: 1 },
    intent,
  });
}

/** In flight: the marked implementation intent of the `reserved` charge. */
async function inFlight(c: ConflictCtxV1): Promise<WorkRecordV1> {
  return await published(c.ctx, {
    kind: "implementation",
    key: implementationIntentKey(CHARGE),
    startedAt: T0,
    branch: BRANCH,
    expectedHead: null,
    observedBase: c.ctx.base,
    pr: null,
    requestId: CHARGE,
    resultId: null,
    failure: conflictMarker(c.moved, T0),
  });
}

/** Resolved: the receipt consumed into the marked refresh intent of M. */
async function resolved(c: ConflictCtxV1): Promise<WorkRecordV1> {
  return await published(c.ctx, {
    kind: "base_refresh",
    key: baseRefreshIntentKey(PR, c.ctx.head, c.moved),
    startedAt: T0 + 10,
    branch: BRANCH,
    expectedHead: c.ctx.head,
    observedBase: c.moved,
    pr: PR,
    requestId: null,
    resultId: c.merge,
    failure: conflictMarker(c.moved, T0),
  });
}

function charge(
  record: WorkRecordV1,
  outcome: "reserved" | "submitted" | "ambiguous" | "confirmed_not_submitted",
  overrides: Record<string, unknown> = {},
) {
  return reservation(CHARGE, {
    repository: { ...SELF_REPO },
    taskId: record.id,
    attempt: record.counters.attempts,
    head: record.target.base,
    purpose: "retry",
    outcome,
    settledAt: outcome === "reserved" ? null : T0 + 5,
    proofRef: null,
    ...overrides,
  });
}

/** The exact refresh-binding descriptor of (PR, H, B) for M. */
function mergeCandidate(c: ConflictCtxV1) {
  return candidateFor(
    TASK,
    c.moved,
    c.merge,
    baseRefreshIntentKey(PR, c.ctx.head, c.moved),
  );
}

/** A loader over one mirror: present objects only, never a network read. */
function loader(c: ConflictCtxV1, dir: string) {
  return async (_taskId: WorkItemId, head: GitSha) =>
    await objectPresent(dir, c.ctx.env, head)
      ? portOk(undefined)
      : portError("unavailable", "candidate objects are not in this mirror");
}

/** A job mirror cloned from the remote: B0, H and B, never M. */
async function emptyMirror(c: ConflictCtxV1): Promise<string> {
  const dir = `${c.ctx.tmp}/empty-${crypto.randomUUID()}`;
  const cloned = await gitRun(
    c.ctx.tmp,
    ["clone", "-q", "--no-hardlinks", `file://${c.ctx.bare}`, dir],
    c.ctx.env,
  );
  assert.ok(cloned.ok, cloned.stderr);
  assert.equal(await objectPresent(dir, c.ctx.env, c.merge), false);
  return dir;
}

Deno.test("preserver: an in-flight conflict resolution preserves M under its refresh binding; an empty mirror then reconciles it", async () => {
  const c = await conflictCtx();
  try {
    const record = await inFlight(c);
    const state = new MemoryState();
    state.repair = snapshot([record], [charge(record, "reserved")]);
    const durable = structuredClone(state.repair);
    // A later job's mirror, cloned before anything was preserved.
    const later = await emptyMirror(c);
    const ingestMirror = await mirror(c.ctx);
    const candidate = await mergeCandidate(c);
    const ingest = await preserveAttempt({
      ctx: c.ctx,
      state,
      taskId: TASK,
      sourcePath: ingestMirror,
      publishedHead: c.ctx.head,
      candidate,
      ensure: loader(c, ingestMirror),
    });
    assert.ok(ingest.result.ok, JSON.stringify(ingest.result));
    assert.equal(await remoteSha(c.ctx, candidate.ref), c.merge);
    assert.deepEqual(ingest.pushes, [{
      ref: candidate.ref,
      sha: c.merge,
      expected: null,
    }]);
    assert.equal(
      await remoteSha(c.ctx, `refs/heads/${BRANCH}`),
      c.ctx.head,
      "the task branch still carries H",
    );
    assert.deepEqual(state.repair, durable, "preservation writes no state");

    // The receipt is consumed: a LATER job with an empty mirror publishes.
    const consumed = await resolved(c);
    state.repair = snapshot([consumed], [charge(consumed, "submitted")]);
    assert.equal(await objectPresent(later, c.ctx.env, c.merge), false);
    const publish = await preserveAttempt({
      ctx: c.ctx,
      state,
      taskId: TASK,
      sourcePath: later,
      publishedHead: c.ctx.head,
      candidate,
      ensure: loader(c, later),
    });
    assert.ok(publish.result.ok, JSON.stringify(publish.result));
    assert.deepEqual(publish.pushes, [], "reconciled, never pushed again");
    assert.ok(await objectPresent(later, c.ctx.env, c.merge), "M imported");
  } finally {
    await c.ctx.cleanup();
  }
});

Deno.test("preserver: without the ingest's preservation an empty mirror cannot publish a resolved merge", async () => {
  const c = await conflictCtx();
  try {
    const consumed = await resolved(c);
    const state = new MemoryState();
    state.repair = snapshot([consumed], [charge(consumed, "submitted")]);
    const later = await emptyMirror(c);
    const candidate = await mergeCandidate(c);
    const attempt = await preserveAttempt({
      ctx: c.ctx,
      state,
      taskId: TASK,
      sourcePath: later,
      publishedHead: c.ctx.head,
      candidate,
      ensure: loader(c, later),
    });
    assert.equal(attempt.result.ok, false);
    assert.equal(await remoteSha(c.ctx, candidate.ref), null);
  } finally {
    await c.ctx.cleanup();
  }
});

Deno.test("preserver: the in-flight conflict binding refuses every near miss before any remote read", async () => {
  const c = await conflictCtx();
  try {
    const record = await inFlight(c);
    const exact = await mergeCandidate(c);
    const otherKey = baseRefreshIntentKey(PR, c.ctx.head, c.ctx.base);
    const cases: [
      string,
      WorkRecordV1,
      unknown[],
      typeof exact,
      GitSha | null,
    ][] = [
      [
        "charge settled ambiguous",
        record,
        [charge(record, "ambiguous")],
        exact,
        c.ctx.head,
      ],
      [
        "charge refunded",
        record,
        [
          charge(record, "confirmed_not_submitted", {
            proofRef: "artifact://proof/not-submitted",
          }),
        ],
        exact,
        c.ctx.head,
      ],
      ["missing charge", record, [], exact, c.ctx.head],
      [
        "charge of another attempt",
        record,
        [charge(record, "reserved", { attempt: 1 })],
        exact,
        c.ctx.head,
      ],
      [
        "charge on another base",
        record,
        [charge(record, "reserved", { head: c.moved })],
        exact,
        c.ctx.head,
      ],
      [
        "charge of another task",
        record,
        [charge(record, "reserved", { taskId: "candidates-2" })],
        exact,
        c.ctx.head,
      ],
      [
        "unmarked implementation intent",
        await published(c.ctx, { ...record.intent!, failure: undefined }),
        [charge(record, "reserved")],
        exact,
        c.ctx.head,
      ],
      [
        "another operation key",
        record,
        [charge(record, "reserved")],
        await candidateFor(TASK, c.moved, c.merge, otherKey),
        c.ctx.head,
      ],
      [
        "another merged base",
        record,
        [charge(record, "reserved")],
        await candidateFor(
          TASK,
          c.ctx.base,
          c.merge,
          baseRefreshIntentKey(PR, c.ctx.head, c.moved),
        ),
        c.ctx.head,
      ],
      [
        "the published candidate itself",
        record,
        [charge(record, "reserved")],
        await candidateFor(
          TASK,
          c.moved,
          c.ctx.head,
          baseRefreshIntentKey(PR, c.ctx.head, c.moved),
        ),
        c.ctx.head,
      ],
      [
        "another published head",
        record,
        [charge(record, "reserved")],
        exact,
        c.ctx.base,
      ],
      [
        "no pull request",
        await published(c.ctx, record.intent!).then((row) => ({
          ...row,
          target: { ...row.target, pr: null },
        })),
        [charge(record, "reserved")],
        exact,
        c.ctx.head,
      ],
    ];
    for (const [name, work, reservations, candidate, publishedHead] of cases) {
      const state = new MemoryState();
      state.repair = snapshot([work], reservations as never);
      const ingestMirror = await mirror(c.ctx);
      const attempt = await preserveAttempt({
        ctx: c.ctx,
        state,
        taskId: TASK,
        sourcePath: ingestMirror,
        publishedHead,
        candidate,
        ensure: loader(c, ingestMirror),
      });
      assert.equal(attempt.result.ok, false, name);
      if (!attempt.result.ok) {
        assert.equal(attempt.result.error.kind, "unavailable", name);
      }
      assert.deepEqual(attempt.http.paths, [], `${name}: no remote read`);
      assert.deepEqual(attempt.pushes, [], name);
    }
    assert.equal(await remoteSha(c.ctx, exact.ref), null);
  } finally {
    await c.ctx.cleanup();
  }
});

Deno.test("preserver: a re-ingest after a settled but unpersisted consumption still preserves the same merge", async () => {
  // The consumption settles the charge `submitted` and then persists the
  // resolved intent in a second write; when that write fails, the next scan
  // re-ingests the same receipt with the in-flight intent still bound.
  const c = await conflictCtx();
  try {
    const record = await inFlight(c);
    const state = new MemoryState();
    state.repair = snapshot([record], [charge(record, "submitted")]);
    const ingestMirror = await mirror(c.ctx);
    const candidate = await mergeCandidate(c);
    const attempt = await preserveAttempt({
      ctx: c.ctx,
      state,
      taskId: TASK,
      sourcePath: ingestMirror,
      publishedHead: c.ctx.head,
      candidate,
      ensure: loader(c, ingestMirror),
    });
    assert.ok(attempt.result.ok, JSON.stringify(attempt.result));
    assert.equal(await remoteSha(c.ctx, candidate.ref), c.merge);
  } finally {
    await c.ctx.cleanup();
  }
});
