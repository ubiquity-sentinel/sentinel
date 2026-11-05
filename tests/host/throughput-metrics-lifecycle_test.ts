import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import {
  parseThroughputMetricsLineV1,
  THROUGHPUT_METRICS_RECORD_MAX_BYTES,
} from "../../src/contracts/throughput-metrics.ts";
import {
  collectFinalizeMetricsV1,
  type FinalizeMetricsFactsV1,
  writeFinalizeThroughputMetricsV1,
} from "../../src/host/throughput-metrics-finalize.ts";
import { DenoGitRunner } from "../../src/state/state-git.ts";
import {
  THROUGHPUT_DAILY_PATH,
  THROUGHPUT_METRICS_REF,
} from "../../src/state/throughput-metrics-ledger.ts";
import {
  appendThroughputMetricsV1,
  GitThroughputMetricsStore,
} from "../../src/state/throughput-metrics-store.ts";
import { gitRun, makeRemoteCtx, testGitEnv } from "../state/helpers.ts";

const MIDNIGHT = Date.UTC(2026, 10, 6);

function facts(runId: number): FinalizeMetricsFactsV1 {
  const nowMs = MIDNIGHT + (runId - 6) * 300_000;
  return {
    cycle: { runId, attempt: 1 },
    finalizeStartedAtMs: nowMs - 1_000,
    nowMs,
    jobs: [],
    runSummary: null,
    deliveryCounts: {
      trainsBuilt: 1,
      targetCiRunsTriggered: 2,
      mergesCompleted: 1,
    },
    ownerNoticesSent: 1,
  };
}

Deno.test("finalize keeps ten consecutive cycles readable and compacts completed UTC days", async () => {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-metrics-lifecycle-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  try {
    await Deno.mkdir(`${root}/home`);
    const env = testGitEnv(`${root}/home`);
    const { bare, remoteUrl } = await makeRemoteCtx(root, env);
    const runner = new DenoGitRunner(`${root}/home`);
    const store = new GitThroughputMetricsStore({
      scratchDir: `${root}/writer`,
      remoteUrl,
      runner,
    });
    const log: string[] = [];
    const heads: string[] = [];
    for (let runId = 1; runId <= 10; runId++) {
      const pass = facts(runId);
      const result = await writeFinalizeThroughputMetricsV1(
        { port: store, log: (line) => log.push(line) },
        pass,
      );
      assert.equal(result.status, "applied");
      // A fresh consumer, not the writer's memory, must see the exact cycle.
      const reader = new GitThroughputMetricsStore({
        scratchDir: `${root}/reader-${runId}`,
        remoteUrl,
        runner,
      });
      const read = await reader.read();
      assert(read.ok && read.value.head !== null);
      heads.push(read.value.head);
      assert.deepEqual(
        read.value.ledger.records.at(-1),
        collectFinalizeMetricsV1(pass),
      );
      assert.equal(
        (await writeFinalizeThroughputMetricsV1(
          { port: store, log: () => {} },
          pass,
        )).status,
        "duplicate",
      );
    }
    const read = await store.read();
    assert(read.ok);
    assert.deepEqual(read.value.ledger.records.map((row) => row.cycle.runId), [
      6,
      7,
      8,
      9,
      10,
    ]);
    assert.equal(read.value.ledger.daily.length, 1);
    const daily = read.value.ledger.daily[0];
    assert.equal(daily.date, "2026-11-05");
    assert.equal(daily.records, 5);
    assert.deepEqual(daily.counts.mergesCompleted, { sum: 5, known: 5 });
    const cold = await gitRun(bare, [
      "show",
      `${THROUGHPUT_METRICS_REF}:${THROUGHPUT_DAILY_PATH}`,
    ], env);
    assert(cold.ok);
    assert.equal(cold.stdout, `${canonicalStringify(daily)}\n`);
    // Compaction never rewrites the original per-cycle evidence in Git.
    for (let index = 0; index < heads.length; index++) {
      const date = index < 5 ? "2026-11-05" : "2026-11-06";
      const blob = await gitRun(bare, [
        "show",
        `${heads[index]}:throughput/${date}.jsonl`,
      ], env);
      assert(blob.ok);
      const line = blob.stdout.trim().split("\n").at(-1)!;
      assert.equal(parseThroughputMetricsLineV1(line).cycle.runId, index + 1);
    }
    assert.equal(log.length, 10);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("finalize metrics writer rejects an oversized record before touching state", async () => {
  const pass = facts(1);
  const record = collectFinalizeMetricsV1(pass);
  const oversized = {
    ...record,
    extra: "x".repeat(THROUGHPUT_METRICS_RECORD_MAX_BYTES),
  };
  let reads = 0;
  let writes = 0;
  const result = await appendThroughputMetricsV1({
    read: () => {
      reads++;
      throw new Error("must reject before reading state");
    },
    write: () => {
      writes++;
      throw new Error("must reject before writing state");
    },
  }, oversized);
  assert.deepEqual(result, { status: "unavailable", detail: "invalid" });
  assert.equal(reads, 0);
  assert.equal(writes, 0);
});
