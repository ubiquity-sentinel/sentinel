/**
 * The live starvation, end to end: a late cell finishes after its own repair
 * job's consumer stopped, so the maintenance history walk consumes it and
 * applies (`current-matrix:ingested:1`). Before continuation that pass
 * returned there, every pass, and the due conflict re-admission and the due
 * reviewed merge waited behind it. The real walk, producer pass and
 * preservation tail run here over one gen-79 release whose producer proof is
 * both the settled and the healthy one; repair state is the expected-head CAS
 * store with the real snapshot and transition rules, and the consumer is the
 * ingest seam with the real consumer's dispositions.
 */
import { withDarkQueueAuthority } from "./hosted-autonomy-preservation-fixtures.ts";
import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type {
  RepairStateWriter,
  StateReadView,
} from "../../src/contracts/ports.ts";
import type { MatrixPlanV1 } from "../../src/contracts/matrix-identity.ts";
import { matrixDigestV1 } from "../../src/contracts/matrix.ts";
import { HOSTED_RUNTIME_ID } from "../../src/contracts/hosted-supervisor.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import { CLOSED_C_WAVE } from "../../src/host/modern-matrix-recovery.ts";
import {
  candidatePreservationRef,
  implementationIntentKey,
} from "../../src/repair/keys.ts";
import {
  type HostedAutonomyDepsV1,
  type HostedAutonomyResultV1,
  runHostedAutonomy,
} from "../../ops/hosted-autonomy.ts";
import { runHostedMatrixMaintenance } from "../../ops/hosted-autonomy-maintenance.ts";
import { dedicatedMatrixReservations } from "../../ops/hosted-autonomy-current-recovery.ts";
import { CONFLICT_READMISSION_DETAIL } from "../../ops/hosted-autonomy-conflict-retries.ts";
import { REPO, reservation, SHA1, T0, workRecord } from "../state/helpers.ts";
import { deliveryRecord } from "./hosted-autonomy-fixtures.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";
import {
  assertCasChain,
  assertRollbackReads,
  CONFLICT,
  conflictBlocked,
  MERGE,
  NOW,
  PIN,
  RecordingState,
  SELF_ID,
  snapshotWith,
  surfaces,
} from "./hosted-autonomy-continuation-fixtures.ts";

const LATE = "issue-ubiquity-ai.ubq.fi-700";
const REQUEST = "7".repeat(64);
const CANDIDATE = "5".repeat(40) as GitSha;
const FAILED_CELL = "model run ended without a trusted receipt";

/** The late cell's record as its producer admitted it: charged, in flight. */
function lateRecord(): WorkRecordV1 {
  return workRecord(LATE, {
    source: { kind: "issue", id: "700", revision: SHA1 },
    related: { incidentId: null, issueNumber: 700 },
    counters: { attempts: 1, retries: 0, reviewRounds: 0 },
    intent: {
      kind: "implementation",
      key: implementationIntentKey(REQUEST),
      startedAt: T0,
      branch: null,
      expectedHead: null,
      observedBase: SHA1,
      pr: null,
      requestId: REQUEST,
      resultId: null,
    },
  });
}

/**
 * One maintenance pass over the late cell, the conflict candidate and the
 * reviewed self delivery. `outcome` is what the consumer makes of the cell:
 * a candidate it settles into the pending preservation, or a failed run.
 */
