/**
 * The launcher's producer recovery over a HOSTED conflict-resolution cell that
 * finished after its repair job, so maintenance consumes it (the common case
 * for late cells, `hosted-autonomy-inflight-preservation_test.ts`). The walk,
 * the producer pass, the real consumer (`ingestMatrixResults`), the launcher's
 * own candidate port (`createHostedCandidateRecoveryPort`: its ref gate, the
 * real preserver with its create-only push and fresh-store proof) and the
 * bundle import into the launcher's own mirror are the real ones, over real
 * Git. Release history, the native proof and the artifact transport are the
 * walk fixtures.
 *
 * The launcher preserves the merge M under the refresh binding of (PR, H, B)
 * BEFORE it consumes the receipt, also past the 24-hour deferral window, so M
 * never lives only in the launcher's mirror; the consumed cell is reported
 * `ingested` (its timeout streak cleared), so the walk applies instead of
 * deferring on it. Every write passes R78's parser and transition validator.
 */
import assert from "node:assert/strict";
import { createHostedCandidateRecoveryPort } from "../../ops/hosted-autonomy-candidate-port.ts";
import { recoverHostedCurrentMatrix } from "../../ops/hosted-autonomy-current-recovery.ts";
import { RollingStartBudget } from "../../src/budget/mod.ts";
import type { GitSha } from "../../src/contracts/brands.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import {
  portError,
  portOk,
  type RepairStateWriter,
  type StateReadView,
} from "../../src/contracts/ports.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import { DenoGitExecutor } from "../../src/github/git-executor.ts";
import { planMatrixWave } from "../../src/host/matrix.ts";
import { createGitBundleImporter } from "../../src/host/matrix-git.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import {
  CONFLICT_MERGE_PRESERVE_WINDOW_MS,
  conflictMarkerBase,
  resolvedConflictResolution,
} from "../../src/repair/conflict-resolution.ts";
import { DurableGitHubCooldownGate } from "../../src/repair/github-cooldown.ts";
import {
  baseRefreshIntentKey,
  candidatePreservationRef,
} from "../../src/repair/keys.ts";
import { createReleaseStateStore, DenoGitRunner } from "../../src/state/mod.ts";
import { REPO, T0 } from "../state/helpers.ts";
import { assertGen78Parses } from "../state/gen77-contracts.ts";
import { BRANCH, PR, TASK } from "../repair/conflict-resolution-rig.ts";
import type { HttpTransportV1 } from "../../src/github/http.ts";
import { membershipWire, response } from "../github/merge-queue-fixtures.ts";
import { FakeGate } from "./actions-candidates-fixture.ts";
import { RealRefHttp } from "./actions-candidates-preservation-fixture.ts";
import { gen78Available, loadGen78Modules } from "./gen77-runtime-source.ts";
import {
  execution,
  FIRST_RUN,
  GENERATION,
  LAUNCHER,
  proof,
  releaseHistory,
  RUNTIME,
} from "./hosted-autonomy-history-reach-fixtures.ts";
import {
  hostedConflictRig,
  jobMirror,
  present,
  remoteRef,
} from "./matrix-conflict-hosted-rig.ts";

const HOUR = 60 * 60_000;
const BINDING = "historical preservation binding unavailable";
const available = await gen78Available();

interface WriteV1 {
  prior: RepairStateSnapshotV1;
  next: RepairStateSnapshotV1;
  /** The remote preservation ref when this write landed. */
  preserved: string | null;
}

/**
 * One ordinary producer (FIRST_RUN) whose wave granted one conflict cell; the
 * cell ran (a `uos` route receipt and its bundle) and nothing consumed it. The
 * record carries a timeout streak from an earlier attempt.
 */
