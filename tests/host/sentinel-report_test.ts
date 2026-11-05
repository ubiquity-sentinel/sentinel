import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
  metricsTime,
  parsePassMetrics,
  type PassMetricsV1,
} from "../../src/contracts/pass-metrics.ts";
import {
  readPassMetrics,
  renderReport,
  reportFromFile,
} from "../../ops/sentinel-report.ts";

const fixture = new URL(
  "../fixtures/metrics/pass-metrics.jsonl",
  import.meta.url,
);
const source = fileURLToPath(
  new URL("../../ops/sentinel-cli.ts", import.meta.url),
);
const since = metricsTime("2026-11-02");
const until = metricsTime("2026-11-04");
const expected = `Throughput report (UTC)
Window: 2026-11-02T00:00:00.000Z <= time < 2026-11-04T00:00:00.000Z
Completed passes: 2; latest: 2026-11-03T01:20:00.000Z
Model duty cycle: 40.00 cell minutes / 30.00 controller minutes = 133.33%
Pass deltas are selected by finish time; parallel cells can exceed 100% duty.
Queue, blocked causes and live records use each repository's latest snapshot, not sums.

Merges per day by repository
| Day (UTC) | Repository | Merges |
| --- | --- | --- |
| 2026-11-02 | example/alpha | 1 |
| 2026-11-02 | example/beta | 0 |
| 2026-11-03 | example/alpha | 1 |
| 2026-11-03 | example/beta | 0 |

Repository totals
| Repository | Merges | Merges/day | Refresh commits | Refresh/merge | Target CI runs | CI/merge | Delivery queue | Snapshot (UTC) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| example/alpha | 2 | 1.00 | 3 | 1.50 | 6 | 3.00 | 1 | 2026-11-03T01:20:00.000Z |
| example/beta | 0 | 0.00 | 0 | n/a | 2 | n/a | 4 | 2026-11-02T00:10:00.000Z |

Blocked-cause histogram (latest snapshots)
| Repository | Cause | Count |
| --- | --- | --- |
| example/alpha | ci | 1 |
| example/beta | authorization | 1 |

Planner refusal histogram (pass deltas)
| Repository | Refusal | Count |
| --- | --- | --- |
| example/alpha | capacity | 3 |
| example/beta | source_unavailable | 1 |

Longest-waiting live records (latest snapshots; top 10; age at window end)
| Repository | Record | Next step | Cause | Waiting since (UTC) | Waiting hours |
| --- | --- | --- | --- | --- | --- |
| example/beta | beta-old | delivery | ci_pending | 2026-11-01T00:00:00.000Z | 72.00 |
| example/alpha | alpha-live | blocked | ci | 2026-11-02T00:00:00.000Z | 48.00 |`;

async function records() {
  return readPassMetrics(await Deno.readTextFile(fixture));
}

Deno.test("sentinel report fixture produces the expected throughput tables", async () => {
  assert.equal(renderReport(await records(), since, until), expected);
  assert.equal(
    await reportFromFile({
      since: "2026-11-02",
      metrics: fileURLToPath(fixture),
    }, until),
    expected,
  );
});

Deno.test("sentinel report deduplicates exports and sorts out-of-order passes", async () => {
  const input = await Deno.readTextFile(fixture);
  const rows = (await records()).reverse();
  assert.equal(
    renderReport(readPassMetrics(input + input), since, until),
    expected,
  );
  assert.equal(
    renderReport(readPassMetrics(JSON.stringify(rows)), since, until),
    expected,
  );
  rows[0].id = rows[1].id;
  assert.throws(
    () => readPassMetrics(JSON.stringify(rows)),
    /Conflicting pass metrics/,
  );
});

Deno.test("sentinel report excludes pre-window merges in a boundary-crossing pass", async () => {
  const row = (await records())[1];
  row.startedAt = "2026-11-01T23:55:00.000Z";
  row.repositories[0].merges.push({
    number: 8,
    mergedAt: "2026-11-01T23:59:00.000Z",
  });
  const result = renderReport([row], since, until);
  assert.match(result, /example\/alpha \| 1 \| 0.50 \| 2 \| 2.00 \| 4 \| 4.00/);
  assert.match(
    result,
    /15.00 cell minutes \/ 15.00 controller minutes = 100.00%/,
  );
  row.finishedAt = "2026-11-02T00:00:00.000Z";
  row.repositories[0].merges = [];
  assert.match(renderReport([row], since, until), /Completed passes: 1/);
});

Deno.test("sentinel report uses n/a for zero controller time and has empty histograms", async () => {
  const row = (await records())[1];
  row.startedAt = row.finishedAt;
  row.cellMinutes = 0;
  row.repositories.forEach((repo) => {
    repo.merges = [];
    repo.liveRecords = [];
    repo.blockedCauses = {};
    repo.plannerRefusals = {};
  });
  const result = renderReport([row], since, until);
  assert.match(result, /0.00 cell minutes \/ 0.00 controller minutes = n\/a/);
  assert.equal(result.match(/\(none\)/g)?.length, 3);
});