async function walkRig(outcome: "candidate" | "failed") {
  const state = new RecordingState(
    snapshotWith(
      [lateRecord(), await conflictBlocked(), deliveryRecord()],
      [reservation(REQUEST, { taskId: LATE, head: SHA1 })],
    ),
  );
  const github = surfaces(state);
  const read = await state.readRelease();
  assert.ok(read.ok && read.value.status === "found");
  const runtime = read.value.snapshot.hostedRuntimes.find((row) =>
    row.id === HOSTED_RUNTIME_ID
  )!;
  const proof = runtime.lastExecutionProof!;
  assert.equal(proof.outcome, "healthy");
  assert.deepEqual(proof, runtime.lastHealthyProof);
  const execution = proof.execution;
  const run = {
    runId: execution.runId,
    runAttempt: execution.runAttempt,
    launcherSha: execution.launcherSha,
  };
  const plan = {
    waveId: execution.id,
    run,
    cells: [{
      cellId: `cell-${LATE}`,
      taskId: LATE,
      repository: REPO,
      reservationId: REQUEST,
      intentKey: implementationIntentKey(REQUEST),
      expectedBase: SHA1,
      runtimeSha: execution.revision,
      generation: execution.generation,
    }],
  };
  const wave = {
    plan,
    provenance: { run },
    planDigest: await matrixDigestV1(plan as never),
    results: [{
      cellId: `cell-${LATE}`,
      taskId: LATE,
      reservationId: REQUEST,
      receipt: { candidate: { head: CANDIDATE } },
      bundle: { head: CANDIDATE },
    }],
    bundlesDir: "/nonexistent",
  };
  const ref = await candidatePreservationRef(
    REPO,
    LATE as never,
    implementationIntentKey(REQUEST),
  );
  const calls = { recovered: 0, ingested: 0, preserved: [] as string[] };
  const refs = new Map<string, string>();
  const ingest = async (
    cycle: { state: RepairStateWriter & StateReadView },
    planned: MatrixPlanV1,
  ) => {
    const current = await cycle.state.readRepair();
    assert.ok(current.ok && current.value.status === "found");
    const at = NOW;
    const { head, snapshot } = current.value;
    const written = await cycle.state.writeRepair({
      ...snapshot,
      stateHead: head as GitSha,
      sequence: snapshot.sequence + 1,
      updatedAt: at,
      work: snapshot.work.map((row) =>
        row.id !== LATE ? row : outcome === "candidate"
          ? {
            ...row,
            intent: {
              ...row.intent!,
              kind: "candidate_preservation" as const,
              startedAt: at,
              branch: ref,
              expectedHead: CANDIDATE,
            },
            target: {
              ...row.target,
              branch: `sentinel/repair/${LATE}`,
              head: CANDIDATE,
              candidateState: { preserved: null, publishedHead: null },
            },
            updatedAt: at,
          }
          : {
            ...row,
            nextStep: "blocked" as const,
            blocker: {
              kind: "other" as const,
              message: FAILED_CELL,
              since: at,
            },
            updatedAt: at,
          }
      ),
      reservations: snapshot.reservations.map((row) =>
        row.id === REQUEST
          ? { ...row, outcome: "submitted" as const, settledAt: at }
          : row
      ),
    }, head as GitSha);
    assert.ok(written.ok && written.value.status === "applied");
    calls.ingested++;
    return {
      waveId: planned.waveId,
      entries: [{
        cellId: `cell-${LATE}`,
        disposition: "ingested" as const,
        detail: null,
      }],
      ingested: 1,
    };
  };
  const preserver = {
    preserveCandidate: (
      request: { candidate: { ref: string; head: string } },
    ) => {
      calls.preserved.push(request.candidate.ref);
      refs.set(request.candidate.ref, request.candidate.head);
      return Promise.resolve(portOk(undefined));
    },
    readRef: (name: string) =>
      Promise.resolve(
        portOk(refs.has(name) ? { ref: name, sha: refs.get(name)! } : null),
      ),
  };
  const clock = { now: () => NOW };
  const deps: HostedAutonomyDepsV1 = {
    state: state as unknown as StateReadView & RepairStateWriter,
    githubFor: github.githubFor,
    clock,
    conflictResolutionRuntimes: PIN,
    closedMatrix: (composed) =>
      Promise.resolve({
        state: composed ?? deps.state,
        clock,
        configs: [{ repository: REPO }],
        cycleFor: () => ({ clock, github: preserver }),
        prepareTarget: () => Promise.resolve(),
        ingest,
        importerFor: () => ({}),
        transportFor: () => ({
          confirmCompletedExecution: () => Promise.resolve(true),
          recover: () => {
            calls.recovered++;
            return Promise.resolve([wave]);
          },
        }),
        readExecution: () => Promise.resolve(portOk(proof)),
      } as never),
  };
  return { state, github, deps: await withDarkQueueAuthority(deps), calls };
}

const late = (snapshot: { work: readonly WorkRecordV1[] }) =>
  snapshot.work.find((row) => row.id === LATE)!;
const conflict = (snapshot: { work: readonly WorkRecordV1[] }) =>
  snapshot.work.find((row) => row.id === CONFLICT)!;

function assertLiveOrder(result: HostedAutonomyResultV1) {
  const prefixes = [
    "current-matrix:ingested:1",
    `retry:${CONFLICT}:readmit:${CONFLICT_READMISSION_DETAIL}`,
    `merge:${SELF_ID}:pr=51:sha=${MERGE}`,
    `request:${SELF_ID}:`,
  ];
  const at = prefixes.map((prefix) =>
    result.actions.findIndex((action) => action.startsWith(prefix))
  );
  assert.ok(at.every((index) => index >= 0), JSON.stringify(result.actions));
  assert.deepEqual([...at].sort((a, b) => a - b), at);
}

