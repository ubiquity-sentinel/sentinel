/**
 * Amortized candidate durability proofs (#185): every candidate one pass
 * preserves for one target is proved in ONE fresh, unmasked store that pays
 * the target's history once. REAL fixture remote, REAL preserver, port and
 * validators; the preserver's injected process port counts every proof run.
 */
import assert from "node:assert/strict";
import { basename } from "node:path";
import type { GitSha, WorkItemId } from "../../src/contracts/brands.ts";
import type { BudgetReservationV1 } from "../../src/contracts/budget-reservation.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { PUBLICATION_PROTECTED_DETAIL } from "../../src/github/snapshot-policy.ts";
import { CandidateProofPassV1 } from "../../src/host/actions-candidates-proof.ts";
import { implementationIntentKey } from "../../src/repair/keys.ts";
import {
  DenoReplayRuntime,
  type ReplayCommandInputV1,
  type ReplayCommandResultV1,
  type ReplayRuntimeV1,
} from "../../src/replay/runtime.ts";
import { MemoryState } from "../repair/helpers.ts";
import { SHA1, T0 } from "../state/helpers.ts";
import {
  type CandidateCtxV1,
  candidateRecord,
  commitIn,
  gitRun,
  makeCandidateCtx,
  snapshot,
  TRUSTED_PATH,
} from "./actions-candidates-fixture.ts";
import {
  candidateFor,
  mirror,
  preserveAttempt,
  remoteSha,
  submittedReservation,
} from "./actions-candidates-preservation-fixture.ts";

const STORE_PREFIX = "sentinel-candidate-store-";

/** Default-branch commits behind every candidate: what a full fetch pays. */
const HISTORY = 40;

/** A candidate's own commit, tree and blob: all an amortized fetch needs. */
const CANDIDATE_OBJECTS = 3;

/** Objects one store holds, loose plus packed (a repeated object counts twice). */
async function storeObjects(ctx: CandidateCtxV1, store: string) {
  const read = await gitRun(store, ["count-objects", "-v"], ctx.env);
  assert.ok(read.ok, read.stderr);
  const field = (name: string) =>
    Number(new RegExp(`^${name}: (\\d+)$`, "m").exec(read.stdout)?.[1]);
  return field("count") + field("in-pack");
}

/** The preserver's injected process port, recording every proof git run. */
class CountingRuntime implements ReplayRuntimeV1 {
  readonly runs: { args: readonly string[]; cwd: string }[] = [];
  /** Objects each credential-scoped fetch into a proof store added there. */
  readonly fetches: { store: string; received: number }[] = [];
  readonly #delegate = new DenoReplayRuntime(TRUSTED_PATH);
  constructor(private readonly ctx: CandidateCtxV1) {}
  async run(input: ReplayCommandInputV1): Promise<ReplayCommandResultV1> {
    this.runs.push({ args: [...input.args], cwd: input.cwd });
    const storeFetch = input.args.includes("fetch") &&
      basename(input.cwd).startsWith(STORE_PREFIX);
    const before = storeFetch ? await storeObjects(this.ctx, input.cwd) : 0;
    const result = await this.#delegate.run(input);
    if (storeFetch) {
      this.fetches.push({
        store: input.cwd,
        received: await storeObjects(this.ctx, input.cwd) - before,
      });
    }
    return result;
  }
  /** The store each `git init --bare` created, in order. */
  inits(): string[] {
    return this.runs.filter((run) => run.args.includes("init")).map((run) =>
      run.cwd
    );
  }
}

interface PassTaskV1 {
  taskId: WorkItemId;
  head: GitSha;
  requestId: string;
}

/**
 * One target with a substantial default-branch history and `count` exact
 * candidates on top of it, each bound to its own pending preservation intent
 * and genuine submitted implementation charge. `protectedAt` names the one
 * candidate that adds the protected `protected.txt`.
 */
