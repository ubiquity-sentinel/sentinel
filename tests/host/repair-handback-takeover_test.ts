/**
 * The serial repair job steps the records its own run's repository cells
 * handed back, in the same run (issue #328; live 2026-11-13: PR #389 lost a
 * supervisor cycle at its refresh and another at its review start, #399 and
 * #400 opened about an hour after their code was ready).
 *
 * Three published heads on a moved base, all delegated: the cell hands back
 * the line front (its refresh is a trusted effect). The REAL aggregate and
 * step loop run over in-memory state, a fake repository and a fake artifact
 * transport; no network, no model call. The last two tests run the whole
 * chain: the REAL cell host seals the delta, and the REAL hand-back reader
 * and finalize read that run from a fake Actions API through the production
 * transport (`repair-fanout-actions-rig.ts`).
 */
import assert from "node:assert/strict";
import type { GitHubPort } from "../../src/contracts/ports.ts";
import { portOk } from "../../src/contracts/ports.ts";
import type { RepairDeltaEnvelopeV1 } from "../../src/contracts/repair-delta.ts";
import type { RepositoryIdentityV1 } from "../../src/contracts/shared.ts";
import type { RepairStateSnapshotV1 } from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { ActionsTargetCyclesInputV1 } from "../../src/host/actions.ts";
import type {
  MatrixArtifactTransportV1,
  RepairHandbackRequestV1,
  RepairHandbackV1,
} from "../../src/host/matrix-artifact-port.ts";
import { REPAIR_CELL_MARKER_KIND } from "../../src/host/hosted-runtime-repair-cell.ts";
import { scanChildStatusRecords } from "../../src/host/hosted-runtime-status.ts";
import { runActionsMatrixAggregateCycles } from "../../src/host/matrix-aggregate.ts";
import { runRepairFanoutFinalize } from "../../src/host/repair-fanout-finalize.ts";
import {
  publishRepairFanoutOrNone,
  readRepairFanoutPlan,
  runRepairCellTargetCycles,
} from "../../src/host/repair-fanout-host.ts";
import { readRepairHandbacks } from "../../src/host/repair-handback-reader.ts";
import { REPAIR_HANDBACK_KIND } from "../../src/host/repair-handback-takeover.ts";
import {
  delegatedRecordsV1,
  planRepairFanoutV1,
} from "../../src/repair/repair-fanout-plan.ts";
import { STEP_LINE_KIND } from "../../src/repair/step-line.ts";
import { queueRig } from "../repair/delivery-queue-rig.ts";
import { captured, OLD_STAMP } from "../repair/repository-pass-rig.ts";
import { MINUTE, sha } from "../repair/review-round-cap-rig.ts";
import { REPO, SHA1, SHA2, T0 } from "../state/helpers.ts";
import { releaseSnapshot } from "./hosted-autonomy-rig.ts";
import { actionsRun, RUNTIME, TOKEN } from "./repair-fanout-actions-rig.ts";

const RUN = { runId: 41, runAttempt: 1, launcherSha: SHA1 };
type Rig = Awaited<ReturnType<typeof queueRig>>;

async function line(): Promise<Rig> {
  const rig = await queueRig(3, {
    tip: sha(0x777),
    shape: (records) =>
      records.map((record) => ({ ...record, stepInputs: OLD_STAMP })),
  });
  // The aggregate reads both authoritative state surfaces.
  rig.state.setRelease(releaseSnapshot());
  return rig;
}

/** `line()` with the batched live read, so every settled step is stamped. */
async function stampedLine(): Promise<Rig> {
  const rig = await line();
  const github = rig.github;
  (github as GitHubPort).readLiveInputs = (request) =>
    Promise.resolve(portOk({
      issues: request.issues.map((number) => ({
        number,
        state: "open" as const,
      })),
      pulls: request.pulls.map((number) => {
        const pr = github.pulls.get(number);
        return {
          number,
          pull: pr === undefined ? null : {
            number,
            state: pr.mergeSha === null ? "open" as const : "merged" as const,
            head: github.heads.get(pr.branch)!,
            base: github.remoteBase,
            baseRef: "development",
            checks: "success" as const,
            latestReview: null,
          },
        };
      }),
      branches: request.branches.map((branch) => ({
        branch,
        tip: github.remoteBase,
      })),
    }));
  return rig;
}

