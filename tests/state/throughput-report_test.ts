import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createMetricsCollectorV1 } from "../../src/contracts/throughput-metrics-collector.ts";
import {
  foldThroughputRecordV1,
  type PlannerRefusalReasonV1,
  type ThroughputMetricsRecordV1,
} from "../../src/contracts/throughput-metrics.ts";
import {
  parseThroughputReportWindowV1,
  renderThroughputReport,
  ThroughputReportRefusal,
  type ThroughputReportSnapshotV1,
} from "../../src/state/throughput-report.ts";
import {
  appendThroughputMetricsV1,
  GitThroughputMetricsStore,
} from "../../src/state/throughput-metrics-store.ts";
import { gitRun, makeRemoteCtx, testGitEnv } from "./helpers.ts";

const D1 = Date.UTC(2026, 10, 1);
const H = 3_600_000;
const M = 60_000;

function cycle(input: {
  runId: number;
  start: number;
  minutes: number;
  cellMs?: number;
  merges?: number;
  refresh?: number;
  ci?: number;
  refusal?: PlannerRefusalReasonV1;
}): ThroughputMetricsRecordV1 {
  const collector = createMetricsCollectorV1();
  if (input.cellMs !== undefined) {
    collector.addPhaseMs("matrixCellTotal", input.cellMs);
  }
  if (input.merges !== undefined) {
    collector.addCount("mergesCompleted", input.merges);
  }
  if (input.refresh !== undefined) {
    collector.addCount("refreshCommits", input.refresh);
  }
  if (input.ci !== undefined) {
    collector.addCount("targetCiRunsTriggered", input.ci);
  }
  if (input.refusal !== undefined) collector.setPlannerRefusal(input.refusal);
  return collector.snapshot({
    cycle: { runId: input.runId, attempt: 1 },
    startedAtMs: input.start,
    finishedAtMs: input.start + input.minutes * M,
  });
}

type Work = ThroughputReportSnapshotV1["work"][number];
function work(
  repo: string,
  nextStep: Work["nextStep"],
  updatedAt: number,
  extra: {
    pr?: number;
    issue?: number;
    wait?: Work["wait"];
    blocker?: Work["blocker"];
  } = {},
): Work {
  const [owner, name] = repo.split("/");
  return {
    repository: { owner, name, installationId: 1 },
    source: {
      kind: extra.issue === undefined ? "incident" : "issue",
      id: "x",
      revision: "r",
    },
    related: { incidentId: null, issueNumber: extra.issue ?? null },
    nextStep,
    wait: extra.wait ?? null,
    blocker: extra.blocker ?? null,
    target: {
      base: "a".repeat(40),
      branch: null,
      checkpoint: null,
      head: null,
      pr: extra.pr ?? null,
    },
    updatedAt,
  } as Work;
}

const window = parseThroughputReportWindowV1(
  "2026-11-01",
  "2026-11-03",
  D1 + 2 * 24 * H + 12 * H,
);

