import assert from "node:assert/strict";
import { canonicalStringify } from "../../src/contracts/canonical.ts";
import { createMetricsCollectorV1 } from "../../src/contracts/throughput-metrics-collector.ts";
import {
  parseThroughputMetricsLineV1,
  parseThroughputMetricsRecordV1,
  THROUGHPUT_METRICS_RECORD_MAX_BYTES,
  THROUGHPUT_OPTIONAL_COUNTERS_V1,
  THROUGHPUT_WAIT_CAUSE_KEYS,
  type ThroughputMetricsRecordV1,
} from "../../src/contracts/throughput-metrics.ts";
import { RecordParseError } from "../../src/contracts/validation.ts";
import { DenoGitRunner } from "../../src/state/mod.ts";
import {
  appendThroughputRecordV1,
  decodeThroughputLedgerV1,
  EMPTY_THROUGHPUT_LEDGER,
  encodeThroughputLedgerV1,
  THROUGHPUT_DAILY_PATH,
  THROUGHPUT_HOT_MAX_RECORDS,
  THROUGHPUT_METRICS_REF,
  type ThroughputMetricsLedgerV1,
} from "../../src/state/throughput-metrics-ledger.ts";
import {
  appendThroughputMetricsV1,
  GitThroughputMetricsStore,
} from "../../src/state/throughput-metrics-store.ts";
import { gitRun, makeRemoteCtx, T0, testGitEnv } from "./helpers.ts";

const DAY = 86_400_000;

function record(
  runId: number,
  finishedAtMs = T0 + runId * 300_000,
): ThroughputMetricsRecordV1 {
  const collector = createMetricsCollectorV1();
  collector.addPhaseMs("prepare", 1_000);
  collector.addCount("modelStarts", runId % 3);
  return collector.snapshot({
    cycle: { runId, attempt: 1 },
    startedAtMs: finishedAtMs - 60_000,
    finishedAtMs,
  });
}

function rejects(input: unknown, code: string) {
  assert.throws(
    () => parseThroughputMetricsRecordV1(input),
    (error: unknown) =>
      error instanceof RecordParseError && error.issues[0]?.code === code,
  );
}

Deno.test("throughput record parser is strict, nullable and byte bounded", () => {
  const value = record(7);
  assert.deepEqual(parseThroughputMetricsRecordV1(value), value);
  assert.equal(value.counts.reviewsRequested, null);
  assert.equal(value.phaseMs.prepare, 1_000);
  // The largest possible record fits its byte bound.
  const max = structuredClone(value) as unknown as Record<string, unknown>;
  for (const key of ["phaseMs", "counts"]) {
    const group = max[key] as Record<string, unknown>;
    for (const k of Object.keys(group)) group[k] = Number.MAX_SAFE_INTEGER;
  }
  max.plannerRefusal = "provider_unavailable";
  max.cycle = { runId: Number.MAX_SAFE_INTEGER, attempt: 99 };
  max.startedAtMs = 0;
  max.finishedAtMs = Number.MAX_SAFE_INTEGER;
  // Every optional key at its widest too: all additive counters and a full
  // wait-cause histogram with the longest keys.
  const counts = max.counts as Record<string, unknown>;
  for (const key of THROUGHPUT_OPTIONAL_COUNTERS_V1) {
    counts[key] = Number.MAX_SAFE_INTEGER;
  }
  max.waitCauses = Object.fromEntries(
    Array.from(
      { length: THROUGHPUT_WAIT_CAUSE_KEYS },
      (
        _,
        i,
      ) => [`abcdefg:abcdefg:abcdefghijklmno${i}`, Number.MAX_SAFE_INTEGER],
    ),
  );
  const widest = parseThroughputMetricsRecordV1(max);
  const bytes = new TextEncoder().encode(canonicalStringify(widest)).length;
  assert(
    bytes > 1024 && bytes <= THROUGHPUT_METRICS_RECORD_MAX_BYTES,
    `${bytes}`,
  );
  assert.equal(THROUGHPUT_METRICS_RECORD_MAX_BYTES, 2048);

  rejects({ ...value, extra: 1 }, "unknown_key");
  rejects(
    { ...value, counts: { ...value.counts, modelStarts: -1 } },
    "invalid_count",
  );
  rejects({ ...value, plannerRefusal: "other" }, "invalid_enum");
  rejects({ ...value, finishedAtMs: value.startedAtMs - 1 }, "invalid_value");
  const { counts: _counts, ...missing } = value;
  rejects(missing, "missing_field");
});

Deno.test("throughput record parser rejects URL-bearing and long strings anywhere", () => {
  const value = record(8);
  for (
    const url of [
      "https://example.com/x",
      "git://h/r",
      "www.example.com",
      "api.github.com/repos",
    ]
  ) {
    rejects({ ...value, plannerRefusal: url }, "invalid_value");
    rejects({ ...value, note: url }, "invalid_value");
  }
  rejects({ ...value, plannerRefusal: "x".repeat(33) }, "bound_exceeded");
  rejects({ ...value, ["k".repeat(40)]: 1 }, "bound_exceeded");
});

