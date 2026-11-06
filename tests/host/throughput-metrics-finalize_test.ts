import assert from "node:assert/strict";
import type { GitSha } from "../../src/contracts/brands.ts";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { portError, portOk } from "../../src/contracts/ports.ts";
import { foldThroughputRecordV1 } from "../../src/contracts/throughput-metrics.ts";
import { passSummaryLine } from "../../src/repair/pass-summary-line.ts";
import {
  aggregateRunSummary,
  type ChildRuntimeSummaryV1,
  type RunJobSummaryV1,
  runtimeSummaryWithPlanRefusal,
  scanRepairPassCounts,
} from "../../src/host/run-summary.ts";
import {
  formatTierCounts,
  parseTierCounts,
  TIER_COUNTS_ENV,
  tierCountsFromActions,
  tierSummaryAction,
  writeTierCountsOutput,
} from "../../src/host/tier-counts-output.ts";
import {
  collectFinalizeMetricsV1,
  writeFinalizeThroughputMetricsV1,
} from "../../src/host/throughput-metrics-finalize.ts";
import {
  EMPTY_THROUGHPUT_LEDGER,
  encodeThroughputLedgerV1,
  type ThroughputMetricsLedgerV1,
} from "../../src/state/throughput-metrics-ledger.ts";
import type { ThroughputMetricsPortV1 } from "../../src/state/throughput-metrics-store.ts";

const T = Date.UTC(2026, 10, 5, 12, 0, 0);
const HEAD = "a".repeat(40) as GitSha;

/** In-memory fake of the metrics sidecar with the store's CAS semantics. */
function fakePort(): ThroughputMetricsPortV1 & {
  ledger: ThroughputMetricsLedgerV1;
  writes: number;
} {
  let head: GitSha | null = null;
  const port = {
    ledger: EMPTY_THROUGHPUT_LEDGER,
    writes: 0,
    read: () => Promise.resolve(portOk({ head, ledger: port.ledger })),
    write: ({ expectedHead, ledger }: {
      expectedHead: GitSha | null;
      ledger: ThroughputMetricsLedgerV1;
    }) => {
      if (expectedHead !== head) {
        return Promise.resolve(portOk({ status: "conflict" as const, head }));
      }
      port.writes++;
      port.ledger = ledger;
      head = `${port.writes}`.padStart(40, "0") as GitSha;
      return Promise.resolve(portOk({ status: "applied" as const, head }));
    },
  };
  return port;
}

function child(
  modelStarts: number,
  purpose = "ordinary",
): ChildRuntimeSummaryV1 {
  return {
    launcherSha: HEAD,
    runtimeSha: HEAD,
    generation: 90,
    purpose,
    targets: [],
    admittedWorkCount: modelStarts,
    modelStarts,
    prsTouched: [],
    outcome: "healthy",
    reasonCode: "ok",
  };
}

function job(
  name: string,
  startS: number,
  endS: number,
  summary: ChildRuntimeSummaryV1 | null = null,
  conclusion = "success",
): RunJobSummaryV1 {
  return {
    name,
    conclusion,
    summary,
    startedAtMs: T + startS * 1000,
    completedAtMs: T + endS * 1000,
  };
}

function fakePass(purpose = "ordinary"): RunJobSummaryV1[] {
  return [
    job("maintenance", 0, 40),
    job("prepare", 41, 61),
    job("matrix_plan", 62, 80),
    job("matrix_cell (c1)", 81, 200, child(1, purpose)),
    job("matrix_cell (c2)", 81, 150, child(2, purpose)),
    job("repair", 81, 121, child(0, purpose)),
  ];
}

