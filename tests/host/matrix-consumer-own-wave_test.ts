/**
 * The progressive matrix consumer polls only for the producers its own
 * execution planned. An earlier wave's still-reserved producer gets the
 * mandatory initial recovery scan and nothing more: it never holds the
 * consumer's polling, and it stays charged for a later recovery.
 */
import assert from "node:assert/strict";
import { portOk } from "../../src/contracts/ports.ts";
import { runActionsRepairHost } from "../../src/host/actions.ts";
import {
  runActionsMatrixAggregateCycles,
  runActionsMatrixHost,
} from "../../src/host/matrix-actions.ts";
import { MATRIX_ARTIFACT_RECOVERY_MAX_MS } from "../../src/host/matrix-artifact-port.ts";
import {
  assertGen76Parses,
  assertGen76Shape,
  gen76Available,
} from "../state/gen76-contracts.ts";
import { issue, rig } from "./matrix-actions-fixtures.ts";

const MINUTE = 60_000;
/** The default consumer window: twenty minutes of polling at most. */
const CONSUMER_WINDOW_MS = 20 * MINUTE;

type Rig = Awaited<ReturnType<typeof rig>>;

async function plan(r: Rig, name: string) {
  const planned = await runActionsMatrixHost({
    ...await r.job(name, "matrix_plan"),
    model: {
      modelId: "gpt-reserve",
      runModel: () => Promise.reject(new Error("planner cannot infer")),
    },
  });
  assert.ok("plan" in planned);
  return planned;
}

/**
 * Run 71 plans live cells for both committed targets and ends without
 * delivering them. Run 72 then starts: its own planner admits sentinel issue
 * 2 when `ownProducer` is set (and nothing otherwise), and the REAL repair host
 * and REAL progressive consumer run over every charged producer. Only external
 * boundaries are fake: no completed artifact ever appears, the poll wait
 * advances the injected clock, and each target cycle records when it starts.
 */
async function runLaterWave(ownProducer: boolean) {
  const r = await rig();
  try {
    const earlier = await plan(r, "earlier-plan");
    assert.deepEqual(
      earlier.plan.cells.map((cell) => cell.repository.name).sort(),
      ["ai.ubq.fi", "sentinel"],
      "run 71 leaves a live charged cell for both targets",
    );
    // Run 71's cells never deliver; run 72 starts an hour later.
    r.clock.advance(60 * MINUTE);
    await r.advanceRun(72);
    if (ownProducer) {
      const sentinel = r.github.get("ubiquity-sentinel/sentinel")!;
      const rows = [issue(1), issue(2)];
      sentinel.listOpenIssues = () => {
        sentinel.calls.push("listOpenIssues");
        return Promise.resolve(portOk(rows));
      };
      sentinel.readIssue = (number: number) => {
        sentinel.calls.push("readIssue:" + number);
        return Promise.resolve(
          portOk(rows.find((row) => row.number === number) ?? null),
        );
      };
    }
    const current = await plan(r, "current-plan");
    assert.equal(current.plan.run.runId, 72);
    assert.equal(current.plan.cells.length, ownProducer ? 1 : 0);
    const before = await r.store.readRepair();
    assert.ok(before.ok && before.value.status === "found");
    const stale = earlier.plan.cells.map((cell) => cell.reservationId).sort();
    const own = current.plan.cells.map((cell) => cell.reservationId);
    for (const id of [...stale, ...own]) {
      assert.equal(
        before.value.snapshot.reservations.find((row) => row.id === id)
          ?.outcome,
        "reserved",
        "every planned producer is still live",
      );
    }
    const origin = r.clock.now();
    const deps = await r.job("current-aggregate", "repair");
    const scans: { at: number; ids: string[] }[] = [];
    const waits: number[] = [];
    const cycles: { slug: string; at: number }[] = [];
    const result = await runActionsRepairHost({
      ...deps,
      model: {
        modelId: "gpt-reserve",
        runModel: () => Promise.reject(new Error("aggregate cannot infer")),
      },
      runTargetCycles: (input) =>
        runActionsMatrixAggregateCycles(
          {
            ...input,
            runCycle: (cycleDeps) => {
              const repository = cycleDeps.configs[0]!.repository;
              cycles.push({
                slug: repository.owner + "/" + repository.name,
                at: r.clock.now(),
              });
              return Promise.resolve({ status: "idle", detail: "fixture" });
            },
          },
          {
            recover: (request) => {
              scans.push({
                at: r.clock.now(),
                ids: request.requests.map((entry) => entry.reservationId)
                  .sort(),
              });
              return Promise.resolve([]);
            },
          },
          { planDigest: current.planDigest },
          {
            pollWait: (ms) => {
              waits.push(ms);
              r.clock.advance(ms);
              return Promise.resolve();
            },
          },
        ),
    });
    assert.equal(result.status, "ran");
    const after = await r.store.readRepair();
    assert.ok(after.ok && after.value.status === "found");
    return {
      origin,
      stale,
      own,
      scans,
      waits,
      cycles,
      before: before.value.snapshot,
      after: after.value.snapshot,
    };
  } finally {
    await r.cleanup();
  }
}

