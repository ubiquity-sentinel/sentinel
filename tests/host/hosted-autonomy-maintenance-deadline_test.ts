/**
 * Phase-local history expiry, or an exact producer whose wave is not listed,
 * must leave independent guarded delivery live; integrity, custody and
 * unknown refusals still stop it, with only fixed vocabulary logged.
 */
import { INACTIVE_CI_MINUTES } from "../../src/budget/ci-minutes.ts";
import assert from "node:assert/strict";
import { darkQueueCoordinatorFixture } from "./hosted-autonomy-dark-queue-fixture.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy-runner.ts";
import { CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE } from "../../ops/hosted-autonomy-policy.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { CURRENT_MATRIX_WAVE_UNAVAILABLE } from "../../ops/hosted-autonomy-current-error.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
import { parseHostedRunProofV1 } from "../../src/contracts/hosted-supervisor.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { createReleaseStateStore } from "../../src/state/mod.ts";
import { reservation, T0, workRecord } from "../state/helpers.ts";
import {
  BASE,
  FOREIGN_TARGET,
  foreignPullFacts,
  foreignReceipt,
  foreignRecord,
  HEAD,
} from "./hosted-autonomy-fixtures.ts";
import {
  makeRig,
  releaseSnapshot,
  repairSnapshot,
} from "./hosted-autonomy-rig.ts";

/** The exact ordinary producer whose saved proof the walk reaches first. */
function producerProof() {
  return parseHostedRunProofV1({
    execution: {
      id: "1001:1:repair",
      runId: 1001,
      runAttempt: 1,
      launcherSha: "d".repeat(40),
      purpose: "ordinary",
      revision: BASE,
      generation: 1,
      releaseId: null,
      createdAt: T0,
    },
    workflowId: 357012162,
    workflowPath: ".github/workflows/supervisor.yml",
    repository: "ubiquity-sentinel/sentinel",
    ref: "refs/heads/sentinel-supervisor",
    jobId: 1001,
    startedAt: T0 + 100,
    finishedAt: T0 + 200,
    observedAt: T0 + 300,
    // A failed run keeps the healthy pointer as it was; the walk reads any
    // settled ordinary proof the same way.
    outcome: "failed",
    startupReady: true,
    settled: true,
    baseSha: BASE,
    terminalAt: T0 + 150,
    logDigest: "0".repeat(64),
  });
}

/** That producer's authenticated transport answer, the case under test. */
interface ProducerCase {
  recover(): Promise<unknown[]>;
  /** Runs as the pass reads the native proof, before its custody re-proof. */
  beforeCustody?(): void;
}

async function deadlineRig(producer?: ProducerCase) {
  const chargeId = "e".repeat(64);
  const pending = workRecord("pending-preservation", {
    target: {
      base: BASE,
      head: HEAD,
      branch: "sentinel/repair/pending-preservation",
      pr: null,
      checkpoint: null,
      candidateState: { preserved: null, publishedHead: null },
    },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    intent: {
      kind: "candidate_preservation",
      key: `impl:${chargeId}`,
      startedAt: T0,
      branch: `refs/heads/sentinel-candidates/${"f".repeat(64)}`,
      expectedHead: HEAD,
      observedBase: BASE,
      pr: null,
      requestId: chargeId,
      resultId: null,
    },
  });
  const charge = reservation(chargeId, {
    taskId: pending.id,
    head: BASE,
    outcome: "submitted",
    settledAt: T0 + 1,
  });
  const release = releaseSnapshot();
  const proof = producer === undefined ? null : producerProof();
  release.hostedRuntimes = [{
    version: "v1",
    kind: "hosted_runtime",
    id: "ubiquity-sentinel/sentinel:0:production",
    activeRevision: BASE,
    generation: 1,
    lastHealthyProof: null,
    lastExecutionProof: null,
    nextOrdinaryAt: T0,
    execution: null,
    createdAt: T0,
    updatedAt: T0,
  }];
  const { rig } = await makeRig("maintenance-deadline", {
    fixtureDir: new URL("../../", import.meta.url).pathname,
    repair: repairSnapshot([pending, foreignRecord()], [foreignReceipt()], [], [
      charge,
    ]),
    release,
    pull: foreignPullFacts({
      state: "open",
      merged: false,
      mergeCommitSha: null,
      author: "ubiquity-sentinel[bot]",
    }),
    afterMerge: foreignPullFacts({ author: "ubiquity-sentinel[bot]" }),
  });
  const store = createReleaseStateStore({
    scratchDir: `${rig.tmp}/history`,
    remoteUrl: `${rig.tmp}/remote.git`,
  });
  const read = await store.readRelease();
  assert.ok(read.ok && read.value.status === "found");
  let snapshot = {
    ...read.value.snapshot,
    sequence: read.value.snapshot.sequence + 1,
    stateHead: read.value.head,
    updatedAt: T0 + 1,
  };
  const moved = await store.writeRelease(snapshot, read.value.head);
  assert.ok(
    moved.ok && moved.value.status === "applied",
    JSON.stringify(moved),
  );
  // An exact producer starts, then settles with its proof, in later writes.
  let head = moved.value.head;
  for (const execution of proof === null ? [] : [proof.execution, null]) {
    snapshot = {
      ...snapshot,
      sequence: snapshot.sequence + 1,
      stateHead: head,
      updatedAt: snapshot.updatedAt + 1,
      hostedRuntimes: snapshot.hostedRuntimes.map((row) => ({
        ...row,
        execution,
        lastExecutionProof: execution === null ? proof : null,
      })),
    };
    const written = await store.writeRelease(snapshot, head);
    assert.ok(
      written.ok && written.value.status === "applied",
      JSON.stringify(written),
    );
    head = written.value.head;
  }
  let now = T0 + 5000;
  const calls = { recovered: 0 };
  const unselected = () => {
    throw new Error("no matrix producer is selected");
  };
  const deps: HostedAutonomyDepsV1 = {
    ciMinutes: INACTIVE_CI_MINUTES,
    queue: await darkQueueCoordinatorFixture(rig),
    state: rig.state,
    githubFor: rig.githubFor,
    clock: { now: () => now },
    closedMatrix: () =>
      Promise.resolve({
        state: rig.state,
        clock: { now: () => now },
        // The pending record's own target, so the producer requests it.
        configs: (producer === undefined
          ? []
          : [{ repository: pending.repository }]) as never[],
        binding: CLOSED_C_WAVE,
        cycleFor: unselected,
        prepareTarget: unselected,
        importerFor: unselected,
        transportFor: producer === undefined ? unselected : () =>
          ({
            confirmCompletedExecution: () => Promise.resolve(true),
            recover: () => {
              calls.recovered++;
              return producer.recover();
            },
          }) as never,
        readExecution: producer === undefined ? unselected : () => {
          producer.beforeCustody?.();
          return Promise.resolve(portOk(proof!));
        },
      }),
  };
  const historyRead = rig.state.readReleaseAt!;
  return {
    rig,
    deps,
    calls,
    pending,
    charge,
    historyRead,
    expire: () => {
      now += 300001;
    },
    now: () => now,
  };
}