Deno.test("an oversized metrics line or record is refused before storage", () => {
  const line = canonicalStringify(record(9));
  assert.deepEqual(parseThroughputMetricsLineV1(line), record(9));
  const padded = `${line}${" ".repeat(THROUGHPUT_METRICS_RECORD_MAX_BYTES)}`;
  assert.throws(
    () => parseThroughputMetricsLineV1(padded),
    (error: unknown) =>
      error instanceof RecordParseError &&
      error.issues[0]?.code === "bound_exceeded",
  );
  // Non-canonical spelling is refused too.
  assert.throws(() =>
    parseThroughputMetricsLineV1(JSON.stringify(record(9), null, 1))
  );
  // The ledger append refuses an oversized (padded) record object.
  const oversized = {
    ...record(10),
    counts: { ...record(10).counts, pad: "a".repeat(2000) },
  } as unknown as ThroughputMetricsRecordV1;
  assert.throws(() =>
    appendThroughputRecordV1(EMPTY_THROUGHPUT_LEDGER, oversized)
  );
});

Deno.test("collector accumulates, keeps unobserved fields null and refuses bad input", () => {
  const collector = createMetricsCollectorV1();
  collector.addPhaseMs("matrixCellTotal", 10);
  collector.addPhaseMs("matrixCellTotal", 15);
  collector.addCount("mergesCompleted", 0);
  collector.setPlannerRefusal("deadline_margin");
  const out = collector.snapshot({
    cycle: { runId: 1, attempt: 2 },
    startedAtMs: T0,
    finishedAtMs: T0 + 1,
  });
  assert.equal(out.phaseMs.matrixCellTotal, 25);
  assert.equal(out.phaseMs.repair, null);
  assert.equal(out.counts.mergesCompleted, 0);
  assert.equal(out.counts.trainsBuilt, null);
  assert.equal(out.plannerRefusal, "deadline_margin");
  assert.throws(() => collector.addCount("modelStarts", -1));
  assert.throws(() => collector.addPhaseMs("repair", 1.5));
});

Deno.test("retention keeps the newest records and folds older ones into daily rollups", () => {
  let ledger: ThroughputMetricsLedgerV1 = EMPTY_THROUGHPUT_LEDGER;
  const total = THROUGHPUT_HOT_MAX_RECORDS + 25;
  // One record per ~two minutes, spanning several UTC days.
  for (let runId = 1; runId <= total; runId++) {
    const next = appendThroughputRecordV1(
      ledger,
      record(runId, T0 + runId * 200_000),
    );
    assert.equal(next.status, "appended");
    ledger = next.ledger;
  }
  assert.equal(ledger.records.length, THROUGHPUT_HOT_MAX_RECORDS);
  assert.equal(ledger.records[0].cycle.runId, 26);
  const folded = ledger.daily.reduce((n, day) => n + day.records, 0);
  assert.equal(folded, 25);
  const modelStarts = ledger.daily.reduce(
    (n, day) => n + day.counts.modelStarts.sum,
    0,
  );
  let expected = 0;
  for (let runId = 1; runId <= 25; runId++) expected += runId % 3;
  assert.equal(modelStarts, expected);
  assert.equal(ledger.daily[0].counts.reviewsRequested.known, 0);
  // Duplicate cycles never write twice.
  assert.equal(
    appendThroughputRecordV1(ledger, record(total)).status,
    "duplicate",
  );
  // Encoding round-trips and spans one file per day plus the rollup.
  const files = encodeThroughputLedgerV1(ledger);
  assert(files.has(THROUGHPUT_DAILY_PATH));
  assert(files.size >= 3);
  assert.deepEqual(decodeThroughputLedgerV1(files), ledger);
  // A record filed under the wrong day is refused.
  const wrong = new Map([[
    "throughput/2001-01-01.jsonl",
    `${canonicalStringify(record(1, T0 + DAY))}\n`,
  ]]);
  assert.throws(() => decodeThroughputLedgerV1(wrong));
  assert.throws(() =>
    decodeThroughputLedgerV1(new Map([["other.json", "{}\n"]]))
  );
});

Deno.test("metrics sidecar uses its own ref with nonforce CAS and refuses a stale head", async () => {
  const root = await Deno.makeTempDir({
    prefix: "sentinel-metrics-test-",
    dir: decodeURIComponent(new URL("../../", import.meta.url).pathname),
  });
  try {
    await Deno.mkdir(`${root}/home`);
    const env = testGitEnv(`${root}/home`);
    const { remoteUrl } = await makeRemoteCtx(root, env);
    const runner = new DenoGitRunner(`${root}/home`);
    const pushes: string[][] = [];
    const store = new GitThroughputMetricsStore({
      scratchDir: `${root}/a`,
      remoteUrl,
      runner: {
        runGit(args, opts) {
          if (args[0] === "push") pushes.push(args);
          return runner.runGit(args, opts);
        },
      },
    });
    const first = await appendThroughputMetricsV1(store, record(1));
    assert.equal(first.status, "applied");
    const second = await appendThroughputMetricsV1(store, record(2));
    assert.equal(second.status, "applied");
    assert.equal(
      (await appendThroughputMetricsV1(store, record(2))).status,
      "duplicate",
    );
    const read = await store.read();
    assert(read.ok);
    assert.deepEqual(read.value.ledger.records, [record(1), record(2)]);
    if (first.status !== "applied") throw new Error("unreachable");
    const stale = await store.write({
      expectedHead: first.head,
      ledger: read.value.ledger,
    });
    assert(stale.ok && stale.value.status === "conflict");
    const refs = await gitRun(root, ["ls-remote", remoteUrl], env);
    assert(refs.ok);
    assert.equal(refs.stdout.trim().split("\n").length, 1);
    assert(refs.stdout.trim().endsWith(`\t${THROUGHPUT_METRICS_REF}`));
    assert(
      pushes.every((args) =>
        !args.some((arg) => arg.startsWith("--force") || arg.startsWith("+"))
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