Deno.test("finalize persists one exact throughput record for a fake pass", async () => {
  const port = fakePort();
  const jobs = fakePass();
  const runSummary = aggregateRunSummary({ runId: 4242, runAttempt: 1 }, jobs);
  const lines: string[] = [];
  const result = await writeFinalizeThroughputMetricsV1(
    { port, log: (line) => lines.push(line) },
    {
      cycle: { runId: 4242, attempt: 1 },
      finalizeStartedAtMs: T + 205_000,
      nowMs: T + 212_500,
      jobs,
      runSummary,
    },
  );
  assert.equal(result.status, "applied");
  const files = encodeThroughputLedgerV1(port.ledger);
  assert.deepEqual([...files.keys()], ["throughput/2026-11-05.jsonl"]);
  const expected = {
    version: "v1",
    kind: "throughput_metrics",
    cycle: { runId: 4242, attempt: 1 },
    startedAtMs: T,
    finishedAtMs: T + 212_500,
    phaseMs: {
      maintenance: 40_000,
      prepare: 20_000,
      matrixPlan: 18_000,
      matrixCellTotal: 119_000 + 69_000,
      repair: 40_000,
      finalize: 7_500,
      bootstrap: null,
    },
    counts: {
      recordsRead: null,
      recordsStepped: null,
      recordsSkipped: null,
      cellsPlanned: 2,
      readyRecordsNotPlanned: null,
      modelStarts: 3,
      reviewsRequested: null,
      refreshCommits: null,
      targetCiRunsTriggered: null,
      trainsBuilt: null,
      mergesCompleted: null,
      ownerNoticesSent: null,
      releaseRequestsMovedToCold: null,
    },
    plannerRefusal: null,
    waitCauses: null,
  };
  assert.equal(
    files.get("throughput/2026-11-05.jsonl"),
    `${canonicalStringify(expected)}\n`,
  );
  assert.deepEqual(lines.map((line) => JSON.parse(line)), [{
    kind: "throughput_metrics_write",
    runId: 4242,
    attempt: 1,
    status: "applied",
  }]);
  // A rerun finalize of the same attempt never writes a second record.
  const again = await writeFinalizeThroughputMetricsV1(
    { port, log: () => {} },
    {
      cycle: { runId: 4242, attempt: 1 },
      finalizeStartedAtMs: T + 300_000,
      nowMs: T + 301_000,
      jobs,
      runSummary,
    },
  );
  assert.equal(again.status, "duplicate");
  assert.equal(port.writes, 1);
});

Deno.test("finalize leaves unobservable fields null and maps a bootstrap repair slot", async () => {
  const port = fakePort();
  const jobs = [
    job("maintenance", 0, 30),
    job("prepare", 31, 50),
    job("matrix_plan", 51, 51, null, "skipped"),
    job("matrix_cell (${{ matrix.cellId }})", 51, 51, null, "skipped"),
    job("repair", 52, 100, child(0, "bootstrap")),
  ];
  const runSummary = aggregateRunSummary({ runId: 5, runAttempt: 2 }, jobs);
  await writeFinalizeThroughputMetricsV1({ port, log: () => {} }, {
    cycle: { runId: 5, attempt: 2 },
    finalizeStartedAtMs: T + 101_000,
    nowMs: T + 102_000,
    jobs,
    runSummary,
  });
  const [record] = port.ledger.records;
  assert.equal(record.phaseMs.bootstrap, 48_000);
  assert.equal(record.phaseMs.repair, null);
  assert.equal(record.phaseMs.matrixPlan, null);
  assert.equal(record.phaseMs.matrixCellTotal, null);
  assert.equal(record.counts.cellsPlanned, null);
  assert.equal(record.counts.modelStarts, 0);

  // Unreadable jobs: only finalize's own window is known.
  const bare = fakePort();
  await writeFinalizeThroughputMetricsV1({ port: bare, log: () => {} }, {
    cycle: { runId: 6, attempt: 1 },
    finalizeStartedAtMs: T,
    nowMs: T + 900,
    jobs: null,
    runSummary: null,
  });
  const [unknown] = bare.ledger.records;
  assert.equal(unknown.startedAtMs, T);
  assert.equal(unknown.phaseMs.finalize, 900);
  assert(Object.values(unknown.counts).every((value) => value === null));
});