Deno.test("maintenance deadline: real history expiry continues reviewed foreign merge and closure", async () => {
  const f = await deadlineRig();
  try {
    let historyReads = 0;
    f.rig.state.readReleaseAt = async (input) => {
      historyReads++;
      const result = await f.historyRead(input);
      f.expire();
      return result;
    };
    const result = await runHostedAutonomy(f.deps);
    assert.equal(
      historyReads,
      1,
      "the five-minute walk bound is retained",
    );
    assert.ok(
      result.actions.includes("matrix-history:deferred"),
      JSON.stringify(result),
    );
    assert.equal(f.rig.merges, 1);
    assert.deepEqual(f.rig.closed, [120]);
    const after = await f.rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.find((r) => r.id === FOREIGN_TARGET)?.nextStep,
      "done",
    );
    assert.deepEqual(
      after.value.snapshot.work.find((r) => r.id === f.pending.id),
      f.pending,
    );
    assert.deepEqual(after.value.snapshot.reservations, [f.charge]);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("maintenance deadline: committed earlier matrix progress is freshly read without duplicate charge", async () => {
  const f = await deadlineRig();
  try {
    let priorWrite = false;
    f.rig.state.readReleaseAt = async (input) => {
      const result = await f.historyRead(input);
      const read = await f.rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const next = {
        ...read.value.snapshot,
        sequence: read.value.snapshot.sequence + 1,
        stateHead: read.value.head,
        updatedAt: f.now(),
        work: read.value.snapshot.work.map((r) =>
          r.id === f.pending.id
            ? {
              ...r,
              wait: {
                reason: "unavailable" as const,
                since: f.now(),
                until: f.now() + 300000,
              },
              updatedAt: f.now(),
            }
            : r
        ),
      };
      const saved = await f.rig.state.writeRepair(next, read.value.head);
      assert.ok(saved.ok && saved.value.status === "applied");
      priorWrite = true;
      f.expire();
      return result;
    };
    const result = await runHostedAutonomy(f.deps);
    assert.equal(priorWrite, true);
    assert.ok(result.actions.includes("matrix-history:deferred"));
    assert.equal(f.rig.merges, 1);
    const after = await f.rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.equal(
      after.value.snapshot.work.find((r) => r.id === f.pending.id)?.wait
        ?.reason,
      "unavailable",
    );
    assert.deepEqual(after.value.snapshot.reservations, [f.charge]);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("maintenance deadline: integrity errors including typed identical budget message still stop delivery", async () => {
  const f = await deadlineRig();
  try {
    const before = await f.rig.state.readRepair();
    for (
      const error of [
        new Error("current matrix history ancestry unavailable"),
        new CurrentMatrixRecoveryIntegrityFailure(
          CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE,
          BASE,
          null,
          null,
        ),
      ]
    ) {
      f.rig.state.readReleaseAt = () => Promise.reject(error);
      await assert.rejects(
        () => runHostedAutonomy(f.deps),
        (actual) => actual === error,
      );
      assert.equal(f.rig.merges, 0);
      assert.deepEqual(f.rig.closed, []);
      assert.deepEqual(await f.rig.state.readRepair(), before);
    }
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

/** The run's outcome plus every JSON line it logged, parsed. */
async function logged<T>(run: () => Promise<T>) {
  const lines: Record<string, unknown>[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    try {
      lines.push(JSON.parse(args.map(String).join(" ")));
    } catch {
      // Not a structured line.
    }
  };
  try {
    const outcome = await run().then(
      (value) => ({ value, error: null as unknown }),
      (error: unknown) => ({ value: null, error }),
    );
    return {
      ...outcome,
      diagnostics: lines.filter((line) =>
        line.kind === "sentinel_current_matrix_error"
      ),
    };
  } finally {
    console.log = original;
  }
}

Deno.test("maintenance: an exact producer whose wave is not listed defers only the walk, and reviewed foreign merge and closure continue", async () => {
  const f = await deadlineRig({ recover: () => Promise.resolve([]) });
  try {
    const outcome = await logged(() => runHostedAutonomy(f.deps));
    assert.equal(outcome.error, null, String(outcome.error));
    const result = outcome.value!;
    assert.ok(
      result.actions.includes("matrix-history:deferred"),
      JSON.stringify(result),
    );
    // The walk still stops at that producer: nothing older is read.
    assert.equal(f.calls.recovered, 1);
    assert.equal(f.rig.merges, 1);
    assert.deepEqual(f.rig.closed, [120]);
    const after = await f.rig.state.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    assert.deepEqual(
      after.value.snapshot.work.find((r) => r.id === f.pending.id),
      f.pending,
    );
    assert.deepEqual(after.value.snapshot.reservations, [f.charge]);
    assert.deepEqual(outcome.diagnostics, [{
      kind: "sentinel_current_matrix_error",
      name: "Error",
      message: CURRENT_MATRIX_WAVE_UNAVAILABLE,
      integrity: false,
      deferred: true,
    }]);
  } finally {
    await Deno.remove(f.rig.tmp, { recursive: true });
  }
});

Deno.test("maintenance: unavailable producer custody, integrity and unknown refusals still stop delivery, logged as fixed vocabulary", async () => {
  class Shaped extends Error {}
  const cases: {
    name: string;
    producer: ProducerCase;
    failRelease?: boolean;
    expected: Record<string, unknown>;
  }[] = [
    {
      name: "a custody read that fails mid-pass",
      producer: { recover: () => Promise.resolve([]) },
      failRelease: true,
      expected: {
        name: "Error",
        message: "current matrix producer custody unavailable",
        integrity: false,
      },
    },
    {
      name: "two waves for one exact producer",
      producer: { recover: () => Promise.resolve([{}, {}]) },
      expected: {
        name: "CurrentMatrixRecoveryIntegrityFailure",
        message: "current matrix wave binding changed",
        integrity: true,
      },
    },
    {
      name: "a transport refusal carrying payload text",
      producer: {
        recover: () =>
          Promise.reject(new Error(`upstream body ghp_${"x".repeat(36)}`)),
      },
      expected: { name: "Error", message: "[redacted]", integrity: false },
    },
    {
      name: "a subclass carrying the wave refusal's text",
      producer: {
        recover: () =>
          Promise.reject(new Shaped(CURRENT_MATRIX_WAVE_UNAVAILABLE)),
      },
      expected: {
        name: "Error",
        message: CURRENT_MATRIX_WAVE_UNAVAILABLE,
        integrity: false,
      },
    },
  ];
  for (const testCase of cases) {
    let failing = false;
    const f = await deadlineRig({
      ...testCase.producer,
      beforeCustody: () => {
        failing = testCase.failRelease === true;
      },
    });
    try {
      const read = f.rig.state.readRelease.bind(f.rig.state);
      f.rig.state.readRelease = () =>
        failing
          ? Promise.resolve(portError("unavailable", "release read failed"))
          : read();
      const before = await f.rig.state.readRepair();
      const outcome = await logged(() => runHostedAutonomy(f.deps));
      assert.ok(outcome.error instanceof Error, testCase.name);
      assert.equal(
        outcome.error instanceof CurrentMatrixRecoveryIntegrityFailure,
        testCase.expected.integrity,
        testCase.name,
      );
      assert.equal(f.rig.merges, 0, testCase.name);
      assert.deepEqual(f.rig.closed, [], testCase.name);
      assert.deepEqual(await f.rig.state.readRepair(), before, testCase.name);
      assert.deepEqual(outcome.diagnostics, [{
        kind: "sentinel_current_matrix_error",
        ...testCase.expected,
        deferred: false,
      }], testCase.name);
    } finally {
      await Deno.remove(f.rig.tmp, { recursive: true });
    }
  }
});
