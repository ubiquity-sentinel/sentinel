/**
 * Sentinel #330/#338: the maintenance delivery pass's train, CI-run and
 * merge counts travel to finalize as one closed step output and land in the
 * cycle's throughput metrics record; anything malformed stays unobserved.
 */
import assert from "node:assert/strict";
import {
  deliveryCountsFromActions,
  formatDeliveryCounts,
  parseDeliveryCounts,
  writeDeliveryCountsOutput,
} from "../../src/host/delivery-counts-output.ts";
import { collectFinalizeMetricsV1 } from "../../src/host/throughput-metrics-finalize.ts";

Deno.test("delivery counts: the summary line round-trips to finalize's metrics record", async () => {
  const counts = deliveryCountsFromActions([
    "merge:issue-1:pr=1:sha=" + "a".repeat(40),
    "delivery-summary:trains_built=2:target_ci_runs=2:merges=4",
  ]);
  assert.deepEqual(counts, {
    trainsBuilt: 2,
    targetCiRunsTriggered: 2,
    mergesCompleted: 4,
  });
  const dir = await Deno.makeTempDir({ dir: ".", prefix: ".delivery-counts-" });
  try {
    const path = `${dir}/output`;
    await writeDeliveryCountsOutput(path, null);
    await writeDeliveryCountsOutput(path, counts);
    const lines = (await Deno.readTextFile(path)).trim().split("\n");
    assert.deepEqual(lines, ["deliveryCounts=none", "deliveryCounts=2,2,4"]);
    const value = lines.at(-1)!.slice("deliveryCounts=".length);
    const record = collectFinalizeMetricsV1({
      cycle: { runId: 7, attempt: 1 },
      finalizeStartedAtMs: 1_000,
      nowMs: 2_000,
      jobs: null,
      runSummary: null,
      deliveryCounts: parseDeliveryCounts(value),
    });
    assert.equal(record.counts.trainsBuilt, 2);
    assert.equal(record.counts.targetCiRunsTriggered, 2);
    assert.equal(record.counts.mergesCompleted, 4);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("delivery counts: absent or malformed values stay unobserved", () => {
  assert.equal(deliveryCountsFromActions([]), null);
  assert.equal(
    deliveryCountsFromActions([
      "delivery-summary:trains_built=1:target_ci_runs=1:merges=1",
      "delivery-summary:trains_built=1:target_ci_runs=1:merges=1",
    ]),
    null,
  );
  for (const value of [undefined, null, "", "none", "1,2", "1,2,x", "-1,0,0"]) {
    assert.equal(parseDeliveryCounts(value), null, String(value));
  }
  assert.equal(formatDeliveryCounts(null), "none");
  const record = collectFinalizeMetricsV1({
    cycle: { runId: 7, attempt: 1 },
    finalizeStartedAtMs: 1_000,
    nowMs: 2_000,
    jobs: null,
    runSummary: null,
    deliveryCounts: null,
  });
  assert.equal(record.counts.trainsBuilt, null);
  assert.equal(record.counts.mergesCompleted, null);
});
