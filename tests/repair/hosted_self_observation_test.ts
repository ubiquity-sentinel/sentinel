/**
 * Applier tests for the self-observation pass: bounded reads, per-pass issue
 * cap and marker dedup over a fake surface. No network, state or model access;
 * every fixture below is synthetic.
 */
// ---- applier: bounded, deduplicated filing over a fake surface ------------

import {
  type HostedAutonomyGitHubV1,
  runSelfObservationPass,
} from "../../ops/hosted-autonomy.ts";

function fakeSurface(input: {
  runs: unknown;
  jobs: unknown;
  logs: Record<number, string | null>;
  bodies: string[];
  capability?: boolean;
}) {
  const filed: { title: string; body: string }[] = [];
  const base = {
    readDefaultBranch: () => Promise.resolve("development"),
    readBaseTip: () => Promise.resolve(null),
    hasSuccessfulCheck: () => Promise.resolve(false),
    hasAllChecksGreen: () => Promise.resolve(false),
    readPull: () => Promise.resolve(null),
    readIssueOpen: () => Promise.resolve(null),
    merge: () => Promise.resolve(null),
    closeIssue: () => Promise.resolve(false),
    listParkedRuns: () => Promise.resolve([]),
    approveRun: () => Promise.resolve(false),
  };
  const observation = {
    listRuns: () => Promise.resolve(input.runs),
    listJobs: () => Promise.resolve(input.jobs),
    readJobLog: (request: { jobId: number }) =>
      Promise.resolve(input.logs[request.jobId] ?? null),
    listOpenIssueBodies: () => Promise.resolve(input.bodies),
    fileIssue: (issue: { title: string; body: string }) => {
      filed.push(issue);
      return Promise.resolve(900 + filed.length);
    },
  };
  const surface = (input.capability === false ? base : {
    ...base,
    selfObservation: observation,
  }) as unknown as HostedAutonomyGitHubV1;
  return { surface, filed };
}

import assert from "node:assert/strict";

const FAILED_RUNS = [
  {
    id: 1,
    name: "sentinel-ci",
    conclusion: "failure",
    createdAt: "2026-09-23T18:18:46Z",
  },
  {
    id: 2,
    name: "sentinel-ci",
    conclusion: "failure",
    createdAt: "2026-09-23T18:20:46Z",
  },
  {
    id: 3,
    name: "sentinel-supervisor",
    conclusion: "cancelled",
    createdAt: "2026-09-23T18:22:46Z",
  },
];

Deno.test("self observation: absent capability skips every read and write", async () => {
  const { surface, filed } = fakeSurface({
    runs: FAILED_RUNS,
    jobs: [],
    logs: {},
    bodies: [],
    capability: false,
  });
  const actions = await runSelfObservationPass({
    github: surface,
    now: Date.parse("2026-09-23T19:00:00Z"),
  });
  assert.deepEqual(actions, ["self-observation:skipped:capability_absent"]);
  assert.equal(filed.length, 0);
});

Deno.test("self observation: repeated classes are filed once and capped per pass", async () => {
  const jobs = [{ id: 11, name: "test-local", conclusion: "failure" }];
  const log = "error: AssertionError: unexpected github calls: readRef\n";
  const { surface, filed } = fakeSurface({
    runs: FAILED_RUNS,
    jobs,
    logs: { 11: log },
    bodies: [],
  });
  const actions = await runSelfObservationPass({
    github: surface,
    now: Date.parse("2026-09-23T19:00:00Z"),
  });
  assert.equal(
    filed.length,
    2,
    "one report per workflow class, within the per-pass cap",
  );
  assert.ok(
    actions.some((action) => action.startsWith("self-observation:filed:90")),
  );
  assert.ok(
    filed.every((issue) => issue.body.includes("sentinel:self-observation:")),
  );
  assert.ok(
    filed.every((issue) => !issue.body.includes("=== raw log ===")),
    "no raw log body is carried",
  );
  const keys = filed.map((issue) =>
    issue.body.match(/<!-- sentinel:self-observation:([a-z0-9:._-]+) -->/)
      ?.[1] ?? null
  );
  assert.equal(
    new Set(keys).size,
    2,
    "the two classes are distinct identities",
  );
  assert.ok(keys.every((key) => key !== null && key.startsWith("sentinel-")));

  const second = fakeSurface({
    runs: FAILED_RUNS,
    jobs,
    logs: { 11: log },
    bodies: filed.map((issue) => issue.body),
  });
  const secondActions = await runSelfObservationPass({
    github: second.surface,
    now: Date.parse("2026-09-23T19:00:00Z"),
  });
  assert.equal(
    second.filed.length,
    0,
    "an already-filed class is never refiled",
  );
  assert.ok(
    secondActions.includes("self-observation:no_change"),
    "a pass with nothing new reports no_change",
  );
});

Deno.test("self observation: an unreadable log is an explicit skip, not a report", async () => {
  const jobs = [{ id: 11, name: "test-local", conclusion: "failure" }];
  const { surface, filed } = fakeSurface({
    runs: [FAILED_RUNS[0]!],
    jobs,
    logs: { 11: null },
    bodies: [],
  });
  const actions = await runSelfObservationPass({
    github: surface,
    now: Date.parse("2026-09-23T19:00:00Z"),
  });
  assert.equal(filed.length, 0);
  assert.ok(
    actions.some((action) => action.includes("log_unavailable")),
    "the refusal is visible as an action",
  );
});