async function inTemp(body: (work: string) => Promise<void>) {
  const work = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-repair-test-handback-",
  });
  try {
    await body(work);
  } finally {
    await Deno.remove(work, { recursive: true });
  }
}

/** The planner's fan-out plan; returns the matrix root and plan digest. */
async function published(rig: Rig, work: string) {
  const root = work + "/planner/.sentinel-matrix";
  const output = work + "/github-output";
  await Deno.writeTextFile(output, "");
  await Deno.mkdir(root, { recursive: true });
  await publishRepairFanoutOrNone({
    state: rig.state,
    configs: rig.deps.configs,
    run: RUN,
    artifactRoot: root,
    output,
  });
  const digest = (await Deno.readTextFile(output)).split("\n")
    .find((row) => row.startsWith("repairPlanDigest="))!
    .slice("repairPlanDigest=".length);
  assert.match(digest, /^[0-9a-f]{64}$/);
  return { root, digest };
}

function aggregateInput(rig: Rig, artifactRoot: string) {
  return {
    ...rig.deps,
    controllerSha: SHA2,
    deadline: rig.clock.now() + 90 * MINUTE,
    stepLimit: Infinity,
    modelStartsEnabled: true,
    composeGithub: () => rig.github,
    host: {
      execution: {
        id: "41:1:repair",
        runId: 41,
        runAttempt: 1,
        launcherSha: SHA1,
        purpose: "ordinary" as const,
        revision: SHA2,
        generation: 3,
        releaseId: null,
        createdAt: T0,
      },
      run: RUN,
      artifactRoot,
      sourcePathFor: () => "/unused",
      expectedProvider: "unused",
      createArtifactTransport: () => {
        throw new Error("the injected transport is used");
      },
    },
  } as unknown as ActionsTargetCyclesInputV1;
}

/** No matrix producer; the cells' hand-backs as the transport reads them. */
function transport(
  handbacks: readonly RepairHandbackV1[] | null | undefined,
  asked: RepairHandbackRequestV1[] = [],
): MatrixArtifactTransportV1 {
  return {
    recover: () => Promise.resolve([]),
    ...(handbacks === undefined ? {} : {
      repairHandbacks: (request: RepairHandbackRequestV1) => {
        asked.push(request);
        return Promise.resolve(handbacks);
      },
    }),
  };
}

async function aggregate(
  rig: Rig,
  work: string,
  reader: MatrixArtifactTransportV1,
  overrides: Partial<ActionsTargetCyclesInputV1> = {},
) {
  const { root, digest } = await published(rig, work);
  const { lines } = await captured(() =>
    runActionsMatrixAggregateCycles(
      { ...aggregateInput(rig, root), ...overrides },
      reader,
      { planDigest: "d".repeat(64), repairPlanDigest: digest },
      { maxWaitMs: 20 * MINUTE },
    )
  );
  return {
    digest,
    stepped: lines.filter((entry) => entry.kind === STEP_LINE_KIND)
      .map((entry) => entry.recordId),
    handback: lines.filter((entry) => entry.kind === REPAIR_HANDBACK_KIND),
  };
}

const FRONT: RepositoryIdentityV1 = REPO;

Deno.test("hand-back takeover: the serial pass steps the record a completed cell handed back in the same run", async () => {
  const rig = await line();
  await inTemp(async (work) => {
    const asked: RepairHandbackRequestV1[] = [];
    const { digest, stepped, handback } = await aggregate(
      rig,
      work,
      transport([{ repository: FRONT, records: ["issue-1"] }], asked),
    );
    // Its refresh ran on the trusted path now, not on the next plan.
    assert.ok(stepped.includes("issue-1"), JSON.stringify(stepped));
    assert.ok(rig.github.refreshes >= 1);
    // The heads the cell kept stay its own: never stepped here.
    assert.deepEqual(stepped.filter((id) => id !== "issue-1"), []);
    // One advisory line, never read as the child's status record.
    assert.deepEqual(handback, [{
      kind: REPAIR_HANDBACK_KIND,
      outcome: "read",
      records: 1,
    }]);
    assert.deepEqual(
      scanChildStatusRecords(JSON.stringify(handback[0])),
      { kind: "none" },
    );
    // The read is bound to this run, its runtime and its plan.
    assert.equal(asked.length, 1);
    assert.equal(asked[0].planDigest, digest);
    assert.deepEqual(asked[0].run, RUN);
    assert.deepEqual(asked[0].runtime, { revision: SHA2, generation: 3 });
  });
});