async function passRig(count: number, protectedAt: number | null = null) {
  const ctx = await makeCandidateCtx();
  try {
    const work = `${ctx.tmp}/work`;
    assert.ok(
      (await gitRun(work, ["checkout", "-q", "development"], ctx.env)).ok,
    );
    let base = ctx.base;
    for (let i = 0; i < HISTORY; i++) {
      base = await commitIn(work, ctx.env, `history-${i}`);
    }
    assert.ok(
      (await gitRun(work, ["push", "-q", "origin", "development"], ctx.env))
        .ok,
    );
    const tasks: PassTaskV1[] = [];
    const records: WorkRecordV1[] = [];
    const charges: BudgetReservationV1[] = [];
    for (let i = 0; i < count; i++) {
      const branch = `sentinel/repair/pass-${i}`;
      assert.ok(
        (await gitRun(work, ["checkout", "-q", "-b", branch, base], ctx.env))
          .ok,
      );
      const head = await commitIn(
        work,
        ctx.env,
        i === protectedAt ? "protected" : `pass-candidate-${i}`,
      );
      const task = {
        taskId: `pass-task-${i}` as WorkItemId,
        head,
        requestId: (i + 1).toString(16).padStart(64, "c"),
      };
      tasks.push(task);
      const key = implementationIntentKey(task.requestId);
      const candidate = await candidateFor(task.taskId, base, head, key);
      const record = candidateRecord(ctx, {
        id: task.taskId,
        source: { kind: "issue", id: String(i + 2), revision: SHA1 },
        related: { incidentId: null, issueNumber: i + 2 },
        target: {
          base,
          branch,
          checkpoint: null,
          head,
          pr: 20 + i,
          candidateState: { preserved: null, publishedHead: null },
        },
        intent: {
          kind: "candidate_preservation",
          key,
          startedAt: T0,
          branch: candidate.ref,
          expectedHead: head,
          observedBase: base,
          pr: null,
          requestId: task.requestId,
          resultId: null,
        },
      });
      records.push(record);
      charges.push(submittedReservation(record, { id: task.requestId }));
    }
    const state = new MemoryState();
    state.repair = snapshot(records, charges);
    const sourcePath = await mirror(ctx);
    const runtime = new CountingRuntime(ctx);
    const preserve = async (
      task: PassTaskV1,
      proofPass?: CandidateProofPassV1,
    ) =>
      (await preserveAttempt({
        ctx,
        state,
        taskId: task.taskId,
        sourcePath,
        candidate: await candidateFor(
          task.taskId,
          base,
          task.head,
          implementationIntentKey(task.requestId),
        ),
        protectedPaths: ["protected.txt"],
        runtime,
        ...(proofPass === undefined ? {} : { proofPass }),
      })).result;
    const stores = () =>
      [...Deno.readDirSync(`${ctx.tmp}/home`)].filter((entry) =>
        entry.name.startsWith(STORE_PREFIX)
      ).map((entry) => `${ctx.tmp}/home/${entry.name}`).sort();
    const refOf = async (task: PassTaskV1) =>
      (await candidateFor(
        task.taskId,
        base,
        task.head,
        implementationIntentKey(task.requestId),
      )).ref;
    return { ctx, tasks, runtime, preserve, stores, refOf };
  } catch (error) {
    await ctx.cleanup();
    throw error;
  }
}