Deno.test("an unavailable metrics store never throws and logs only a closed status", async () => {
  const lines: string[] = [];
  const result = await writeFinalizeThroughputMetricsV1({
    port: {
      read: () => Promise.resolve(portError("unavailable", "down")),
      write: () => Promise.reject(new Error("never")),
    },
    log: (line) => lines.push(line),
  }, {
    cycle: { runId: 7, attempt: 1 },
    finalizeStartedAtMs: T,
    nowMs: T + 1,
    jobs: null,
    runSummary: null,
  });
  assert.deepEqual(result, { status: "unavailable", detail: "unavailable" });
  assert.equal(lines.length, 1);
  assert(!lines[0].includes("down"));
});

// ---------------------------------------------------------------------------
// #338 follow-up: tier counts from maintenance and repair pass counts from
// the repair job log reach the record; bootstrap uses the launcher duration.
// ---------------------------------------------------------------------------

function passLine(read: number, stepped: number, unchanged: number): string {
  const line = passSummaryLine({
    recordsRead: read,
    recordsStepped: stepped,
    recordsSkipped: unchanged + 1,
    skipReasons: { unchanged_inputs: unchanged, waiting: 1 },
    batchReads: 2,
    batchUnavailable: 0,
  });
  assert(line !== null);
  return `2026-11-05T12:01:00.0000000Z ${line}`;
}

function repairLog(
  passes: string[],
  extra: Record<string, unknown> = {},
): string {
  return [
    "2026-11-05T12:01:00.0000000Z Run selected Sentinel runtime",
    ...passes,
    `2026-11-05T12:02:00.0000000Z ${
      JSON.stringify({ ...child(0), kind: "hosted_runtime_summary", ...extra })
    }`,
  ].join("\n");
}