Deno.test("hand-back takeover: a hand-back of a target whose cycle already ended is not counted as woken", async () => {
  const rig = await line();
  await inTemp(async (work) => {
    // The target's preparation failed: its cycle ended before the read.
    const { stepped, handback } = await aggregate(
      rig,
      work,
      transport([{ repository: FRONT, records: ["issue-1"] }]),
      { prepareTarget: () => Promise.reject(new Error("checkout failed")) },
    );
    assert.deepEqual(stepped, []);
    assert.equal(rig.github.refreshes, 0);
    assert.deepEqual(handback, [{
      kind: REPAIR_HANDBACK_KIND,
      outcome: "read",
      records: 0,
    }]);
  });
});

Deno.test("hand-back takeover: without a hand-back every delegated record stays the cells'", async () => {
  for (
    const handbacks of [
      undefined,
      null,
      [],
      // Not delegated by this plan, or not this repository's: never woken.
      [{ repository: FRONT, records: ["issue-9"] }],
      [{
        repository: { ...FRONT, name: "elsewhere" },
        records: ["issue-1"],
      }],
    ]
  ) {
    const rig = await line();
    await inTemp(async (work) => {
      const { stepped } = await aggregate(rig, work, transport(handbacks));
      assert.deepEqual(stepped, [], JSON.stringify(handbacks));
      assert.equal(rig.github.refreshes, 0);
    });
  }
});

function rowOf(snapshot: RepairStateSnapshotV1, id: string): WorkRecordV1 {
  const found = snapshot.work.find((record) => record.id === id);
  assert.ok(found !== undefined, id);
  return found;
}

function unstamped(record: WorkRecordV1): WorkRecordV1 {
  const { stepInputs: _stamp, ...rest } = record;
  return rest as WorkRecordV1;
}

async function delegatedNext(rig: Rig): Promise<string[]> {
  const next = await planRepairFanoutV1({
    snapshot: await rig.snapshot(),
    head: rig.state.repairHead!,
    configs: rig.deps.configs,
    runId: 99,
    runAttempt: 1,
  });
  return [...delegatedRecordsV1(next)].sort();
}

/**
 * One supervisor run end to end: the planner's plan, the REAL repository
 * cell's sealed delta, the serial job's REAL takeover reading this run's
 * Actions artifacts, `between` (another write landing before finalize), then
 * finalize's REAL authentication and application of the same artifacts.
 */
async function endToEnd(
  rig: Rig,
  work: string,
  between: () => Promise<void> = () => Promise.resolve(),
) {
  const { root, digest } = await published(rig, work);
  const fanout = await readRepairFanoutPlan(root, digest, RUN);
  assert.equal(fanout.cells.length, 1);
  const [cell] = fanout.cells;
  const input = aggregateInput(rig, root);
  const carrier = { planDigest: "d".repeat(64), repairPlanDigest: digest };
  const sealed = await captured(() =>
    runRepairCellTargetCycles(input, { ...carrier, cellId: cell.cellId })
  );
  const envelope = JSON.parse(
    await Deno.readTextFile(work + "/planner/.sentinel-repair/result.json"),
  ) as RepairDeltaEnvelopeV1;
  // The run's Actions API serves exactly the marker the cell printed.
  assert.deepEqual(
    sealed.lines.filter((entry) => entry.kind === REPAIR_CELL_MARKER_KIND),
    [{
      kind: REPAIR_CELL_MARKER_KIND,
      run: RUN,
      runtimeSha: RUNTIME.revision,
      generation: RUNTIME.generation,
      cellId: cell.cellId,
      deltaDigest: envelope.digest,
      transitions: envelope.delta.transitions.length,
    }],
  );
  const run = await actionsRun(
    rig,
    fanout,
    new Map([[cell.repository.name, envelope]]),
  );
  const reads = {
    state: rig.state,
    token: TOKEN,
    http: run.http,
    clock: rig.clock,
  };
  const serial = await captured(() =>
    runActionsMatrixAggregateCycles(
      input,
      {
        recover: () => Promise.resolve([]),
        repairHandbacks: (request) =>
          readRepairHandbacks(reads, request, {
            wait: (ms) => {
              rig.clock.advance(ms);
              return Promise.resolve();
            },
          }),
      },
      carrier,
      { maxWaitMs: 20 * MINUTE },
    )
  );
  await between();
  const settled = structuredClone(await rig.snapshot());
  const { value: result } = await captured(() =>
    runRepairFanoutFinalize({
      ...reads,
      run: RUN,
      runtime: RUNTIME,
      planDigest: digest,
      deadline: rig.clock.now() + 10 * MINUTE,
    })
  );
  assert.ok(result !== null);
  return { cell, delta: envelope.delta, serial: serial.lines, settled, result };
}