Deno.test("throughput report renders the expected tables from metrics and a repair snapshot", () => {
  const folded = foldThroughputRecordV1(
    foldThroughputRecordV1(
      null,
      cycle({
        runId: 4,
        start: D1 + 24 * H + 2 * H,
        minutes: 5,
        cellMs: 5 * M,
        merges: 1,
        refresh: 3,
      }),
    ),
    cycle({
      runId: 5,
      start: D1 + 24 * H + 3 * H,
      minutes: 5,
      merges: 0,
      refusal: "reservation_denied",
    }),
  );
  const ledger = {
    records: [
      cycle({
        runId: 1,
        start: D1,
        minutes: 10,
        cellMs: 15 * M,
        merges: 1,
        refresh: 2,
        ci: 3,
      }),
      cycle({
        runId: 2,
        start: D1 + H,
        minutes: 5,
        merges: 0,
        refresh: 1,
        refusal: "deadline_margin",
      }),
      cycle({
        runId: 3,
        start: D1 + 24 * H,
        minutes: 20,
        cellMs: 10 * M,
        merges: 2,
        refresh: 0,
        ci: 4,
        refusal: "no_ready_records",
      }),
    ],
    daily: [folded],
  };
  const dependency = { kind: "dependency" as const, message: "m", since: D1 };
  const snapshot: ThroughputReportSnapshotV1 = {
    updatedAt: D1 + 2 * 24 * H + 11 * H,
    work: [
      work("ubiquity/ai.ubq.fi", "done", D1 + 12 * H, { pr: 10 }),
      work("ubiquity-sentinel/sentinel", "done", D1 + 30 * H, { pr: 11 }),
      work("ubiquity-sentinel/sentinel", "done", D1 + 31 * H),
      work("ubiquity-sentinel/sentinel", "done", D1 - 2 * 24 * H, { pr: 12 }),
      work("ubiquity/ai.ubq.fi", "delivery", D1 + 54 * H, {
        issue: 21,
        pr: 13,
        wait: { reason: "ci_pending", since: D1 + 54 * H, until: null },
      }),
      work("ubiquity/passport.ubq.fi", "blocked", D1, { blocker: dependency }),
      work("ubiquity-sentinel/sentinel", "blocked", D1, {
        blocker: dependency,
      }),
      work("ubiquity-sentinel/sentinel", "work", D1 + 49 * H),
    ],
  };
  assert.equal(
    renderThroughputReport(ledger, snapshot, window),
    `Sentinel throughput report 2026-11-01 .. 2026-11-03 (UTC, inclusive)
repair snapshot updated 2026-11-03 11:00

Cycles per day (all repositories, metrics)
date                    cycles              merges     refresh commits       refresh/merge             CI runs       CI runs/merge            cell min          duty cycle
2026-11-01                   2                   1                   3                3.00                   3                3.00                15.0                1.50
2026-11-02                   3                   3                   3                1.00                   4                1.33                10.0                0.50
2026-11-03  n/a (not recorded)  n/a (not recorded)  n/a (not recorded)  n/a (not recorded)  n/a (not recorded)  n/a (not recorded)  n/a (not recorded)  n/a (not recorded)
total                        5                   4                   6                1.50                   7                1.75                25.0                0.83
duty cycle = matrix cell minutes / controller minutes over hot cycles with a recorded cell total (2 of 5; 2 folded into daily rollups)

Planner refusal histogram (metrics)
reason                cycles
deadline_margin            1
no_ready_records           1
reservation_denied         1
provider_unavailable       0
target_unavailable         0

Merges per day by repository (repair snapshot: done records with a PR, by UTC completion date)
date        ubiquity-sentinel/sentinel  ubiquity/ai.ubq.fi  ubiquity/passport.ubq.fi
2026-11-01                           0                   1                         0
2026-11-02                           1                   0                         0
2026-11-03                           0                   0                         0
total                                1                   1                         0

Delivery-queue depth per repository (current snapshot)
repository                  delivery
ubiquity-sentinel/sentinel         0
ubiquity/ai.ubq.fi                 1
ubiquity/passport.ubq.fi           0

Blocked-cause histogram (current snapshot)
cause       records
dependency        2

Longest-waiting live records (current snapshot, top 10)
repository                  source    step      wait        since (UTC)       waiting
ubiquity-sentinel/sentinel  incident  work      -           2026-11-03 01:00   11h00m
ubiquity/ai.ubq.fi          #21       delivery  ci_pending  2026-11-03 06:00    6h00m
`,
  );
});

Deno.test("throughput report prints the n/a shape for an empty window and absent sources", () => {
  const empty = parseThroughputReportWindowV1("2026-11-01", "2026-11-01", D1);
  const na = "n/a (not recorded)";
  const row = (label: string) =>
    [label.padEnd(10), ...Array.from({ length: 8 }, () => na)].join("  ");
  const header = [
    "date      ",
    "cycles".padStart(18),
    "merges".padStart(18),
    "refresh commits".padStart(18),
    "refresh/merge".padStart(18),
    "CI runs".padStart(18),
    "CI runs/merge".padStart(18),
    "cell min".padStart(18),
    "duty cycle".padStart(18),
  ].join("  ");
  assert.equal(
    renderThroughputReport({ records: [], daily: [] }, null, empty),
    [
      "Sentinel throughput report 2026-11-01 .. 2026-11-01 (UTC, inclusive)",
      `repair snapshot updated ${na}`,
      "",
      "Cycles per day (all repositories, metrics)",
      header,
      row("2026-11-01"),
      row("total"),
      "duty cycle = matrix cell minutes / controller minutes over hot cycles with a recorded cell total (0 of 0; 0 folded into daily rollups)",
      "",
      "Planner refusal histogram (metrics)",
      `${"reason".padEnd(20)}  ${"cycles".padStart(18)}`,
      ...[
        "deadline_margin",
        "no_ready_records",
        "reservation_denied",
        "provider_unavailable",
        "target_unavailable",
      ].map((reason) => `${reason.padEnd(20)}  ${na}`),
      "",
      "Merges per day by repository",
      na,
      "",
      "Delivery-queue depth per repository",
      na,
      "",
      "Blocked-cause histogram",
      na,
      "",
      "Longest-waiting live records",
      na,
      "",
    ].join("\n"),
  );
  const absent = renderThroughputReport(null, null, empty);
  assert.match(
    absent,
    /Cycles per day \(all repositories, metrics\)\nn\/a \(not recorded\)\n/,
  );
  assert.doesNotMatch(absent, /\b0\b/);
});

