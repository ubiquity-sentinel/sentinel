/**
 * Live 2026-11-16 (supervisor run 43933165392): PR #417 was merged by the
 * self-merge executor in the serial repair job, yet the cycle's metrics
 * record counted only the maintenance delivery pass's merges
 * (`delivery-summary:...merges=0`). Finalize now adds each executor merge
 * completed in the cycle's window, exactly once.
 */
import assert from "node:assert/strict";
import type { ReleaseRequestV1 } from "../../src/contracts/release-types.ts";
import {
  parseRepairStateSnapshotV1,
  type RepairStateSnapshotV1,
} from "../../src/contracts/state-snapshots.ts";
import type { WorkRecordV1 } from "../../src/contracts/work-record.ts";
import type { DeliveryCountsV1 } from "../../src/host/delivery-counts-output.ts";
import type { RunJobSummaryV1 } from "../../src/host/run-summary.ts";
import { collectFinalizeMetricsV1 } from "../../src/host/throughput-metrics-finalize.ts";
import { evaluateThroughputWatchdogV1 } from "../../src/host/throughput-watchdog.ts";
import { runFinalizeMetricsTailV1 } from "../../src/host/throughput-watchdog-finalize.ts";
import { releaseRequest } from "../state/helpers.ts";
import {
  fixtureSha as sha,
  SELF_REPOSITORY as SELF,
  selfDeliveryRecord as delivered,
  selfMergeReceipt as receipt,
} from "./self-merge-receipt-fixture.ts";
import { fakeMetrics, fakeTracker } from "./throughput-watchdog-fakes.ts";

const T = Date.UTC(2026, 10, 16, 19, 10, 0);
const S = 1000;
const H = 3_600_000;

/** The release request the merge of `pr` booked at `createdAt`. */
function booked(pr: number, createdAt: number): ReleaseRequestV1 {
  const shape = receipt(pr);
  return releaseRequest(`release-${pr}`, {
    target: { repository: SELF, environment: "production" },
    revision: shape.merge,
    source: {
      pullRequest: pr,
      reviewRequestId: shape.requestId,
      reviewReceiptId: null,
      head: shape.head,
      base: shape.base,
    },
    createdAt,
  });
}

function snapshot(
  work: WorkRecordV1[],
  releaseRequests: ReleaseRequestV1[],
): RepairStateSnapshotV1 {
  return parseRepairStateSnapshotV1({
    version: "v1",
    kind: "repair_state_snapshot",
    stateHead: null,
    sequence: 1,
    updatedAt: T,
    incidents: [],
    evidence: [],
    work,
    reservations: [],
    reviews: [],
    replays: [],
    releaseRequests,
    githubCooldowns: [],
    attemptMemory: [],
    lessons: [],
  });
}

/** One cycle's jobs starting at `at`: maintenance first, repair last. */
function jobs(at: number): RunJobSummaryV1[] {
  const job = (name: string, from: number, to: number): RunJobSummaryV1 => ({
    name,
    conclusion: "success",
    summary: null,
    startedAtMs: at + from * S,
    completedAtMs: at + to * S,
  });
  return [
    job("maintenance", 0, 60),
    job("prepare", 61, 80),
    job("matrix_plan", 81, 100),
    job("repair", 101, 400),
  ];
}

function merges(
  at: number,
  repair: RepairStateSnapshotV1 | null,
  delivery: DeliveryCountsV1 | null,
  readJobs = true,
): number | null {
  return collectFinalizeMetricsV1({
    cycle: { runId: Math.floor(at / S), attempt: 1 },
    finalizeStartedAtMs: at + 410 * S,
    nowMs: at + 420 * S,
    jobs: readJobs ? jobs(at) : null,
    runSummary: null,
    deliveryCounts: delivery,
    repair,
  }).counts.mergesCompleted;
}

const ONE_MAINTENANCE_MERGE = {
  trainsBuilt: 0,
  targetCiRunsTriggered: 0,
  mergesCompleted: 1,
};

// #417 merged by the executor this cycle; #400 merged three hours earlier
// and still waiting at delivery; #410 squash-merged by maintenance this cycle
// (its booked request carries no executor receipt); #412's receipt saw the
// pull request closed rather than merged after the executor's merge landed.
const STATE = snapshot([
  delivered(400, receipt(400)),
  delivered(410, null),
  delivered(412, receipt(412, "closed")),
  delivered(417, receipt(417)),
], [
  booked(400, T - 3 * H),
  booked(410, T + 30 * S),
  booked(412, T + 250 * S),
  booked(417, T + 300 * S),
]);