Deno.test(
  "proof pass: one target's candidates are proved in ONE fresh store that fetches the history once",
  async () => {
    const count = 4;
    // Control: without a pass every proof inits its own store and fetches the
    // whole history again, which is the #185 cost.
    const control = await passRig(count);
    try {
      for (const task of control.tasks) {
        const result = await control.preserve(task);
        assert.ok(result.ok, JSON.stringify(result));
      }
      assert.equal(control.runtime.inits().length, count);
      assert.equal(new Set(control.runtime.inits()).size, count);
      assert.equal(control.runtime.fetches.length, count);
      for (const fetch of control.runtime.fetches) {
        assert.ok(fetch.received > HISTORY * 3, JSON.stringify(fetch));
      }
      assert.deepEqual(control.stores(), []);
    } finally {
      await control.ctx.cleanup();
    }

    const rig = await passRig(count);
    try {
      const pass = new CandidateProofPassV1();
      for (const task of rig.tasks) {
        const result = await rig.preserve(task, pass);
        assert.ok(result.ok, JSON.stringify(result));
        assert.equal(
          await remoteSha(rig.ctx, await rig.refOf(task)),
          task.head,
        );
      }
      const inits = rig.runtime.inits();
      assert.equal(inits.length, 1, "exactly one fresh store per pass");
      assert.deepEqual(rig.stores(), inits, "the one pass store is kept");
      assert.deepEqual(
        rig.runtime.fetches.map((fetch) => fetch.store),
        rig.tasks.map(() => inits[0]),
        "every candidate's exact ref is fetched into that store",
      );
      const [full, ...later] = rig.runtime.fetches;
      assert.ok(full.received > HISTORY * 3, JSON.stringify(full));
      assert.deepEqual(
        later.map((fetch) => fetch.received),
        later.map(() => CANDIDATE_OBJECTS),
        "every later fetch transfers only the candidate's own objects",
      );
      // Every per-candidate check still ran in that store for every proof.
      for (
        const check of [
          "--is-shallow-repository",
          "refs/replace",
          "--is-ancestor",
          "FETCH_HEAD^{commit}",
        ]
      ) {
        assert.equal(
          rig.runtime.runs.filter((run) =>
            run.cwd === inits[0] && run.args.includes(check)
          ).length,
          count,
          check,
        );
      }
      await pass.close();
      assert.equal(pass.closed, true);
      assert.deepEqual(rig.stores(), [], "closing the pass removes its store");
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "proof pass: a candidate whose publication does not verify is refused, and its store is never reused",
  async () => {
    const rig = await passRig(3, 1);
    try {
      const [first, refused, third] = rig.tasks;
      // The refused candidate already sits on its exact preservation ref (an
      // earlier run's push), so its proof runs in the pass store before the
      // trusted validator refuses its protected entry.
      assert.ok(
        (await gitRun(`${rig.ctx.tmp}/work`, [
          "push",
          "-q",
          "origin",
          `${refused.head}:${await rig.refOf(refused)}`,
        ], rig.ctx.env)).ok,
      );
      const pass = new CandidateProofPassV1();
      const results = [];
      for (const task of [first, refused, third]) {
        results.push(await rig.preserve(task, pass));
      }
      assert.ok(results[0].ok, JSON.stringify(results[0]));
      assert.deepEqual(results[1], {
        ok: false,
        error: { kind: "invalid", detail: PUBLICATION_PROTECTED_DETAIL },
      });
      assert.ok(results[2].ok, JSON.stringify(results[2]));
      const inits = rig.runtime.inits();
      assert.equal(inits.length, 2, "the refusal ends the first store's reuse");
      assert.notEqual(inits[0], inits[1]);
      assert.deepEqual(
        rig.runtime.fetches.map((fetch) => fetch.store),
        [inits[0], inits[0], inits[1]],
      );
      assert.ok(
        rig.runtime.fetches[2].received > HISTORY * 3,
        "the next proof starts over in a NEW empty store",
      );
      await pass.close();
      // Exactly as a one-off store: a refused validation keeps its store for
      // diagnosis; the pass removes the store it still held.
      assert.deepEqual(rig.stores(), [inits[0]]);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);

Deno.test(
  "proof pass: a new pass uses a new store, and a closed pass never reopens one",
  async () => {
    const rig = await passRig(3);
    try {
      const [first, second, third] = rig.tasks;
      const earlier = new CandidateProofPassV1();
      assert.ok((await rig.preserve(first, earlier)).ok);
      await earlier.close();
      assert.deepEqual(rig.stores(), []);

      const later = new CandidateProofPassV1();
      assert.ok((await rig.preserve(second, later)).ok);
      const inits = rig.runtime.inits();
      assert.equal(inits.length, 2);
      assert.notEqual(inits[0], inits[1], "never the earlier pass's store");
      assert.ok(
        rig.runtime.fetches[1].received > HISTORY * 3,
        "the new pass's store starts empty",
      );

      // The closed pass gives a one-off store, removed once it settles.
      assert.ok((await rig.preserve(third, earlier)).ok);
      assert.equal(rig.runtime.inits().length, 3);
      assert.deepEqual(rig.stores(), [inits[1]]);
      await later.close();
      assert.deepEqual(rig.stores(), []);
    } finally {
      await rig.ctx.cleanup();
    }
  },
);