Deno.test("throughput report window refuses invalid dates", () => {
  const now = D1;
  for (
    const [since, until] of [
      [undefined, undefined],
      ["true", undefined],
      ["2026-13-01", undefined],
      ["2026-02-30", "2026-03-01"],
      ["2026-11-1", undefined],
      ["yesterday", undefined],
      ["2026-11-02", "2026-11-01"],
      ["2026-01-01", "2026-11-01"],
    ] as const
  ) {
    assert.throws(
      () => parseThroughputReportWindowV1(since, until, now),
      ThroughputReportRefusal,
      `${since} .. ${until}`,
    );
  }
  assert.deepEqual(
    parseThroughputReportWindowV1("2026-10-25", undefined, now),
    {
      since: "2026-10-25",
      until: "2026-11-01",
      nowMs: now,
    },
  );
});

Deno.test("sentinel report CLI refuses an invalid --since before any read", async () => {
  const source = fileURLToPath(
    new URL("../../ops/sentinel-cli.ts", import.meta.url),
  );
  const result = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--frozen",
      "--cached-only",
      "--no-prompt",
      source,
      "report",
      "--since",
      "2026-13-01",
    ],
    clearEnv: true,
    env: { PATH: "/nonexistent" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(result.stderr);
  assert.equal(result.code, 2, stderr);
  assert.equal(new TextDecoder().decode(result.stdout), "");
  assert.match(
    stderr,
    /sentinel report refused: --since must be a UTC calendar date/,
  );
});

Deno.test("sentinel report CLI reads the metrics ref read-only and prints n/a for an absent repair ref", async () => {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-report-test-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  try {
    await Deno.mkdir(`${root}/home`);
    await Deno.mkdir(`${root}/scratch`);
    const env = testGitEnv(`${root}/home`);
    const { remoteUrl } = await makeRemoteCtx(root, env);
    const store = new GitThroughputMetricsStore({
      scratchDir: `${root}/writer`,
      remoteUrl,
    });
    const written = await appendThroughputMetricsV1(
      store,
      cycle({ runId: 9, start: D1, minutes: 10, cellMs: 5 * M, merges: 1 }),
    );
    if (written.status !== "applied") throw new Error("metrics not written");
    const before = await gitRun(root, ["ls-remote", remoteUrl], env);
    const source = fileURLToPath(
      new URL("../../ops/sentinel-cli.ts", import.meta.url),
    );
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--frozen",
        "--cached-only",
        "--no-prompt",
        "--allow-run=git",
        "--allow-env=PATH",
        `--allow-read=${root}`,
        `--allow-write=${root}/scratch`,
        source,
        "report",
        "--since",
        "2026-11-01",
        "--until",
        "2026-11-01",
        "--remote",
        remoteUrl,
        "--scratch",
        `${root}/scratch`,
      ],
      clearEnv: true,
      env: { PATH: env.PATH },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(result.stdout);
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    assert(stdout.startsWith(
      `metrics ref head: ${written.head}\nrepair state head: absent\n`,
    ));
    assert.match(stdout, /\n2026-11-01 +1 +1 +n\/a \(not recorded\)/);
    assert.match(
      stdout,
      /\nMerges per day by repository\nn\/a \(not recorded\)\n/,
    );
    // Read-only: the remote refs are unchanged and the scratch is cleaned.
    assert.equal(
      (await gitRun(root, ["ls-remote", remoteUrl], env)).stdout,
      before.stdout,
    );
    assert.deepEqual([...Deno.readDirSync(`${root}/scratch`)], []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