Deno.test("continuation walk: the ingest, the conflict re-admission and the reviewed merge all land in one pass", async () => {
  const rig = await walkRig("candidate");
  const initial = rig.state.head;
  const result = await runHostedAutonomy(rig.deps);
  assert.equal(result.status, "applied", JSON.stringify(result));
  assert.equal(rig.calls.recovered, 1);
  assert.equal(rig.calls.ingested, 1);
  assert.equal(rig.calls.preserved.length, 1);
  assertLiveOrder(result);
  // The consumer write, the preservation, the retry write, the request write.
  assert.equal(rig.state.log.length, 4, JSON.stringify(result.actions));
  assertCasChain(rig.state.log, initial);
  const [, preserved, retried, delivered] = rig.state.log;
  // The retry write carries the ingested row exactly as the walk left it.
  assert.deepEqual(late(retried.next), late(preserved.next));
  assert.equal(
    late(retried.next).target.candidateState?.preserved?.head,
    CANDIDATE,
  );
  assert.equal(conflict(retried.next).nextStep, "work");
  // The request write carries the re-admitted row exactly as retry wrote it.
  assert.deepEqual(conflict(delivered.next), conflict(retried.next));
  assert.deepEqual(late(delivered.next), late(preserved.next));
  assert.equal(delivered.next.releaseRequests.length, 1);
  // One merge, after the retry write.
  assert.deepEqual(rig.github.merges, [3]);
  assert.equal(result.beforeHead, initial);
  assert.equal(result.appliedHead, rig.state.head);
  assert.equal(result.reason, "retried");
  assert.deepEqual(result.revisions, [MERGE]);
  // Every write parses and validates under R79 (the store) and R78.
  await assertRollbackReads(rig.state.log);
});

Deno.test("continuation walk: a row the walk just wrote waits for the next pass", async () => {
  const rig = await walkRig("failed");
  const result = await runHostedAutonomy(rig.deps);
  assert.equal(result.status, "applied", JSON.stringify(result));
  assertLiveOrder(result);
  assert.equal(rig.state.log.length, 3, JSON.stringify(result.actions));
  const [ingested, retried] = rig.state.log;
  assert.equal(late(ingested.next).blocker?.message, FAILED_CELL);
  // The failed cell is neither granted nor delivered in the pass that wrote it.
  assert.deepEqual(late(retried.next), late(ingested.next));
  assert.ok(
    !result.actions.some((action) => action.startsWith(`retry:${LATE}:`)),
    JSON.stringify(result.actions),
  );
  await assertRollbackReads(rig.state.log);
  // The next pass reads it fresh and grants it like any other parked row.
  const next = await runHostedAutonomy({
    ...rig.deps,
    closedMatrix: undefined,
  });
  assert.ok(
    next.actions.some((action) => action.startsWith(`retry:${LATE}:grant=`)),
    JSON.stringify(next),
  );
});

Deno.test("continuation walk: the closed-C ingest return carries the dedicated reservations", async () => {
  const cell = CLOSED_C_WAVE.cells[0];
  const needing = snapshotWith([], [
    reservation(cell.reservationId, {
      repository: cell.repository,
      taskId: cell.taskId,
      head: cell.base,
    }),
  ]);
  const settled = snapshotWith([]);
  let reads = 0;
  const state = {
    readRepair: () =>
      Promise.resolve(portOk({
        status: "found" as const,
        head: (reads++ === 0 ? "1" : "2").repeat(40) as GitSha,
        snapshot: reads === 1 ? needing : settled,
        ref: null,
      })),
    readRelease: () =>
      Promise.resolve(portOk({
        status: "found" as const,
        head: SHA1,
        snapshot: releaseSnapshot(),
        ref: null,
      })),
    writeRepair: () => {
      throw new Error("nothing is written here");
    },
  } as unknown as StateReadView & RepairStateWriter;
  const deps: HostedAutonomyDepsV1 = {
    state,
    githubFor: () => null,
    clock: { now: () => NOW },
    closedMatrix: () =>
      Promise.resolve(
        { state, clock: { now: () => NOW }, configs: [] } as never,
      ),
  };
  const dedicated = new Set<string>();
  const result = await runHostedMatrixMaintenance(deps, [], dedicated);
  assert.equal(result?.status, "applied", JSON.stringify(result));
  assert.deepEqual(result?.actions, ["closed-c-matrix:ingested:0"]);
  assert.deepEqual(
    [...dedicated].sort(),
    [...dedicatedMatrixReservations(deps, CLOSED_C_WAVE)].sort(),
  );
  assert.ok(dedicated.has(cell.reservationId));
});
