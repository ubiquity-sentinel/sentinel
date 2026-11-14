/** Synthetic repair-cell failures through the production observation pass. */
import assert from "node:assert/strict";
import { runSelfObservationPass } from "../../ops/hosted-autonomy-observation.ts";
import type {
  HostedAutonomyGitHubV1,
  HostedSelfObservationV1,
} from "../../ops/hosted-autonomy-types.ts";
import { SELF_DEFECT_MAX_LOG_BYTES } from "../../ops/self-defects.ts";

Deno.test("self observation: repair-cell reports stay sanitized, deduplicate and remain distinct from matrix cells", async () => {
  const bodies: string[] = [];
  const filed: { title: string; body: string }[] = [];
  const firstCellId = "a".repeat(64);
  const secondCellId = "b".repeat(64);
  let now = Date.parse("2026-11-09T05:40:00Z");
  let runId = 1;
  let jobName = `repair_cell (${firstCellId})`;
  const selfObservation: HostedSelfObservationV1 = {
    listRuns: () =>
      Promise.resolve([{
        id: runId,
        name: "sentinel-supervisor",
        conclusion: "failure",
        createdAt: new Date(now - 60_000).toISOString(),
      }]),
    listJobs: (id) => {
      assert.equal(id, runId);
      return Promise.resolve([{
        id: 11,
        name: jobName,
        conclusion: "failure",
      }]);
    },
    readJobLog: (request) => {
      assert.deepEqual(request, {
        jobId: 11,
        maxBytes: SELF_DEFECT_MAX_LOG_BYTES,
      });
      return Promise.resolve("SYNTHETIC_PRIVATE_DIAGNOSTIC\n");
    },
    listOpenIssueBodies: () => Promise.resolve(bodies),
    fileIssue: (issue) => {
      filed.push(issue);
      bodies.push(issue.body);
      return Promise.resolve(900 + filed.length);
    },
  };
  const github = { selfObservation } as unknown as HostedAutonomyGitHubV1;
  assert.deepEqual(
    await runSelfObservationPass({ github, now }),
    ["self-observation:filed:901:1x"],
  );
  assert.equal(filed.length, 1);
  assert.equal(
    filed[0]!.title,
    "Sentinel self-observation: the job failed with no allowlisted log pattern",
  );
  assert.ok(bodies[0]!.startsWith(
    "<!-- sentinel:self-observation:sentinel-supervisor:repair_cell:job:observed -->",
  ));
  assert.ok(bodies[0]!.includes("- job: `repair_cell`"));
  assert.ok(!JSON.stringify(filed).includes(firstCellId));
  assert.ok(!JSON.stringify(filed).includes("SYNTHETIC_PRIVATE_DIAGNOSTIC"));

  now += 60_000;
  runId++;
  jobName = `repair_cell (${secondCellId})`;
  assert.deepEqual(
    await runSelfObservationPass({ github, now }),
    ["self-observation:no_change"],
  );
  assert.equal(filed.length, 1, "different repair cells share a stable marker");

  now += 60_000;
  runId++;
  jobName = `matrix_cell (${secondCellId})`;
  assert.deepEqual(
    await runSelfObservationPass({ github, now }),
    ["self-observation:filed:902:1x"],
  );
  assert.equal(filed.length, 2, "implementation cells remain a distinct job");
  assert.ok(bodies[1]!.startsWith(
    "<!-- sentinel:self-observation:sentinel-supervisor:matrix_cell:job:observed -->",
  ));
  assert.ok(!JSON.stringify(filed).includes(secondCellId));
});