Deno.test("sentinel report bounds longest-waiting rows with stable ties", async () => {
  const row = (await records())[1];
  row.repositories = [row.repositories[0]];
  row.repositories[0].liveRecords = Array.from({ length: 12 }, (_, i) => ({
    id: `record-${String(i).padStart(2, "0")}`,
    waitingSince: "2026-11-01T00:00:00.000Z",
    nextStep: "review" as const,
    cause: null,
  })).reverse();
  const report = renderReport([parsePassMetrics(row)], since, until);
  assert.equal(report.match(/\| record-/g)?.length, 10);
  assert.ok(report.indexOf("record-00") < report.indexOf("record-09"));
  assert.ok(!report.includes("record-10"));
});

Deno.test("sentinel report refuses missing, invalid and ambiguous evidence", async () => {
  for (
    const date of [
      "2026-02-30",
      "2026-11-02T24:00:00Z",
      "yesterday",
      "2026-11-02T01:00:00",
    ]
  ) {
    assert.throws(() => metricsTime(date), /Invalid UTC date/);
  }
  assert.throws(
    () => readPassMetrics('{"broken"'),
    /Invalid pass metrics JSON/,
  );
  assert.throws(() => renderReport([], since, until), /throughput is unknown/);
  assert.throws(() => renderReport([], until, since), /earlier than/);
  await assert.rejects(() => reportFromFile({}, until), /requires --since/);
  await assert.rejects(
    () => reportFromFile({ since: "2026-11-04" }, until),
    /earlier than/,
  );
  await assert.rejects(
    () => reportFromFile({ since: "2026-11-02", _: "extra" }, until),
    /usage:/,
  );
  await assert.rejects(
    () =>
      reportFromFile(
        { since: "2026-11-02", metrics: `${source}.missing` },
        until,
      ),
    /Pass metrics unavailable/,
  );
  const base = (await records())[1];
  const invalid: ((r: PassMetricsV1) => void)[] = [
    (r) => {
      r.version = 2 as 1;
    },
    (r) => {
      r.cellMinutes = -1;
    },
    (r) => {
      r.cellMinutes = Infinity;
    },
    (r) => {
      r.finishedAt = "2026-11-01T00:00:00Z";
    },
    (r) => {
      r.repositories[0].refreshCommits = 0.5;
    },
    (r) => {
      r.repositories[0].targetCiRuns = -1;
    },
    (r) => {
      r.repositories[0].deliveryQueueDepth = -1;
    },
    (r) => {
      r.repositories[0].blockedCauses = { ci: -1 };
    },
    (r) => {
      r.repositories[0].plannerRefusals = { capacity: NaN };
    },
    (r) => {
      r.repositories[0].liveRecords[0].waitingSince = "2026-11-05T00:00:00Z";
    },
    (r) => {
      r.repositories[0].merges[0].mergedAt = "2026-11-01T00:00:00Z";
    },
    (r) => {
      r.repositories.push(r.repositories[0]);
    },
  ];
  for (const mutate of invalid) {
    const row = structuredClone(base);
    mutate(row);
    assert.throws(() => parsePassMetrics(row));
  }
  const tied = structuredClone(base);
  tied.id = "another-pass";
  tied.repositories[0].deliveryQueueDepth = 50;
  assert.throws(
    () => renderReport([base, tied], since, until),
    /Ambiguous latest snapshot/,
  );
});

async function cli(
  args: string[],
  cwd?: string,
  read = fileURLToPath(fixture),
) {
  return await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-lock",
      "--cached-only",
      `--allow-read=${read}`,
      source,
      "report",
      ...args,
    ],
    cwd,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
}

Deno.test("sentinel report CLI lifecycle reads a fixture without GitHub or write permissions", async () => {
  const before = await Deno.readTextFile(fixture);
  const result = await cli([
    "--since",
    "2026-11-02",
    "--until",
    "2026-11-04",
    "--metrics",
    fileURLToPath(fixture),
  ]);
  assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
  assert.equal(new TextDecoder().decode(result.stdout), expected + "\n");
  assert.equal(await Deno.readTextFile(fixture), before);
  const invalid = await cli(["--since", "2026-02-30"]);
  assert.notEqual(invalid.code, 0);
  assert.match(new TextDecoder().decode(invalid.stderr), /Invalid UTC date/);
});

Deno.test("sentinel report CLI defaults to the local per-pass export", async () => {
  const root = await Deno.makeTempDir({
    dir: Deno.cwd(),
    prefix: "sentinel-test-local-report-",
  });
  try {
    await Deno.mkdir(`${root}/.sentinel`);
    await Deno.writeTextFile(
      `${root}/.sentinel/pass-metrics.jsonl`,
      await Deno.readTextFile(fixture),
    );
    const result = await cli(
      ["--since=2026-11-02", "--until=2026-11-04"],
      root,
      root,
    );
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    assert.equal(new TextDecoder().decode(result.stdout), expected + "\n");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