async function conflictWalk() {
  const rig = await hostedConflictRig({
    counters: { attempts: 1, retries: 0, reviewRounds: 1, timeouts: 1 },
  });
  const { ctx, hosted } = rig;
  const root = `${ctx.tmp}/walk`;
  await Deno.mkdir(`${root}/scratch`, { recursive: true });
  const pending = await rig.runLoop();
  assert.notEqual(pending.status, "state_error", JSON.stringify(pending));
  const run = { runId: FIRST_RUN, runAttempt: 1, launcherSha: LAUNCHER };
  const planned = await planMatrixWave(rig.deps, {
    waveId: execution(FIRST_RUN).id,
    run,
    runtimeSha: RUNTIME,
    generation: GENERATION,
    plannedAt: hosted.clock.now(),
    deadline: hosted.clock.now() + HOUR,
  });
  assert.equal(planned.plan.cells.length, 1, JSON.stringify(planned));
  const plan = planned.plan;
  const { result } = await rig.runCell(plan, plan.cells[0], {
    provider: "uos",
  });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const merge = result.receipt!.candidate!.head!;
  // The launcher's own mirror: the remote without M. Only the bundle its
  // consumer imports brings M there.
  const mirror = await jobMirror(rig, "launcher-mirror");
  assert.equal(await present(rig, mirror, merge), false);
  const ref = await candidatePreservationRef(
    REPO,
    TASK,
    baseRefreshIntentKey(PR, ctx.head, ctx.base),
  );
  const release = createReleaseStateStore({
    scratchDir: `${root}/release`,
    remoteUrl: await releaseHistory(root, 1),
    runner: new DenoGitRunner(`${root}/git-home`),
  });
  const writes: WriteV1[] = [];
  const state = new Proxy(release, {
    get(target, key) {
      if (key === "readRepair") return () => hosted.state.readRepair();
      if (key === "writeRepair") {
        return async (next: RepairStateSnapshotV1, expected: GitSha | null) => {
          const prior = structuredClone(await hosted.snapshot());
          const preserved = await remoteRef(rig, ref);
          const written = await hosted.state.writeRepair(next, expected);
          if (written.ok && written.value.status === "applied") {
            writes.push({ prior, next: structuredClone(next), preserved });
          }
          return written;
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const http = new RealRefHttp(
    new DenoGitExecutor({
      localDir: mirror,
      remoteUrl: `file://${ctx.repo}`,
      gitHome: ctx.home,
      gitPath: "git",
    }),
  );
  const nativeReads: string[] = [];
  const nativeErrors: string[] = [];
  const nativeTransport: HttpTransportV1 = (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/repos/ubiquity/ai.ubq.fi/rules/branches/development") {
      nativeReads.push(`${request.method} ${path}`);
      assert.equal(request.method, "GET");
      return Promise.resolve(response([]));
    }
    if (path === "/graphql") {
      nativeReads.push(`${request.method} ${path}`);
      assert.equal(request.method, "POST");
      const query = JSON.parse(request.body ?? "{}");
      assert.match(query.query, /^query\(/);
      assert.match(query.query, /pullRequest\(number:\$number\)/);
      assert.deepEqual(query.variables, {
        owner: REPO.owner,
        name: REPO.name,
        number: PR,
      });
      return Promise.resolve(response(membershipWire(null, {
        id: "PR_7",
        number: PR,
        headRefName: BRANCH,
        headRefOid: ctx.head,
        baseRefOid: ctx.base,
        author: {
          __typename: "Bot",
          id: "BOT_SYNTHETIC_AUTHOR",
          login: "ubiquity-sentinel[bot]",
        },
        mergedBy: null,
      })));
    }
    if (path === "/repos/ubiquity/ai.ubq.fi/pulls") {
      nativeReads.push(`${request.method} ${path}`);
      assert.equal(request.method, "GET");
      assert.equal(
        url.searchParams.get("head"),
        `${REPO.owner}:${ref.slice("refs/heads/".length)}`,
      );
      // The preservation operation ref is not a pull-request head.
      return Promise.resolve(response([]));
    }
    return http.transport(request);
  };
  const nativeHttp: HttpTransportV1 = async (request) => {
    try {
      return await nativeTransport(request);
    } catch (error) {
      nativeErrors.push(error instanceof Error ? error.message : String(error));
      throw error;
    }
  };
  const port = (passState: StateReadView) =>
    createHostedCandidateRecoveryPort({
      state: passState,
      clock: hosted.clock,
      gate: new FakeGate(),
      config: hosted.configs[0]!,
      token: "offline-token",
      http: nativeHttp,
      sourcePath: mirror,
      scratch: `${root}/scratch`,
      remoteUrl: `file://${ctx.repo}`,
    });
  const transport = {
    confirmCompletedExecution: () => Promise.resolve(true),
    recover: async () => [{
      plan,
      provenance: { run },
      planDigest: await matrixDigestV1(plan),
      results: [result],
      bundlesDir: `${ctx.tmp}/mirror-bundles`,
    }],
  };
  const deps = {
    clock: hosted.clock,
    state,
    closedMatrix: (passState: StateReadView & RepairStateWriter) =>
      Promise.resolve({
        state: passState,
        clock: hosted.clock,
        configs: hosted.configs,
        cycleFor: () => ({
          ...rig.deps,
          state: passState,
          github: port(passState),
          githubCooldown: new DurableGitHubCooldownGate({
            state: passState,
            clock: hosted.clock,
          }),
          budget: new RollingStartBudget({
            clock: hosted.clock,
            state: passState,
            configs: hosted.configs,
          }),
        }),
        prepareTarget: () => Promise.resolve(),
        importerFor: (_config: unknown, bundlesDir: string) =>
          createGitBundleImporter({ repositoryDir: mirror, bundlesDir }),
        transportFor: () => transport,
        readExecution: (saved: { runId: number }) =>
          Promise.resolve(portOk(proof(saved.runId))),
      }),
  };
  let deferred = 0;
  const walk = () =>
    (recoverHostedCurrentMatrix as (...args: unknown[]) => Promise<unknown>)(
      deps,
      CLOSED_C_WAVE,
      () => deferred++,
    ) as Promise<{ status: string; actions: string[] } | null>;
  const refs = async () =>
    (await ctx.git(["for-each-ref", "--format=%(refname) %(objectname)"]))
      .trim().split("\n").sort();
  return {
    rig,
    plan,
    result,
    merge,
    mirror,
    ref,
    writes,
    http,
    nativeReads,
    nativeErrors,
    nativeHttp,
    port,
    walk,
    refs,
    deferred: () => deferred,
  };
}

/** Every write the walk made passes R78's parser and transition validator. */
async function assertRollbackAccepts(writes: readonly WriteV1[]) {
  if (!available) return;
  const loaded = await loadGen78Modules([
    "src/state/state-repair-transition.ts",
  ]);
  try {
    const transition = loaded.modules[0] as {
      validateRepairTransition(
        prior: RepairStateSnapshotV1,
        next: RepairStateSnapshotV1,
      ): unknown;
    };
    for (const { prior, next } of writes) {
      await assertGen78Parses(next);
      assert.equal(transition.validateRepairTransition(prior, next), null);
    }
  } finally {
    await loaded.dispose();
  }
}

for (
  const [name, at] of [
    ["within the deferral window", () => T0 + 10_000_000],
    [
      "past the deferral window",
      (startedAt: number) => startedAt + CONFLICT_MERGE_PRESERVE_WINDOW_MS + 1,
    ],
  ] as const
) {
  Deno.test(`conflict producer (${name}): the launcher preserves M before it consumes a late conflict cell, and the walk applies instead of deferring`, async () => {
    const w = await conflictWalk();
    const { rig } = w;
    try {
      const admitted = await rig.hosted.snapshot();
      const record = admitted.work[0];
      assert.equal(conflictMarkerBase(record.intent), rig.ctx.base);
      assert.equal(record.intent?.kind, "implementation");
      assert.equal(admitted.reservations[0].outcome, "reserved");
      const startedAt = record.intent!.startedAt;
      rig.hosted.clock.advance(at(startedAt) - rig.hosted.clock.now());
      const refsBefore = await w.refs();
      assert.equal(await remoteRef(rig, w.ref), null);

      const outcome = await w.walk();
      // M reached the remote under the refresh binding of (PR, H, B) before
      // the first write (the consumption's charge settlement) landed: never
      // only in the launcher's mirror.
      for (const write of w.writes) {
        assert.equal(write.preserved, w.merge, "preserved before any write");
      }
      assert.equal(w.deferred(), 0, "the walk never defers on this cell");
      assert.equal(outcome?.status, "applied", JSON.stringify(outcome));
      assert.deepEqual(outcome?.actions, ["current-matrix:ingested:1"]);
      // Three writes (the charge settlement, the resolved intent, the streak
      // reset), and nothing else pushed.
      assert.equal(w.writes.length, 3);
      // Dormant queue proof (owner directive 2026-10-24, #180): the guard
      // proves the authenticated negative rule and skips the queue read.
      assert.ok(w.nativeReads.length > 0);
      assert.ok(
        w.nativeReads.every((read) =>
          read === "GET /repos/ubiquity/ai.ubq.fi/rules/branches/development"
        ),
        JSON.stringify(w.nativeReads),
      );
      assert.deepEqual(
        await w.refs(),
        [...refsBefore, `${w.ref} ${w.merge}`].sort(),
      );
      assert.ok(await present(rig, w.mirror, w.merge), "imported first");

      // Consumed exactly once: the resolved intent of M, the one charge
      // settled submitted, the streak cleared as for any receipt.
      const after = await rig.hosted.snapshot();
      const work = after.work[0];
      assert.equal(resolvedConflictResolution(work.intent), w.merge);
      assert.equal(conflictMarkerBase(work.intent), rig.ctx.base);
      assert.equal(work.target.head, rig.ctx.head, "H until published");
      assert.equal(work.counters.timeouts, undefined);
      const { timeouts: _streak, ...counters } = record.counters;
      assert.deepEqual(work.counters, counters);
      assert.equal(after.reservations.length, 1, "one charge");
      assert.equal(after.reservations[0].outcome, "submitted");
      await assertRollbackAccepts(w.writes);

      // The resolved record is no longer matrix work: the next walk reads
      // nothing and writes nothing.
      const writes = w.writes.length;
      assert.equal(await w.walk(), null);
      assert.equal(w.writes.length, writes);
      assert.deepEqual(await rig.hosted.snapshot(), after);
    } finally {
      await rig.cleanup();
    }
  });
}

Deno.test("conflict producer: the launcher's candidate port opens exactly the in-flight conflict binding", async () => {
  const w = await conflictWalk();
  const { rig } = w;
  try {
    const admitted = await rig.hosted.snapshot();
    const record = admitted.work[0];
    const intent = record.intent!;
    const exact = {
      operationKey: baseRefreshIntentKey(PR, rig.ctx.head, rig.ctx.base),
      base: rig.ctx.base,
      head: w.merge,
      ref: w.ref,
    };
    const other = baseRefreshIntentKey(PR, rig.ctx.head, rig.ctx.b0);
    const refused = portError("unavailable", BINDING);
    const cases: [string, RepairStateSnapshotV1, typeof exact][] = [
      ["another merged base", admitted, {
        ...exact,
        operationKey: other,
        ref: await candidatePreservationRef(REPO, TASK, other),
      }],
      ["the implementation intent's own ref", admitted, {
        ...exact,
        operationKey: intent.key,
        ref: await candidatePreservationRef(REPO, TASK, intent.key),
      }],
      ["an unmarked implementation intent", {
        ...admitted,
        work: [{ ...record, intent: { ...intent, failure: undefined } }],
      }, exact],
      ["a record no longer at work", {
        ...admitted,
        work: [{
          ...record,
          nextStep: "blocked",
          blocker: { kind: "other", message: "isolated", since: T0 },
        }],
      }, exact],
      ["a record without its pull request", {
        ...admitted,
        work: [{ ...record, target: { ...record.target, pr: null } }],
      }, exact],
    ];
    for (const [name, snapshot, candidate] of cases) {
      rig.hosted.state.repair = structuredClone(snapshot);
      const port = w.port(rig.hosted.state);
      assert.deepEqual(await port.readRef(candidate.ref), refused, name);
      assert.deepEqual(
        await port.preserveCandidate({
          taskId: TASK,
          candidate,
          publishedHead: rig.ctx.head,
        }),
        refused,
        name,
      );
    }
    assert.deepEqual(w.http.paths, [], "no remote read for a near miss");
    assert.equal(w.nativeReads.length, 0, "no native read for a near miss");
    // Another repository's port never opens this binding.
    rig.hosted.state.repair = structuredClone(admitted);
    const foreign = createHostedCandidateRecoveryPort({
      state: rig.hosted.state,
      clock: rig.hosted.clock,
      gate: new FakeGate(),
      config: {
        ...rig.hosted.configs[0]!,
        repository: { ...REPO, name: "other" },
      },
      token: "offline-token",
      http: w.nativeHttp,
      sourcePath: w.mirror,
      scratch: `${rig.ctx.tmp}/walk/scratch`,
      remoteUrl: `file://${rig.ctx.repo}`,
    });
    assert.deepEqual(await foreign.readRef(w.ref), refused);
    assert.deepEqual(w.http.paths, []);
    assert.equal(
      w.nativeReads.length,
      0,
      "no native read for a foreign binding",
    );

    // The exact binding reaches the real preserver: once the consumer's
    // import brings M into the launcher's mirror, M is preserved.
    const port = w.port(rig.hosted.state);
    const read = await port.readRef(w.ref);
    assert.ok(read.ok && read.value === null, JSON.stringify(read));
    const bundle = w.result.bundle!;
    const imported = await createGitBundleImporter({
      repositoryDir: w.mirror,
      bundlesDir: `${rig.ctx.tmp}/mirror-bundles`,
    }).import({
      base: w.plan.cells[0].expectedBase,
      file: bundle.file,
      digest: bundle.digest,
      head: w.merge,
      checkpointSha: null,
    });
    assert.ok(imported);
    const preserved = await port.preserveCandidate({
      taskId: TASK,
      candidate: exact,
      publishedHead: rig.ctx.head,
    });
    assert.ok(
      preserved.ok,
      JSON.stringify({
        preserved,
        nativeErrors: w.nativeErrors,
        nativeReads: w.nativeReads,
        refReads: w.http.paths,
      }),
    );
    // Dormant queue proof (owner directive 2026-10-24, #180): the guard
    // proves the authenticated negative rule and skips the queue read.
    assert.ok(w.nativeReads.length > 0);
    assert.ok(
      w.nativeReads.every((read) =>
        read === "GET /repos/ubiquity/ai.ubq.fi/rules/branches/development"
      ),
      JSON.stringify(w.nativeReads),
    );
    assert.equal(await remoteRef(rig, w.ref), w.merge);
    assert.deepEqual(await rig.hosted.snapshot(), admitted, "no state write");
  } finally {
    await rig.cleanup();
  }
});