Deno.test("finalize records tier counts and the repair passes' read/stepped/skipped", async () => {
  // Maintenance: the tier step's action becomes the closed step output.
  const action = tierSummaryAction({
    recordsRead: 731,
    demoted: 40,
    promoted: 2,
    releaseRequestsMovedToCold: 3,
    releaseRequestsSuperseded: 1,
  });
  assert.equal(
    action,
    "tier-summary:read=731:demoted=40:promoted=2:moved_cold=3:superseded=1",
  );
  const dir = await Deno.makeTempDir({ dir: ".", prefix: ".tier-counts-" });
  let value: string;
  try {
    const path = `${dir}/output`;
    await writeTierCountsOutput(path, null);
    await writeTierCountsOutput(
      path,
      tierCountsFromActions(["repair-tier:absent", action!]),
    );
    const lines = (await Deno.readTextFile(path)).trim().split("\n");
    assert.deepEqual(lines, ["tierCounts=none", "tierCounts=731,40,2,3,1"]);
    value = lines.at(-1)!.slice("tierCounts=".length);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  // Repair: two re-emitted pass lines in the job log, read by the selector.
  const summary = runtimeSummaryWithPlanRefusal(
    repairLog([passLine(700, 5, 600), passLine(745, 3, 700)]),
  );
  assert.deepEqual(summary?.repairPass, {
    recordsRead: 745,
    recordsStepped: 8,
    recordsSkipped: 1_302,
  });
  const jobs = [
    job("maintenance", 0, 40),
    job("prepare", 41, 61),
    job("repair", 62, 120, summary),
  ];
  const port = fakePort();
  await writeFinalizeThroughputMetricsV1({ port, log: () => {} }, {
    cycle: { runId: 9, attempt: 1 },
    finalizeStartedAtMs: T + 121_000,
    nowMs: T + 122_000,
    jobs,
    runSummary: aggregateRunSummary({ runId: 9, runAttempt: 1 }, jobs),
    tierCounts: parseTierCounts(value),
  });
  const [record] = port.ledger.records;
  // Both report a read: the larger one, never the sum.
  assert.equal(record.counts.recordsRead, 745);
  assert.equal(record.counts.recordsStepped, 8);
  assert.equal(record.counts.recordsSkipped, 1_302);
  assert.equal(record.counts.releaseRequestsMovedToCold, 3);
  assert.equal(record.counts.recordsDemoted, 40);
  assert.equal(record.counts.recordsPromoted, 2);
  assert.equal(record.counts.releaseRequestsSuperseded, 1);
  // The new counters fold into the daily rollup too.
  const daily = foldThroughputRecordV1(null, record);
  assert.deepEqual(daily.counts.recordsDemoted, { sum: 40, known: 1 });
});

Deno.test("tier counts: unobserved release moves stay null and malformed values are unobserved", () => {
  const action = tierSummaryAction({
    recordsRead: 10,
    demoted: 0,
    promoted: 0,
    releaseRequestsMovedToCold: null,
    releaseRequestsSuperseded: null,
  });
  const counts = tierCountsFromActions([action!]);
  assert.equal(formatTierCounts(counts), "10,0,0,-,-");
  const record = collectFinalizeMetricsV1({
    cycle: { runId: 3, attempt: 1 },
    finalizeStartedAtMs: T,
    nowMs: T + 1,
    jobs: null,
    runSummary: null,
    tierCounts: parseTierCounts("10,0,0,-,-"),
  });
  assert.equal(record.counts.recordsRead, 10);
  assert.equal(record.counts.recordsStepped, null);
  assert.equal(record.counts.releaseRequestsMovedToCold, null);
  assert.equal(record.counts.releaseRequestsSuperseded, undefined);
  assert.equal(record.counts.recordsDemoted, 0);
  assert.equal(
    tierSummaryAction({
      recordsRead: null,
      demoted: 0,
      promoted: 0,
      releaseRequestsMovedToCold: null,
      releaseRequestsSuperseded: null,
    }),
    null,
  );
  for (
    const bad of [
      undefined,
      null,
      "",
      "none",
      "1,2,3,4",
      "1,2,3,x,4",
      "-,0,0,0,0",
    ]
  ) assert.equal(parseTierCounts(bad), null, String(bad));
  assert.equal(
    tierCountsFromActions([action!, action!]),
    null,
    "two summaries are ambiguous",
  );
  // Without tier counts or a repair pass, the record keeps the older shape.
  const bare = collectFinalizeMetricsV1({
    cycle: { runId: 4, attempt: 1 },
    finalizeStartedAtMs: T,
    nowMs: T + 1,
    jobs: null,
    runSummary: null,
  });
  assert(!Object.hasOwn(bare.counts, "recordsDemoted"));
  assert.equal(scanRepairPassCounts("no pass lines\n"), null);
});

Deno.test("finalize takes the bootstrap duration from the launcher summary", () => {
  const summary = runtimeSummaryWithPlanRefusal(
    repairLog([], { purpose: "bootstrap", bootstrapDurationMs: 31_500 }),
  );
  assert.equal(summary?.bootstrapDurationMs, 31_500);
  const jobs = [job("prepare", 0, 20), job("repair", 21, 90, summary)];
  const record = collectFinalizeMetricsV1({
    cycle: { runId: 5, attempt: 1 },
    finalizeStartedAtMs: T + 91_000,
    nowMs: T + 92_000,
    jobs,
    runSummary: aggregateRunSummary({ runId: 5, runAttempt: 1 }, jobs),
  });
  assert.equal(record.phaseMs.bootstrap, 31_500);
  assert.equal(record.phaseMs.repair, null);
});

Deno.test("workflow carries the tier counts from maintenance to finalize", async () => {
  const root = new URL("../../", import.meta.url);
  const workflow = await Deno.readTextFile(
    new URL(".github/workflows/supervisor.yml", root),
  );
  const maintenance = workflow.slice(
    workflow.indexOf("\n  maintenance:"),
    workflow.indexOf("\n  prepare:"),
  );
  const finalize = workflow.slice(workflow.indexOf("\n  finalize:"));
  assert.match(
    maintenance,
    /^ {6}tierCounts: \$\{\{ steps\.autonomy\.outputs\.tierCounts \}\}$/m,
  );
  assert.match(
    finalize,
    /^ {10}SENTINEL_TIER_COUNTS: \$\{\{ needs\.maintenance\.outputs\.tierCounts \}\}$/m,
  );
  const tasks = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", root)),
  ).tasks as Record<string, string>;
  assert.match(
    tasks["supervisor:run"],
    new RegExp(`--allow-env=[^ ]*\\b${TIER_COUNTS_ENV}\\b`),
  );
});