Deno.test("matrix consumer: an earlier wave's still-reserved producer holds no poll wait", async () => {
  // Live: 24 implementation intents from an earlier wave kept their
  // reservations "reserved" long after their runs ended, and every later
  // child's consumer polled them for its whole 20-minute window before any
  // target cycle (and so any review request) started.
  const run = await runLaterWave(false);
  assert.equal(run.stale.length, 2);
  // The earlier wave still gets the mandatory initial recovery scan...
  assert.equal(run.scans.length, 1, JSON.stringify(run.scans));
  assert.equal(run.scans[0]!.at, run.origin);
  for (const id of run.stale) assert.ok(run.scans[0]!.ids.includes(id));
  // ...but never holds the consumer's polling: target work starts at once.
  assert.deepEqual(run.waits, []);
  assert.deepEqual(run.cycles.map((cycle) => cycle.slug), [
    "ubiquity-sentinel/sentinel",
    "ubiquity/ai.ubq.fi",
  ]);
  assert.equal(run.cycles[0]!.at, run.origin);
  // The stale producers stay reserved and unchanged: nothing is refunded,
  // settled or terminalized here; their recovery stays with later scans.
  for (const id of run.stale) {
    assert.equal(
      run.after.reservations.find((row) => row.id === id)?.outcome,
      "reserved",
    );
  }
  assert.deepEqual(run.after.reservations, run.before.reservations);
  assert.deepEqual(run.after.work, run.before.work);
  assertGen76Shape(run.after);
});

Deno.test("matrix consumer: a producer this execution planned is still waited for exactly as before, beside an earlier wave's", async () => {
  const run = await runLaterWave(true);
  assert.equal(run.stale.length, 2);
  assert.equal(run.own.length, 1);
  // The initial scan still covers every charged producer of every wave.
  assert.deepEqual(run.scans[0]!.ids, [...run.stale, ...run.own].sort());
  // The consumer polls its own live producer for the unchanged full window:
  // one scan a minute, the last one starting with its whole scan budget
  // before the window ends.
  const last = run.origin + CONSUMER_WINDOW_MS -
    MATRIX_ARTIFACT_RECOVERY_MAX_MS;
  assert.deepEqual(
    run.scans.map((scan) => scan.at),
    Array.from(
      { length: (last - run.origin) / MINUTE + 1 },
      (_, index) => run.origin + index * MINUTE,
    ),
  );
  assert.deepEqual(run.waits, run.scans.slice(1).map(() => MINUTE));
  // Every later scan downloads for this execution's own producer only.
  for (const scan of run.scans.slice(1)) assert.deepEqual(scan.ids, run.own);
  assert.equal(run.cycles[0]!.at, last);
  // Every live producer, own or earlier, stays charged and unresolved.
  assert.deepEqual(run.after.reservations, run.before.reservations);
  assert.deepEqual(run.after.work, run.before.work);
});

Deno.test({
  name:
    "matrix consumer: the snapshot a later-wave consumer run leaves parses under the rollback generation",
  ignore: !await gen76Available(),
  fn: async () => {
    const run = await runLaterWave(true);
    await assertGen76Parses(run.after);
  },
});

Deno.test("matrix consumer: a reservation within the skew allowance is this run's own, an earlier wave's is not", async () => {
  const { matrixConsumerProducersV1, MATRIX_CONSUMER_OWN_SKEW_MS } =
    await import("../../src/host/matrix-aggregate.ts");
  const { repairSnapshot } = await import("./hosted-autonomy-rig.ts");
  const { reservation, T0, workRecord } = await import("../state/helpers.ts");
  const { implementationIntentKey } = await import("../../src/repair/keys.ts");
  const planned = T0 + 60 * MINUTE;
  const row = (id: string) =>
    workRecord(id, {
      intent: {
        kind: "implementation",
        key: implementationIntentKey(`res-${id}`),
        startedAt: T0,
        branch: null,
        expectedHead: null,
        observedBase: null,
        pr: null,
        requestId: `res-${id}`,
        resultId: null,
      },
    });
  const snapshot = repairSnapshot(
    [row("skewed"), row("earlier"), row("after")],
    [],
    [],
    [
      // Planner clock 30 s behind the execution creator: still own.
      reservation("res-skewed", {
        taskId: "skewed",
        createdAt: planned - 30_000,
      }),
      // An earlier wave, minutes older: never own.
      reservation("res-earlier", {
        taskId: "earlier",
        createdAt: planned - 5 * MINUTE,
      }),
      reservation("res-after", {
        taskId: "after",
        createdAt: planned + 45_000,
      }),
    ],
  );
  const producers = matrixConsumerProducersV1(snapshot, planned);
  assert.equal(MATRIX_CONSUMER_OWN_SKEW_MS, MINUTE);
  assert.deepEqual(
    producers.live.map((p) => p.reservationId).sort(),
    ["res-after", "res-earlier", "res-skewed"],
  );
  assert.deepEqual(
    producers.own.map((p) => p.reservationId).sort(),
    ["res-after", "res-skewed"],
  );
});
