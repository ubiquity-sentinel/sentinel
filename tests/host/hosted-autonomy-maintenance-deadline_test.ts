/** Phase-local history expiry must leave independent guarded delivery live. */
import assert from "node:assert/strict";
import { darkQueueCoordinatorFixture } from "./hosted-autonomy-dark-queue-fixture.ts";
import { runHostedAutonomy } from "../../ops/hosted-autonomy-runner.ts";
import { CURRENT_MATRIX_HISTORY_DEADLINE_MESSAGE } from "../../ops/hosted-autonomy-policy.ts";
import { CurrentMatrixRecoveryIntegrityFailure } from "../../ops/hosted-autonomy-producer-recovery.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import type { HostedAutonomyDepsV1 } from "../../ops/hosted-autonomy-types.ts";
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

async function deadlineRig() {
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
  release.hostedRuntimes = [{
    version: "v1",
    kind: "hosted_runtime",
    id: "Ubiquity-Sentinel/sentinel:0:production",
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
  const moved = await store.writeRelease({
    ...read.value.snapshot,
    sequence: read.value.snapshot.sequence + 1,
    stateHead: read.value.head,
    updatedAt: T0 + 1,
  }, read.value.head);
  assert.ok(
    moved.ok && moved.value.status === "applied",
    JSON.stringify(moved),
  );
  let now = T0 + 5000;
  const deps: HostedAutonomyDepsV1 = {
    queue: await darkQueueCoordinatorFixture(rig),
    state: rig.state,
    githubFor: rig.githubFor,
    clock: { now: () => now },
    closedMatrix: () =>
      Promise.resolve({
        state: rig.state,
        clock: { now: () => now },
        configs: [],
        binding: CLOSED_C_WAVE,
        cycleFor: () => {
          throw new Error("no matrix producer is selected");
        },
        prepareTarget: () => {
          throw new Error("no matrix producer is selected");
        },
        importerFor: () => {
          throw new Error("no matrix producer is selected");
        },
        transportFor: () => {
          throw new Error("no matrix producer is selected");
        },
        readExecution: () => {
          throw new Error("no matrix producer is selected");
        },
      }),
  };
  const historyRead = rig.state.readReleaseAt!;
  return {
    rig,
    deps,
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