Deno.test("hand-back takeover: finalize then applies the cell's kept transitions and leaves the record taken over its trusted row", async () => {
  const rig = await stampedLine();
  await inTemp(async (work) => {
    const planned = structuredClone(await rig.snapshot());
    const { cell, delta, serial, settled, result } = await endToEnd(rig, work);
    // The cell kept the held heads and handed back the line front, which the
    // serial job's takeover refreshed in this same run.
    assert.deepEqual(delta.deferredToTrusted, ["issue-1"]);
    assert.deepEqual(delta.transitions.map((row) => row.after.id), [
      "issue-2",
      "issue-3",
    ]);
    assert.deepEqual(
      serial.filter((entry) => entry.kind === REPAIR_HANDBACK_KIND),
      [{ kind: REPAIR_HANDBACK_KIND, outcome: "read", records: 1 }],
    );
    assert.ok(rig.github.refreshes >= 1);
    const trusted = rowOf(settled, "issue-1");
    assert.notEqual(
      trusted.target.head,
      rowOf(planned, "issue-1").target.head,
    );
    // Every kept transition lands on its exact planned row.
    assert.equal(result.status, "applied");
    assert.deepEqual(result.rejected, []);
    assert.deepEqual(result.applied, [{
      repository: cell.repository,
      transitions: 2,
    }]);
    const after = await rig.snapshot();
    for (const transition of delta.transitions) {
      assert.deepEqual(rowOf(after, transition.after.id), transition.after);
    }
    // The record taken over keeps the trusted row; only its stamp is gone.
    assert.equal(result.handedBack, 1);
    assert.deepEqual(rowOf(after, "issue-1"), unstamped(trusted));
    assert.deepEqual(await delegatedNext(rig), ["issue-2", "issue-3"]);
  });
});

Deno.test("hand-back takeover: a rejected delta still leaves the record taken over its trusted row", async () => {
  const rig = await stampedLine();
  await inTemp(async (work) => {
    const planned = structuredClone(await rig.snapshot());
    // Another trusted write moves a record the cell kept before finalize.
    const { delta, settled, result } = await endToEnd(rig, work, async () => {
      const read = await rig.state.readRepair();
      assert.ok(read.ok && read.value.status === "found");
      const { snapshot, head } = read.value;
      const written = await rig.state.writeRepair({
        ...snapshot,
        sequence: snapshot.sequence + 1,
        work: snapshot.work.map((record) =>
          record.id === "issue-2"
            ? { ...record, updatedAt: record.updatedAt + 1 }
            : record
        ),
      }, head);
      assert.ok(written.ok && written.value.status === "applied");
    });
    assert.deepEqual(delta.deferredToTrusted, ["issue-1"]);
    const trusted = rowOf(settled, "issue-1");
    assert.notEqual(
      trusted.target.head,
      rowOf(planned, "issue-1").target.head,
    );
    // The whole delta is rejected: none of its kept transitions lands, and
    // every delegated record is handed back as it now stands, the record
    // taken over with its trusted row.
    assert.deepEqual(result.applied, []);
    assert.deepEqual(result.rejected.map((entry) => entry.reason), [
      "base_moved",
    ]);
    assert.equal(result.handedBack, 3);
    const after = await rig.snapshot();
    for (const id of ["issue-1", "issue-2", "issue-3"]) {
      assert.deepEqual(rowOf(after, id), unstamped(rowOf(settled, id)), id);
    }
    assert.deepEqual(await delegatedNext(rig), []);
  });
});