Deno.test("throughput metrics: an executor merge of this cycle counts beside the maintenance merges", () => {
  // #410 from the maintenance count plus #412 and #417 from the executor
  // (the base counted #410 only).
  assert.equal(merges(T, STATE, ONE_MAINTENANCE_MERGE), 3);
  // A cycle whose maintenance pass reported no counts still records them.
  assert.equal(merges(T, STATE, null), 2);
});

Deno.test("throughput metrics: finalize's tail persists the executor merges of its cycle", async () => {
  const metrics = fakeMetrics([]);
  const issues = fakeTracker();
  const facts = {
    cycle: { runId: 43933165392, attempt: 1 },
    finalizeStartedAtMs: T + 410 * S,
    nowMs: T + 420 * S,
    jobs: jobs(T),
    runSummary: null,
    deliveryCounts: {
      trainsBuilt: 0,
      targetCiRunsTriggered: 0,
      mergesCompleted: 0,
    },
    repair: STATE,
  };
  const tail = await runFinalizeMetricsTailV1({
    metrics: { port: metrics, log: () => {} },
    watchdog: { metrics, issues, log: () => {} },
    selfImprove: undefined,
  }, facts);
  assert.equal(tail.metrics?.status, "applied");
  assert.equal(tail.watchdog?.filed, 0);
  const [record] = metrics.ledger.records;
  assert.equal(record.counts.mergesCompleted, 2);
  assert.equal(record.counts.targetCiRunsTriggered, 0);
  assert.equal(issues.creates.length, 0);
});

Deno.test("throughput metrics: a self merge waiting at delivery is never counted again", () => {
  // The next cycles read the same records, still waiting at delivery.
  for (const at of [T + 600 * S, T + 3 * H, T + 30 * H]) {
    assert.equal(merges(at, STATE, ONE_MAINTENANCE_MERGE), 1);
    assert.equal(merges(at, STATE, null), 0);
  }
  // The record merged three hours ago counted in its own cycle only.
  assert.equal(merges(T - 3 * H - 300 * S, STATE, null), 1);
});

Deno.test("throughput metrics: self merges stay unobserved without the repair state or job list", () => {
  assert.equal(merges(T, null, ONE_MAINTENANCE_MERGE), 1);
  assert.equal(merges(T, STATE, ONE_MAINTENANCE_MERGE, false), 1);
  assert.equal(merges(T, null, null), null);
  assert.equal(merges(T, STATE, null, false), null);
  // A request of another repository or revision books a different merge.
  const request = booked(417, T + 300 * S);
  const elsewhere = snapshot([delivered(417, receipt(417))], [
    { ...request, id: "release-417-revision", revision: sha(9) },
    {
      ...request,
      id: "release-417-repository",
      target: {
        repository: { ...SELF, name: "sentinel-passport" },
        environment: "production",
      },
    },
  ]);
  assert.equal(merges(T, elsewhere, null), 0);
});

Deno.test("throughput metrics: counted self merges only lower the CI-runs-per-merge ratio", () => {
  // Fourteen cycles over seven days, each with one train (one target CI
  // run); one cycle in four has a maintenance merge, and in every other
  // cycle the executor merged one self pull request.
  const records = (withRepair: boolean) =>
    Array.from({ length: 14 }, (_, i) => {
      const at = T - (13 - i) * 12 * H;
      const pr = 500 + i;
      const state = i % 2 === 0
        ? snapshot([delivered(pr, receipt(pr))], [booked(pr, at + 300 * S)])
        : snapshot([], []);
      return collectFinalizeMetricsV1({
        cycle: { runId: 9000 + i, attempt: 1 },
        finalizeStartedAtMs: at + 410 * S,
        nowMs: at + 420 * S,
        jobs: jobs(at),
        runSummary: null,
        deliveryCounts: {
          trainsBuilt: 1,
          targetCiRunsTriggered: 1,
          mergesCompleted: i % 4 === 0 ? 1 : 0,
        },
        repair: withRepair ? state : null,
      });
    });
  const ratio = (withRepair: boolean) =>
    evaluateThroughputWatchdogV1({
      records: records(withRepair),
      daily: [],
      nowMs: T + H,
    }).find((row) => row.id === "ci_runs_per_merge")!;
  const before = ratio(false);
  const after = ratio(true);
  assert.equal(before.detail, "14 / 4");
  assert.equal(before.verdict, "missed");
  assert.equal(after.detail, "14 / 11");
  assert.equal(after.verdict, "met");
  assert(after.measured! < before.measured!);
});