Deno.test("self observation: arbitrary diagnostic text never enters issue titles bodies or markers", async (t) => {
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  for (
    const log of [
      `error: authorization=Bearer ${marker} /private/synthetic/path\n`,
      `error: AssertionError: ${marker} https://private.invalid/model-text\n`,
      `TS2304 [ERROR]: ${marker} /private/synthetic/path\n`,
    ]
  ) {
    await t.step(
      log.startsWith("TS")
        ? "type diagnostic"
        : log.includes("AssertionError")
        ? "assertion diagnostic"
        : "generic diagnostic",
      async () => {
        const { surface, filed } = fakeSurface({
          runs: [FAILED_RUNS[0]!],
          jobs: [{ id: 11, name: marker, conclusion: "failure" }],
          logs: { 11: log },
          bodies: [],
        });
        await runSelfObservationPass({
          github: surface,
          now: Date.parse("2026-09-23T19:00:00Z"),
        });
        assert.equal(filed.length, 1);
        const publicIssue = JSON.stringify(filed).toLowerCase();
        assert.ok(!publicIssue.includes(marker.toLowerCase()));
        assert.ok(!publicIssue.includes("/private/"));
        assert.ok(!publicIssue.includes("https://private.invalid"));
        assert.ok(filed[0]!.body.includes("unknown-job"));
        assert.ok(filed[0]!.body.includes("run ids: `1`"));
      },
    );
  }
});

Deno.test("self observation: a cancelled sibling does not mask a failed job", async (t) => {
  for (const conclusion of ["failure", "timed_out", "startup_failure"]) {
    await t.step(conclusion, async () => {
      const { surface, filed } = fakeSurface({
        runs: [FAILED_RUNS[2]!],
        jobs: [
          { id: 11, name: "maintenance", conclusion: "cancelled" },
          { id: 12, name: "finalize", conclusion },
        ],
        logs: { 11: "##[error]The operation was canceled.\n", 12: "" },
        bodies: [],
      });
      const reads: number[] = [];
      const readJobLog = surface.selfObservation!.readJobLog;
      surface.selfObservation!.readJobLog = (request) => {
        reads.push(request.jobId);
        return readJobLog(request);
      };

      await runSelfObservationPass({
        github: surface,
        now: Date.parse("2026-09-23T19:00:00Z"),
      });

      assert.deepEqual(reads, [12], "read only the primary failure's log");
      assert.equal(filed.length, 1);
      assert.ok(filed[0]!.body.includes("- job: `finalize`"));
      assert.ok(filed[0]!.body.includes(`- conclusion: \`${conclusion}\``));
      assert.ok(!filed[0]!.title.includes("cancelled"));
    });
  }
});

Deno.test("self observation: cancellation without a failed sibling skips logs and filing", async (t) => {
  for (const withFinalizer of [false, true]) {
    await t.step(
      withFinalizer ? "paused admission" : "lone cancellation",
      async () => {
        const { surface, filed } = fakeSurface({
          runs: [{
            id: 40583137237,
            name: "sentinel-supervisor",
            conclusion: "cancelled",
            createdAt: "2026-10-27T21:01:07.000Z",
          }],
          jobs: [
            { id: 11, name: "maintenance", conclusion: "cancelled" },
            ...(withFinalizer
              ? [
                { id: 12, name: "prepare", conclusion: "skipped" },
                { id: 13, name: "finalize", conclusion: "success" },
              ]
              : []),
          ],
          logs: { 11: "##[error]The operation was canceled.\n" },
          bodies: [],
        });
        const reads: string[] = [];
        surface.selfObservation!.readJobLog = () => {
          reads.push("log");
          return Promise.resolve("##[error]The operation was canceled.\n");
        };
        surface.selfObservation!.listOpenIssueBodies = () => {
          reads.push("issues");
          return Promise.resolve([]);
        };

        const actions = await runSelfObservationPass({
          github: surface,
          now: Date.parse("2026-10-27T22:00:00Z"),
        });

        assert.deepEqual(actions, [
          "self-observation:skipped:no_readable_failure",
        ]);
        assert.deepEqual(
          reads,
          [],
          "cancellations do not need log or issue reads",
        );
        assert.deepEqual(filed, []);
      },
    );
  }
});

Deno.test("self observation: current CI errors file sanitized reports and deduplicate legacy names", async () => {
  const marker = "SYNTHETIC_PRIVATE_MARKER";
  const log = `2026-10-27T20:06:18.1234567Z error: ${marker} /private/path\n`;
  const first = fakeSurface({
    runs: [FAILED_RUNS[0]!],
    jobs: [{ id: 11, name: "test-shards (modules, 4)", conclusion: "failure" }],
    logs: { 11: log },
    bodies: [],
  });
  const now = Date.parse("2026-09-23T19:00:00Z");
  const actions = await runSelfObservationPass({ github: first.surface, now });
  assert.deepEqual(actions, ["self-observation:filed:901:1x"]);
  assert.equal(first.filed.length, 1);
  const issue = first.filed[0]!;
  assert.equal(
    issue.title,
    "Sentinel self-observation: the job reported an error",
  );
  assert.ok(
    issue.body.includes(
      "sentinel:self-observation:sentinel-ci:test-shards:error:observed",
    ),
  );
  assert.ok(issue.body.includes("- job: `test-shards`"));
  assert.ok(!JSON.stringify(issue).includes(marker));
  assert.ok(!JSON.stringify(issue).includes("/private/"));

  const second = fakeSurface({
    runs: [FAILED_RUNS[0]!],
    jobs: [{ id: 11, name: "test-shards (modules)", conclusion: "failure" }],
    logs: { 11: "error: another private diagnostic\n" },
    bodies: [issue.body],
  });
  const nextActions = await runSelfObservationPass({
    github: second.surface,
    now,
  });
  assert.equal(second.filed.length, 0);
  assert.deepEqual(nextActions, ["self-observation:no_change"]);
});
